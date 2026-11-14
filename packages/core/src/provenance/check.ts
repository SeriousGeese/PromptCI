import type { CheckProvenance, ProvenanceStatus } from './types.js';

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

/** What the record stands on; see {@link ProvenanceStatus}. */
export function provenanceStatus(record: CheckProvenance): ProvenanceStatus {
  if (record.kind === 'repo-fact') return 'repo-fact';
  if (record.refuted) return 'refuted';
  if (record.unverified) return 'unverified';
  return 'sourced';
}

/**
 * What is structurally wrong with a set of records, one sentence each. Needs no
 * clock, so it belongs in the test suite: it is the same on every day.
 *
 * - A `tool-fact` is sourced only by a `supports` source (or an eval). A page that
 *   merely `contradicts` or gives `context` does not make it sourced.
 * - An `opinion` is sourced only by an eval: documentation is related reading, so
 *   an opinion without one is `unverified`.
 * - `unverified` lists only `context` sources and no eval; `refuted` needs a
 *   `contradicts` source and no `supports` one or eval; the two exclude each other.
 * - Dates are real `YYYY-MM-DD` dates, and a record is not verified before a
 *   source it cites was read.
 */
export function provenanceStructureProblems(records: readonly CheckProvenance[]): string[] {
  const problems: string[] = [];
  for (const record of records) {
    const stances = (stance: string): number => record.sources.filter((s) => s.stance === stance).length;
    const supports = stances('supports');
    const contradicts = stances('contradicts');
    const evals = record.evals?.length ?? 0;

    const verified = dayNumber(record.lastVerified.date);
    if (verified === undefined) {
      problems.push(`${record.id}: lastVerified "${record.lastVerified.date}" is not a YYYY-MM-DD date`);
    }
    for (const source of record.sources) {
      const read = dayNumber(source.readOn);
      if (read === undefined) {
        problems.push(`${record.id}: source ${source.url} has readOn "${source.readOn}", which is not a YYYY-MM-DD date`);
      } else if (verified !== undefined && verified < read) {
        problems.push(`${record.id}: lastVerified ${record.lastVerified.date} is before source ${source.url} was read (${source.readOn})`);
      }
    }
    if (record.unverified && record.refuted) {
      problems.push(`${record.id}: marked both unverified and refuted`);
    }
    if (record.kind === 'repo-fact') continue;

    if (record.unverified) {
      if (evals > 0) problems.push(`${record.id}: marked unverified but lists ${evals} eval(s); drop the flag`);
      // A tool-fact that a page supports is sourced. An opinion has no page that can
      // support it, so related documentation of any stance may stay next to the flag.
      if (record.kind === 'tool-fact' && (supports > 0 || contradicts > 0)) {
        problems.push(
          `${record.id}: marked unverified but lists ${supports} supporting and ${contradicts} contradicting source(s); ` +
            'keep only context sources, or drop the flag (or mark it refuted when a source contradicts it)',
        );
      }
    } else if (record.refuted) {
      if (contradicts === 0) problems.push(`${record.id}: marked refuted but no source contradicts it`);
      if (supports > 0 || evals > 0) problems.push(`${record.id}: marked refuted but a source or eval supports it`);
    } else if (record.kind === 'tool-fact') {
      if (supports === 0 && evals === 0) {
        problems.push(
          `${record.id}: a tool-fact needs a source that supports it (or an eval); ` +
            `it has ${record.sources.length} source(s), none supporting. Mark it unverified, or refuted when a source contradicts it`,
        );
      }
    } else if (evals === 0) {
      problems.push(
        `${record.id}: an opinion needs an eval; a documentation page is related reading, not support. Mark it unverified (context sources may stay)`,
      );
    }
  }
  return problems;
}

/**
 * What the calendar makes wrong on `today`, one sentence each: a `tool-fact` or
 * `opinion` (of any status) whose `lastVerified` is more than
 * {@link PROVENANCE_MAX_AGE_DAYS} days old, naming the check and the sources to
 * re-read; and a date after `today`. `repo-fact` records never expire.
 *
 * This depends on the clock, so it must not run in the test suite: it would turn
 * every build red on the day the records age out, including a rebuild of an old
 * release. It runs from `scripts/check-provenance.mjs`, on a schedule.
 */
export function provenanceDateProblems(records: readonly CheckProvenance[], today: string): string[] {
  const problems: string[] = [];
  if (dayNumber(today) === undefined) return [`today "${today}" is not a YYYY-MM-DD date`];
  for (const record of records) {
    const verifiedDays = daysSince(record.lastVerified.date, today);
    if (verifiedDays !== undefined && verifiedDays < 0) {
      problems.push(`${record.id}: lastVerified ${record.lastVerified.date} is in the future`);
    }
    for (const source of record.sources) {
      const readDays = daysSince(source.readOn, today);
      if (readDays !== undefined && readDays < 0) problems.push(`${record.id}: source ${source.url} was read on ${source.readOn}, in the future`);
    }
    if (record.kind === 'repo-fact' || verifiedDays === undefined) continue;
    if (verifiedDays > PROVENANCE_MAX_AGE_DAYS) {
      const reread = record.sources.length > 0 ? record.sources.map((s) => s.url).join(', ') : 'no sources recorded';
      problems.push(
        `${record.id}: lastVerified ${record.lastVerified.date} is ${verifiedDays} days old (limit ${PROVENANCE_MAX_AGE_DAYS}); re-read: ${reread}`,
      );
    }
  }
  return problems;
}

/** Everything {@link provenanceStructureProblems} and {@link provenanceDateProblems} find on `today`. */
export function provenanceProblems(records: readonly CheckProvenance[], today: string): string[] {
  return [...provenanceStructureProblems(records), ...provenanceDateProblems(records, today)];
}

/** Records within `withinDays` of expiring (or already past it), for the monthly triage and the early warning. */
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
