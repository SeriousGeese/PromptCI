/**
 * Tests for Phase 6: health score computation and top-fix selection.
 */

import { describe, it, expect } from 'vitest';
import { computeHealthScore, selectTopFixes } from '../src/health-score.js';
import type { IssueSeverity, PromptCiIssue } from '../src/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeIssue(
  overrides: Partial<PromptCiIssue> & { severity: IssueSeverity; confidence: number },
): PromptCiIssue {
  return {
    id: overrides.id ?? `issue-${Math.random().toString(36).slice(2, 8)}`,
    severity: overrides.severity,
    category: overrides.category ?? 'duplicate',
    title: overrides.title ?? 'Test issue',
    summary: overrides.summary ?? 'A test issue.',
    filePaths: overrides.filePaths ?? ['/repo/CLAUDE.md'],
    locations: overrides.locations ?? [{ filePath: '/repo/CLAUDE.md' }],
    evidence: overrides.evidence ?? ['evidence line'],
    recommendation: overrides.recommendation ?? 'Fix it.',
    confidence: overrides.confidence,
  };
}

// ── computeHealthScore ────────────────────────────────────────────────────────

describe('computeHealthScore', () => {
  it('returns 100 for an empty issue set', () => {
    expect(computeHealthScore([])).toBe(100);
  });

  it('subtracts 18 × confidence for a critical issue', () => {
    const issues = [makeIssue({ severity: 'critical', confidence: 1.0 })];
    expect(computeHealthScore(issues)).toBe(82);
  });

  it('subtracts 10 × confidence for a high issue', () => {
    const issues = [makeIssue({ severity: 'high', confidence: 1.0 })];
    expect(computeHealthScore(issues)).toBe(90);
  });

  it('subtracts 4 × confidence for a warning issue', () => {
    const issues = [makeIssue({ severity: 'warning', confidence: 1.0 })];
    expect(computeHealthScore(issues)).toBe(96);
  });

  it('subtracts 1 × confidence for an info issue', () => {
    const issues = [makeIssue({ severity: 'info', confidence: 1.0 })];
    expect(computeHealthScore(issues)).toBe(99);
  });

  it('scales penalty by confidence', () => {
    const issues = [makeIssue({ severity: 'high', confidence: 0.5 })];
    // 100 - 10 × 0.5 = 95
    expect(computeHealthScore(issues)).toBe(95);
  });

  it('accumulates penalties from multiple issues (uncapped categories)', () => {
    // Use four different categories that have no per-category cap so the raw formula applies.
    const issues = [
      makeIssue({ severity: 'critical', confidence: 1.0, category: 'conflict' }),       // -18
      makeIssue({ severity: 'high', confidence: 1.0, category: 'missing_context' }),    // -10
      makeIssue({ severity: 'warning', confidence: 1.0, category: 'context_bloat' }),   // -4
      makeIssue({ severity: 'info', confidence: 1.0, category: 'agent_practices' }),    // -1
    ];
    // 100 - 18 - 10 - 4 - 1 = 67
    expect(computeHealthScore(issues)).toBe(67);
  });

  it('clamps to 0 when total penalty exceeds 100 (uncapped category)', () => {
    // 'conflict' has no per-category cap, so 10 critical issues drive score to 0.
    const issues = Array.from({ length: 10 }, () =>
      makeIssue({ severity: 'critical', confidence: 1.0, category: 'conflict' }),
    );
    // 100 - 10 × 18 = -80 → clamped to 0
    expect(computeHealthScore(issues)).toBe(0);
  });

  it('caps per-category deductions to prevent a single noisy detector from zeroing the score', () => {
    // 'structure' (dead refs) is capped at 30 pts. 20 warning issues × 4 × 1.0 = 80 pts raw,
    // but only 30 pts are applied → score = 100 - 30 = 70.
    const issues = Array.from({ length: 20 }, () =>
      makeIssue({ severity: 'warning', confidence: 1.0, category: 'structure' }),
    );
    expect(computeHealthScore(issues)).toBe(70);
  });

  it('never returns a value above 100', () => {
    expect(computeHealthScore([])).toBe(100);
  });

  it('rounds the result to an integer', () => {
    // 100 - 4 × 0.3 = 98.8 → rounds to 99
    const issues = [makeIssue({ severity: 'warning', confidence: 0.3 })];
    const score = computeHealthScore(issues);
    expect(Number.isInteger(score)).toBe(true);
  });

  it('is deterministic — same result regardless of iteration order', () => {
    const a = makeIssue({ id: 'aaa', severity: 'high', confidence: 0.9 });
    const b = makeIssue({ id: 'bbb', severity: 'warning', confidence: 0.6 });
    const c = makeIssue({ id: 'ccc', severity: 'critical', confidence: 0.8 });

    const score1 = computeHealthScore([a, b, c]);
    const score2 = computeHealthScore([c, a, b]);
    const score3 = computeHealthScore([b, c, a]);

    expect(score1).toBe(score2);
    expect(score2).toBe(score3);
  });

  it('handles confidence of 0 without changing the score', () => {
    const issues = [makeIssue({ severity: 'critical', confidence: 0 })];
    expect(computeHealthScore(issues)).toBe(100);
  });
});

// ── selectTopFixes ────────────────────────────────────────────────────────────

describe('selectTopFixes', () => {
  it('returns an empty array when given no issues', () => {
    expect(selectTopFixes([])).toEqual([]);
  });

  it('returns at most 3 items', () => {
    const issues = Array.from({ length: 10 }, (_, i) =>
      makeIssue({ id: `issue-${i}`, severity: 'high', confidence: 0.9 }),
    );
    expect(selectTopFixes(issues).length).toBeLessThanOrEqual(3);
  });

  it('prioritises critical over high over warning over info', () => {
    // Use distinct categories so the per-category dedup does not collapse them
    const issues = [
      makeIssue({ id: 'w1', title: 'Warning issue', severity: 'warning', confidence: 1.0, category: 'stale_instruction' }),
      makeIssue({ id: 'c1', title: 'Critical issue', severity: 'critical', confidence: 1.0, category: 'conflict' }),
      makeIssue({ id: 'h1', title: 'High issue', severity: 'high', confidence: 1.0, category: 'duplicate' }),
      makeIssue({ id: 'i1', title: 'Info issue', severity: 'info', confidence: 1.0, category: 'vague_guidance' }),
    ];
    const fixes = selectTopFixes(issues);
    expect(fixes[0].title).toBe('Critical issue');
    expect(fixes[1].title).toBe('High issue');
    expect(fixes[2].title).toBe('Warning issue');
  });

  it('breaks ties by confidence (higher first)', () => {
    const issues = [
      makeIssue({ id: 'h-low', title: 'Low confidence high', severity: 'high', confidence: 0.5 }),
      makeIssue({ id: 'h-high', title: 'High confidence high', severity: 'high', confidence: 0.9 }),
    ];
    const fixes = selectTopFixes(issues);
    expect(fixes[0].title).toBe('High confidence high');
  });

  it('breaks confidence ties by number of files affected (more files first)', () => {
    const issues = [
      makeIssue({
        id: 'few',
        title: 'Few files',
        severity: 'high',
        confidence: 0.8,
        filePaths: ['/a.md'],
      }),
      makeIssue({
        id: 'many',
        title: 'Many files',
        severity: 'high',
        confidence: 0.8,
        filePaths: ['/a.md', '/b.md', '/c.md'],
      }),
    ];
    const fixes = selectTopFixes(issues);
    expect(fixes[0].title).toBe('Many files');
  });

  it('breaks remaining ties by category then id (alphabetical, stable)', () => {
    const issues = [
      makeIssue({ id: 'zzz', title: 'Issue Z', severity: 'warning', confidence: 0.7, category: 'duplicate' }),
      makeIssue({ id: 'aaa', title: 'Issue A', severity: 'warning', confidence: 0.7, category: 'duplicate' }),
    ];
    const fixes = selectTopFixes(issues);
    // Same category, same confidence, same severity → sort by id → 'aaa' comes first
    expect(fixes[0].title).toBe('Issue A');
  });

  it('suppresses duplicate titles (same title only appears once)', () => {
    const issues = [
      makeIssue({ id: 'dup-1', title: 'Duplicate section', severity: 'high', confidence: 0.9 }),
      makeIssue({ id: 'dup-2', title: 'Duplicate section', severity: 'high', confidence: 0.8 }),
      makeIssue({ id: 'dup-3', title: 'Duplicate section', severity: 'high', confidence: 0.7 }),
      makeIssue({ id: 'other', title: 'Other issue', severity: 'high', confidence: 0.6 }),
    ];
    const fixes = selectTopFixes(issues);
    const titles = fixes.map((f) => f.title);
    const unique = new Set(titles);
    expect(unique.size).toBe(titles.length);
  });

  it('maps issue fields to fix shape correctly', () => {
    const issue = makeIssue({
      id: 'x1',
      title: 'Fix me',
      summary: 'Because reasons.',
      recommendation: 'Do this.',
      severity: 'critical',
      confidence: 1.0,
    });
    const [fix] = selectTopFixes([issue]);
    expect(fix.title).toBe('Fix me');
    expect(fix.reason).toBe('Because reasons.');
    expect(fix.suggestedAction).toBe('Do this.');
  });

  it('is stable — same output for same input on repeated calls', () => {
    const issues = [
      makeIssue({ id: 'a', title: 'A', severity: 'high', confidence: 0.9 }),
      makeIssue({ id: 'b', title: 'B', severity: 'high', confidence: 0.8 }),
      makeIssue({ id: 'c', title: 'C', severity: 'warning', confidence: 1.0 }),
      makeIssue({ id: 'd', title: 'D', severity: 'critical', confidence: 0.7 }),
    ];
    const run1 = selectTopFixes(issues);
    const run2 = selectTopFixes(issues);
    expect(run1).toEqual(run2);
  });

  it('returns fewer than 3 when fewer distinct titles exist', () => {
    const issues = [
      makeIssue({ id: 'x', title: 'Only issue', severity: 'critical', confidence: 1.0 }),
    ];
    expect(selectTopFixes(issues)).toHaveLength(1);
  });

  it('prioritizes high-impact warning over low-impact warning', () => {
    const issues = [
      makeIssue({ id: 'low-imp', title: 'Low impact warning', severity: 'warning', confidence: 0.9, category: 'duplicate' }),
      makeIssue({ id: 'high-imp', title: 'High impact warning', severity: 'warning', confidence: 0.9, category: 'security' }),
    ];
    const fixes = selectTopFixes(issues);
    expect(fixes[0].title).toBe('High impact warning');
  });

  it('maintains severity dominance over impact (critical low-impact outranks warning high-impact)', () => {
    const issues = [
      makeIssue({ id: 'high-imp-warn', title: 'High impact warning', severity: 'warning', confidence: 0.9, category: 'security' }),
      makeIssue({ id: 'low-imp-crit', title: 'Low impact critical', severity: 'critical', confidence: 0.9, category: 'duplicate' }),
    ];
    const fixes = selectTopFixes(issues);
    expect(fixes[0].title).toBe('Low impact critical');
  });
});
