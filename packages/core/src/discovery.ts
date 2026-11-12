/**
 * Discovery lists and a pure path-based discovery API (pcic-zg3).
 *
 * `scanner.ts` (instruction files), `ai-config.ts` (skills) and
 * `repo-context.ts` (workflows / composite actions) each discover a different
 * class of file from the real filesystem with `fast-glob`. The constants and
 * predicates that decide WHAT belongs to each class live here, once, so those
 * three modules import them instead of keeping their own copies — two
 * modules can no longer drift apart on what counts as, say, a skill location.
 *
 * `selectScanPaths` is the filesystem-free counterpart: given a plain list of
 * repo-relative paths (as a server with only a GitHub tree listing has, not a
 * checkout), it applies the exact same patterns and caps to answer what a real
 * scan would read, without ever touching disk. It cannot apply the size/binary
 * guards those modules apply before reading a file's bytes (there are no bytes
 * here) — a caller with sizes can filter oversized candidates itself.
 */

import micromatch from 'micromatch';

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

// ── Skills (ai-config.ts) ─────────────────────────────────────────────────────

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

// ── Workflows and composite actions (repo-context.ts) ─────────────────────────

/** Composite actions: a root `action.yml` and any under `.github/actions/`. */
export const COMPOSITE_ACTION_GLOBS: readonly string[] = [
  'action.yml',
  'action.yaml',
  '.github/actions/**/action.yml',
  '.github/actions/**/action.yaml',
];

// ── Pure path-based discovery API ────────────────────────────────────────────

/** A repo-relative POSIX path, optionally carrying its blob size in bytes. */
export type ScanPathEntry = string | { path: string; size?: number };

export type SelectScanPathsOptions = {
  /**
   * Overrides `DEFAULT_INSTRUCTION_PATTERNS` entirely — the same effect
   * `ScanInput.include` (`.promptci/config.json`'s `include`) has on a real
   * scan. A repo that opts into `docs/**` via `include` is matched the same
   * way here: pass the full pattern list you would pass as `include`, not
   * just the addition.
   */
  patterns?: readonly string[];
};

export type SelectScanPathsResult = {
  /** Files a scan reads and reports on as always-loaded instruction prose. */
  instructionFiles: string[];
  /** `SKILL.md` files plus the files bundled alongside them. */
  skillFiles: string[];
  /** GitHub Actions workflow files and composite `action.yml`/`action.yaml` files. */
  workflowFiles: string[];
  /** Files read for resolution (manifests, lockfiles, ignore files) but never reported on. */
  contextFiles: string[];
};

function normalizePaths(paths: readonly ScanPathEntry[]): Array<{ path: string; size?: number }> {
  return paths.map((p) => (typeof p === 'string' ? { path: p } : p));
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

/**
 * SKILL.md files plus their bundled files, from a full path list — the pure
 * equivalent of ai-config.ts's `discoverSkillFiles` (no filesystem walk
 * needed: every candidate is already in `paths`).
 */
function selectSkillFiles(paths: readonly { path: string; size?: number }[]): string[] {
  const skillMatches = micromatch(paths.map((p) => p.path), SKILL_GLOBS, { dot: true })
    .filter((p) => !hasAncestorDir(p, DISCOVERY_IGNORE_DIRS));
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
  const perSkill = new Map<string, string[]>();
  for (const entry of paths) {
    const rel = entry.path;
    if (skillSet.has(rel)) continue;
    if (rel.endsWith('/SKILL.md') || rel === 'SKILL.md') continue;
    const dir = nearestSkillDir(rel);
    if (dir === null) continue;
    const belowSkillDir = rel.split('/').slice(dir === '.' ? 0 : dir.split('/').length);
    if (belowSkillDir.slice(0, -1).some((seg) => BUNDLE_SKIP_DIRS.has(seg))) continue;
    const list = perSkill.get(dir) ?? [];
    list.push(rel);
    perSkill.set(dir, list);
  }

  const out = [...skillMatches];
  for (const list of perSkill.values()) {
    list.sort((a, b) => Number(isPriorityBundleFile(b)) - Number(isPriorityBundleFile(a)) || byPath(a, b));
    out.push(...list.slice(0, MAX_BUNDLED_FILES_PER_SKILL));
  }
  return out.sort(byPath);
}

function selectWorkflowFiles(paths: readonly string[]): string[] {
  const workflows = paths.filter(
    (p) => p.startsWith('.github/workflows/') && p.split('/').length === 3 && /\.ya?ml$/i.test(p),
  );
  const composites = micromatch(paths, COMPOSITE_ACTION_GLOBS, { dot: true });
  return [...new Set([...workflows, ...composites])].sort();
}

/** Root names GNU make looks up when no `-f` is given. */
const ROOT_MAKEFILE_NAMES: readonly string[] = ['GNUmakefile', 'makefile', 'Makefile'];

/** Lockfiles repo-context.ts reads at the repo root. */
const LOCKFILE_NAMES: readonly string[] = [
  'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lockb', 'bun.lock',
];

/** Root manifests read for cross-referencing (version/script checks), never scanned as prose. */
const ROOT_MANIFEST_NAMES: readonly string[] = ['package.json', 'pyproject.toml', 'requirements.txt'];

/** TS/JS project configs dependency-staleness.ts resolves import aliases against. */
const TS_CONFIG_NAMES: readonly string[] = ['tsconfig.json', 'tsconfig.base.json', 'jsconfig.json'];

function selectContextFiles(paths: readonly string[], skillFiles: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    if (skillFiles.has(p)) continue; // a skill's own package.json belongs to its bundle, not workspace resolution
    const base = p.slice(p.lastIndexOf('/') + 1);
    if (base === '.gitignore') { out.add(p); continue; }
    if (p === 'pnpm-workspace.yaml') { out.add(p); continue; }
    if (ROOT_MAKEFILE_NAMES.includes(p)) { out.add(p); continue; }
    if (LOCKFILE_NAMES.includes(p)) { out.add(p); continue; }
    if (ROOT_MANIFEST_NAMES.includes(p)) { out.add(p); continue; }
    if (TS_CONFIG_NAMES.includes(p)) { out.add(p); continue; }
    if (p === '.promptci/config.json' || p === '.promptci/custom-rules.json') { out.add(p); continue; }
    // Nested package.json (workspace manifests) — the root copy is already added above.
    if (base === 'package.json' && p !== 'package.json' && !hasAncestorDir(p, SCAN_IGNORE_DIRS)) out.add(p);
  }
  return [...out].sort();
}

/**
 * Pure counterpart to a real scan's file discovery: given a repo's full path
 * list (as a server building from GitHub's tree listing has, not a checkout),
 * returns what a scan would read, classified the way the scanner, ai_config
 * and repo-context modules classify it. Applies the same ignore dirs,
 * skill-bundle rules and caps those modules use — see the module doc above.
 *
 * `size`, when given, only ever narrows a result (a caller that also wants
 * scanner.ts's MAX_FILE_SIZE / binary guard applies it with the bytes it
 * fetches; there is nothing to check without them).
 */
export function selectScanPaths(
  paths: readonly ScanPathEntry[],
  options?: SelectScanPathsOptions,
): SelectScanPathsResult {
  const entries = normalizePaths(paths);
  const allPaths = entries.map((e) => e.path);

  const clineIsDir = allPaths.some((p) => p.startsWith('.clinerules/'));
  const patterns = options?.patterns && options.patterns.length > 0
    ? options.patterns
    : defaultInstructionPatterns(clineIsDir);

  const instructionFiles = micromatch(allPaths, [...patterns], { dot: true })
    .filter((p) => !hasAncestorDir(p, SCAN_IGNORE_DIRS))
    .sort();

  const skillFiles = selectSkillFiles(entries);

  return {
    instructionFiles,
    skillFiles,
    workflowFiles: selectWorkflowFiles(allPaths),
    contextFiles: selectContextFiles(allPaths, new Set(skillFiles)),
  };
}
