import * as crypto from 'node:crypto';
import type { InstructionFile, PromptCiIssue } from './types.js';

export type ContextBloatThresholds = {
  fileWarning: number;
  fileHigh: number;
  totalWarning: number;
  totalHigh: number;
  /** Line count above which a Copilot instructions file may degrade response quality (GitHub guidance). */
  copilotLineWarning: number;
  /**
   * Higher char thresholds for README files — READMEs are project docs that agents
   * read for context, not pure instruction files, so they naturally run longer.
   */
  readmeFileWarning: number;
  readmeFileHigh: number;
};

const DEFAULTS: ContextBloatThresholds = {
  fileWarning: 8_000,
  fileHigh: 20_000,
  totalWarning: 30_000,
  totalHigh: 60_000,
  copilotLineWarning: 1_000,
  // READMEs are project documentation consumed by agents for context — they
  // naturally run longer than pure instruction files. Use a relaxed threshold.
  readmeFileWarning: 15_000,
  readmeFileHigh: 30_000,
};

function fileIssueId(filePath: string): string {
  const hash = crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 12);
  return `context-bloat-file-${hash}`;
}

const TOTAL_ISSUE_ID = 'context-bloat-total';

/**
 * BUG-A: `{ ...DEFAULTS, ...thresholds }` looks safe but isn't — object spread
 * copies a key's value even when that value is `undefined`, it only skips
 * keys that are ABSENT. detectors.ts always passes an object literal with all
 * four threshold keys present (e.g. `totalWarning: context.contextBudget`),
 * so when no budget is configured every key is `undefined` rather than
 * missing — silently overriding every real default and disabling every
 * charCount/totalChars comparison (`n >= undefined` is always false).
 *
 * Merges key-by-key, only applying an override when it's not `undefined`, so
 * a caller passing `{ totalWarning: undefined }` (whether by an explicit
 * `undefined` literal or a variable that resolved to `undefined`) can never
 * blank out a real default.
 */
function mergeThresholds(
  defaults: ContextBloatThresholds,
  overrides?: Partial<ContextBloatThresholds>,
): ContextBloatThresholds {
  if (!overrides) return defaults;
  const merged = { ...defaults };
  for (const key of Object.keys(overrides) as Array<keyof ContextBloatThresholds>) {
    const value = overrides[key];
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

export function detectContextBloat(
  files: InstructionFile[],
  thresholds?: Partial<ContextBloatThresholds>,
): PromptCiIssue[] {
  const t: ContextBloatThresholds = mergeThresholds(DEFAULTS, thresholds);
  const issues: PromptCiIssue[] = [];

  for (const file of files) {
    const { charCount, estimatedTokens, path: filePath, fileType } = file;

    // README files are project docs consumed for context — use relaxed thresholds
    const warnThreshold = fileType === 'readme' ? t.readmeFileWarning : t.fileWarning;
    const highThreshold = fileType === 'readme' ? t.readmeFileHigh : t.fileHigh;

    if (charCount >= highThreshold) {
      issues.push({
        id: fileIssueId(filePath),
        severity: 'high',
        category: 'context_bloat',
        title: 'Instruction file is very large',
        summary: `File is ${charCount.toLocaleString()} chars, above high threshold (${highThreshold.toLocaleString()}).`,
        filePaths: [filePath],
        locations: [{ filePath }],
        evidence: [
          `charCount: ${charCount.toLocaleString()}`,
          `estimatedTokens: ~${estimatedTokens.toLocaleString()}`,
        ],
        recommendation: 'Consider splitting this file.',
        confidence: 1.0,
      });
    } else if (charCount >= warnThreshold) {
      issues.push({
        id: fileIssueId(filePath),
        severity: 'warning',
        category: 'context_bloat',
        title: 'Instruction file may be too large',
        summary: `File is ${charCount.toLocaleString()} chars, above warning threshold (${warnThreshold.toLocaleString()}).`,
        filePaths: [filePath],
        locations: [{ filePath }],
        evidence: [
          `charCount: ${charCount.toLocaleString()}`,
          `estimatedTokens: ~${estimatedTokens.toLocaleString()}`,
        ],
        recommendation: 'Consider trimming this file.',
        confidence: 1.0,
      });
    }
  }

  // Copilot-specific: flag if line count exceeds GitHub's recommended limit
  for (const file of files) {
    if (file.fileType === 'copilot' && file.lineCount > t.copilotLineWarning) {
      issues.push({
        id: fileIssueId(file.path + ':copilot-lines'),
        severity: 'warning',
        category: 'context_bloat',
        title: 'Copilot instructions file exceeds recommended line limit',
        summary:
          `File is ${file.lineCount.toLocaleString()} lines. GitHub recommends keeping Copilot ` +
          `instruction files under ${t.copilotLineWarning.toLocaleString()} lines — longer files may be truncated, ` +
          `degrading response quality.`,
        filePaths: [file.path],
        locations: [{ filePath: file.path }],
        evidence: [
          `lineCount: ${file.lineCount.toLocaleString()}`,
          `threshold: ${t.copilotLineWarning.toLocaleString()} lines`,
        ],
        recommendation:
          'Split into multiple focused instruction files, or move rarely-needed context to separate docs that are linked rather than inlined.',
        confidence: 1.0,
      });
    }
  }

  const totalChars = files.reduce((sum, f) => sum + f.charCount, 0);
  const totalTokens = files.reduce((sum, f) => sum + f.estimatedTokens, 0);
  const allPaths = files.map((f) => f.path);

  if (totalChars >= t.totalHigh) {
    issues.push({
      id: TOTAL_ISSUE_ID,
      severity: 'high',
      category: 'context_bloat',
      title: 'Total instruction context is very large',
      summary: `Total is ${totalChars.toLocaleString()} chars, above high threshold (${t.totalHigh.toLocaleString()}).`,
      filePaths: allPaths,
      locations: allPaths.map((p) => ({ filePath: p })),
      evidence: [
        `totalCharCount: ${totalChars.toLocaleString()}`,
        `totalEstimatedTokens: ~${totalTokens.toLocaleString()}`,
      ],
      recommendation: 'Aim to keep total context under 30k characters.',
      confidence: 1.0,
    });
  } else if (totalChars >= t.totalWarning) {
    issues.push({
      id: TOTAL_ISSUE_ID,
      severity: 'warning',
      category: 'context_bloat',
      title: 'Total instruction context may be too large',
      summary: `Total is ${totalChars.toLocaleString()} chars, above warning threshold (${t.totalWarning.toLocaleString()}).`,
      filePaths: allPaths,
      locations: allPaths.map((p) => ({ filePath: p })),
      evidence: [
        `totalCharCount: ${totalChars.toLocaleString()}`,
        `totalEstimatedTokens: ~${totalTokens.toLocaleString()}`,
      ],
      recommendation: 'Consider trimming instruction files.',
      confidence: 1.0,
    });
  }

  return issues;
}
