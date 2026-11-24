/**
 * pcic-1ik0.24: the version a manifest declares, as the version-mismatch checks in
 * manifest-consistency.ts and their rewrite recipes (pcic-k1t3.12) read it.
 *
 * A finding needs a FLOOR: a mention below it is stale. A rewrite needs more: one version every
 * declaration agrees on, from a source that states what the project runs. When the sources
 * disagree, or the only source is a compatibility claim or an extra, the finding stays and the
 * rewrite is refused (advisory):
 *
 * - package.json: `dependencies` and `devDependencies` are what the project installs;
 *   `peerDependencies` is a range the package claims to work with: it may lower the floor (a
 *   mention it supports is not stale), never set the version (it used to win, read last).
 * - pyproject.toml: `[project].dependencies` and `[tool.poetry.dependencies]` are the main
 *   dependencies; optional-dependencies, Poetry groups and optional entries, dependency groups
 *   and uv or PDM dev lists are extras, read only when no main dependency names the library (the
 *   first line naming it anywhere in the file used to win, comments and [build-system] included).
 * - requires-python and Poetry's `python` must both hold: the floor is the higher of them, and
 *   their disagreement refuses the rewrite. Two main entries for one library may be alternatives
 *   (environment markers), so they floor at the lower.
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
 * Poetry's `^`, `~` and `||` read as npm's.
 * Null when a part of it is not a version comparator, or when it has no lower bound at all
 * (`*`, `<2`): an upper bound alone does not say the project moved to anything.
 */
export type Dialect = 'npm' | 'pep440';

export function parseVersionSpec(spec: string, precision: 1 | 2, dialect: Dialect): Declaration | null {
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
        // npm ">18" is ">=19.0.0", so it excludes 18; ">18.2" only says "18 or later". PEP 440 ">3.8"
        // lets 3.8.1 through, but on an interpreter line the author means "not 3.8", so it excludes
        // 3.8 too; a library's ">2" admits 2.1, so at major precision it excludes nothing.
        const exclusive = parts.length <= precision && (dialect === 'npm' || precision === 2);
        candidate = { floor: { version, exclusive }, rewritable: false };
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
 * One reading from what a manifest declares. `main` states what the project runs. When several
 * main declarations must all hold (`allHold`: requires-python and Poetry's `python`) the floor is
 * the highest of them; otherwise they may be alternatives (a library listed twice under different
 * environment markers, or in both dependencies and devDependencies) and the floor is the lowest.
 * `support` is a range the project claims to work
 * with (a peer range): it may lower the floor, never set the version. `fallback` (a pyproject.toml
 * extra) is read only when no main source declares it. Null when nothing readable declares it.
 */
function readDeclarations(
  main: Read[],
  { support = [], fallback = [], allHold = false }: { support?: Read[]; fallback?: Read[]; allHold?: boolean } = {},
): ManifestVersionReading | null {
  const readable = (ds: Read[]) => ds.filter((d): d is Declaration => d !== UNREADABLE);
  const least = (ds: Declaration[]) => ds.reduce((a, b) => (compareFloors(b.floor, a.floor) < 0 ? b : a)).floor;
  const most = (ds: Declaration[]) => ds.reduce((a, b) => (compareFloors(b.floor, a.floor) > 0 ? b : a)).floor;
  const mains = readable(main);
  const claims = readable(support);
  const extras = readable(fallback);
  let floor: VersionFloor;
  if (mains.length > 0) {
    floor = allHold ? most(mains) : least(mains);
    if (claims.length > 0) floor = least([{ floor, rewritable: false }, ...claims]);
  } else if (claims.length > 0 || extras.length > 0) {
    floor = least([...claims, ...extras]);
  } else {
    return null;
  }
  const agreed =
    mains.length > 0 &&
    [...main, ...support, ...fallback].every((d) => d !== UNREADABLE && d.rewritable && compareFloors(d.floor, floor) === 0);
  return {
    floor,
    label: (floor.exclusive ? '>' : '≥') + formatVersion(floor.version),
    declared: (mains.length > 0 ? (allHold ? most(mains) : least(mains)) : floor).version,
    ...(agreed ? { rewriteTo: floor.version } : {}),
  };
}

/** A declared spec: its floor, or UNREADABLE when present but not a readable range. */
function declaration(spec: unknown, dialect: Dialect): Read {
  if (typeof spec !== 'string') return UNREADABLE;
  return parseVersionSpec(spec, 1, dialect);
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
  return readDeclarations([parseVersionSpec(enginesNode, 1, 'npm')]);
}

/** A package's major in package.json: dependencies and devDependencies over peerDependencies. */
export function readJsLibraryVersion(packageJsonContent: string, packageName: string): ManifestVersionReading | null {
  const obj = jsonObject(packageJsonContent);
  if (!obj) return null;
  const declared = (keys: string[]): Read[] =>
    keys.flatMap((key) => (Object.hasOwn(block(obj, key), packageName) ? [declaration(block(obj, key)[packageName], 'npm')] : []));
  return readDeclarations(declared(['dependencies', 'devDependencies']), { support: declared(['peerDependencies']) });
}

// ── pyproject.toml ────────────────────────────────────────────────────────────

interface Table {
  name: string;
  start: number;
  end: number;
}

/**
 * The file with every comment blanked to spaces, so offsets still line up and a commented-out
 * dependency is never read. Strings are skipped (a "#" inside one is not a comment).
 */
function blankComments(content: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;
    if (quote) {
      if (ch === '\\' && quote === '"') {
        out += ch + (content[i + 1] ?? '');
        i++;
        continue;
      }
      if (ch === quote || ch === '\n') quote = null;
      out += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
    } else if (ch === '#') {
      while (i < content.length && content[i] !== '\n' && content[i] !== '\r') {
        out += ' ';
        i++;
      }
      i--;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Top-level tables of a TOML file by name, with body offsets. Content before any header is table "". */
function tomlTables(content: string): Table[] {
  const tables: Table[] = [];
  const header = /^[ \t]*\[\[?[ \t]*((?:[A-Za-z0-9_.\- \t]|"[^"\n]*"|'[^'\n]*')+?)[ \t]*\]\]?[ \t]*$/gm;
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

/** The span of the array value of `key = [ ... ]` inside `table` (comments already blanked). */
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
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
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

/** Poetry's main dependency table, under either of its names. */
function isPoetryMainTable(name: string): boolean {
  return name === 'tool.poetry.dependencies' || name === 'tool.poetry.group.main.dependencies';
}

/** Tables whose entries are a pyproject.toml extra: optional, a dependency group, a dev list. */
const EXTRA_TABLE_RE =
  /^(?:project\.optional-dependencies|dependency-groups|tool\.poetry\.group\.[^.]+\.dependencies|tool\.poetry\.dev-dependencies|tool\.uv|tool\.pdm\.dev-dependencies)$/;

/** Requires-python and Poetry's `python` constraint, as a major.minor reading. Both must hold. */
export function readPythonVersion(pyprojectContent: string): ManifestVersionReading | null {
  const content = blankComments(pyprojectContent);
  const decls: Read[] = [];
  for (const table of tomlTables(content)) {
    const body = content.slice(table.start, table.end);
    if (table.name === 'project' || table.name === '') {
      const m = /^[ \t]*requires-python[ \t]*=[ \t]*["']([^"']*)["']/m.exec(body);
      if (m) decls.push(parseVersionSpec(m[1]!, 2, 'pep440'));
    }
    if (isPoetryMainTable(table.name) || table.name === '') {
      const m = poetryKeyRe('python').exec(body);
      if (m) decls.push(parseVersionSpec(m[1] ?? inlineVersion(m[2] ?? '') ?? '', 2, 'pep440'));
    }
  }
  return readDeclarations(decls, { allHold: true });
}

/**
 * A library's major in pyproject.toml: the main dependencies (`[project].dependencies`, and
 * Poetry's main table, entries marked optional aside) over the extras (optional-dependencies,
 * Poetry groups and optional entries, dependency groups, a uv or PDM dev list), which are read only
 * when no main dependency names it. A mention anywhere else ([build-system], a tool's own table) is
 * not the project's version and is not read.
 */
export function readPythonLibraryVersion(pyprojectContent: string, library: string): ManifestVersionReading | null {
  const content = blankComments(pyprojectContent);
  const tables = tomlTables(content);
  const mainSpans: Array<[number, number]> = [];
  for (const table of tables) {
    if (table.name === 'project' || table.name === '') {
      const span = arraySpan(content, table, 'dependencies');
      if (span) mainSpans.push(span);
    }
    if (isPoetryMainTable(table.name)) mainSpans.push([table.start, table.end]);
  }
  const inMain = (index: number) => mainSpans.some(([s, e]) => index >= s && index < e);
  const inExtra = (index: number) => {
    const table = tables.find((t) => index >= t.start && index < t.end);
    return table !== undefined && EXTRA_TABLE_RE.test(table.name);
  };
  const main: Read[] = [];
  const extras: Read[] = [];
  const sort = (index: number, read: Read, optional = false) => {
    if (inMain(index) && !optional) main.push(read);
    else if (inMain(index) || inExtra(index)) extras.push(read);
  };

  const poetry = poetryKeyRe(library);
  for (let m = poetry.exec(content); m !== null; m = poetry.exec(content)) {
    const optional = m[2] !== undefined && /\boptional[ \t]*=[ \t]*true\b/.test(m[2]);
    const spec = m[1] ?? (m[2] !== undefined ? inlineVersion(m[2]) : undefined);
    sort(m.index, declaration(spec, 'pep440'), optional);
  }
  // PEP 508 strings: "pandas>=2.1", "pandas[performance] (>=2.1,<3) ; python_version >= '3.9'".
  const pep508 = new RegExp(`["']${escapeRegExp(library)}(?:\\[[^\\]"']*\\])?[ \\t]*\\(?[ \\t]*([~^=<>!][^"';)]*)`, 'gi');
  for (let m = pep508.exec(content); m !== null; m = pep508.exec(content)) {
    sort(m.index, declaration(m[1], 'pep440'));
  }
  return readDeclarations(main, { fallback: extras });
}
