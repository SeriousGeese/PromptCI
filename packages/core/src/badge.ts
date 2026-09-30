/**
 * Shields.io endpoint badge for a health score (`promptci badge`).
 *
 * The badge is SELF-REPORTED: it is whatever score the last local or CI scan
 * produced, committed to the repo and rendered by shields.io's endpoint badge
 * (https://shields.io/badges/endpoint-badge). Nothing here uploads anything.
 *
 * Only the score is published — never finding text, file names, or contents.
 */

import { scoreLabel } from './report.js';

/** The JSON document shields.io's endpoint badge reads (schemaVersion 1). */
export type ShieldsBadge = {
  schemaVersion: 1;
  label: string;
  message: string;
  color: string;
};

export const BADGE_LABEL = 'instruction health';

/**
 * Shields.io named colour for a score, banded by `scoreLabel` so the badge
 * and the report can never disagree about which band a score is in.
 */
export function badgeColor(score: number): string {
  switch (scoreLabel(score)) {
    case 'Healthy':
      return 'brightgreen';
    case 'Fair':
      return 'yellowgreen';
    case 'Needs attention':
      return 'orange';
    default:
      return 'red';
  }
}

/** Build the endpoint JSON for a 0–100 health score. */
export function buildBadge(score: number, label: string = BADGE_LABEL): ShieldsBadge {
  if (!Number.isFinite(score)) {
    throw new Error(`Health score must be a finite number, got ${String(score)}.`);
  }
  const clamped = Math.round(Math.max(0, Math.min(100, score)));
  return {
    schemaVersion: 1,
    label,
    message: `${clamped}/100`,
    color: badgeColor(clamped),
  };
}
