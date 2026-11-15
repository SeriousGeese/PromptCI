import type { InstructionFile, PromptCiIssue } from './types.js';
import { INSTRUCTION_FILE_TYPES } from './types.js';
import { matchEvidence } from './evidence.js';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileIdPath } from './finding-id.js';
import { UNSCORED_TAG } from './health-score.js';

/**
 * B4: every id in this file was keyed by `${file.fileType}` — two files
 * sharing a fileType (e.g. CLAUDE.md and .claude/notes.md, both 'claude')
 * collided on the same id for each of the 5 checks below.
 */
function promptCacheIssueId(kind: string, filePath: string): string {
  const hash = crypto.createHash('sha1').update(`prompt-cache-${kind}:${filePath}`).digest('hex').slice(0, 12);
  return `prompt-cache-${kind}-${hash}`;
}

/**
 * BUG-20: each pattern carries a human-readable label. Evidence quotes the
 * matched instruction text under that label — the regex source is never shown
 * to report readers. See evidence.ts.
 */
type LabelledPattern = { re: RegExp; label: string };

const DATE_PATTERNS: LabelledPattern[] = [
  {
    re: /\b(?:last\s+updated|last\s+modified|updated\s+at|modified\s+at|date)\b\s*:\s*\b\d{4}-\d{2}-\d{2}\b/i,
    label: 'Dated "last updated"/"modified" line',
  },
  { re: /\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}\b/i, label: 'ISO 8601 timestamp' },
  {
    re: /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?,\s+\d{4}\b/i,
    label: 'Long-form calendar date',
  },
];

const SCAN_REPORT_PATTERNS: LabelledPattern[] = [
  { re: /health\s+score\s*:\s*\d+/i, label: 'Health-score line from a scan report' },
  { re: /files\s+scanned\s*:\s*\d+/i, label: 'File-count line from a scan report' },
  { re: /promptci\s+report/i, label: 'PromptCI report heading' },
  { re: /\bgenerated\s+by\s+promptci\b/i, label: 'PromptCI generated-by marker' },
  { re: /latest\s+scan\s+results/i, label: 'Pasted "latest scan results" section' },
  { re: /scan\s+history/i, label: 'Pasted "scan history" section' },
];

const BRANCH_TASK_PATTERNS: LabelledPattern[] = [
  { re: /current\s+branch\s*:\s*\S+/i, label: 'Current-branch line' },
  { re: /git\s+branch\s*:\s*\S+/i, label: 'Git-branch line' },
  { re: /current\s+task\s*:\s*\S+/i, label: 'Current-task line' },
];

const LOCAL_PATH_PATTERN = /(?:[a-zA-Z]:\\users\\[a-zA-Z0-9_-]+)|(?:\/users\/[a-zA-Z0-9_-]+\/)|(?:\/home\/(?!runner)[a-zA-Z0-9_-]+\/)/i;

/**
 * Claude Code's own instruction files (CLAUDE.md and the files typed like it) get no
 * volatile-content or local-path finding (#181, #182). Claude Code reads the project-root
 * and user CLAUDE.md once at session start, so editing one mid-session does not invalidate
 * its prompt cache, and its cache is already scoped to one machine and directory
 * (https://code.claude.com/docs/en/prompt-caching). The scanner's `fileType` decides this;
 * the file's contents (an absolute path, say) are never used to guess the tool.
 */
function isClaudeCodeFile(file: InstructionFile): boolean {
  return file.fileType === 'claude';
}

/** Hint-level: opinion for tools other than Claude Code, costs no health-score points. */
const HINT_TAGS = [UNSCORED_TAG];

export function detectPromptCacheFriendliness(files: InstructionFile[]): PromptCiIssue[] {
  const issues: PromptCiIssue[] = [];

  // Focus only on persistent, always-loaded instruction files
  const targetFiles = files.filter((f) =>
    INSTRUCTION_FILE_TYPES.has(f.fileType)
  );

  for (const file of targetFiles) {
    const fileName = path.basename(file.path);
    const claudeCode = isClaudeCodeFile(file);

    // 1. Timestamps and Dates
    for (const pat of DATE_PATTERNS) {
      if (!claudeCode && pat.re.test(file.content)) {
        issues.push({
          id: promptCacheIssueId('volatile-timestamp', fileIdPath(file)),
          severity: 'info',
          category: 'context_bloat',
          title: 'Volatile timestamp in instruction file',
          summary: `The instruction file "${fileName}" contains a date or timestamp. For tools that re-send instruction files with every request, text that changes often may cause cached prompt prefixes to be rebuilt.`,
          filePaths: [file.path],
          locations: [],
          evidence: [matchEvidence(file.content, pat.re, pat.label)],
          recommendation: 'Move volatile dates to a separate task-specific prompt or scratch file, or remove them from canonical instructions.',
          fixRecipe: 'Remove the "Last updated: <date>" or timestamp line from the file.',
          confidence: 0.6,
          tags: HINT_TAGS,
        });
        break; // one is enough
      }
    }

    // 2. Pasted Scan Outputs/Reports
    for (const pat of SCAN_REPORT_PATTERNS) {
      if (!claudeCode && pat.re.test(file.content)) {
        issues.push({
          id: promptCacheIssueId('pasted-report', fileIdPath(file)),
          severity: 'info',
          category: 'context_bloat',
          title: 'Pasted scan report or summary in instructions',
          summary: `The instruction file "${fileName}" contains pasted scan results or reports. Generated output in a canonical instruction file changes often and adds to context; for tools that cache the prompt prefix it may also cause the cache to be rebuilt.`,
          filePaths: [file.path],
          locations: [],
          evidence: [matchEvidence(file.content, pat.re, pat.label)],
          recommendation: 'Link to the generated report file or read it on-demand instead of pasting its contents into canonical instructions.',
          fixRecipe: 'Delete the pasted report summary block and reference the report file path instead.',
          confidence: 0.6,
          tags: HINT_TAGS,
        });
        break;
      }
    }

    // 3. Current Branch or Task status
    for (const pat of BRANCH_TASK_PATTERNS) {
      if (!claudeCode && pat.re.test(file.content)) {
        issues.push({
          id: promptCacheIssueId('volatile-branch-task', fileIdPath(file)),
          severity: 'info',
          category: 'context_bloat',
          title: 'Volatile branch or task status in instructions',
          summary: `The instruction file "${fileName}" contains active git branch or task details. Text that is updated often may cause cached prompt prefixes to be rebuilt in tools that cache them.`,
          filePaths: [file.path],
          locations: [],
          evidence: [matchEvidence(file.content, pat.re, pat.label)],
          recommendation: 'Move branch-specific notes and active task details to git commit messages, PR descriptions, or a temporary scratch file.',
          fixRecipe: 'Remove active branch and task notes from the persistent instructions.',
          confidence: 0.6,
          tags: HINT_TAGS,
        });
        break;
      }
    }

    // 4. Local User Paths
    if (!claudeCode && LOCAL_PATH_PATTERN.test(file.content)) {
      const match = file.content.match(LOCAL_PATH_PATTERN)?.[0] ?? '';
      issues.push({
        id: promptCacheIssueId('local-paths', fileIdPath(file)),
        severity: 'info',
        category: 'context_bloat',
        title: 'Local machine paths in instructions',
        summary: `The instruction file "${fileName}" contains an absolute local machine path ("${match}"). It will differ on other machines, which may reduce prompt-cache reuse in tools that share a cache across machines, and the path will not resolve for other contributors.`,
        filePaths: [file.path],
        locations: [],
        evidence: [`Found absolute local path: ${match}`],
        recommendation: 'Use repository-relative paths instead of absolute local machine paths.',
        fixRecipe: 'Replace absolute local paths with repository-relative paths.',
        confidence: 0.5,
        tags: HINT_TAGS,
      });
    }

    // 5. Large Tables (more than 15 rows)
    const lines = file.content.split(/\r?\n/);
    let maxTableRows = 0;
    let currentTableRows = 0;
    let currentStart = 0;
    let currentEnd = 0;
    let maxStart = 0;
    let maxEnd = 0;
    for (const [index, line] of lines.entries()) {
      const trimmed = line.trim();
      if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
        if (/^\|[-\s:|]+\|$/.test(trimmed)) {
          continue;
        }
        if (currentTableRows === 0) currentStart = index + 1;
        currentEnd = index + 1;
        currentTableRows++;
      } else {
        if (currentTableRows > maxTableRows) {
          maxTableRows = currentTableRows;
          maxStart = currentStart;
          maxEnd = currentEnd;
        }
        currentTableRows = 0;
      }
    }
    if (currentTableRows > maxTableRows) {
      maxTableRows = currentTableRows;
      maxStart = currentStart;
      maxEnd = currentEnd;
    }

    if (maxTableRows > 15) {
      issues.push({
        id: promptCacheIssueId('large-table', fileIdPath(file)),
        severity: 'warning',
        category: 'context_bloat',
        title: 'Large table in instruction file',
        summary: `The instruction file "${fileName}" contains a large Markdown table (${maxTableRows} rows). Large tables bloat prompt context and reduce caching friendliness.`,
        filePaths: [file.path],
        locations: [{ filePath: file.path, startLine: maxStart, endLine: maxEnd }],
        evidence: [`Markdown table with ${maxTableRows} rows found in ${fileName}.`],
        recommendation: 'Move large tables to separate documentation files (e.g. under docs/) or load them on-demand via tools instead of keeping them in always-loaded instructions.',
        fixRecipe: 'Extract the table to a separate document and link to it.',
        confidence: 0.9,
      });
    }
  }

  return issues;
}
