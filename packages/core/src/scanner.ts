import fg from 'fast-glob';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { FileType, InstructionFile, InstructionSection, ScanInput } from './types.js';
import { scanFencedLines } from './markdown-fences.js';
import { isWithinRoot, realPath, realPathWithinRoot } from './path-containment.js';

const DEFAULT_PATTERNS = [
  // Core AI instruction files
  'CLAUDE.md',
  'AGENTS.md',
  '.cursorrules',
  '.windsurfrules',
  // Gemini CLI. Root only, like CLAUDE.md/AGENTS.md above.
  'GEMINI.md',
  // Cline: a single `.clinerules` file OR a `.clinerules/` directory of
  // markdown rule files (fast-glob's onlyFiles default means the bare pattern
  // matches only the file form; defaultPatterns() drops the directory globs
  // when `.clinerules` is a file). `.clinerules/workflows/` holds on-demand
  // slash-command workflows, not always-loaded rules, so it is left out.
  '.clinerules',
  '.clinerules/**/*.md',
  '!.clinerules/workflows/**',
  // Agent persona files (SOUL.md, USER.md, TOOLS.md). Repo ROOT only: the
  // names are generic enough that a nested `docs/USER.md` is far more likely a
  // user guide than an agent persona. deriveFileType enforces the same rule
  // when an explicit `include` pattern pulls a nested copy in.
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
  // BUG-I1: Additional root-level instruction files that agents commonly read.
  // Explicit names only — keeps the set narrow enough to avoid scanning docs/
  // but broad enough to catch QA.md, CONTRIBUTING.md, and similar convention files.
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
// NOTE: docs/**/*.md is intentionally excluded — docs directories typically
// contain project documentation (QA reports, plans, guides) that are not AI
// instruction files and cause false positive context-bloat and conflict findings.

// 'worktrees'/'.worktrees' covers git worktree checkouts nested anywhere in the
// tree (e.g. Claude Code's .claude/worktrees/<name>/, or a top-level worktrees/
// dir used by other agent tooling) — these are full copies of the repo and
// would otherwise be scanned as duplicate instruction-file trees.
const IGNORE_DIRS = ['.git', 'node_modules', 'Library', 'Temp', 'bin', 'obj', 'dist', 'build', 'worktrees', '.worktrees'];

// Exported so ai_config discovery (ai-config.ts) applies the exact same
// size/binary policy as this scanner — one definition of "scannable file".
export const MAX_FILE_SIZE = 500 * 1024;
export const BINARY_CHECK_BYTES = 512;

const PERSONA_ROOT_PATHS: ReadonlySet<string> = new Set(['/SOUL.md', '/USER.md', '/TOOLS.md']);

// Takes the repo-root-relative path (not the absolute path): classification must
// depend only on where a file sits INSIDE the scanned repo. Using the absolute
// path let the checkout location leak in — a repo checked out under an external
// `.../.claude/worktrees/<branch>/` path (e.g. a Claude Code worktree) made every
// scanned file match `/.claude/` and get classified 'claude', producing bogus
// findings like "No behavioral guidance in CLAUDE.md" against README.md.
//
// A root-relative path has no leading slash (e.g. `.claude/foo.md`), so normalise
// to a leading-slash, forward-slash form before the directory-substring checks.
function deriveFileType(relPath: string): FileType {
  const norm = '/' + relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const base = norm.slice(norm.lastIndexOf('/') + 1);

  if (base === 'AGENTS.md') return 'agents';
  if (base === '.cursorrules' || norm.includes('/.cursor/rules/')) return 'cursor';
  // BUG-19: `.windsurfrules` is in DEFAULT_PATTERNS above, so it was always read
  // and counted toward context-bloat totals — but with no branch here it fell
  // through to 'unknown', which every filetype-gated detector's allowlist omits.
  // The file was scanned and then silently ignored by ~6 detectors.
  if (base === '.windsurfrules') return 'windsurf';
  if (base === 'copilot-instructions.md' || norm.includes('/.github/instructions/')) return 'copilot';
  // Gemini/Cline/persona files are matched anchored at the scan ROOT (`norm` is
  // leading-slash root-relative), never by basename or directory substring.
  // That is what they are discovered as, and it guarantees no file an earlier
  // release already discovered changes type: `.claude/skills/x/GEMINI.md` stays
  // an on-demand 'skill', `prompts/USER.md` stays 'prompt'.
  if (norm === '/GEMINI.md') return 'gemini';
  if (norm === '/.clinerules' || norm.startsWith('/.clinerules/')) return 'cline';
  if (PERSONA_ROOT_PATHS.has(norm)) return 'persona';
  // Load-on-demand Claude Code config surfaces. Classified before the generic
  // '/.claude/' → 'claude' rule below so a skill's SKILL.md and its reference
  // files (and every agent definition) are treated as on-demand, not as
  // always-loaded prose — the ai_config detectors audit them structurally.
  if (norm.includes('/.claude/agents/')) return 'agent';
  if (norm.includes('/.claude/skills/')) return 'skill';
  if (base === 'CLAUDE.md' || norm.includes('/.claude/')) return 'claude';
  if (base === 'README.md') return 'readme';
  if (norm.includes('/docs/') && base.endsWith('.md')) return 'docs';
  if ((norm.includes('/ai/') || norm.includes('/prompts/')) && base.endsWith('.md')) return 'prompt';
  return 'unknown';
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// `content.split('\n')` produces a phantom trailing empty element whenever the
// file ends with a newline (the common case). Drop it so line counts/endLine
// values refer to real lines, not one past EOF.
function splitLines(content: string): string[] {
  const rawLines = content.split('\n');
  if (content.length > 0 && content.endsWith('\n')) {
    rawLines.pop();
  }
  return rawLines;
}

/**
 * Splits markdown into heading-delimited sections.
 *
 * Exported because context-optimizer previously carried a forked copy with a
 * naive fence toggle (any ``` line flipped the flag, so ~~~ fences and longer
 * ``` runs desynchronised it) — and that copy decided which sections get moved
 * out of a user's instruction files.
 */
export function parseSections(
  content: string,
  filePath: string,
  relativePath?: string,
): InstructionSection[] {
  const lines = splitLines(content);
  const sections: InstructionSection[] = [];

  let currentHeading: string | undefined = undefined;
  let currentStartLine = 1;
  let currentLines: string[] = [];

  const flush = (endLine: number) => {
    const text = currentLines.join('\n');
    const id = currentHeading !== undefined ? slugify(currentHeading) : `${filePath}:0`;
    sections.push({
      id,
      filePath,
      ...(relativePath !== undefined ? { relativePath } : {}),
      heading: currentHeading,
      startLine: currentStartLine,
      endLine,
      text,
      normalizedText: text.toLowerCase().trim(),
    });
  };

  // Fenced lines are kept in the section text but never read as headings —
  // otherwise a bash comment (`# text`) inside a code block splits the section.
  const fenceLines = scanFencedLines(content);

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i] ?? '';

    if (fenceLines[i]?.inFence) {
      currentLines.push(line);
      continue;
    }

    const headingMatch = /^ {0,3}(#{1,3})\s+(.+)/.exec(line);

    if (headingMatch) {
      if (currentLines.length > 0 || currentHeading !== undefined) {
        flush(lineNum - 1);
      }
      currentHeading = headingMatch[2].trim();
      currentStartLine = lineNum;
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }

  if (currentLines.length > 0 || currentHeading !== undefined) {
    flush(lines.length);
  }

  return sections;
}

export function isBinary(buffer: Buffer): boolean {
  const end = Math.min(buffer.length, BINARY_CHECK_BYTES);
  for (let i = 0; i < end; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

const CLINE_DIR_PATTERNS: ReadonlySet<string> = new Set([
  '.clinerules/**/*.md',
  '!.clinerules/workflows/**',
]);

/**
 * DEFAULT_PATTERNS, minus the `.clinerules/` directory globs unless
 * `.clinerules` really is a directory. fast-glob scandirs `.clinerules` to
 * expand them, and a FILE of that name (Cline's single-file form) makes it
 * throw ENOTDIR — which scanFiles' catch turned into an empty scan of the
 * WHOLE repo. `suppressErrors` now contains that too; dropping the globs
 * keeps the default scan from relying on it.
 */
async function defaultPatterns(repoRoot: string): Promise<string[]> {
  let clineIsDir = false;
  try {
    clineIsDir = (await fs.stat(path.join(repoRoot, '.clinerules'))).isDirectory();
  } catch {
    // absent — the directory globs would match nothing anyway
  }
  return clineIsDir ? DEFAULT_PATTERNS : DEFAULT_PATTERNS.filter((p) => !CLINE_DIR_PATTERNS.has(p));
}

/**
 * What {@link scanFilesWithAliases} found: `files` holds each distinct file's
 * content exactly once; `aliases` holds the extra symlinked names that resolve
 * to a file already in `files` (each carries `aliasOf`).
 */
export type ScanFilesResult = { files: InstructionFile[]; aliases: InstructionFile[] };

/** The canonical real path, or null when it does not exist. Kept apart from `realPath` (used only to group names). */
function resolveReal(p: string): string | null {
  try {
    return fsSync.realpathSync.native(p);
  } catch {
    return null;
  }
}

/**
 * Read one instruction file.
 *
 * Threat model: the scanner runs on checkouts it does not trust (a fork's PR in
 * CI), where the committer controls every symlink in the tree. A link must never
 * make the scanner read a file outside the repo. So the path is resolved to its
 * real path ONCE, that real path is checked against the repo root, and the file
 * is then opened by the REAL path (never the link) with O_NOFOLLOW where the OS
 * has it, and stat'ed and read from that one handle. A link swapped in after the
 * check cannot redirect the read. What remains is a race against a writer that
 * can already modify the working tree during the scan, which is outside this
 * guard's scope.
 */
async function readInstructionFile(
  repoRoot: string,
  realRoot: string,
  absPath: string,
  typeRelPath: string,
): Promise<InstructionFile | undefined> {
  const real = resolveReal(absPath);
  if (real === null || !isWithinRoot(realRoot, real)) return undefined;

  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const noFollow = (fsSync.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    handle = await fs.open(real, fsSync.constants.O_RDONLY | noFollow);
    const stat = await handle.stat();
    if (!stat.isFile()) return undefined;
    if (stat.size > MAX_FILE_SIZE) return undefined;

    const buffer = await handle.readFile();
    if (isBinary(buffer)) return undefined;

    const content = buffer.toString('utf-8');
    // Root-relative, forward slashes: the location-independent form finding
    // ids hash (finding-id.ts), identical on every OS and checkout path.
    const relativePath = path.relative(repoRoot, absPath).replace(/\\/g, '/');
    const sections = parseSections(content, absPath, relativePath);
    const lineCount = splitLines(content).length;
    const charCount = content.length;

    return {
      path: absPath,
      relativePath,
      fileType: deriveFileType(typeRelPath),
      content,
      sections,
      lineCount,
      charCount,
      estimatedTokens: Math.round(charCount / 4),
    };
  } catch {
    // skip unreadable files
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

type GlobEntry = { path: string; dirent: { isFile(): boolean; isSymbolicLink(): boolean } };

/**
 * Longest trimmed content (characters) of a file that stands in for a symlink.
 * A path longer than this is not a link target anyone wrote by hand (MAX_PATH).
 */
const MAX_TEXT_SYMLINK_CHARS = 260;
/** A chain of text symlinks followed to the real file (`A -> B -> C`); longer chains are left as plain files. */
const MAX_TEXT_SYMLINK_HOPS = 8;

/**
 * The repo-relative path a "text symlink" points to, or undefined when the file
 * is not one. A checkout without link support (Windows without `core.symlinks`)
 * materializes a committed symlink as a small regular file whose whole content
 * is the link's target path (`CLAUDE.md` containing `AGENTS.md`). Such a file is
 * recognised only when ALL of these hold, so a genuine short instruction file is
 * never mistaken for one:
 *  - its trimmed content is a single line of at most {@link MAX_TEXT_SYMLINK_CHARS} characters;
 *  - that line is a relative path (no absolute or drive prefix, no backslashes, no `..` out of the repo);
 *  - the path is EXACTLY the repo-relative path of another discovered file, read either
 *    the way git stores a link target (relative to the link's directory: `../AGENTS.md`
 *    from `docs/CLAUDE.md`) or from the repo root (`./AGENTS.md`).
 */
function textSymlinkTarget(file: InstructionFile, discovered: ReadonlyMap<string, InstructionFile>): string | undefined {
  const rel = file.relativePath;
  if (rel === undefined || file.charCount > MAX_TEXT_SYMLINK_CHARS + 16) return undefined;
  const text = file.content.replace(/^\u{FEFF}/u, '').trim();
  if (text === '' || text.length > MAX_TEXT_SYMLINK_CHARS || /[\r\n]/.test(text)) return undefined;
  if (text.startsWith('/') || /^[A-Za-z]:/.test(text) || text.includes('\\')) return undefined;
  const candidates = [path.posix.normalize(path.posix.join(path.posix.dirname(rel), text)), path.posix.normalize(text)];
  for (const candidate of candidates) {
    if (candidate === '..' || candidate.startsWith('../')) continue;
    if (candidate !== rel && discovered.has(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Make the text symlinks among `files` aliases of the file they name, so a
 * Windows checkout without link support scans like the Linux one: the real file
 * is scanned once, the link name is an alias carrying the real content (so tool-
 * specific checks run for it under its own type) and is listed with zeroed counts.
 * Chains (`A -> B -> C`) resolve to the final real file; a cycle, an over-long chain
 * or a target that is not a discovered file leaves the file as it was. Aliases that
 * pointed at a file which turned out to be a link are re-pointed at the real one.
 */
function foldTextSymlinks(files: InstructionFile[], aliases: InstructionFile[]): ScanFilesResult {
  const byRelativePath = new Map<string, InstructionFile>();
  for (const file of files) if (file.relativePath !== undefined) byRelativePath.set(file.relativePath, file);

  const links = new Map<string, string>();
  for (const file of files) {
    const target = textSymlinkTarget(file, byRelativePath);
    if (target !== undefined) links.set(file.relativePath!, target);
  }
  if (links.size === 0) return { files, aliases };

  const real = new Map<string, InstructionFile>();
  for (const rel of links.keys()) {
    let current = links.get(rel)!;
    for (let hop = 0; hop < MAX_TEXT_SYMLINK_HOPS && links.has(current); hop++) current = links.get(current)!;
    if (!links.has(current)) real.set(rel, byRelativePath.get(current)!);
  }
  if (real.size === 0) return { files, aliases };

  const folded = files.filter((file) => file.relativePath === undefined || !real.has(file.relativePath));
  const out = aliases.map((alias) => {
    const target = alias.aliasOf === undefined ? undefined : real.get(alias.aliasOf);
    return target === undefined ? alias : { ...alias, aliasOf: target.relativePath };
  });
  for (const [rel, target] of real) {
    const link = byRelativePath.get(rel)!;
    out.push({
      ...target,
      path: link.path,
      relativePath: link.relativePath,
      fileType: link.fileType,
      sections: parseSections(target.content, link.path, link.relativePath),
      aliasOf: target.relativePath,
    });
  }
  return { files: folded, aliases: out };
}

/**
 * Discover and read instruction files, plus the symlinked names that point at
 * them.
 *
 * fast-glob with `followSymbolicLinks: false` never lists a symlinked FILE as
 * a file (its dirent is a symlink), so `CLAUDE.md -> AGENTS.md` — a very common
 * way to share one rule set between tools — used to be skipped entirely. Names
 * are grouped by REAL path, so the same content is scanned once whether it is
 * reached through a symlinked file or a linked directory
 * (`.clinerules -> .cursor/rules`):
 *
 *  - A name whose real path leaves the repo is skipped (never read).
 *  - A name that resolves to a file already discovered is an ALIAS: it is
 *    returned in `aliases` (with `aliasOf` naming the canonical file) and its
 *    content is NOT scanned a second time, so findings are not double-counted
 *    and a file is never reported as a duplicate of its own symlink. The
 *    canonical name is the one that reaches the file without crossing a symlink.
 *  - A link whose target was not discovered (an in-repo file outside the
 *    patterns, or excluded) is scanned under the LINK's path and typed by the
 *    link's name. Several links to the same such target: the first (by path)
 *    is scanned, the rest are aliases of it.
 *  - A small regular file that is nothing but the repo-relative path of another
 *    discovered file (`CLAUDE.md` containing `AGENTS.md`) is how a checkout without
 *    symlink support (Windows without `core.symlinks`) materializes a link; it is
 *    folded into an alias of that file, so both platforms scan the same repo alike
 *    (see {@link foldTextSymlinks}).
 */
export async function scanFilesWithAliases(input: ScanInput): Promise<ScanFilesResult> {
  const repoRoot = path.resolve(input.repoPath);
  const realRoot = resolveReal(repoRoot) ?? repoRoot;
  const patterns = (input.include && input.include.length > 0)
    ? input.include
    : await defaultPatterns(repoRoot);
  const ignorePatterns = [
    ...IGNORE_DIRS.map((d) => `**/${d}/**`),
    ...(input.exclude ?? []),
  ];

  let entries: GlobEntry[];
  try {
    entries = await fg(patterns, {
      cwd: repoRoot,
      ignore: ignorePatterns,
      dot: true,
      absolute: false,
      // `onlyFiles: false` + `objectMode` so symlinked entries are listed;
      // regular files and links are told apart by dirent below.
      onlyFiles: false,
      objectMode: true,
      followSymbolicLinks: false,
      // Skip unreadable entries instead of failing the whole glob: an explicit
      // `include: [".clinerules/**"]` with a `.clinerules` FILE (ENOTDIR), or
      // one permission-denied directory, used to empty the entire scan via the
      // catch below.
      suppressErrors: true,
    });
  } catch {
    return { files: [], aliases: [] };
  }

  const fileRels: string[] = [];
  const linkRels: string[] = [];
  for (const entry of entries) {
    if (entry.dirent.isSymbolicLink()) linkRels.push(entry.path);
    else if (entry.dirent.isFile()) fileRels.push(entry.path);
  }
  linkRels.sort();

  const files: InstructionFile[] = [];
  const aliases: InstructionFile[] = [];
  // Real path -> the file whose content represents it.
  const canonicalByReal = new Map<string, InstructionFile>();

  // Path traversal guard: skip anything a glob result resolves outside the
  // root — lexically, or through a symlink. With `followSymbolicLinks: false`
  // fast-glob never descends into a linked directory, but it does START its
  // walk at a pattern's base directory even when that directory is a link
  // (`.cursor/rules -> /elsewhere`), and every file below it would then be
  // read through.
  const regular: Array<{ relPath: string; absPath: string; real: string | null; direct: boolean }> = [];
  for (const relPath of fileRels) {
    const absPath = path.resolve(repoRoot, relPath);
    if (!isWithinRoot(repoRoot, absPath) || !realPathWithinRoot(repoRoot, absPath)) continue;
    const real = realPath(absPath);
    // "Direct": reaches the file without crossing a symlink, so it is the natural canonical name
    // when a linked directory makes the same file visible under two paths.
    regular.push({ relPath, absPath, real, direct: real !== null && real === path.join(realRoot, relPath) });
  }
  regular.sort((a, b) => Number(b.direct) - Number(a.direct) || a.relPath.localeCompare(b.relPath));

  for (const { relPath, absPath, real } of regular) {
    const file = await readInstructionFile(repoRoot, realRoot, absPath, relPath);
    if (!file) continue;
    const canonical = real !== null ? canonicalByReal.get(real) : undefined;
    if (canonical) {
      aliases.push({ ...file, aliasOf: canonical.relativePath });
      continue;
    }
    files.push(file);
    if (real !== null) canonicalByReal.set(real, file);
  }

  for (const relPath of linkRels) {
    const absPath = path.resolve(repoRoot, relPath);
    // Out-of-repo targets are skipped. A dangling link has nothing to read
    // (readInstructionFile fails on it) and a link to a directory is not a file.
    if (!isWithinRoot(repoRoot, absPath) || !realPathWithinRoot(repoRoot, absPath)) continue;

    const file = await readInstructionFile(repoRoot, realRoot, absPath, relPath);
    if (!file) continue;
    const real = realPath(absPath);
    const canonical = real !== null ? canonicalByReal.get(real) : undefined;
    if (canonical) {
      aliases.push({ ...file, aliasOf: canonical.relativePath });
      continue;
    }
    files.push(file);
    if (real !== null) canonicalByReal.set(real, file);
  }

  const linked = foldTextSymlinks(files, aliases);
  linked.files.sort((a, b) => a.path.localeCompare(b.path));
  linked.aliases.sort((a, b) => a.path.localeCompare(b.path));
  return linked;
}

export async function scanFiles(input: ScanInput): Promise<InstructionFile[]> {
  return (await scanFilesWithAliases(input)).files;
}
