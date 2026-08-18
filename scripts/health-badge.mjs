#!/usr/bin/env node
// Regenerate the Shields.io endpoint JSON that backs the instruction-health badge
// in README.md. Reads the health score from the most recent scan report
// (.promptci/report.json, written by `promptci scan`) and writes
// .promptci/health-badge.json — one of the few .promptci/ files committed to the
// repo (see .gitignore). Run via `pnpm selfscan:update`, which scans first so the
// report is fresh.
//
// Kept deterministic and dependency-free: no network, no clock in the output.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const score = report.healthScore;
if (typeof score !== 'number') {
  console.error('health-badge: report.json has no numeric healthScore field.');
  process.exit(1);
}

// Match the Shields.io named-colour bands to the report's own score labels
// (report.ts scoreLabel): >=90 healthy, >=70 fair, >=50 needs attention, else critical.
function colorFor(s) {
  if (s >= 90) return 'brightgreen';
  if (s >= 70) return 'yellowgreen';
  if (s >= 50) return 'orange';
  return 'red';
}

const badge = {
  schemaVersion: 1,
  label: 'instruction health',
  message: `${score}/100`,
  color: colorFor(score),
};

fs.writeFileSync(badgePath, JSON.stringify(badge, null, 2) + '\n');
console.error(`health-badge: wrote ${path.relative(repoRoot, badgePath)} (${score}/100)`);
