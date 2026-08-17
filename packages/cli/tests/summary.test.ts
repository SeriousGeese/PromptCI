import { describe, it, expect } from 'vitest';
import { formatSummary, meetsThreshold, anyIssuesMeetThreshold, severityRank } from '../src/summary.js';
import type { ScanReport, PromptCiIssue } from '@promptci/core';

function makeReport(overrides: Partial<ScanReport> = {}): ScanReport {
  return {
    schemaVersion: '0.1',
    generatedAt: '2026-01-01T00:00:00.000Z',
    repoPath: '/tmp/repo',
    projectType: 'unknown',
    healthScore: 100,
    filesScanned: [],
    issues: [],
    topFixes: [],
    ...overrides,
  };
}

function makeIssue(severity: PromptCiIssue['severity']): PromptCiIssue {
  return {
    id: `test-${severity}`,
    severity,
    category: 'vague_guidance',
    title: `Test ${severity}`,
    summary: 'Test summary',
    filePaths: [],
    locations: [],
    evidence: [],
    recommendation: 'Fix it',
    confidence: 0.8,
  };
}

describe('severityRank', () => {
  it('orders info < warning < high < critical', () => {
    expect(severityRank('info')).toBeLessThan(severityRank('warning'));
    expect(severityRank('warning')).toBeLessThan(severityRank('high'));
    expect(severityRank('high')).toBeLessThan(severityRank('critical'));
  });
});

describe('meetsThreshold', () => {
  it('returns true when severity equals threshold', () => {
    expect(meetsThreshold('high', 'high')).toBe(true);
  });

  it('returns true when severity exceeds threshold', () => {
    expect(meetsThreshold('critical', 'high')).toBe(true);
    expect(meetsThreshold('high', 'warning')).toBe(true);
  });

  it('returns false when severity is below threshold', () => {
    expect(meetsThreshold('warning', 'high')).toBe(false);
    expect(meetsThreshold('info', 'critical')).toBe(false);
  });
});

describe('anyIssuesMeetThreshold', () => {
  it('returns false when no issues exist', () => {
    expect(anyIssuesMeetThreshold(makeReport(), 'info')).toBe(false);
  });

  it('returns true when an issue meets the threshold', () => {
    const report = makeReport({ issues: [makeIssue('high')] });
    expect(anyIssuesMeetThreshold(report, 'high')).toBe(true);
    expect(anyIssuesMeetThreshold(report, 'warning')).toBe(true);
  });

  it('returns false when all issues are below threshold', () => {
    const report = makeReport({ issues: [makeIssue('info'), makeIssue('warning')] });
    expect(anyIssuesMeetThreshold(report, 'high')).toBe(false);
  });
});

describe('formatSummary', () => {
  it('includes health score', () => {
    const summary = formatSummary(makeReport({ healthScore: 72 }));
    expect(summary).toContain('72/100');
  });

  it('shows "none" when there are no issues', () => {
    const summary = formatSummary(makeReport());
    expect(summary).toContain('none');
  });

  it('shows issue counts by severity', () => {
    const report = makeReport({
      issues: [makeIssue('critical'), makeIssue('high'), makeIssue('high')],
    });
    const summary = formatSummary(report);
    expect(summary).toContain('2 high');
    expect(summary).toContain('1 critical');
  });

  it('lists top fixes', () => {
    const report = makeReport({
      topFixes: [
        { title: 'Fix vague guidance', reason: 'r', suggestedAction: 'a' },
        { title: 'Remove stale refs', reason: 'r', suggestedAction: 'a' },
      ],
    });
    const summary = formatSummary(report);
    expect(summary).toContain('Fix vague guidance');
    expect(summary).toContain('Remove stale refs');
  });

  it('includes output paths when provided', () => {
    const summary = formatSummary(makeReport(), {
      mdPath: '/out/latest.md',
      jsonPath: '/out/report.json',
    });
    // Paths are shown relative to CWD, so we check for the filename suffix
    expect(summary).toContain('latest.md');
    expect(summary).toContain('report.json');
    expect(summary).toContain('Output:');
  });

  it('omits output section when no paths given', () => {
    const summary = formatSummary(makeReport());
    expect(summary).not.toContain('Output:');
  });

  it('includes trend score change and new/resolved issue counts in the summary', () => {
    const report = makeReport({
      healthScore: 92,
      trend: {
        scoreDelta: 6,
        newIssuesCount: 0,
        resolvedIssuesCount: 3,
        severityDeltas: {},
        categoryDeltas: {},
        newIssueIds: [],
        resolvedIssueIds: [],
        streak: 5,
      },
    });
    const summary = formatSummary(report);
    expect(summary).toContain('+6 vs last scan');
    expect(summary).toContain('new issues: 0');
    expect(summary).toContain('resolved: 3');
    expect(summary).toContain('Streak: 5 scan(s) without high/critical issues');
  });
});
