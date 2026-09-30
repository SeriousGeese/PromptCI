/**
 * Shared support for the AI-setup config detectors (issue #23).
 *
 * These detectors audit the non-markdown surfaces of a 2026 AI setup — skills,
 * subagents, hooks/permissions, MCP servers, and Cursor rules — against
 * filesystem reality, the same way `command-validity` verifies documented
 * commands. Everything here is deterministic and offline: no network, no LLM,
 * identical output for identical input.
 *
 * This module holds the pieces every one of those detectors needs: a minimal
 * YAML-frontmatter parser, root-relative path helpers that refuse to escape the
 * repo, a stable file lister, and issue path normalization.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import fg from 'fast-glob';
import micromatch from 'micromatch';
import { MAX_FILE_SIZE, BINARY_CHECK_BYTES, isBinary } from './scanner.js';
import { resolveWithinRoot } from './path-containment.js';
import type { PromptCiIssue, ScanInput } from './types.js';

// ── Path helpers ──────────────────────────────────────────────────────────────

/** Convert a filesystem path to forward-slash form for stable, portable output. */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

// Re-exported so the many `resolveWithinRoot` importers under core keep their
// import path while the implementation lives in the shared path-containment
// module. Every filesystem read below routes through it so a hostile config
// value cannot point the detector at `/etc/passwd`.
export { resolveWithinRoot };

/** True when a repo-relative path exists and is a regular file. */
export function isFileWithinRoot(repoRoot: string, relativePath: string): boolean {
  const abs = resolveWithinRoot(repoRoot, relativePath);
  if (!abs) return false;
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

/** Read a repo-relative text file, or `undefined` if it is absent/unreadable. */
export function readTextWithinRoot(repoRoot: string, relativePath: string): string | undefined {
  const abs = resolveWithinRoot(repoRoot, relativePath);
  if (!abs) return undefined;
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Directory names excluded when discovering config files: dependency trees and
 * vendored copies whose own `.claude/` must never pollute the scan. This is a
 * *discovery* policy — do not reuse it to answer "does glob X match anything in
 * the repo" (see detectCursorRules, which needs `dist/`/`build/` visible).
 */
const DISCOVERY_IGNORE = [
  '**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**',
  '**/worktrees/**', '**/.worktrees/**',
];

/**
 * List files under `repoRoot` matching `patterns`, returned as repo-relative
 * POSIX paths in sorted order. Dotfiles are included (these configs all live in
 * dot-directories). Pass `ignore` to override the default discovery excludes.
 */
export function listFiles(repoRoot: string, patterns: string[], ignore: string[] = DISCOVERY_IGNORE): string[] {
  let matches: string[];
  try {
    matches = fg.sync(patterns, {
      cwd: repoRoot,
      dot: true,
      onlyFiles: true,
      followSymbolicLinks: false,
      ignore,
    });
  } catch {
    return [];
  }
  return matches.map(toPosix).sort();
}

// ── Config-file discovery ─────────────────────────────────────────────────────

/**
 * Every location an Agent Skill is installed from: the `.claude/` skills, the
 * cross-tool `.agents/skills/` layout, and a Claude Code plugin's (or plugin
 * marketplace's) root-level `skills/<name>/SKILL.md`. The root-level globs are
 * anchored on purpose: a `**\/skills/**` glob would also sweep up vendored
 * copies and test fixtures.
 */
const SKILL_GLOBS = [
  '.claude/**/SKILL.md',
  '.agents/skills/**/SKILL.md',
  'skills/*/SKILL.md',
  'plugins/*/skills/*/SKILL.md',
] as const;

/** Repo-relative globs for each config surface the ai_config detectors audit. */
const AI_CONFIG_GLOBS = {
  // The structural skills detector audits the same locations the supply-chain
  // scan reads (it used to stop at `.claude/`, so `.agents/skills/` and plugin
  // skills never got frontmatter, description or dead-reference checks).
  skills: SKILL_GLOBS,
  allSkills: SKILL_GLOBS,
  agents: ['.claude/agents/**/*.md'],
  settings: ['.claude/settings.json', '.claude/settings.local.json'],
  mcp: ['.mcp.json'],
  cursorRules: ['.cursor/rules/**/*.mdc'],
  // GitHub Copilot per-file instructions. The legacy single-file
  // `.github/copilot-instructions.md` has no `applyTo` support, so it is NOT
  // discovered here — only the per-file format under `.github/instructions/`.
  copilotInstructions: ['.github/instructions/**/*.md'],
} as const;

/** Pre-discovered config files per surface, as sorted repo-relative POSIX paths. */
export type AiConfigFiles = {
  /**
   * Agent Skills audited structurally by the skills detector, in every
   * supported skill location: `.claude/**\/SKILL.md`, `.agents/skills/**`,
   * plugin `skills/*` and marketplace `plugins/*\/skills/*`. Subject to the
   * size/binary guards.
   */
  skills: string[];
  /**
   * Every SKILL.md in the same locations as `skills`, read by the skill
   * supply-chain scan. Honors include/exclude but NOT the size/binary guards:
   * the supply-chain scan must see — and report — an oversized or NUL-bearing
   * SKILL.md rather than silently lose the skill.
   * Optional so hand-built contexts from older releases keep working.
   */
  allSkills?: string[];
  /**
   * Files bundled alongside a skill in `allSkills` (scripts, references,
   * manifests): every file under the skill's directory except SKILL.md files,
   * include/exclude applied, capped per skill BEFORE any file I/O. Read as text
   * by the supply-chain scan — never executed. Optional (see `allSkills`).
   */
  skillFiles?: string[];
  /** Bundled files dropped by the per-skill cap — reported, never silently lost. */
  skillFilesOverCap?: string[];
  /**
   * Parts of a skill bundle the listing did not enumerate, so the supply-chain
   * scan can name them: dependency/VCS directories, files an `include` config
   * left out, and bundles too large to list.
   */
  skillBundleSkips?: SkillBundleSkip[];
  /** Subagent definitions: `.claude/agents/**\/*.md`. */
  agents: string[];
  /** Claude Code settings: `.claude/settings.json` and `.claude/settings.local.json`. */
  settings: string[];
  /** Project MCP servers: `.mcp.json`. */
  mcp: string[];
  /** Cursor project rules: `.cursor/rules/**\/*.mdc`. */
  cursorRules: string[];
  /** GitHub Copilot per-file instructions: `.github/instructions/**\/*.md`. */
  copilotInstructions: string[];
};

export type SkillBundleSkip = {
  /** Repo-relative path: the skipped directory, or the skill directory for counts. */
  path: string;
  kind: 'dependency-dir' | 'include' | 'listing-limit';
  /** Files affected, when known. */
  count?: number;
};

/** An AiConfigFiles with every surface empty — for contexts built without discovery. */
export function emptyAiConfigFiles(): AiConfigFiles {
  return {
    skills: [], allSkills: [], skillFiles: [], skillFilesOverCap: [], skillBundleSkips: [],
    agents: [], settings: [], mcp: [], cursorRules: [], copilotInstructions: [],
  };
}

/**
 * Exact repo-relative directories that hold skills rather than being one. A
 * SKILL.md sitting directly in one of them is not a skill directory of its own
 * — enumerating "its" bundle would sweep in the whole `.claude/` tree — so
 * bundled-file discovery skips it. Compared as exact paths, never basenames: a
 * skill that is itself NAMED `skills` (`.claude/skills/skills/`) is a real skill
 * whose scripts must be scanned.
 */
const SKILL_CONTAINER_DIRS: ReadonlySet<string> = new Set([
  '.', '.claude', '.agents', '.claude/skills', '.agents/skills', '.claude/plugins', 'skills', 'plugins',
]);

export function isSkillContainerDir(dir: string): boolean {
  return SKILL_CONTAINER_DIRS.has(dir);
}

/** Upper bound on bundled files read per skill, so one huge skill cannot stall a scan. */
export const MAX_BUNDLED_FILES_PER_SKILL = 200;
/** Directory entries visited per skill before the listing stops (and says so). */
const MAX_BUNDLE_LISTING = 20_000;
/** Over-cap file names kept for reporting; the rest are counted. */
const MAX_OVER_CAP_NAMES = 1_000;
/**
 * Directories inside a skill that are not walked but ARE reported: dependency
 * trees and VCS/worktree copies (a locally installed `node_modules` would
 * otherwise flood the scan with third-party code). Build output (`dist/`,
 * `build/`) IS walked — inside a skill it is shipped, executable content.
 */
const BUNDLE_SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git', 'worktrees', '.worktrees']);

/** Dependency package manifests read per skill. */
const MAX_DEPENDENCY_MANIFESTS = 100;

/**
 * Scripts, executables, manifests, shell-like config and extensionless files:
 * listed (and scanned) before documents. Mirrors the supply-chain detector's
 * priority classes by name, without any file I/O.
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

/** `node_modules/<pkg>/package.json` and `node_modules/@scope/<pkg>/package.json`, bounded. */
function listPackageManifests(repoRoot: string, nodeModules: string): string[] {
  const out: string[] = [];
  const read = (rel: string): fs.Dirent[] => {
    const abs = resolveWithinRoot(repoRoot, rel);
    if (!abs) return [];
    try { return fs.readdirSync(abs, { withFileTypes: true }); } catch { return []; }
  };
  const tryPkg = (pkgDir: string) => {
    const manifest = `${pkgDir}/package.json`;
    if (out.length < MAX_DEPENDENCY_MANIFESTS && isFileWithinRoot(repoRoot, manifest)) out.push(manifest);
  };
  for (const entry of read(nodeModules).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (out.length >= MAX_DEPENDENCY_MANIFESTS) break;
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (entry.name.startsWith('@')) {
      for (const scoped of read(`${nodeModules}/${entry.name}`).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (scoped.isDirectory()) tryPkg(`${nodeModules}/${entry.name}/${scoped.name}`);
      }
    } else {
      tryPkg(`${nodeModules}/${entry.name}`);
    }
  }
  return out;
}

/** True when `rel` or any ancestor directory matches an `exclude` pattern (glob-ignore semantics). */
function isExcluded(rel: string, exclude: string[]): boolean {
  if (exclude.length === 0) return false;
  const parts = rel.split('/');
  const candidates = [rel];
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join('/');
    candidates.push(dir, `${dir}/`);
  }
  return candidates.some((c) => micromatch.isMatch(c, exclude, { dot: true }));
}

/**
 * Enumerate the files bundled with each skill with a bounded, deterministic
 * directory walk: everything under the SKILL.md's directory, minus SKILL.md
 * files and anything owned by a nested skill (a file belongs to its nearest
 * enclosing skill directory). Symlinks are not followed. `exclude` always
 * applies; files an `include` list leaves out are counted and reported. The
 * per-skill cap is applied here, before any file is opened, and everything it
 * drops is reported — nothing in a bundle disappears silently.
 */
function discoverSkillFiles(
  repoRoot: string,
  skills: string[],
  policy: { include?: string[]; exclude: string[] },
): { files: string[]; overCap: string[]; skips: SkillBundleSkip[] } {
  const skillDirs = [...new Set(
    skills.map((s) => path.posix.dirname(s)).filter((dir) => !isSkillContainerDir(dir)),
  )].sort();
  const skillDirSet = new Set(skillDirs);
  const files: string[] = [];
  const overCap: string[] = [];
  const skips: SkillBundleSkip[] = [];

  for (const dir of skillDirs) {
    const owned: string[] = [];
    const dependencyManifests: string[] = [];
    let includeDropped = 0;
    let visited = 0;
    let truncated = false;
    const stack = [dir];
    while (stack.length > 0) {
      const current = stack.pop()!;
      const abs = resolveWithinRoot(repoRoot, current);
      if (!abs) continue;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0)); // reversed: stack pops in order
      for (const entry of entries) {
        if (++visited > MAX_BUNDLE_LISTING) { truncated = true; break; }
        const rel = `${current}/${entry.name}`;
        if (entry.isSymbolicLink()) continue;
        if (isExcluded(rel, policy.exclude)) continue;
        if (entry.isDirectory()) {
          if (skillDirSet.has(rel)) continue; // a nested skill owns its own subtree
          if (BUNDLE_SKIP_DIRS.has(entry.name)) {
            skips.push({ path: rel, kind: 'dependency-dir' });
            if (entry.name === 'node_modules') dependencyManifests.push(...listPackageManifests(repoRoot, rel));
            continue;
          }
          stack.push(rel);
        } else if (entry.isFile() && entry.name !== 'SKILL.md') {
          if (policy.include && !micromatch.isMatch(rel, policy.include, { dot: true })) { includeDropped++; continue; }
          owned.push(rel);
        }
      }
      if (truncated) break;
    }
    // Executable content first, so the cap drops documents before it drops scripts.
    owned.sort((a, b) => Number(isPriorityBundleFile(b)) - Number(isPriorityBundleFile(a)) || (a < b ? -1 : a > b ? 1 : 0));
    files.push(...owned.slice(0, MAX_BUNDLED_FILES_PER_SKILL));
    // Dependency package manifests are read (install scripts, `bin`) even though the tree is not walked.
    files.push(...dependencyManifests.sort().slice(0, MAX_DEPENDENCY_MANIFESTS));
    const dropped = owned.slice(MAX_BUNDLED_FILES_PER_SKILL);
    overCap.push(...dropped.slice(0, MAX_OVER_CAP_NAMES));
    if (dropped.length > MAX_OVER_CAP_NAMES || truncated) {
      skips.push({ path: dir, kind: 'listing-limit', count: Math.max(0, dropped.length - MAX_OVER_CAP_NAMES) });
    }
    if (includeDropped > 0) skips.push({ path: dir, kind: 'include', count: includeDropped });
  }
  return { files: files.sort(), overCap: overCap.sort(), skips };
}

/**
 * Same size/binary gate the markdown scanner applies before reading a file
 * (scanner.ts): regular file, at most MAX_FILE_SIZE bytes, no NUL byte in the
 * leading BINARY_CHECK_BYTES.
 */
function passesScanGuards(repoRoot: string, relativePath: string): boolean {
  const abs = resolveWithinRoot(repoRoot, relativePath);
  if (!abs) return false;
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size > MAX_FILE_SIZE) return false;
    const fd = fs.openSync(abs, 'r');
    try {
      const head = Buffer.alloc(Math.min(stat.size, BINARY_CHECK_BYTES));
      const read = fs.readSync(fd, head, 0, head.length, 0);
      return !isBinary(head.subarray(0, read));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * Discover the config files the ai_config detectors audit, honoring the same
 * user-facing scan policy the markdown scanner applies: `exclude` patterns
 * always remove files, an explicit `include` list bounds the scan scope (when
 * unset, each surface's own globs are the scope — these configs are not in the
 * scanner's DEFAULT_PATTERNS), and oversized or binary files are skipped.
 *
 * Called from buildRepoContext so detectors consume pre-discovered lists; a
 * `--exclude` that silences a markdown finding for a file silences that file's
 * ai_config findings too, instead of the detectors re-walking the repo with a
 * policy of their own.
 */
export function discoverAiConfigFiles(
  repoRoot: string,
  policy: Pick<ScanInput, 'include' | 'exclude'> = {},
): AiConfigFiles {
  const ignore = [...DISCOVERY_IGNORE, ...(policy.exclude ?? [])];
  const include = policy.include && policy.include.length > 0 ? policy.include : undefined;
  /** include/exclude only — no file I/O. */
  const list = (patterns: readonly string[]): string[] => {
    const files = listFiles(repoRoot, [...patterns], ignore);
    return include ? micromatch(files, include, { dot: true }).sort() : files;
  };
  const discover = (patterns: readonly string[]): string[] =>
    list(patterns).filter((file) => passesScanGuards(repoRoot, file));
  const allSkills = list(AI_CONFIG_GLOBS.allSkills);
  const bundled = discoverSkillFiles(repoRoot, allSkills, { include, exclude: policy.exclude ?? [] });
  return {
    skills: discover(AI_CONFIG_GLOBS.skills),
    allSkills,
    skillFiles: bundled.files,
    skillFilesOverCap: bundled.overCap,
    skillBundleSkips: bundled.skips,
    agents: discover(AI_CONFIG_GLOBS.agents),
    settings: discover(AI_CONFIG_GLOBS.settings),
    mcp: discover(AI_CONFIG_GLOBS.mcp),
    cursorRules: discover(AI_CONFIG_GLOBS.cursorRules),
    copilotInstructions: discover(AI_CONFIG_GLOBS.copilotInstructions),
  };
}

/** Stable short hash for building per-finding IDs. */
export function shortHash(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 12);
}

/**
 * Rewrite an issue's `filePaths`/`locations` from the detectors' repo-relative
 * POSIX form to the absolute form the scanner stores in `InstructionFile.path`.
 * Inline `promptci-ignore` suppressions match on exact path equality with the
 * scanned file, so detector output must speak the same dialect or the
 * `ai_config` category is unsuppressable. Display strings (titles, summaries,
 * evidence) keep the friendly relative form; baseline fingerprints re-normalize
 * absolute paths back to repo-relative, so they are unaffected.
 */
export function withScannerPaths(repoRoot: string, issues: PromptCiIssue[]): PromptCiIssue[] {
  const abs = (p: string) => path.resolve(repoRoot, p);
  return issues.map((issue) => ({
    ...issue,
    filePaths: issue.filePaths.map(abs),
    locations: issue.locations.map((loc) => ({ ...loc, filePath: abs(loc.filePath) })),
  }));
}

/** Extensions treated as invokable local scripts in hook/MCP command strings. */
export const SCRIPT_EXT_RE = /\.(sh|bash|zsh|js|mjs|cjs|ts|py|rb|ps1)$/i;

/**
 * 1-based line where `needle` first appears in `raw`, or 1 when not found.
 * JSON sources store strings escaped, so a parsed command containing quotes or
 * backslashes never appears verbatim — fall back to the JSON-escaped form
 * before giving up on a real line number.
 */
export function lineOf(raw: string, needle: string): number {
  let idx = raw.indexOf(needle);
  if (idx < 0) idx = raw.indexOf(JSON.stringify(needle).slice(1, -1));
  if (idx < 0) return 1;
  return raw.slice(0, idx).split(/\r?\n/).length;
}

// ── Frontmatter parsing ─────────────────────────────────────────────────────

export type FrontmatterValue = string | string[] | boolean | number | null;

export type Frontmatter = {
  /** An opening `---` fence was present on the first content line. */
  present: boolean;
  /** A closing `---` (or `...`) fence was found. */
  closed: boolean;
  /** Top-level key → parsed value. Last write wins on duplicate keys. */
  data: Record<string, FrontmatterValue>;
  /** 1-based line of each top-level key (first occurrence). */
  keyLines: Record<string, number>;
  /** 1-based line of the closing fence, or -1 when unterminated. */
  fenceEndLine: number;
  /** 1-based first line of the document body after the closing fence. */
  bodyStartLine: number;
  /** Structural problems found while parsing (duplicate keys, etc.). */
  errors: string[];
};

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * A closing fence must sit at column 0. An indented `---` is content — most
 * commonly a markdown horizontal rule inside a `|` block-scalar description —
 * and must not terminate the frontmatter.
 */
const FENCE_RE = /^(?:---|\.\.\.)[ \t]*$/;

/**
 * Strip a YAML trailing comment (` #` onward) from a raw value, tracking quote
 * state so a `#` inside a quoted string survives. A quote only *opens* at the
 * start of the value or after whitespace/`[`/`{`/`(`/`,` — an apostrophe inside
 * a word (o'brien) is content, not a quote.
 */
function stripTrailingComment(raw: string): string {
  let quote = '';
  let prev = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (quote) {
      if (c === quote) quote = '';
    } else if ((c === '"' || c === "'") && (prev === '' || /[\s[{(,]/.test(prev))) {
      quote = c;
    } else if (c === '#' && (prev === '' || /\s/.test(prev))) {
      return raw.slice(0, i).trimEnd();
    }
    prev = c;
  }
  return raw;
}

/**
 * Split on top-level `,` only — commas inside quotes or `[]`/`{}`/`()` are left
 * alone. Without this, a glob with a brace-expansion pattern such as a
 * `{ts,tsx}` suffix would be shredded at the inner comma, producing bogus
 * dead-glob findings. A quote only opens at the start of an item, so an
 * apostrophe inside a path does not swallow the following commas.
 */
function splitTopLevelCommas(inner: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let depth = 0;
  let quote = '';
  for (const c of inner) {
    if (quote) {
      cur += c;
      if (c === quote) quote = '';
      continue;
    }
    if ((c === '"' || c === "'") && cur.trim() === '') { quote = c; cur += c; continue; }
    if (c === '[' || c === '{' || c === '(') { depth++; cur += c; continue; }
    if (c === ']' || c === '}' || c === ')') { if (depth > 0) depth--; cur += c; continue; }
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts.map((s) => unquote(s.trim())).filter((s) => s !== '');
}

function unquote(s: string): string {
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseScalar(raw: string): FrontmatterValue {
  // Comment stripping happens BEFORE dispatch so `globs: ["*.ts"] # note` is
  // still recognized as a sequence, not left behind as a raw bracketed string.
  const value = stripTrailingComment(raw).trim();
  if (value === '') return null;
  // Fully-quoted string: contents verbatim (a `#` inside was preserved above).
  const unquoted = unquote(value);
  if (unquoted !== value) return unquoted;
  // Inline flow sequence: [a, b, c]
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (inner === '') return [];
    return splitTopLevelCommas(inner);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

/**
 * Parse a minimal YAML frontmatter block from the top of a document.
 *
 * Handles the subset these config files actually use: top-level `key: value`
 * scalars, quoted strings, booleans/numbers, inline `[a, b]` sequences, block
 * lists (`  - item`), and `|`/`>` block scalars. Nested mappings are recorded
 * as errors rather than silently dropped, since none of the audited surfaces
 * use them and a nested block is far more likely to be a mistake.
 *
 * This is deliberately not a full YAML engine — it exists to answer "is the
 * frontmatter structurally sane and what are its top-level keys", not to load
 * arbitrary YAML.
 */
export function parseFrontmatter(content: string): Frontmatter {
  const text = stripBom(content);
  const lines = text.split(/\r?\n/);
  const result: Frontmatter = {
    present: false,
    closed: false,
    data: {},
    keyLines: {},
    fenceEndLine: -1,
    bodyStartLine: 1,
    errors: [],
  };

  if (lines.length === 0 || lines[0]!.trim() !== '---') {
    return result; // no frontmatter — whole file is body
  }
  result.present = true;

  let lastListKey: string | null = null;
  let blockScalarKey: string | null = null;
  let blockScalarFold = false;
  let blockScalarLines: string[] = [];

  const flushBlockScalar = () => {
    if (blockScalarKey === null) return;
    const joined = blockScalarFold ? blockScalarLines.join(' ') : blockScalarLines.join('\n');
    result.data[blockScalarKey] = joined.trim();
    blockScalarKey = null;
    blockScalarLines = [];
  };

  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (blockScalarKey !== null) {
      // Block scalar continues while lines are indented or blank; the closing
      // fence (column 0 only) or a non-indented line ends it.
      if (FENCE_RE.test(line)) {
        flushBlockScalar();
        result.closed = true;
        result.fenceEndLine = i + 1;
        result.bodyStartLine = i + 2;
        break;
      }
      if (trimmed === '' || /^\s/.test(line)) {
        blockScalarLines.push(trimmed);
        continue;
      }
      flushBlockScalar();
      // fall through to normal handling of this line
    }

    if (FENCE_RE.test(line)) {
      result.closed = true;
      result.fenceEndLine = i + 1;
      result.bodyStartLine = i + 2;
      break;
    }
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    // Block list item belonging to the most recent empty-valued key.
    const listMatch = /^(\s*)-\s+(.*)$/.exec(line);
    if (listMatch && lastListKey) {
      const arr = result.data[lastListKey];
      const item = unquote(stripTrailingComment(listMatch[2]!).trim());
      if (item !== '') {
        if (Array.isArray(arr)) arr.push(item);
        else result.data[lastListKey] = [item];
      }
      continue;
    }

    const kvMatch = /^(\s*)([^:\s][^:]*):\s?(.*)$/.exec(line);
    if (!kvMatch) {
      result.errors.push(`Unparseable frontmatter line ${i + 1}: ${trimmed.slice(0, 60)}`);
      continue;
    }
    const indent = kvMatch[1]!.length;
    const key = kvMatch[2]!.trim();
    const rawValue = kvMatch[3]!;

    if (indent > 0) {
      // Nested mapping — outside the supported subset.
      result.errors.push(`Nested frontmatter key "${key}" on line ${i + 1} is not supported`);
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(result.data, key)) {
      result.errors.push(`Duplicate frontmatter key "${key}" (line ${i + 1})`);
    } else {
      result.keyLines[key] = i + 1; // first occurrence
    }

    const valueTrimmed = rawValue.trim();
    if (valueTrimmed === '|' || valueTrimmed === '|-' || valueTrimmed === '|+' ||
        valueTrimmed === '>' || valueTrimmed === '>-' || valueTrimmed === '>+') {
      blockScalarKey = key;
      blockScalarFold = valueTrimmed.startsWith('>');
      blockScalarLines = [];
      lastListKey = null;
      continue;
    }

    if (valueTrimmed === '') {
      // Either an empty scalar or the header of a block list on following lines.
      result.data[key] = null;
      lastListKey = key;
      continue;
    }

    result.data[key] = parseScalar(rawValue);
    lastListKey = null;
  }

  if (blockScalarKey !== null) flushBlockScalar();

  if (!result.closed) {
    // Unterminated frontmatter — the whole remainder was consumed as fm.
    result.bodyStartLine = lines.length + 1;
  }

  return result;
}

/** Coerce a frontmatter value that may be a list or comma/newline string into a string[]. */
export function asStringList(value: FrontmatterValue): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string') {
    // Top-level commas only — `*.{ts,tsx}` is one glob, not two fragments.
    return value.split('\n').flatMap((line) => splitTopLevelCommas(line));
  }
  return [String(value)];
}

// ── Shared finding shapes ─────────────────────────────────────────────────────

/** Fill in the defaults every ai_config finding shares. */
export function aiConfigIssue(issue: Omit<PromptCiIssue, 'severity' | 'category' | 'confidence'> &
  Partial<Pick<PromptCiIssue, 'severity' | 'category' | 'confidence'>>): PromptCiIssue {
  return {
    severity: 'warning',
    category: 'ai_config',
    confidence: 0.8,
    ...issue,
  };
}

/** Per-surface wording for the shared frontmatter-structure findings. */
export type FrontmatterSurface = {
  /** Id segment: findings get ids of the form `ai-config-<idPrefix>-<kind>-<hash>`. */
  idPrefix: string;
  /** Noun opening each finding title, e.g. 'Skill' or 'Cursor rule'. */
  noun: string;
  /** No-frontmatter summary tail: what a valid frontmatter block provides. */
  why: string;
  /** Recommendation for the no-frontmatter finding. */
  recommendation: string;
  /** Title override when the default `<noun> is missing YAML frontmatter` is wrong. */
  noFrontmatterTitle?: string;
  /** A missing block defaults to 'high' — Cursor rules soften it (metadata is optional-ish). */
  noFrontmatterSeverity?: PromptCiIssue['severity'];
  noFrontmatterConfidence?: number;
};

/**
 * The three structural frontmatter findings every frontmatter-bearing surface
 * (skills, subagents, Cursor rules) shares: block missing entirely, block never
 * closed, and parse errors inside the block. When the block is missing the
 * caller should skip its per-surface field checks, keyed off `fm.present` as
 * before — this helper only builds the findings.
 */
export function frontmatterStructureIssues(
  filePath: string,
  content: string,
  fm: Frontmatter,
  surface: FrontmatterSurface,
): PromptCiIssue[] {
  const sid = (kind: string, key: string) =>
    `ai-config-${surface.idPrefix}-${kind}-${shortHash(key)}`;

  if (!fm.present) {
    return [aiConfigIssue({
      id: sid('no-frontmatter', filePath),
      severity: surface.noFrontmatterSeverity ?? 'high',
      title: surface.noFrontmatterTitle ?? `${surface.noun} is missing YAML frontmatter`,
      summary: `${filePath} has no \`---\` frontmatter block. ${surface.why}`,
      filePaths: [filePath],
      locations: [{ filePath, startLine: 1, endLine: 1 }],
      evidence: [`First line: ${content.split(/\r?\n/)[0]?.slice(0, 60) ?? '(empty)'}`],
      recommendation: surface.recommendation,
      confidence: surface.noFrontmatterConfidence ?? 0.85,
    })];
  }

  const issues: PromptCiIssue[] = [];

  if (!fm.closed) {
    issues.push(aiConfigIssue({
      id: sid('unterminated', filePath),
      severity: 'high',
      title: `${surface.noun} frontmatter is not closed`,
      summary: `${filePath} opens a \`---\` frontmatter block that is never closed.`,
      filePaths: [filePath],
      locations: [{ filePath, startLine: 1, endLine: 1 }],
      evidence: ['Opening `---` on line 1 has no closing `---`.'],
      recommendation: 'Close the frontmatter block with a `---` line.',
      confidence: 0.9,
    }));
  }

  for (const err of fm.errors) {
    // BUG-007: surface a clear, user-facing finding that names the offending
    // key and points at the offending line, rather than a generic "structural
    // problem" anchored to the whole fence. The parser embeds the key (in
    // quotes) and the line number in each error string; lift both out so the
    // title and location are specific. Nested maps are the common trigger —
    // e.g. `tools:` followed by an indented `read: true`.
    const offendingKey = /"([^"]+)"/.exec(err)?.[1];
    const errLine = Number(/\bline (\d+)\b/.exec(err)?.[1]);
    const anchorLine = Number.isInteger(errLine) && errLine > 0
      ? errLine
      : (fm.fenceEndLine > 0 ? fm.fenceEndLine : 1);
    issues.push(aiConfigIssue({
      id: sid('fm-error', `${filePath}|${err}`),
      title: offendingKey
        ? `${surface.noun} frontmatter has an unsupported key "${offendingKey}"`
        : `${surface.noun} frontmatter has a structural problem`,
      summary: `${filePath}: ${err}.`,
      filePaths: [filePath],
      locations: [{ filePath, startLine: anchorLine, endLine: anchorLine }],
      evidence: [err],
      recommendation:
        'Fix the frontmatter so it is valid YAML with flat, unique keys. ' +
        'Nested maps are not supported — flatten the offending key or move it into the body.',
      confidence: 0.7,
    }));
  }

  return issues;
}
