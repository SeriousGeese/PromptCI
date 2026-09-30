/**
 * Shields.io endpoint badge for a health score (`promptci badge`).
 *
 * The badge is SELF-REPORTED: it is whatever score the last local or CI scan
 * produced, committed to the repo and rendered by shields.io's endpoint badge
 * (https://shields.io/badges/endpoint-badge). Nothing here uploads anything.
 *
 * Only the score is published — never finding text, file names, or contents.
 *
 * Lives in the CLI, not @promptci/core's public API: only `promptci badge`
 * (and this repo's own badge script, locked to it by test) needs it. The
 * score bands come from core's `scoreLabel` so badge and report agree.
 */

import { scoreLabel } from '@promptci/core';

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

/**
 * The README snippet for a committed badge file. `badgePath` is the file's
 * path relative to the repository root, forward slashes. The label is used as
 * image alt text, so `[`, `]` and `\` are backslash-escaped to keep a label
 * like `a]b` from closing the link text early.
 */
export function badgeMarkdown(label: string, badgePath: string): string {
  const alt = label.replace(/[\\[\]]/g, (c) => `\\${c}`);
  // Placeholders stay literal (not %3C-encoded) so they are easy to spot and replace.
  const raw =
    'https%3A%2F%2Fraw.githubusercontent.com%2F<owner>%2F<repo>%2F<branch>%2F' + encodeURIComponent(badgePath);
  return `[![${alt}](https://img.shields.io/endpoint?url=${raw})](https://github.com/SeriousGeese/PromptCI)`;
}

/**
 * The `.gitignore` line that un-ignores the badge under the recommended
 * `**\/.promptci/*` stanza, or undefined when the path is not under a
 * `.promptci/` directory. Git cannot re-include a file whose parent directory
 * is excluded, so a badge in a subdirectory of `.promptci/` needs that
 * directory re-included instead of the file.
 */
export function gitignoreException(badgePath: string): string | undefined {
  const parts = badgePath.split('/');
  const idx = parts.indexOf('.promptci');
  if (idx < 0 || idx === parts.length - 1) return undefined;
  const inside = parts.slice(idx + 1);
  return inside.length === 1 ? `!**/.promptci/${inside[0]}` : `!**/.promptci/${inside[0]}/`;
}
