#!/usr/bin/env node
/**
 * The provenance expiry check (pcic-kvv3.4, issue #162).
 *
 * Fails (exit 1) when a tool-fact or opinion check was last verified more than 90
 * days ago, or a record is structurally wrong; prints a non-failing early warning
 * for every record within 30 days of expiring.
 *
 * It reads the clock, so it is NOT part of `pnpm test`: a test that goes red when
 * the records age out would break every PR on that day, and a rebuild of an old
 * tagged release after it. It runs from .github/workflows/provenance.yml, weekly
 * and on demand. Needs `pnpm build` first (it reads packages/core/dist).
 *
 *   node scripts/check-provenance.mjs              # today, from the system clock
 *   PROVENANCE_TODAY=2027-02-01 node scripts/check-provenance.mjs   # a given day
 *   node scripts/check-provenance.mjs --report provenance-report.md  # also write a Markdown report,
 *                                  only when something is due: expired, malformed or within 30 days
 */

import * as fs from 'node:fs';
import {
  CHECK_PROVENANCE,
  PROVENANCE_MAX_AGE_DAYS,
  daysSince,
  provenanceDateProblems,
  provenanceExpiringSoon,
  provenanceStatus,
  provenanceStructureProblems,
} from '../packages/core/dist/index.js';

const today = process.env.PROVENANCE_TODAY || new Date().toISOString().slice(0, 10);
const onGitHub = process.env.GITHUB_ACTIONS === 'true';
const annotate = (level, message) => console.log(onGitHub ? `::${level}::${message.replace(/\n/g, ' ')}` : `${level.toUpperCase()}: ${message}`);

const counts = {};
for (const record of CHECK_PROVENANCE) {
  const key = `${record.kind}/${provenanceStatus(record)}`;
  counts[key] = (counts[key] ?? 0) + 1;
}
console.log(`Provenance on ${today}: ${CHECK_PROVENANCE.length} records`);
for (const [key, n] of Object.entries(counts).sort()) console.log(`  ${key}: ${n}`);

const structure = provenanceStructureProblems(CHECK_PROVENANCE);
const dated = provenanceDateProblems(CHECK_PROVENANCE, today);
for (const problem of [...structure, ...dated]) annotate('error', problem);

const soon = provenanceExpiringSoon(CHECK_PROVENANCE, today).filter((r) => (daysSince(r.lastVerified.date, today) ?? 0) <= PROVENANCE_MAX_AGE_DAYS);
for (const record of soon) {
  const left = PROVENANCE_MAX_AGE_DAYS - (daysSince(record.lastVerified.date, today) ?? 0);
  const reread = record.sources.length > 0 ? [...new Set(record.sources.map((s) => s.url))].join(', ') : 'no sources recorded';
  annotate('warning', `${record.id} expires in ${left} day(s) (lastVerified ${record.lastVerified.date}); re-read: ${reread}`);
}
if (soon.length > 0) console.log(`${soon.length} record(s) within 30 days of expiring: re-verify them (see Docs/check-provenance.md).`);

// A weekly run that only annotates a green job reaches nobody: the workflow opens or updates one issue from this report.
const reportAt = process.argv.includes('--report') ? process.argv[process.argv.indexOf('--report') + 1] : undefined;
if (reportAt && (structure.length + dated.length > 0 || soon.length > 0)) {
  const left = (r) => PROVENANCE_MAX_AGE_DAYS - (daysSince(r.lastVerified.date, today) ?? 0);
  const lines = [
    `Check provenance, as of ${today}.`,
    '',
    ...(structure.length + dated.length > 0 ? ['## Needs action now', '', ...[...structure, ...dated].map((p) => `- ${p}`), ''] : []),
    ...(soon.length > 0
      ? [
          '## Expires within 30 days',
          '',
          ...soon.map((r) => `- ${r.id}: lastVerified ${r.lastVerified.date}, expires in ${left(r)} day(s); re-read ${[...new Set(r.sources.map((x) => x.url))].join(', ') || 'its sources'}`),
          '',
        ]
      : []),
    'How to re-verify: Docs/check-provenance.md. The weekly Provenance workflow updates this issue and closes it when nothing is due.',
  ];
  fs.writeFileSync(reportAt, lines.join('\n') + '\n');
}

if (structure.length + dated.length > 0) {
  console.error(`${structure.length + dated.length} problem(s).`);
  process.exit(1);
}
console.log('Provenance is current.');
