/**
 * Discovery lists and a pure path-based discovery API (pcic-zg3).
 *
 * `scanner.ts` (instruction files), `ai-config.ts` (skills, settings, MCP) and
 * `repo-context.ts` (workflows / composite actions) each discover a different
 * class of file from the real filesystem with `fast-glob`. The constants and
 * predicates that decide WHAT belongs to each class live here, once, so those
 * three modules import them instead of keeping their own copies — two
 * modules can no longer drift apart on what counts as, say, a skill location.
 *
 * `selectScanPaths` is the filesystem-free counterpart: given a plain list of
 * repo-relative paths (as a server with only a GitHub tree listing has, not a
 * checkout), it applies the exact same patterns, `include`/`exclude` policy,
 * and caps to answer what a real scan would read, without ever touching disk.
 * It applies scanner.ts's MAX_FILE_SIZE guard to instruction files and
 * composite actions when a caller supplies `size` (there is nothing to check
 * without it); it never applies the binary-content guard, since there are no
 * bytes here to sniff.
 */

import micromatch from 'micromatch';

// ── Shared size guard (scanner.ts) ───────────────────────────────────────────

/** Files larger than this are skipped before they are ever read (scanner.ts). */
export const MAX_FILE_SIZE = 500 * 1024;
/** Bytes sniffed for a NUL byte when deciding whether a file is binary (scanner.ts). */
export const BINARY_CHECK_BYTES = 512;

// ── Instruction files (scanner.ts) ────────────────────────────────────────────

/** Default glob patterns scanner.ts reads when no `include` override is given. */
export const DEFAULT_INSTRUCTION_PATTERNS: readonly string[] = [
  // Core AI instruction files
  'CLAUDE.md',
  'AGENTS.md',
  '.cursorrules',
  '.windsurfrules',
  // Gemini CLI. Root only, like CLAUDE.md/AGENTS.md above.
  'GEMINI.md',
  // Cline: a single `.clinerules` file OR a `.clinerules/` directory of
  // markdown rule files.
  '.clinerules',
  '.clinerules/**/*.md',
  '!.clinerules/workflows/**',
  // Agent persona files (SOUL.md, USER.md, TOOLS.md). Repo ROOT only.
  'SOUL.md',
  'USER.md',
  'TOOLS.md',
  // Cursor IDE rules
  '.cursor/rules/**',
  // GitHub Copilot instructions (legacy + new per-file format)
  '.github/copilot-instructions.md',
  '.github/instructions/**/*.md',
  // Claude memory / settings directory
  '.claude/**/*.md',
  // README is often the only context file in small repos
  'README.md',
  'QA.md',
  'CONTRIBUTING.md',
  'ARCHITECTURE.md',
  'DEVELOPMENT.md',
  'CODING_STANDARDS.md',
  'CONVENTIONS.md',
  'GUIDELINES.md',
  // Explicit AI/prompt directories only — not generic docs/
  'ai/**/*.md',
  'ai-instructions/**/*.md',
  'prompts/**/*.md',
  'system-prompts/**/*.md',
];

/** The `.clinerules/` directory globs, dropped when `.clinerules` is a file (see scanner.ts). */
const CLINE_DIR_PATTERNS: ReadonlySet<string> = new Set([
  '.clinerules/**/*.md',
  '!.clinerules/workflows/**',
]);

/** `DEFAULT_INSTRUCTION_PATTERNS`, minus the `.clinerules/` directory globs when it is a file. */
export function defaultInstructionPatterns(clineIsDir: boolean): readonly string[] {
  return clineIsDir
    ? DEFAULT_INSTRUCTION_PATTERNS
    : DEFAULT_INSTRUCTION_PATTERNS.filter((p) => !CLINE_DIR_PATTERNS.has(p));
}

/** Directory names scanner.ts's default scan ignores at any depth. */
export const SCAN_IGNORE_DIRS: readonly string[] = [
  '.git', 'node_modules', 'Library', 'Temp', 'bin', 'obj', 'dist', 'build', 'worktrees', '.worktrees',
];

// ── Skills, settings, MCP (ai-config.ts) ──────────────────────────────────────

/**
 * Every location an Agent Skill is installed from. The root-level globs are
 * anchored on purpose: a `**\/skills/**` glob would also sweep up vendored
 * copies and test fixtures.
 */
export const SKILL_GLOBS: readonly string[] = [
  '.claude/**/SKILL.md',
  '.agents/skills/**/SKILL.md',
  'skills/*/SKILL.md',
  'plugins/*/skills/*/SKILL.md',
];

/** Non-markdown config surfaces ai-config.ts discovers and whose content a detector reports on. */
export const AI_CONFIG_EXACT_FILES: readonly string[] = [
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.mcp.json',
];

/** Directory names discovery for skills/agents/settings/mcp/cursor-rules ignores. */
export const DISCOVERY_IGNORE_DIRS: readonly string[] = [
  'node_modules', '.git', 'dist', 'build', 'worktrees', '.worktrees',
];

/**
 * Exact repo-relative directories that hold skills rather than being one — a
 * SKILL.md sitting directly in one of them owns no bundle of its own.
 */
export const SKILL_CONTAINER_DIRS: ReadonlySet<string> = new Set([
  '.', '.claude', '.agents', '.claude/skills', '.agents/skills', '.claude/plugins', 'skills', 'plugins',
]);

export function isSkillContainerDir(dir: string): boolean {
  return SKILL_CONTAINER_DIRS.has(dir);
}

/** Directories inside a skill that are not walked for bundled files. */
export const BUNDLE_SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git', 'worktrees', '.worktrees']);

/** Upper bound on bundled files read per skill. */
export const MAX_BUNDLED_FILES_PER_SKILL = 200;
/** Directory entries visited per skill before the (real, filesystem) walk stops. */
export const MAX_BUNDLE_LISTING = 20_000;
/** Dependency package manifests read per skill (per `node_modules/` found, and in total). */
export const MAX_DEPENDENCY_MANIFESTS = 100;

/**
 * Scripts, executables, manifests, shell-like config and extensionless files:
 * listed (and scanned) before documents.
 */
const PRIORITY_BUNDLE_RE = new RegExp(
  String.raw`(?:^|\/)(?:[^/.]+|package\.json|requirements[^/]{0,40}\.txt|(?:GNU)?makefile|Dockerfile[^/]{0,40}|Containerfile|Justfile)$|` +
  String.raw`\.(?:sh|bash|zsh|ksh|fish|command|js|mjs|cjs|ts|mts|cts|jsx|tsx|py|pyw|rb|ps1|psm1|pl|php|lua|bat|cmd|mk|` +
  String.raw`vbs|vba|vbe|hta|applescript|wsf|jse|reg|exe|dll|so|dylib|wasm|jar|war|class|zip|tar|gz|tgz|bz2|xz|7z|rar|` +
  String.raw`msi|dmg|pkg|deb|rpm|appimage|apk|bin|o|a|lnk|scr|com|pif|scpt|node|env)$`,
  'i',
);

export function isPriorityBundleFile(rel: string): boolean {
  return PRIORITY_BUNDLE_RE.test(rel);
}

/**
 * Candidate `<node_modules>/<pkg>/package.json` manifests, in the order and
 * bounded the way ai-config.ts's `listPackageManifests` reads them: top-level
 * entries sorted by name (dot-prefixed ones skipped), a `@scope` entry's own
 * children sorted by name within it, capped at `cap` total. Shared between
 * that filesystem-backed reader and this module's path-only equivalent so
 * the two cannot drift on ORDER — each supplies its own `exists`/listing.
 */
export function dependencyManifestCandidates(
  topLevelNames: readonly string[],
  scopedNamesOf: (scope: string) => readonly string[],
  exists: (relPath: string) => boolean,
  nodeModulesDir: string,
  cap: number = MAX_DEPENDENCY_MANIFESTS,
): string[] {
  const out: string[] = [];
  const tryPkg = (pkgDir: string): void => {
    const manifest = `${pkgDir}/package.json`;
    if (out.length < cap && exists(manifest)) out.push(manifest);
  };
  for (const name of [...topLevelNames].sort()) {
    if (out.length >= cap) break;
    if (name.startsWith('.')) continue;
    if (name.startsWith('@')) {
      for (const scoped of [...scopedNamesOf(name)].sort()) tryPkg(`${nodeModulesDir}/${name}/${scoped}`);
    } else {
      tryPkg(`${nodeModulesDir}/${name}`);
    }
  }
  return out;
}

// ── Workflows and composite actions (repo-context.ts) ─────────────────────────

/** Composite actions: a root `action.yml` and any under `.github/actions/`. */
export const COMPOSITE_ACTION_GLOBS: readonly string[] = [
  'action.yml',
  'action.yaml',
  '.github/actions/**/action.yml',
  '.github/actions/**/action.yaml',
];

// ── Pure path-based discovery API ────────────────────────────────────────────

/** A repo-relative POSIX path, optionally carrying its blob size in bytes and whether it is a symlink. */
export type ScanPathEntry = string | { path: string; size?: number; symlink?: boolean };

export type SelectScanPathsOptions = {
  /**
   * Overrides `DEFAULT_INSTRUCTION_PATTERNS` entirely for instruction-file
   * matching — the same effect `ScanInput.include` has on a real scan. Also
   * NARROWS (intersects with) the skill, settings and MCP surfaces, exactly
   * as `discoverAiConfigFiles` does — it does not replace their own globs.
   * Never affects workflow or composite-action discovery (neither does a
   * real scan's `include`).
   */
  include?: readonly string[];
  /**
   * The same effect `ScanInput.exclude` has on a real scan: removed from
   * every class except the root-level context reads (package.json,
   * pyproject.toml, lockfile-adjacent manifests, etc.) that core itself
   * never checks `exclude` against.
   */
  exclude?: readonly string[];
};

export type SelectScanPathsResult = {
  /** Files a scan reads and reports on as always-loaded instruction prose. */
  instructionFiles: string[];
  /** `SKILL.md` files plus the files bundled alongside them. */
  skillFiles: string[];
  /** Non-markdown AI config a detector reads and reports on: Claude settings, `.mcp.json`. */
  aiConfigFiles: string[];
  /** GitHub Actions workflow files and composite `action.yml`/`action.yaml` files. */
  workflowFiles: string[];
  /** Files read for resolution (manifests, ignore files) but never reported on. */
  contextFiles: string[];
};

type NormalizedEntry = { path: string; size?: number; symlink?: boolean };

/** Strip a leading `./` and normalize backslashes, so either form of the same path collapses to one entry. */
function normalizeOnePath(p: string): string {
  let out = p.replace(/\\/g, '/');
  while (out.startsWith('./')) out = out.slice(2);
  return out;
}

/** Normalizes and de-duplicates by path (first occurrence wins). */
function normalizePaths(paths: readonly ScanPathEntry[]): NormalizedEntry[] {
  const seen = new Set<string>();
  const out: NormalizedEntry[] = [];
  for (const raw of paths) {
    const e = typeof raw === 'string' ? { path: raw } : raw;
    const path = normalizeOnePath(e.path);
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ path, size: e.size, symlink: e.symlink });
  }
  return out;
}

function hasAncestorDir(filePath: string, dirs: readonly string[]): boolean {
  const segs = filePath.split('/');
  return segs.slice(0, -1).some((seg) => dirs.includes(seg));
}

/** `dirname` for a POSIX repo-relative path, `.` for a root-level file. */
function dirOf(filePath: string): string {
  const idx = filePath.lastIndexOf('/');
  return idx < 0 ? '.' : filePath.slice(0, idx);
}

function splitNegated(patterns: readonly string[]): { positive: string[]; negative: string[] } {
  const positive: string[] = [];
  const negative: string[] = [];
  for (const p of patterns) {
    if (p.startsWith('!')) negative.push(p.slice(1));
    else positive.push(p);
  }
  return { positive, negative };
}

/**
 * fast-glob's actual pattern-array semantics (scanner.ts, ai-config.ts's
 * `listFiles`): a `!`-prefixed pattern is a GLOBAL subtraction from the union
 * of the positive patterns, regardless of where it sits in the array — unlike
 * a bare `micromatch(list, patterns)` call, which is order-sensitive (a `!`
 * pattern only subtracts from positive matches that appear earlier in the
 * same array). `extraIgnore` is an always-literal addition (scanner.ts's
 * `IGNORE_DIRS`, a caller's `exclude`).
 */
function globMatch(list: readonly string[], patterns: readonly string[], extraIgnore: readonly string[] = []): string[] {
  const { positive, negative } = splitNegated(patterns);
  if (positive.length === 0) return [];
  return micromatch(list, positive, { ignore: [...negative, ...extraIgnore], dot: true });
}

/**
 * ai-config.ts's `isExcluded` / repo-context.ts's `isExcludedPath`: true when
 * `filePath` itself, or any ancestor directory of it, matches an `exclude`
 * pattern (checked both bare and with a trailing slash, the way a directory
 * entry in `exclude` is meant to cover everything beneath it).
 */
function isAncestorExcluded(filePath: string, exclude: readonly string[]): boolean {
  if (exclude.length === 0) return false;
  const candidates = [filePath];
  const parts = filePath.split('/');
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join('/');
    candidates.push(dir, `${dir}/`);
  }
  return candidates.some((c) => micromatch.isMatch(c, [...exclude], { dot: true }));
}

/**
 * `discoverAiConfigFiles`'s `list()` narrowing: when `include` is given, the
 * candidate set is INTERSECTED with it via a single, order-sensitive
 * `micromatch` call (not `globMatch` — ai-config.ts does not give `include`
 * fast-glob's global-negation treatment, so neither does this).
 */
function narrowByInclude(list: readonly string[], include: readonly string[] | undefined): string[] {
  if (!include || include.length === 0) return [...list];
  return micromatch([...list], [...include], { dot: true });
}

function matchesInclude(path: string, include: readonly string[] | undefined): boolean {
  return !include || include.length === 0 || micromatch.isMatch(path, [...include], { dot: true });
}

const instructionIgnoreGlobs = SCAN_IGNORE_DIRS.map((d) => `**/${d}/**`);
const discoveryIgnoreGlobs = DISCOVERY_IGNORE_DIRS.map((d) => `**/${d}/**`);

function underSize(size: number | undefined): boolean {
  return size === undefined || size <= MAX_FILE_SIZE;
}

/**
 * SKILL.md files plus their bundled files, from a full path list — the pure
 * equivalent of ai-config.ts's `discoverSkillFiles` (no filesystem walk
 * needed: every candidate is already in `entries`). Symlinks are excluded
 * entirely, as `discoverSkillFiles`'s walk does.
 */
function selectSkillFiles(
  entries: readonly NormalizedEntry[],
  include: readonly string[] | undefined,
  exclude: readonly string[],
): string[] {
  const real = entries.filter((e) => !e.symlink);
  const allPaths = real.map((e) => e.path);

  const skillCandidates = globMatch(allPaths, SKILL_GLOBS, [...discoveryIgnoreGlobs, ...exclude]);
  const skillMatches = narrowByInclude(skillCandidates, include).sort();
  if (skillMatches.length === 0) return [];
  const skillSet = new Set(skillMatches);

  const skillDirs = [...new Set(
    skillMatches.map((p) => dirOf(p)).filter((dir) => !isSkillContainerDir(dir)),
  )].sort();
  const skillDirSet = new Set(skillDirs);

  const nearestSkillDir = (filePath: string): string | null => {
    const segs = filePath.split('/');
    for (let n = segs.length - 1; n >= 1; n--) {
      const dir = segs.slice(0, n).join('/');
      if (skillDirSet.has(dir)) return dir;
    }
    return null;
  };

  const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const pathSet = new Set(allPaths);
  const perSkillOwned = new Map<string, string[]>();
  const perSkillNodeModules = new Map<string, Set<string>>();

  for (const entry of real) {
    const rel = entry.path;
    if (skillSet.has(rel)) continue;
    if (rel.endsWith('/SKILL.md') || rel === 'SKILL.md') continue;
    const dir = nearestSkillDir(rel);
    if (dir === null) continue;
    // `isExcluded`'s check comes before anything else in the real walk: an
    // excluded path is never counted as owned, and never opens a node_modules
    // dir for manifest harvesting either.
    if (isAncestorExcluded(rel, exclude)) continue;

    const belowSkillDir = rel.split('/').slice(dir === '.' ? 0 : dir.split('/').length);
    const ancestors = belowSkillDir.slice(0, -1);
    const skipIdx = ancestors.findIndex((seg) => BUNDLE_SKIP_DIRS.has(seg));
    if (skipIdx !== -1) {
      if (ancestors[skipIdx] === 'node_modules') {
        const nmPath = [dir === '.' ? null : dir, ...ancestors.slice(0, skipIdx + 1)].filter(Boolean).join('/');
        const set = perSkillNodeModules.get(dir) ?? new Set<string>();
        set.add(nmPath);
        perSkillNodeModules.set(dir, set);
      }
      continue; // inside node_modules/.git/worktrees/.worktrees — not an owned bundle file
    }
    if (!matchesInclude(rel, include)) continue;
    const list = perSkillOwned.get(dir) ?? [];
    list.push(rel);
    perSkillOwned.set(dir, list);
  }

  const out = [...skillMatches];
  for (const dir of skillDirs) {
    let owned = perSkillOwned.get(dir) ?? [];
    // MAX_BUNDLE_LISTING bounds how many directory entries the real walk visits
    // before it gives up on a single skill; a flat path list has no traversal
    // order to truncate mid-walk, so the closest faithful approximation is
    // capping the candidate pool (sorted, for determinism) before priority
    // sorting and the per-skill cap apply.
    owned = owned.sort(byPath).slice(0, MAX_BUNDLE_LISTING);
    owned.sort((a, b) => Number(isPriorityBundleFile(b)) - Number(isPriorityBundleFile(a)) || byPath(a, b));
    out.push(...owned.slice(0, MAX_BUNDLED_FILES_PER_SKILL));

    const dependencyManifests: string[] = [];
    for (const nmDir of [...(perSkillNodeModules.get(dir) ?? [])].sort()) {
      const prefix = `${nmDir}/`;
      const topLevelNames = new Set<string>();
      for (const p of allPaths) {
        if (p.startsWith(prefix)) topLevelNames.add(p.slice(prefix.length).split('/')[0]!);
      }
      const scopedNamesOf = (scope: string): string[] => {
        const scopePrefix = `${nmDir}/${scope}/`;
        const names = new Set<string>();
        for (const p of allPaths) {
          if (p.startsWith(scopePrefix)) names.add(p.slice(scopePrefix.length).split('/')[0]!);
        }
        return [...names];
      };
      dependencyManifests.push(
        ...dependencyManifestCandidates(
          [...topLevelNames],
          scopedNamesOf,
          (rel) => pathSet.has(rel),
          nmDir,
        ),
      );
    }
    out.push(...dependencyManifests.sort().slice(0, MAX_DEPENDENCY_MANIFESTS));
  }
  return out.sort(byPath);
}

function selectAiConfigFiles(
  allPaths: readonly string[],
  include: readonly string[] | undefined,
  exclude: readonly string[],
): string[] {
  const matches = globMatch(allPaths, AI_CONFIG_EXACT_FILES, [...discoveryIgnoreGlobs, ...exclude]);
  return narrowByInclude(matches, include).sort();
}

function selectWorkflowFiles(
  entries: readonly NormalizedEntry[],
  exclude: readonly string[],
): string[] {
  const real = entries.filter((e) => !e.symlink);
  const paths = real.map((e) => e.path);
  const sizeOf = new Map(real.map((e) => [e.path, e.size] as const));

  // `context.workflows.files` lists every workflow file unconditionally — no
  // exclude, no size cap (only reading its CONTENT into `sources` is gated).
  const workflows = paths.filter(
    (p) => p.startsWith('.github/workflows/') && p.split('/').length === 3 && /\.ya?ml$/i.test(p),
  );

  // Composite actions: `listFiles`'s own DISCOVERY_IGNORE_DIRS, then
  // `isExcludedPath`, then the same MAX_FILE_SIZE guard every read applies
  // (repo-context.ts's `readCompositeActionSources` always checks it).
  const composites = globMatch(paths, COMPOSITE_ACTION_GLOBS, discoveryIgnoreGlobs)
    .filter((p) => !isAncestorExcluded(p, exclude))
    .filter((p) => underSize(sizeOf.get(p)));

  return [...new Set([...workflows, ...composites])].sort();
}

/** Root names GNU make looks up when no `-f` is given. */
const ROOT_MAKEFILE_NAMES: readonly string[] = ['GNUmakefile', 'makefile', 'Makefile'];

/** Root manifests read for cross-referencing (version/script checks), never scanned as prose. */
const ROOT_MANIFEST_NAMES: readonly string[] = ['package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml'];

/** Directory names workspace-manifests.ts's own nested-package.json discovery ignores. */
const WORKSPACE_MANIFEST_IGNORE_DIRS: readonly string[] = ['node_modules', '.git'];
/** Workspace package manifests read per scan (workspace-manifests.ts's own cap). */
const MAX_WORKSPACE_MANIFESTS = 200;

/** tsconfig/jsconfig/deno configs dependency-staleness.ts reads at the root and at each manifest's directory. */
const NESTED_CONFIG_NAMES: readonly string[] = ['tsconfig.json', 'jsconfig.json', 'deno.json', 'deno.jsonc'];

function selectContextFiles(
  paths: readonly string[],
  skillFiles: ReadonlySet<string>,
  exclude: readonly string[],
): string[] {
  const pathSet = new Set(paths);
  const out = new Set<string>();

  // Root-level reads core never checks `exclude` against.
  for (const p of paths) {
    if (p === '.gitignore' || p === 'pnpm-workspace.yaml') out.add(p);
    else if (ROOT_MANIFEST_NAMES.includes(p)) out.add(p);
    else if (p === '.promptci/config.json' || p === '.promptci/custom-rules.json') out.add(p);
  }
  // frameworks/dotnet.ts reads exactly one root `.csproj` (the first, sorted).
  const rootCsproj = paths.filter((p) => !p.includes('/') && p.endsWith('.csproj')).sort()[0];
  if (rootCsproj !== undefined) out.add(rootCsproj);

  // Makefile/GNUmakefile/makefile at any depth outside the scan's ignore dirs:
  // `make -C dir` / `cd dir && make` makes a non-root one reachable, and WHICH
  // one core actually opens is content-dependent (it follows an instruction
  // file's documented command) — every candidate name is listed instead of
  // guessing which directory a command points at.
  for (const p of paths) {
    const base = p.slice(p.lastIndexOf('/') + 1);
    if (ROOT_MAKEFILE_NAMES.includes(base) && !hasAncestorDir(p, SCAN_IGNORE_DIRS)) out.add(p);
  }

  // Nested .gitignore files, outside the directories the scan ignores wholesale.
  for (const p of paths) {
    if (p !== '.gitignore' && p.endsWith('/.gitignore') && !hasAncestorDir(p, SCAN_IGNORE_DIRS)) out.add(p);
  }

  // Nested package.json (workspace manifests): workspace-manifests.ts's own
  // discovery ignores only node_modules/.git (narrower than the scanner's own
  // ignore list) and honors `exclude`. It then resolves whichever directories
  // the root package.json's `workspaces` field or pnpm-workspace.yaml's
  // `packages:` declare — content this pure function cannot read. Every
  // nested package.json outside node_modules/.git is listed instead: a
  // superset of what any one such glob would reach, not a false negative.
  const nestedPackageJson = paths
    .filter((p) => p !== 'package.json' && p.endsWith('/package.json'))
    .filter((p) => !hasAncestorDir(p, WORKSPACE_MANIFEST_IGNORE_DIRS))
    .filter((p) => !skillFiles.has(p))
    .filter((p) => !isAncestorExcluded(p, exclude))
    .sort()
    .slice(0, MAX_WORKSPACE_MANIFESTS);
  for (const p of nestedPackageJson) out.add(p);

  // tsconfig/jsconfig/deno configs, read at the root and at each manifest dir above.
  const manifestDirs = new Set<string>(['.', ...nestedPackageJson.map((p) => dirOf(p))]);
  for (const dir of manifestDirs) {
    for (const name of NESTED_CONFIG_NAMES) {
      const candidate = dir === '.' ? name : `${dir}/${name}`;
      if (pathSet.has(candidate) && !isAncestorExcluded(candidate, exclude)) out.add(candidate);
    }
  }

  return [...out].sort();
}

/**
 * Pure counterpart to a real scan's file discovery: given a repo's full path
 * list (as a server building from GitHub's tree listing has, not a checkout),
 * returns what a scan would read, classified the way the scanner, ai_config
 * and repo-context modules classify it. Applies the same ignore dirs,
 * `include`/`exclude` policy, skill-bundle rules and caps those modules use —
 * see the module doc above.
 */
export function selectScanPaths(
  paths: readonly ScanPathEntry[],
  options?: SelectScanPathsOptions,
): SelectScanPathsResult {
  const entries = normalizePaths(paths);
  const allPaths = entries.map((e) => e.path);
  const sizeOf = new Map(entries.map((e) => [e.path, e.size] as const));
  const include = options?.include && options.include.length > 0 ? [...options.include] : undefined;
  const exclude = options?.exclude ? [...options.exclude] : [];

  const clineIsDir = allPaths.some((p) => p.startsWith('.clinerules/'));
  const instrPatterns = include ?? defaultInstructionPatterns(clineIsDir);

  const instructionFiles = globMatch(allPaths, instrPatterns, [...instructionIgnoreGlobs, ...exclude])
    .filter((p) => underSize(sizeOf.get(p)))
    .sort();

  const skillFiles = selectSkillFiles(entries, include, exclude);

  return {
    instructionFiles,
    skillFiles,
    aiConfigFiles: selectAiConfigFiles(allPaths, include, exclude),
    workflowFiles: selectWorkflowFiles(entries, exclude),
    contextFiles: selectContextFiles(allPaths, new Set(skillFiles), exclude),
  };
}
