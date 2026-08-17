/**
 * Main scan pipeline: discovers files, detects project type, runs detectors,
 * computes health score, and assembles a ScanReport.
 */

import { buildRepoContext } from './repo-context.js';
import { runDetectors } from './detectors.js';
import { parseSuppressions, buildValidationIssues, applySuppressions } from './suppression.js';
import { computeHealthScore, selectTopFixes } from './health-score.js';
import { filterNewIssues } from './baseline.js';
import type { ScanInput, ScanReport } from './types.js';

export async function scan(input: ScanInput): Promise<ScanReport> {
  const context = await buildRepoContext(input);
  const issues = runDetectors(context, 'scan');

  // Apply inline suppression annotations.
  // Invalid annotations are surfaced as warning issues (count against score).
  // Suppressed issues are excluded from health score and topFixes.
  const annotations = parseSuppressions(context.files);
  const allIssues = [...issues, ...buildValidationIssues(annotations)];
  const { active, suppressed } = applySuppressions(allIssues, annotations);

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
    filesScanned: context.files,
    issues: active,
    topFixes,
    newIssues,
    baselinedIssues,
    suppressedIssues: suppressed.length > 0 ? suppressed : undefined,
  };
}
