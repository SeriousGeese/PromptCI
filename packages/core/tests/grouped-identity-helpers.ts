/**
 * One rule for every grouped finding (a finding whose evidence lists members
 * that come and go: agent-practice, action-pin, mirrored instruction files):
 * its identity depends on the GROUP, not on the list inside it. Editing or
 * shrinking the group must not create a new fingerprint anywhere identity is
 * compared: the baseline (`--fail-on-new`, review-diff), the scan trend
 * (`trend.newIssueIds` / counts) and SARIF `partialFingerprints`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect } from 'vitest';
import { scan } from '../src/scan.js';
import { createBaseline, filterNewIssues } from '../src/baseline.js';
import { computeTrend, generateJsonReport } from '../src/report.js';
import { generateSarifReport } from '../src/sarif.js';
import type { PromptCiIssue, ScanReport } from '../src/types.js';

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
}

/** The SARIF `partialFingerprints["promptci/v1"]` values of a report. */
function sarifFingerprints(report: ScanReport): string[] {
  const log = JSON.parse(generateSarifReport(report, 'test')) as {
    runs: Array<{ results: Array<{ partialFingerprints: Record<string, string> }> }>;
  };
  return log.runs[0]!.results.map((r) => r.partialFingerprints['promptci/v1']!);
}

/**
 * Scan `root`, apply `change`, scan again, and assert that the grouped
 * finding picked by `select` exists on both sides, that its list changed, and
 * that it keeps its identity in the baseline, the trend and SARIF.
 */
export async function expectGroupKeepsIdentity(
  root: string,
  change: Record<string, string>,
  select: (issue: PromptCiIssue) => boolean,
): Promise<void> {
  const before = await scan({ repoPath: root });
  writeFiles(root, change);
  const after = await scan({ repoPath: root });

  const only = (report: ScanReport): ScanReport => ({ ...report, issues: report.issues.filter(select) });
  const [b, a] = [only(before), only(after)];
  expect(b.issues, 'grouped finding present before the change').toHaveLength(1);
  expect(a.issues, 'grouped finding present after the change').toHaveLength(1);
  // The change must alter what the finding says, or the test proves nothing.
  const shape = (i: PromptCiIssue) => JSON.stringify([i.evidence, i.summary, i.filePaths]);
  expect(shape(a.issues[0]!), 'the change alters the finding').not.toBe(shape(b.issues[0]!));

  // Baseline: --fail-on-new and review-diff --fail-on-regression.
  expect(filterNewIssues(a.issues, createBaseline(b.issues, root), root).newIssues, 'baseline').toEqual([]);

  // Trend: computed from the previous report's JSON, as `writeReport` does.
  const previous = JSON.parse(generateJsonReport(b)) as Record<string, unknown>;
  const trend = await computeTrend(a, previous, []);
  expect(trend?.newIssuesCount, 'trend: new').toBe(0);
  expect(trend?.resolvedIssuesCount, 'trend: resolved').toBe(0);

  // SARIF partialFingerprints.
  expect(sarifFingerprints(a), 'SARIF').toEqual(sarifFingerprints(b));
}
