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
    filesScanned: allScannedFiles,
    issues: active,
    topFixes,
    newIssues,
    baselinedIssues,
    suppressedIssues: suppressed.length > 0 ? suppressed : undefined,
  };
}
