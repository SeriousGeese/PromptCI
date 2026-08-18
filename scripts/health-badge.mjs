#!/usr/bin/env node
// Regenerate the Shields.io endpoint JSON that backs the instruction-health badge
// in README.md. Reads the health score from the most recent scan report
// (.promptci/report.json, written by `promptci scan`) and writes
// .promptci/health-badge.json — one of the few .promptci/ files committed to the
// repo (see .gitignore). Run via `pnpm selfscan:update`, which scans first so the
// report is fresh; CI regenerates it after the self-scan and fails if the
// committed copy is stale.
//
// Kept deterministic and dependency-free: no network, no clock in the output.
// colorFor mirrors scoreLabel in packages/core/src/report.ts; the two are locked
// together by packages/cli/tests/health-badge.test.ts, which imports both and
// fails if the bands drift.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Shields.io named colour for a health score, banded like report.ts scoreLabel. */
export function colorFor(score) {
  if (score >= 90) return 'brightgreen'; // "Healthy"
  if (score >= 70) return 'yellowgreen'; // "Fair"
  if (score >= 50) return 'orange'; // "Needs attention"
  return 'red'; // "Critical issues found"
}

/** Build the Shields.io endpoint JSON object for a numeric health score. */
export function buildBadge(score) {
  return {
    schemaVersion: 1,
    label: 'instruction health',
    message: `${score}/100`,
    color: colorFor(score),
  };
}

function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const reportPath = path.join(repoRoot, '.promptci', 'report.json');
  const badgePath = path.join(repoRoot, '.promptci', 'health-badge.json');

  if (!fs.existsSync(reportPath)) {
    console.error(
      `health-badge: ${path.relative(repoRoot, reportPath)} not found. ` +
        `Run "pnpm selfscan:update" (it scans first), not this script directly.`,
    );
    process.exit(1);
  }

  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch (err) {
    console.error(
      `health-badge: could not parse ${path.relative(repoRoot, reportPath)}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  const score = report.healthScore;
  if (typeof score !== 'number') {
    console.error('health-badge: report.json has no numeric healthScore field.');
    process.exit(1);
  }

  fs.writeFileSync(badgePath, JSON.stringify(buildBadge(score), null, 2) + '\n');
  console.error(`health-badge: wrote ${path.relative(repoRoot, badgePath)} (${score}/100)`);
}

// Run only when invoked directly (node scripts/health-badge.mjs), not when the
// test suite imports colorFor/buildBadge.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
