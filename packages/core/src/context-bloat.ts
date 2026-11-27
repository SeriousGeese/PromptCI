/**
 * Context-bloat detector: how much does this repo's instruction context cost
 * to carry on every agent turn, and which file is responsible?
 *
 * This absorbed the former context-cost detector. The two fired the same
 * category on the same files at thresholds that differed only in unit —
 * 8,000 chars is ~2,000 tokens against a 2,500-token rule — so a large file
 * produced two findings stating one fact, and each had to be dismissed
 * separately. Sizes are measured in characters, with the token estimate in
 * the evidence; README dominance, the one fact the token detector had to
 * itself, moved here intact.
 */

import * as crypto from 'node:crypto';
import type { InstructionFile, PromptCiIssue } from './types.js';
import { fileIdPath } from './finding-id.js';
import { UNSCORED_TAG } from './health-score.js';
import { aliasesWithNewType } from './alias-files.js';
import { agentsOverridePairs, ruleActivation } from './rule-activation.js';
import { splitReferenceDocs } from './reference-docs.js';

export type ContextBloatThresholds = {
  fileWarning: number;
  fileHigh: number;
  totalWarning: number;
  totalHigh: number;
  /**
   * Line count above which a Copilot instructions file is reported as long. PromptCI's own
   * heuristic: GitHub documents no line limit for these files (#189).
   */
  copilotLineWarning: number;
  /**
   * Higher char thresholds for README files — READMEs are project docs that agents
   * read for context, not pure instruction files, so they naturally run longer.
   */
  readmeFileWarning: number;
  readmeFileHigh: number;
  /**
   * Lower char thresholds for `.windsurfrules`: Windsurf silently truncates a
   * rules file past ~6,000 characters, and the combined global+workspace budget
   * is ~12,000. Rules past the limit never reach the model.
   */
  windsurfFileWarning: number;
  windsurfFileHigh: number;
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
  // Windsurf truncates a `.windsurfrules` file beyond ~6,000 characters; 12,000
  // is the combined global+workspace budget. Tighter than the generic bars.
  windsurfFileWarning: 6_000,
  windsurfFileHigh: 12_000,
};

function fileIssueId(filePath: string): string {
  const hash = crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 12);
  return `context-bloat-file-${hash}`;
}

const TOTAL_ISSUE_ID = 'context-bloat-total';

/**
 * A README this far past both bars is carrying the repo's agent context.
 * Absolute floor as well as ratio: half of a 200-token context is not a
 * finding, it is a small repo.
 */
const README_DOMINANCE_RATIO = 0.5;
const README_DOMINANCE_MIN_TOKENS = 1_000;

/** Marks the findings that are about what the context costs to carry. */
const COST_TAGS = ['cost', 'context'];

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

/**
 * Symlink aliases of a file of a DIFFERENT type whose own tool has a size limit
 * (`.windsurfrules -> AGENTS.md`: Windsurf truncates the content it reads under
 * that name). They get only that tool-specific check, against the real content;
 * the total and every generic threshold keep counting the content once.
 */
function aliasesOfType(files: InstructionFile[], aliases: InstructionFile[], fileType: InstructionFile['fileType']) {
  return aliasesWithNewType(files, aliases, (type) => type === fileType);
}

/**
 * The legacy `.windsurfrules` file, the one the Windsurf size limit is about. A
 * `.windsurf/rules/*.md` or `.devin/` rule file is also typed 'windsurf'
 * (pcic-k1t3.10), but no limit is documented for those, so they get the
 * generic thresholds.
 */
function isLegacyWindsurfRules(file: InstructionFile): boolean {
  return file.fileType === 'windsurf' && fileIdPath(file).split('/').pop()?.toLowerCase() === '.windsurfrules';
}

export function detectContextBloat(
  files: InstructionFile[],
  thresholds?: Partial<ContextBloatThresholds>,
  aliases: InstructionFile[] = [],
  unloadedReferenceDocs: readonly InstructionFile[] = splitReferenceDocs(files, aliases).reference,
): PromptCiIssue[] {
  const t: ContextBloatThresholds = mergeThresholds(DEFAULTS, thresholds);
  const issues: PromptCiIssue[] = [];

  for (const file of [...files, ...aliasesOfType(files, aliases, 'windsurf').filter(isLegacyWindsurfRules)]) {
    const { charCount, estimatedTokens, path: filePath, fileType } = file;
    const isWindsurf = isLegacyWindsurfRules(file);

    // Per-file-type thresholds: READMEs are project docs consumed for context
    // (relaxed), while `.windsurfrules` is truncated by Windsurf past a low
    // char limit (tighter, with Windsurf-specific guidance).
    let warnThreshold = t.fileWarning;
    let highThreshold = t.fileHigh;
    if (fileType === 'readme') {
      warnThreshold = t.readmeFileWarning;
      highThreshold = t.readmeFileHigh;
    } else if (isWindsurf) {
      warnThreshold = t.windsurfFileWarning;
      highThreshold = t.windsurfFileHigh;
    }

    // Windsurf silently drops rules past its truncation limit, so the guidance
    // is about staying under the limit, not just "trim/split for cost".
    const windsurfRecommendation =
      `Trim the file under ~${t.windsurfFileWarning.toLocaleString()} characters, or split it into ` +
      'scoped `.windsurf/rules/*.md` files so each loads only when relevant — Windsurf ' +
      'silently truncates rules past its limit, so later rules never reach the model.';

    if (charCount >= highThreshold) {
      issues.push({
        id: fileIssueId(fileIdPath(file)),
        severity: 'high',
        category: 'context_bloat',
        title: isWindsurf ? '.windsurfrules is past the Windsurf size limit' : 'Instruction file is very large',
        summary: isWindsurf
          ? `File is ${charCount.toLocaleString()} chars, past Windsurf's ~${t.windsurfFileHigh.toLocaleString()}-char combined budget — rules beyond the ~${t.windsurfFileWarning.toLocaleString()}-char limit are silently truncated.`
          : `File is ${charCount.toLocaleString()} chars, above high threshold (${highThreshold.toLocaleString()}).`,
        filePaths: [filePath],
        locations: [{ filePath }],
        evidence: [
          `charCount: ${charCount.toLocaleString()}`,
          `estimatedTokens: ~${estimatedTokens.toLocaleString()}`,
        ],
        recommendation: isWindsurf ? windsurfRecommendation : 'Consider splitting this file.',
        confidence: 1.0,
        tags: COST_TAGS,
      });
    } else if (charCount >= warnThreshold) {
      issues.push({
        id: fileIssueId(fileIdPath(file)),
        severity: 'warning',
        category: 'context_bloat',
        title: isWindsurf ? '.windsurfrules may exceed the Windsurf size limit' : 'Instruction file may be too large',
        summary: isWindsurf
          ? `File is ${charCount.toLocaleString()} chars, past Windsurf's ~${t.windsurfFileWarning.toLocaleString()}-char truncation limit — rules beyond it may be silently dropped.`
          : `File is ${charCount.toLocaleString()} chars, above warning threshold (${warnThreshold.toLocaleString()}).`,
        filePaths: [filePath],
        locations: [{ filePath }],
        evidence: [
          `charCount: ${charCount.toLocaleString()}`,
          `estimatedTokens: ~${estimatedTokens.toLocaleString()}`,
        ],
        recommendation: isWindsurf ? windsurfRecommendation : 'Consider trimming this file.',
        confidence: 1.0,
        tags: COST_TAGS,
      });
    }
  }

  // Copilot instructions files: a generic size hint against our own line heuristic (not a GitHub limit).
  for (const file of [...files, ...aliasesOfType(files, aliases, 'copilot')]) {
    if (file.fileType === 'copilot' && file.lineCount > t.copilotLineWarning) {
      issues.push({
        id: fileIssueId(fileIdPath(file) + ':copilot-lines'),
        severity: 'info',
        category: 'context_bloat',
        title: 'Copilot instructions file is long',
        summary:
          `File is ${file.lineCount.toLocaleString()} lines, past PromptCI's ${t.copilotLineWarning.toLocaleString()}-line ` +
          `size hint for a Copilot instructions file. This is PromptCI's own rule of thumb, not a documented limit; ` +
          `a long file adds context to every request and is harder to keep accurate.`,
        filePaths: [file.path],
        locations: [{ filePath: file.path }],
        evidence: [
          `lineCount: ${file.lineCount.toLocaleString()}`,
          `threshold: ${t.copilotLineWarning.toLocaleString()} lines (PromptCI heuristic)`,
        ],
        recommendation:
          'Split into multiple focused instruction files, or move rarely-needed context to separate docs that are linked rather than inlined.',
        confidence: 0.6,
        tags: [UNSCORED_TAG],
      });
    }
  }

  // The total is what is loaded on every request: a rule file its tool loads only
  // for some files, one mode or on request (rule-activation.ts: a Cursor rule
  // without alwaysApply, a Copilot applyTo, a Kiro fileMatch, a Windsurf glob
  // trigger, a Roo Code mode directory) still gets the per-file checks above,
  // but is not added to every turn's cost (pcic-k1t3.10).
  // Codex reads AGENTS.override.md instead of the AGENTS.md beside it, so the
  // pair is counted once, as the larger of the two.
  const replaced = new Set(
    agentsOverridePairs(files).map(([agents, override]) => (override.charCount >= agents.charCount ? agents : override)),
  );
  // A README or CONTRIBUTING no CLAUDE.md imports is scanned above but never
  // loaded by an agent, so it is no part of the total (pcic-5rop.110).
  const unloaded = new Set(unloadedReferenceDocs);
  const alwaysLoaded = files.filter((f) => ruleActivation(f) === 'always' && !replaced.has(f) && !unloaded.has(f));
  const totalChars = alwaysLoaded.reduce((sum, f) => sum + f.charCount, 0);
  const totalTokens = alwaysLoaded.reduce((sum, f) => sum + f.estimatedTokens, 0);
  const allPaths = alwaysLoaded.map((f) => f.path);

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
      tags: COST_TAGS,
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
      tags: COST_TAGS,
    });
  }

  // Which file is the context? A README that accounts for most of it is not
  // necessarily too big — it is in the wrong place, since a README is written
  // for people and an `@README.md` import carries it on every agent turn. A
  // README nothing imports costs no turn anything, so it never fires here.
  const readme = alwaysLoaded.find((file) => file.fileType === 'readme');
  if (
    totalTokens > 0 &&
    readme &&
    readme.estimatedTokens >= README_DOMINANCE_MIN_TOKENS &&
    readme.estimatedTokens / totalTokens >= README_DOMINANCE_RATIO
  ) {
    const share = Math.round((readme.estimatedTokens / totalTokens) * 100);
    issues.push({
      id: fileIssueId(`${fileIdPath(readme)}:readme-dominates`),
      severity: 'info',
      category: 'context_bloat',
      title: 'README dominates scanned instruction context',
      summary:
        `README content accounts for about ${share}% of the always-loaded instruction tokens, because an @ import loads it. ` +
        'That may be appropriate, but AI-specific guidance is usually cheaper in a smaller canonical file.',
      filePaths: [readme.path],
      locations: [{ filePath: readme.path }],
      evidence: [`README: ~${readme.estimatedTokens} of ~${totalTokens} always-loaded tokens`],
      recommendation:
        'Consider keeping AI rules in AGENTS.md and dropping the `@README.md` import, leaving README as project documentation.',
      confidence: 0.65,
      tags: COST_TAGS,
    });
  }

  return issues;
}
