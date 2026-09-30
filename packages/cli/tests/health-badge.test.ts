import { describe, expect, it } from 'vitest';
import { scoreLabel } from '@promptci/core';
import { buildBadge as cliBuildBadge } from '../src/badge.js';
// The badge script duplicates core's score bands (it must stay dependency-free
// so `pnpm selfscan:update` works without importing core's build output). This
// test is the lock between the two: if report.ts rebands scoreLabel, or the
// script's colorFor drifts, it fails and forces them back in sync.
// @ts-expect-error — plain .mjs module without type declarations
import { buildBadge, colorFor } from '../../../scripts/health-badge.mjs';

/** The intended label→colour pairing between report.ts and the README badge. */
const LABEL_TO_COLOR: Record<string, string> = {
  Healthy: 'brightgreen',
  Fair: 'yellowgreen',
  'Needs attention': 'orange',
  'Critical issues found': 'red',
};

describe('health-badge script', () => {
  it('bands every score to the colour matching core scoreLabel', () => {
    // Sweep the full score range so any boundary drift (>=90/>=70/>=50) between
    // colorFor and scoreLabel is caught, not just the current edges.
    for (let score = 0; score <= 100; score++) {
      const label = scoreLabel(score);
      expect(LABEL_TO_COLOR[label], `scoreLabel(${score}) returned unknown label "${label}"`).toBeDefined();
      expect(colorFor(score), `score ${score} (label "${label}")`).toBe(LABEL_TO_COLOR[label]);
    }
  });

  // `promptci badge` and this repo's own dependency-free script must produce
  // identical badges, or the self-hosted README badge and what users get from
  // the CLI would drift apart.
  it('matches the `promptci badge` command for every score', () => {
    for (let score = 0; score <= 100; score++) {
      expect(buildBadge(score), `score ${score}`).toEqual(cliBuildBadge(score));
    }
  });

  it('builds a valid Shields.io endpoint object', () => {
    expect(buildBadge(100)).toEqual({
      schemaVersion: 1,
      label: 'instruction health',
      message: '100/100',
      color: 'brightgreen',
    });
    expect(buildBadge(42)).toEqual({
      schemaVersion: 1,
      label: 'instruction health',
      message: '42/100',
      color: 'red',
    });
  });
});
