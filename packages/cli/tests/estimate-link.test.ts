import { describe, it, expect } from 'vitest';
import { buildEstimateLink } from '../src/estimate-link.js';
import { formatSummary } from '../src/summary.js';
import type { ScanReport } from '@promptci/core';

function report(overrides: Partial<ScanReport> = {}): ScanReport {
  return {
    schemaVersion: '0.1',
    generatedAt: '2026-01-01T00:00:00.000Z',
    repoPath: '/home/someone/secret-client-repo',
    projectType: 'unknown',
    healthScore: 90,
    metrics: {
      estimatedInstructionTokens: 14200,
      instructionFileCount: 1,
      largestInstructionFiles: [{ path: '/home/someone/secret-client-repo/CLAUDE.md', estimatedTokens: 14200 }],
      estimatedAddressableTokens: 6800,
    },
    filesScanned: [],
    issues: [],
    topFixes: [],
    ...overrides,
  };
}

describe('buildEstimateLink', () => {
  it('carries exactly the two integers and the fragment', () => {
    expect(buildEstimateLink(14200, 6800)).toBe(
      'https://promptci.seriousgeese.dev/?tokens=14200&addressable=6800#estimate',
    );
  });

  it('coerces bad input to non-negative integers', () => {
    expect(buildEstimateLink(12.9, -4)).toBe('https://promptci.seriousgeese.dev/?tokens=12&addressable=0#estimate');
    expect(buildEstimateLink(NaN, Infinity)).toBe('https://promptci.seriousgeese.dev/?tokens=0&addressable=0#estimate');
    expect(buildEstimateLink(1e300, 1)).toBe(
      `https://promptci.seriousgeese.dev/?tokens=${Number.MAX_SAFE_INTEGER}&addressable=1#estimate`,
    );
  });
});

describe('formatSummary token lines', () => {
  it('prints both numbers and a link with nothing else in it', () => {
    const out = formatSummary(report());
    expect(out).toContain('Tokens loaded per agent turn: 14200');
    expect(out).toContain('In flagged sections: up to 6800');
    const link = out
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.includes('https://promptci.seriousgeese.dev'))!;
    const url = new URL(link.slice(link.indexOf('http')));
    expect([...url.searchParams.keys()].sort()).toEqual(['addressable', 'tokens']);
    expect(url.searchParams.get('tokens')).toBe('14200');
    expect(url.searchParams.get('addressable')).toBe('6800');
    expect(url.pathname).toBe('/');
    expect(url.hash).toBe('#estimate');
    expect(link).not.toMatch(/secret-client-repo|someone|CLAUDE|\.md/);
  });

  it('never prints addressable above the loaded total', () => {
    const r = report();
    r.metrics!.estimatedAddressableTokens = 99999;
    expect(formatSummary(r)).toContain('In flagged sections: up to 14200');
  });

  it('omits the block when there are no instruction files', () => {
    const r = report();
    r.metrics!.instructionFileCount = 0;
    r.metrics!.estimatedInstructionTokens = 0;
    const out = formatSummary(r);
    expect(out).not.toContain('Tokens loaded');
    expect(out).not.toContain('seriousgeese.dev');
  });

  it('omits the block when the report has no metrics', () => {
    expect(formatSummary(report({ metrics: undefined }))).not.toContain('Tokens loaded');
  });
});
