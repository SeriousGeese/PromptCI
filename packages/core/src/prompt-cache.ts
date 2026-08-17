import type { InstructionFile, PromptCiIssue } from './types.js';
import { matchEvidence } from './evidence.js';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

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

export function detectPromptCacheFriendliness(files: InstructionFile[]): PromptCiIssue[] {
  const issues: PromptCiIssue[] = [];

  // Focus only on persistent, always-loaded instruction files
  const targetFiles = files.filter((f) =>
    ['claude', 'agents', 'cursor', 'windsurf', 'copilot', 'prompt'].includes(f.fileType)
  );

  for (const file of targetFiles) {
    const fileName = path.basename(file.path);

    // 1. Timestamps and Dates
    for (const pat of DATE_PATTERNS) {
      if (pat.re.test(file.content)) {
        issues.push({
          id: promptCacheIssueId('volatile-timestamp', file.path),
          severity: 'warning',
          category: 'context_bloat',
          title: 'Volatile timestamp in instruction file',
          summary: `The instruction file "${fileName}" contains a volatile date or timestamp. Frequently changing dates in persistent instruction files invalidate prompt caches.`,
          filePaths: [file.path],
          locations: [],
          evidence: [matchEvidence(file.content, pat.re, pat.label)],
          recommendation: 'Move volatile dates to a separate task-specific prompt or scratch file, or remove them from canonical instructions.',
          fixRecipe: 'Remove the "Last updated: <date>" or timestamp line from the file.',
          confidence: 0.85,
        });
        break; // one is enough
      }
    }

    // 2. Pasted Scan Outputs/Reports
    for (const pat of SCAN_REPORT_PATTERNS) {
      if (pat.re.test(file.content)) {
        issues.push({
          id: promptCacheIssueId('pasted-report', file.path),
          severity: 'warning',
          category: 'context_bloat',
          title: 'Pasted scan report or summary in instructions',
          summary: `The instruction file "${fileName}" contains pasted scan results or reports. Committing generated reports into canonical instruction files breaks prompt caching and bloats context.`,
          filePaths: [file.path],
          locations: [],
          evidence: [matchEvidence(file.content, pat.re, pat.label)],
          recommendation: 'Link to the generated report file or read it on-demand instead of pasting its contents into canonical instructions.',
          fixRecipe: 'Delete the pasted report summary block and reference the report file path instead.',
          confidence: 0.9,
        });
        break;
      }
    }

    // 3. Current Branch or Task status
    for (const pat of BRANCH_TASK_PATTERNS) {
      if (pat.re.test(file.content)) {
        issues.push({
          id: promptCacheIssueId('volatile-branch-task', file.path),
          severity: 'warning',
          category: 'context_bloat',
          title: 'Volatile branch or task status in instructions',
          summary: `The instruction file "${fileName}" contains active git branch or task details. Frequently updated task status or branch names break prompt caching.`,
          filePaths: [file.path],
          locations: [],
          evidence: [matchEvidence(file.content, pat.re, pat.label)],
          recommendation: 'Move branch-specific notes and active task details to git commit messages, PR descriptions, or a temporary scratch file.',
          fixRecipe: 'Remove active branch and task notes from the persistent instructions.',
          confidence: 0.85,
        });
        break;
      }
    }

    // 4. Local User Paths
    if (LOCAL_PATH_PATTERN.test(file.content)) {
      const match = file.content.match(LOCAL_PATH_PATTERN)?.[0] ?? '';
      issues.push({
        id: promptCacheIssueId('local-paths', file.path),
        severity: 'warning',
        category: 'context_bloat',
        title: 'Local machine paths in instructions',
        summary: `The instruction file "${fileName}" contains absolute local machine paths ("${match}"). These paths change per environment, preventing prompt caching and causing instruction drift.`,
        filePaths: [file.path],
        locations: [],
        evidence: [`Found absolute local path: ${match}`],
        recommendation: 'Use repository-relative paths instead of absolute local machine paths.',
        fixRecipe: 'Replace absolute local paths with repository-relative paths.',
        confidence: 0.8,
      });
    }

    // 5. Large Tables (more than 15 rows)
    const lines = file.content.split(/\r?\n/);
    let maxTableRows = 0;
    let currentTableRows = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
        if (/^\|[-\s:|]+\|$/.test(trimmed)) {
          continue;
        }
        currentTableRows++;
      } else {
        if (currentTableRows > maxTableRows) {
          maxTableRows = currentTableRows;
        }
        currentTableRows = 0;
      }
    }
    if (currentTableRows > maxTableRows) {
      maxTableRows = currentTableRows;
    }

    if (maxTableRows > 15) {
      issues.push({
        id: promptCacheIssueId('large-table', file.path),
        severity: 'warning',
        category: 'context_bloat',
        title: 'Large table in instruction file',
        summary: `The instruction file "${fileName}" contains a large Markdown table (${maxTableRows} rows). Large tables bloat prompt context and reduce caching friendliness.`,
        filePaths: [file.path],
        locations: [],
        evidence: [`Markdown table with ${maxTableRows} rows found in ${fileName}.`],
        recommendation: 'Move large tables to separate documentation files (e.g. under docs/) or load them on-demand via tools instead of keeping them in always-loaded instructions.',
        fixRecipe: 'Extract the table to a separate document and link to it.',
        confidence: 0.9,
      });
    }
  }

  return issues;
}
