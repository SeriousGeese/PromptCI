/**
 * pcic-1ik0.24: the version a manifest declares, as the version-mismatch checks in
 * manifest-consistency.ts and their rewrite recipes (pcic-k1t3.12) read it.
 *
 * A finding needs only a FLOOR: the lowest version any declaration allows, so a mention below it is
 * stale whichever declaration is right. A rewrite needs more: one version every declaration agrees
 * on, from a source that states what the project runs. When the sources disagree, or the only
 * source is a compatibility claim, the finding stays and the rewrite is refused (advisory):
 *
 * - package.json: `dependencies` and `devDependencies` are what the project installs;
 *   `peerDependencies` is a range the package claims to work with, read only for the floor
 *   (it used to win because it was read last).
 * - pyproject.toml: `[project].dependencies` and `[tool.poetry.dependencies]` are the main
 *   dependencies; optional-dependencies, Poetry groups and optional entries, dependency groups
 *   and the like are extras, read only for the floor (the first line naming the library anywhere
 *   in the file used to win).
 * - An exclusive bound (`>3.8`, `>18`) excludes the version it names: a mention of exactly that
 *   version is below it, and no rewrite is offered (`>3.8` used to read as 3.8).
 * - Alternatives (`^18.18 || >=20`) floor at the lowest; a rewrite needs them all to agree (the
 *   last `>=` used to win, so `^18 || >=20` read as 20).
 * - A spec this cannot read (`catalog:`, `workspace:*`, a tag, a URL) refuses the rewrite.
 *
 * Exported so a consumer that re-checks a stored rewrite (the hosted fix PR) reads the manifest the
 * same way: a rewrite is core's answer only when it equals `rewriteTo`.
 */

/** The lowest version a declaration allows, at the precision of the check (major, or major.minor). */
export interface VersionFloor {
  /** `[major]` or `[major, minor]`. */
  version: number[];
  /** The bound excludes `version` itself (`>3.8`): a mention of exactly it is below the floor too. */
  exclusive: boolean;
}

export interface ManifestVersionReading {
  /** The least restrictive floor of every declaration read. */
  floor: VersionFloor;
  /** How the floor reads in a title: `≥3.11`, `>3.8`. */
  label: string;
  /** The version the main source declares (its floor), for wording; the floor's when there is none. */
  declared: number[];
  /**
   * What a rewrite may write: set only when a main source declares it, every declaration (extras
   * and peer ranges included) has the same inclusive floor, and none was unreadable.
   */
  rewriteTo?: number[];
}

interface Declaration {
  floor: VersionFloor;
  rewritable: boolean;
}

/** A source that names the package with a spec this file cannot read: it blocks a rewrite. */
const UNREADABLE = null;
type Read = Declaration | typeof UNREADABLE;

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Negative when floor `a` allows more than `b` (lower, or equal and inclusive). */
function compareFloors(a: VersionFloor, b: VersionFloor): number {
  return compareVersions(a.version, b.version) || Number(a.exclusive) - Number(b.exclusive);
}

/** Is `mention` (same precision as the floor) below the floor? */
export function isBelowFloor(mention: number[], floor: VersionFloor): boolean {
  const d = compareVersions(mention, floor.version);
  return d < 0 || (d === 0 && floor.exclusive);
}

export function formatVersion(version: number[]): string {
  return version.join('.');
}

const COMPARATOR_RE =
  /^(~=|===|==|!=|>=|<=|>|<|\^|~>|~|=)?v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:\.\d+)*(?:[-+.]?[0-9A-Za-z][0-9A-Za-z.+-]*)?$/;

/**
 * The floor of one version spec, npm (semver ranges) or PEP 440 / Poetry, at `precision` components.
 * Null when a part of it is not a version comparator, or when it has no lower bound at all
 * (`*`, `<2`): an upper bound alone does not say the project moved to anything.
 */
export function parseVersionSpec(spec: string, precision: 1 | 2): Declaration | null {
  const trimmed = spec.trim();
  if (trimmed === '') return null;
  let lowest: Declaration | null = null;
  for (const alternative of trimmed.split(/\|\|?/)) {
    const normalized = alternative
      .trim()
      .replace(/^\((.*)\)$/, '$1')
      // npm hyphen range "18 - 20" is ">=18 <=20".
      .replace(/^(\S+)\s+-\s+(\S+)$/, '>=$1 <=$2')
      .replace(/(~=|===|==|!=|>=|<=|>|<|\^|~>|~|=)\s+/g, '$1');
    const comparators = normalized.split(/[\s,]+/).filter((c) => c !== '');
    if (comparators.length === 0) return null;
    let bound: Declaration | null = null;
    for (const comparator of comparators) {
      const m = COMPARATOR_RE.exec(comparator);
      if (!m) return null;
      const op = m[1] ?? '';
      if (op === '<' || op === '<=' || op === '!=') continue;
      const parts: number[] = [];
      for (const part of [m[2], m[3], m[4]]) {
        if (part === undefined || !/^\d+$/.test(part)) break;
        parts.push(parseInt(part, 10));
      }
      if (parts.length === 0) continue; // "*", "x": no lower bound
      const version = Array.from({ length: precision }, (_, i) => parts[i] ?? 0);
      let candidate: Declaration;
      if (op === '>') {
        // ">18" (npm: >=19.0.0) and ">3.8" (PEP 440 lets 3.8.1 through, but the author excluded 3.8)
        // both exclude the named version at this precision; ">18.2" only says "18 or later".
        candidate = { floor: { version, exclusive: parts.length <= precision }, rewritable: false };
      } else {
        candidate = { floor: { version, exclusive: false }, rewritable: parts.length >= precision };
      }
      if (bound === null || compareFloors(candidate.floor, bound.floor) > 0) bound = candidate;
    }
    if (bound === null) return null; // this alternative has no lower bound, so neither does the spec
    if (lowest === null) {
      lowest = bound;
    } else {
      const d = compareFloors(bound.floor, lowest.floor);
      const rewritable: boolean = lowest.rewritable && bound.rewritable && d === 0;
      lowest = { floor: d < 0 ? bound.floor : lowest.floor, rewritable };
    }
  }
  return lowest;
}

/**
 * One reading from declarations in tiers of trust: `tiers[0]` states what the project runs, later
 * tiers only what it claims to support. Null when nothing readable declares it.
 */
function readTiers(tiers: Read[][]): ManifestVersionReading | null {
  const readable = tiers.flat().filter((d): d is Declaration => d !== UNREADABLE);
  if (readable.length === 0) return null;
  const least = (ds: Declaration[]) => ds.reduce((a, b) => (compareFloors(b.floor, a.floor) < 0 ? b : a)).floor;
  const floor = least(readable);
  const main = tiers[0]!.filter((d): d is Declaration => d !== UNREADABLE);
  const agreed =
    main.length > 0 &&
    tiers.every((tier) => tier.every((d) => d !== UNREADABLE && d.rewritable && compareFloors(d.floor, floor) === 0));
  return {
    floor,
    label: (floor.exclusive ? '>' : '≥') + formatVersion(floor.version),
    declared: (main.length > 0 ? least(main) : floor).version,
    ...(agreed ? { rewriteTo: floor.version } : {}),
  };
}

/** A declared spec: its floor, or UNREADABLE when present but not a readable range. */
function declaration(spec: unknown, precision: 1 | 2): Read {
  if (typeof spec !== 'string') return UNREADABLE;
  return parseVersionSpec(spec, precision);
}

// ── package.json ──────────────────────────────────────────────────────────────

function jsonObject(content: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(content);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function block(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = obj[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** `engines.node` as a major-version reading. */
export function readNodeEngineVersion(enginesNode: string | undefined): ManifestVersionReading | null {
  if (enginesNode === undefined) return null;
  return readTiers([[parseVersionSpec(enginesNode, 1)]]);
}

/** A package's major in package.json: dependencies and devDependencies over peerDependencies. */
export function readJsLibraryVersion(packageJsonContent: string, packageName: string): ManifestVersionReading | null {
  const obj = jsonObject(packageJsonContent);
  if (!obj) return null;
  const tier = (keys: string[]): Read[] =>
    keys.flatMap((key) => (Object.hasOwn(block(obj, key), packageName) ? [declaration(block(obj, key)[packageName], 1)] : []));
  return readTiers([tier(['dependencies', 'devDependencies']), tier(['peerDependencies'])]);
}

// ── pyproject.toml ────────────────────────────────────────────────────────────

interface Table {
  name: string;
  start: number;
  end: number;
}

/** Top-level tables of a TOML file by name, with body offsets. Content before any header is table "". */
function tomlTables(content: string): Table[] {
  const tables: Table[] = [];
  const header = /^[ \t]*\[\[?[ \t]*([A-Za-z0-9_.\-"' \t]+?)[ \t]*\]\]?[ \t]*(?:#.*)?$/gm;
  let current: Table = { name: '', start: 0, end: content.length };
  let m: RegExpExecArray | null;
  while ((m = header.exec(content)) !== null) {
    current.end = m.index;
    tables.push(current);
    current = { name: m[1]!.replace(/["'\s]/g, ''), start: m.index + m[0].length, end: content.length };
  }
  tables.push(current);
  return tables;
}

/** The span of the array value of `key = [ ... ]` inside `table`, string-aware. */
function arraySpan(content: string, table: Table, key: string): [number, number] | null {
  const body = content.slice(table.start, table.end);
  const m = new RegExp(`^[ \\t]*["']?${key}["']?[ \\t]*=[ \\t]*\\[`, 'm').exec(body);
  if (!m) return null;
  const open = table.start + m.index + m[0].length - 1;
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < table.end; i++) {
    const ch = content[i]!;
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#') {
      const nl = content.indexOf('\n', i);
      i = nl === -1 ? table.end : nl;
    } else if (ch === '[') {
      depth++;
    } else if (ch === ']') {
      depth--;
      if (depth === 0) return [open, i + 1];
    }
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The `python` or library key of a Poetry table line: a string, or an inline table's `version`. */
function poetryKeyRe(name: string): RegExp {
  return new RegExp(
    `^[ \\t]*["']?${escapeRegExp(name)}["']?[ \\t]*=[ \\t]*(?:["']([^"']*)["']|(\\{[^\\n}]*\\}))`,
    'gim',
  );
}

function inlineVersion(inline: string): string | undefined {
  return /\bversion[ \t]*=[ \t]*["']([^"']*)["']/.exec(inline)?.[1];
}

/** Requires-python and Poetry's `python` constraint, as a major.minor reading. */
export function readPythonVersion(pyprojectContent: string): ManifestVersionReading | null {
  const tables = tomlTables(pyprojectContent);
  const decls: Read[] = [];
  for (const table of tables) {
    const body = pyprojectContent.slice(table.start, table.end);
    if (table.name === 'project' || table.name === '') {
      const m = /^[ \t]*requires-python[ \t]*=[ \t]*["']([^"']*)["']/m.exec(body);
      if (m) decls.push(parseVersionSpec(m[1]!, 2));
    }
    if (table.name === 'tool.poetry.dependencies' || table.name === '') {
      const m = poetryKeyRe('python').exec(body);
      if (m) decls.push(parseVersionSpec(m[1] ?? inlineVersion(m[2] ?? '') ?? '', 2));
    }
  }
  return readTiers([decls]);
}

/**
 * A library's major in pyproject.toml: the main dependencies (`[project].dependencies`, and
 * `[tool.poetry.dependencies]` entries not marked optional) over any other mention of it in the
 * file (optional-dependencies, Poetry groups, dependency groups, a tool's dev list).
 */
export function readPythonLibraryVersion(pyprojectContent: string, library: string): ManifestVersionReading | null {
  const tables = tomlTables(pyprojectContent);
  const mainSpans: Array<[number, number]> = [];
  for (const table of tables) {
    if (table.name === 'project' || table.name === '') {
      const span = arraySpan(pyprojectContent, table, 'dependencies');
      if (span) mainSpans.push(span);
    }
    if (table.name === 'tool.poetry.dependencies') mainSpans.push([table.start, table.end]);
  }
  const inMain = (index: number) => mainSpans.some(([s, e]) => index >= s && index < e);
  const main: Read[] = [];
  const extras: Read[] = [];

  const poetry = poetryKeyRe(library);
  for (let m = poetry.exec(pyprojectContent); m !== null; m = poetry.exec(pyprojectContent)) {
    const optional = m[2] !== undefined && /\boptional[ \t]*=[ \t]*true\b/.test(m[2]);
    const spec = m[1] ?? (m[2] !== undefined ? inlineVersion(m[2]) : undefined);
    (inMain(m.index) && !optional ? main : extras).push(declaration(spec, 1));
  }
  // PEP 508 strings: "pandas>=2.1", "pandas[performance] (>=2.1,<3) ; python_version >= '3.9'".
  const pep508 = new RegExp(`["']${escapeRegExp(library)}(?:\\[[^\\]"']*\\])?[ \\t]*\\(?[ \\t]*([~^=<>!][^"';)]*)`, 'gi');
  for (let m = pep508.exec(pyprojectContent); m !== null; m = pep508.exec(pyprojectContent)) {
    (inMain(m.index) ? main : extras).push(declaration(m[1], 1));
  }
  return readTiers([main, extras]);
}
