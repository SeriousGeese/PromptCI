import fg from 'fast-glob';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { FileType, InstructionFile, InstructionSection, ScanInput } from './types.js';

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

const MAX_FILE_SIZE = 500 * 1024;
const BINARY_CHECK_BYTES = 512;

function deriveFileType(absPath: string): FileType {
  const base = path.basename(absPath);
  const norm = absPath.replace(/\\/g, '/');

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

function parseSections(content: string, filePath: string): InstructionSection[] {
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

  let inCodeBlock = false;
  let fenceChar: string | null = null;
  let fenceLen = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i] ?? '';

    // Track fenced code blocks so bash comments (`# text`) are not treated as
    // headings. A closing fence must use the same fence character (``` vs ~~~
    // are not interchangeable) and be at least as long as the opening fence,
    // per CommonMark. Up to 3 leading spaces are allowed on either fence.
    if (!inCodeBlock) {
      const openMatch = /^ {0,3}([`~]{3,})/.exec(line);
      if (openMatch) {
        inCodeBlock = true;
        fenceChar = openMatch[1][0] ?? null;
        fenceLen = openMatch[1].length;
        currentLines.push(line);
        continue;
      }
    } else {
      const closeMatch = /^ {0,3}([`~]{3,})\s*$/.exec(line);
      if (closeMatch && closeMatch[1][0] === fenceChar && closeMatch[1].length >= fenceLen) {
        inCodeBlock = false;
        fenceChar = null;
        fenceLen = 0;
        currentLines.push(line);
        continue;
      }
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

function isBinary(buffer: Buffer): boolean {
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

    // Path traversal guard
    const relative = path.relative(repoRoot, absPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
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
        fileType: deriveFileType(absPath),
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
