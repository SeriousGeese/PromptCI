/**
 * Main scan pipeline: discovers files, detects project type, runs detectors,
 * computes health score, and assembles a ScanReport.
 */

import * as path from 'node:path';
import { buildRepoContext } from './repo-context.js';
import type { RepoContext } from './repo-context.js';
import { runDetectors } from './detectors.js';
import { parseSuppressions, buildValidationIssues, applySuppressions } from './suppression.js';
import type { SuppressionAnnotation } from './suppression.js';
import { computeHealthScore, selectTopFixes } from './health-score.js';
import { filterNewIssues } from './baseline.js';
import { SKILL_SUPPLY_CHAIN_TAG } from './skill-supply-chain.js';
import type { PromptCiIssue, ScanInput, ScanReport } from './types.js';

/**
 * Inline suppression, with one carve-out: a skill-supply-chain finding is never
 * silenced by an annotation that lives INSIDE a skill directory. That text is
 * the very content under audit — a malicious skill could otherwise ship a
 * `promptci-ignore: security` next to its own payload. Such findings are
 * silenced from outside the skill instead: `exclude` in .promptci/config.json,
 * or the baseline. Every other finding keeps the normal rules.
 */
function applyScanSuppressions(
  issues: PromptCiIssue[],
  annotations: SuppressionAnnotation[],
  context: RepoContext,
): { active: PromptCiIssue[]; suppressed: PromptCiIssue[] } {
  // Tolerates hand-built contexts (older shapes, test doubles) without these lists.
  const skillDirs = (context.aiConfig?.allSkills ?? context.aiConfig?.skills ?? [])
    .map((skillMd) => path.dirname(path.resolve(context.repoRoot, skillMd)) + path.sep);
  const outsideSkills = annotations.filter(
    (ann) => !skillDirs.some((dir) => path.resolve(ann.filePath).startsWith(dir)),
  );
  const isSupplyChain = (issue: PromptCiIssue) => issue.tags?.[0] === SKILL_SUPPLY_CHAIN_TAG;
  const regular = applySuppressions(issues.filter((i) => !isSupplyChain(i)), annotations);
  const supplyChain = applySuppressions(issues.filter(isSupplyChain), outsideSkills);
  const suppressedSet = new Set([...regular.suppressed, ...supplyChain.suppressed]);
  // Keep detector order in both lists.
  return {
    active: issues.filter((i) => !suppressedSet.has(i)),
    suppressed: issues.filter((i) => suppressedSet.has(i)),
  };
}

export async function scan(input: ScanInput): Promise<ScanReport> {
  const context = await buildRepoContext(input);
  const issues = runDetectors(context);

  // On-demand skill/agent bodies are held out of context.files so the prose
  // detectors skip them, but they still appear in the report inventory and can
  // carry inline suppression annotations for ai_config findings on their path.
  const allScannedFiles = [...context.files, ...context.onDemandFiles];

  // Apply inline suppression annotations.
  // Invalid annotations are surfaced as warning issues (count against score).
  // Suppressed issues are excluded from health score and topFixes.
  const annotations = parseSuppressions(allScannedFiles);
  const allIssues = [...issues, ...buildValidationIssues(annotations)];
  const { active, suppressed } = applyScanSuppressions(allIssues, annotations, context);

  const healthScore = computeHealthScore(active);
  const topFixes = selectTopFixes(active);

  let newIssues;
  let baselinedIssues;

  if (input.baseline) {
    const filtered = filterNewIssues(active, input.baseline, context.repoRoot);
    newIssues = filtered.newIssues;
    baselinedIssues = filtered.baselinedIssues;
  }

  return {
    schemaVersion: '0.1',
    generatedAt: new Date().toISOString(),
    repoPath: context.repoRoot,
    projectType: context.projectType,
    healthScore,
    metrics: context.metrics,
    // Symlink aliases are inventory only (see RepoContext.aliasFiles): they are
    // not scanned, so they carry no annotations to parse above.
    filesScanned: [...allScannedFiles, ...(context.aliasFiles ?? [])],
    issues: active,
    topFixes,
    newIssues,
    baselinedIssues,
    suppressedIssues: suppressed.length > 0 ? suppressed : undefined,
  };
}
