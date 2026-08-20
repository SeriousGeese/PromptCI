/**
 * Buried critical-instruction detector (FEAT-011).
 *
 * Models weight earlier context more heavily than later context. A long file
 * that puts its highest-stakes instructions ("never", "critical", "MUST NOT",
 * "security", "dangerous") at the very bottom risks having them under-weighted.
 *
 * Heuristic: for files longer than 100 lines, find the lines carrying a
 * high-severity keyword. If more than 60% of those lines sit in the bottom half
 * of the file, emit an info finding suggesting the critical guidance be
 * promoted toward the top.
 *
 * Deterministic and rule-based: no clock, network, or randomness.
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type { InstructionFile, PromptCiIssue } from './types.js';
import { snippet } from './evidence.js';

/** Persistent, always-loaded instruction files this detector applies to. */
const TARGET_FILE_TYPES: ReadonlySet<InstructionFile['fileType']> = new Set([
  'claude',
  'agents',
  'cursor',
  'windsurf',
  'copilot',
  'prompt',
]);

/**
 * High-severity keywords. Word-boundary matched, case-insensitive, so "MUST
 * NOT" matches regardless of casing and "security" does not match inside an
 * unrelated longer token.
 */
const HIGH_SEVERITY_KEYWORDS: RegExp[] = [
  /\bnever\b/i,
  /\bcritical\b/i,
  /\bmust\s+not\b/i,
  /\bsecurity\b/i,
  /\bdangerous\b/i,
];

const MIN_LINES = 100; // only long files can meaningfully "bury" content
const BOTTOM_HALF_RATIO_THRESHOLD = 0.6; // > 60% of keyword lines in bottom half

function lineHasKeyword(line: string): boolean {
  return HIGH_SEVERITY_KEYWORDS.some((re) => re.test(line));
}

function issueId(filePath: string): string {
  const hash = crypto.createHash('sha1').update(`buried-critical:${filePath}`).digest('hex').slice(0, 12);
  return `buried-critical-${hash}`;
}

export function detectBuriedCriticalInstructions(files: InstructionFile[]): PromptCiIssue[] {
  const issues: PromptCiIssue[] = [];

  for (const file of files) {
    if (!TARGET_FILE_TYPES.has(file.fileType)) continue;

    const lines = file.content.split(/\r?\n/);
    // Drop a single trailing empty line from a file-final newline so the
    // midpoint reflects real content lines.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

    const lineCount = lines.length;
    if (lineCount <= MIN_LINES) continue;

    const midpoint = Math.floor(lineCount / 2);

    const keywordLines: number[] = []; // 1-based line numbers
    let bottomHalfCount = 0;
    let inFence = false;

    for (let i = 0; i < lineCount; i++) {
      const line = lines[i] ?? '';
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      if (!lineHasKeyword(line)) continue;

      keywordLines.push(i + 1);
      if (i >= midpoint) bottomHalfCount++;
    }

    if (keywordLines.length === 0) continue;

    const bottomRatio = bottomHalfCount / keywordLines.length;
    if (bottomRatio <= BOTTOM_HALF_RATIO_THRESHOLD) continue;

    const fileName = path.basename(file.path);
    const pct = Math.round(bottomRatio * 100);
    const bottomLineNumbers = keywordLines.filter((ln) => ln > midpoint);
    const sampleLine = lines[(bottomLineNumbers[0] ?? keywordLines[0]!) - 1] ?? '';

    issues.push({
      id: issueId(file.path),
      severity: 'info',
      category: 'structure',
      title: 'Critical instructions near the bottom of a long file',
      summary:
        `${pct}% of the high-severity lines in "${fileName}" (${bottomHalfCount} of ` +
        `${keywordLines.length}) sit in the bottom half of a ${lineCount}-line file. Models ` +
        `weight earlier context more heavily, so critical guidance placed late may be applied ` +
        `less reliably.`,
      filePaths: [file.path],
      locations: bottomLineNumbers.slice(0, 5).map((ln) => ({ filePath: file.path, startLine: ln, endLine: ln })),
      evidence: [
        `Keyword lines in bottom half: ${bottomLineNumbers.slice(0, 8).join(', ')}` +
          (bottomLineNumbers.length > 8 ? ', …' : ''),
        `e.g. line ${bottomLineNumbers[0] ?? keywordLines[0]}: "${snippet(sampleLine, 100)}"`,
      ],
      recommendation:
        'Promote the highest-stakes instructions (security rules, "never"/"must not" ' +
        'constraints) toward the top of the file, or add a short summary of them near the ' +
        'top that points to the detail below.',
      confidence: 0.5,
    });
  }

  return issues;
}
