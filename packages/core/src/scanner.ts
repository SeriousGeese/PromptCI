import fg from 'fast-glob';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { FileType, InstructionFile, InstructionSection, ScanInput } from './types.js';
import { scanFencedLines } from './markdown-fences.js';
import { isWithinRoot } from './path-containment.js';

const DEFAULT_PATTERNS = [
  // Core AI instruction files
  'CLAUDE.md',
  'AGENTS.md',
  '.cursorrules',
  '.windsurfrules',
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
export function parseSections(content: string, filePath: string): InstructionSection[] {
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

export async function scanFiles(input: ScanInput): Promise<InstructionFile[]> {
  const repoRoot = path.resolve(input.repoPath);
  const patterns = (input.include && input.include.length > 0) ? input.include : DEFAULT_PATTERNS;
  const ignorePatterns = [
    ...IGNORE_DIRS.map((d) => `**/${d}/**`),
    ...(input.exclude ?? []),
  ];

  let relativePaths: string[];
  try {
    relativePaths = await fg(patterns, {
      cwd: repoRoot,
      ignore: ignorePatterns,
      dot: true,
      absolute: false,
      followSymbolicLinks: false,
    });
  } catch {
    return [];
  }

  const results: InstructionFile[] = [];

  for (const relPath of relativePaths) {
    const absPath = path.resolve(repoRoot, relPath);

    // Path traversal guard: skip anything a glob result resolves outside the root.
    if (!isWithinRoot(repoRoot, absPath)) {
      continue;
    }

    try {
      const stat = await fs.stat(absPath);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_FILE_SIZE) continue;

      const buffer = await fs.readFile(absPath);
      if (isBinary(buffer)) continue;

      const content = buffer.toString('utf-8');
      const sections = parseSections(content, absPath);
      const lineCount = splitLines(content).length;
      const charCount = content.length;

      results.push({
        path: absPath,
        fileType: deriveFileType(relPath),
        content,
        sections,
        lineCount,
        charCount,
        estimatedTokens: Math.round(charCount / 4),
      });
    } catch {
      // skip unreadable files
    }
  }

  results.sort((a, b) => a.path.localeCompare(b.path));
  return results;
}
