import type { CheckProvenance } from './types.js';

/** A `tool-fact` or `opinion` record older than this many days has expired. */
export const PROVENANCE_MAX_AGE_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function dayNumber(date: string): number | undefined {
  if (!DATE_RE.test(date)) return undefined;
  const ms = Date.parse(`${date}T00:00:00Z`);
  // Date.parse rolls an impossible day over (`2026-02-30` is 2 March); only a date that round-trips is real.
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== date) return undefined;
  return Math.floor(ms / DAY_MS);
}

/**
 * Whole days from `date` to `today` (`YYYY-MM-DD` both); `undefined` when either
 * is not a real date. The clock is the caller's: this module never reads one.
 */
export function daysSince(date: string, today: string): number | undefined {
  const from = dayNumber(date);
  const to = dayNumber(today);
  return from === undefined || to === undefined ? undefined : to - from;
}

/**
 * What is wrong with a set of provenance records on `today`, one sentence each.
 * Empty means the set passes.
 *
 * - A `tool-fact` or `opinion` whose `lastVerified` is more than
 *   {@link PROVENANCE_MAX_AGE_DAYS} days old fails, and the message names the
 *   check and the sources to re-read. `repo-fact` records are exempt.
 * - A `tool-fact` or `opinion` with no source and not explicitly `unverified`
 *   fails: silence is not an answer.
 * - A record that says `unverified` yet lists a source contradicts itself.
 * - Dates that are not real dates fail for every kind, so expiry cannot be
 *   dodged with a malformed one.
 */
export function provenanceProblems(records: readonly CheckProvenance[], today: string): string[] {
  const problems: string[] = [];
  for (const record of records) {
    const reread = record.sources.length > 0 ? record.sources.map((s) => s.url).join(', ') : 'no sources recorded';
    const verifiedDays = daysSince(record.lastVerified.date, today);
    if (verifiedDays === undefined) {
      problems.push(`${record.id}: lastVerified "${record.lastVerified.date}" or today "${today}" is not a YYYY-MM-DD date`);
    }
    for (const source of record.sources) {
      if (dayNumber(source.readOn) === undefined) {
        problems.push(`${record.id}: source ${source.url} has readOn "${source.readOn}", which is not a YYYY-MM-DD date`);
      }
    }
    if (record.unverified && record.sources.length > 0) {
      problems.push(`${record.id}: marked unverified but lists ${record.sources.length} source(s); drop the flag or the sources`);
    }
    if (record.kind === 'repo-fact') continue;
    const hasBasis = record.sources.length > 0 || (record.evals?.length ?? 0) > 0 || record.unverified === true;
    if (!hasBasis) {
      problems.push(`${record.id}: a ${record.kind} check needs a source, an eval, or an explicit unverified: true`);
    }
    if (verifiedDays !== undefined && verifiedDays > PROVENANCE_MAX_AGE_DAYS) {
      problems.push(
        `${record.id}: lastVerified ${record.lastVerified.date} is ${verifiedDays} days old (limit ${PROVENANCE_MAX_AGE_DAYS}); ` +
          `re-read: ${reread}`,
      );
    }
  }
  return problems;
}

/** Records whose `lastVerified` falls within `withinDays` of expiring (or already past it), for the monthly triage. */
export function provenanceExpiringSoon(
  records: readonly CheckProvenance[],
  today: string,
  withinDays = 30,
): CheckProvenance[] {
  return records.filter((record) => {
    if (record.kind === 'repo-fact') return false;
    const age = daysSince(record.lastVerified.date, today);
    // Inclusive: a record with exactly `withinDays` days left is within the window.
    return age !== undefined && age >= PROVENANCE_MAX_AGE_DAYS - withinDays;
  });
}
