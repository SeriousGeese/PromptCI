/**
 * Tests for Baseline & Ratchet logic.
 *
 * Covers spec acceptance criteria:
 *  - Baseline suppresses existing matching issue from fail-on-new
 *  - New issue is surfaced correctly
 *  - Changed severity (worsened) counts as new/worsened
 *  - Fingerprint is stable across line-number shifts
 *  - Fingerprint is stable regardless of filePaths / evidence order
 *  - assertValidBaseline throws clear errors on invalid shapes
 *  - createBaseline produces sorted deterministic output
 *  - Updating baseline writes deterministic JSON (sorted by fingerprint)
 */

import { describe, it, expect } from 'vitest';
import {
  computeFingerprint,
  createBaseline,
  filterNewIssues,
  assertValidBaseline,
} from '../src/baseline.js';
import type { PromptCiIssue } from '../src/types.js';

function makeIssue(overrides: Partial<PromptCiIssue> = {}): PromptCiIssue {
  return {
    id: 'test-id',
    severity: 'warning',
    category: 'duplicate',
    title: 'Test Issue',
    summary: 'Summary',
    filePaths: ['file1.md'],
    locations: [{ filePath: 'file1.md', startLine: 42 }],
    evidence: ['evidence1'],
    recommendation: 'fix it',
    confidence: 0.9,
    ...overrides,
  };
}

// ── computeFingerprint ────────────────────────────────────────────────────────

describe('computeFingerprint', () => {
  it('produces the same hash for two identical issues', () => {
    expect(computeFingerprint(makeIssue())).toBe(computeFingerprint(makeIssue()));
  });

  it('produces different hashes for different categories', () => {
    const a = makeIssue({ category: 'duplicate' });
    const b = makeIssue({ category: 'vague_guidance' });
    expect(computeFingerprint(a)).not.toBe(computeFingerprint(b));
  });

  it('produces different hashes for different titles', () => {
    const a = makeIssue({ title: 'Title A' });
    const b = makeIssue({ title: 'Title B' });
    expect(computeFingerprint(a)).not.toBe(computeFingerprint(b));
  });

  it('is stable regardless of filePaths order', () => {
    const a = makeIssue({ filePaths: ['a.md', 'b.md'] });
    const b = makeIssue({ filePaths: ['b.md', 'a.md'] });
    expect(computeFingerprint(a)).toBe(computeFingerprint(b));
  });

  it('is stable regardless of evidence order', () => {
    const a = makeIssue({ evidence: ['ev1', 'ev2'] });
    const b = makeIssue({ evidence: ['ev2', 'ev1'] });
    expect(computeFingerprint(a)).toBe(computeFingerprint(b));
  });

  it('changes when evidence changes', () => {
    const a = makeIssue({ evidence: ['ev1'] });
    const b = makeIssue({ evidence: ['ev1 changed'] });
    expect(computeFingerprint(a)).not.toBe(computeFingerprint(b));
  });

  it('is NOT affected by line number changes (stable across edits)', () => {
    // Line number is in locations, which is excluded from fingerprint
    const a = makeIssue({ locations: [{ filePath: 'file1.md', startLine: 10 }] });
    const b = makeIssue({ locations: [{ filePath: 'file1.md', startLine: 99 }] });
    expect(computeFingerprint(a)).toBe(computeFingerprint(b));
  });

  it('is NOT affected by severity (severity is tracked separately)', () => {
    const a = makeIssue({ severity: 'warning' });
    const b = makeIssue({ severity: 'high' });
    expect(computeFingerprint(a)).toBe(computeFingerprint(b));
  });

  it('is stable across checkout roots when repoRoot is provided', () => {
    const windowsIssue = makeIssue({
      filePaths: ['C:\\git\\repo\\CLAUDE.md'],
      evidence: ['In file: C:\\git\\repo\\CLAUDE.md'],
    });
    const linuxIssue = makeIssue({
      filePaths: ['/home/runner/work/repo/CLAUDE.md'],
      evidence: ['In file: /home/runner/work/repo/CLAUDE.md'],
    });

    expect(computeFingerprint(windowsIssue, 'C:\\git\\repo')).toBe(
      computeFingerprint(linuxIssue, '/home/runner/work/repo'),
    );
  });
});

// ── createBaseline ────────────────────────────────────────────────────────────

describe('createBaseline', () => {
  it('includes severity in each entry', () => {
    const issue = makeIssue({ severity: 'high' });
    const baseline = createBaseline([issue]);
    expect(baseline[0]!.severity).toBe('high');
  });

  it('includes fingerprint in each entry', () => {
    const issue = makeIssue();
    const baseline = createBaseline([issue]);
    expect(typeof baseline[0]!.fingerprint).toBe('string');
    expect(baseline[0]!.fingerprint.length).toBeGreaterThan(0);
  });

  it('produces a deterministic sorted output (by fingerprint)', () => {
    // Two issues with known fingerprints; result must be sorted
    const a = makeIssue({ title: 'Alpha Issue', category: 'duplicate' });
    const b = makeIssue({ title: 'Beta Issue', category: 'conflict' });
    const baseline1 = createBaseline([a, b]);
    const baseline2 = createBaseline([b, a]); // reversed input
    // Both must produce identical JSON
    expect(JSON.stringify(baseline1)).toBe(JSON.stringify(baseline2));
  });

  it('includes sorted filePaths within each entry', () => {
    const issue = makeIssue({ filePaths: ['z.md', 'a.md'] });
    const baseline = createBaseline([issue]);
    expect(baseline[0]!.filePaths).toEqual(['a.md', 'z.md']);
  });

  it('stores file paths relative to repoRoot when provided', () => {
    const issue = makeIssue({ filePaths: ['C:\\git\\repo\\AGENTS.md'] });
    const baseline = createBaseline([issue], 'C:\\git\\repo');
    expect(baseline[0]!.filePaths).toEqual(['AGENTS.md']);
  });
});

// ── filterNewIssues ───────────────────────────────────────────────────────────

describe('filterNewIssues', () => {
  it('correctly partitions pre-existing and new issues', () => {
    const existing = makeIssue({ id: 'i1', title: 'Existing Issue' });
    const newIssue = makeIssue({ id: 'i2', title: 'New Issue', category: 'conflict' });

    const baseline = createBaseline([existing]);
    const { newIssues, baselinedIssues } = filterNewIssues([existing, newIssue], baseline);

    expect(baselinedIssues).toHaveLength(1);
    expect(baselinedIssues[0]!.id).toBe('i1');
    expect(newIssues).toHaveLength(1);
    expect(newIssues[0]!.id).toBe('i2');
  });

  it('treats an issue with changed evidence as new', () => {
    const original = makeIssue({ title: 'Issue', evidence: ['old evidence'] });
    const baseline = createBaseline([original]);

    const updated = makeIssue({ title: 'Issue', evidence: ['updated evidence'] });
    const { newIssues, baselinedIssues } = filterNewIssues([updated], baseline);

    expect(newIssues).toHaveLength(1);
    expect(baselinedIssues).toHaveLength(0);
  });

  it('treats a worsened severity as a new/worsened issue — spec requirement', () => {
    // Spec: "Worsened severity or confidence should count as new/worsened."
    const original = makeIssue({ severity: 'warning' });
    const baseline = createBaseline([original]);

    // Same fingerprint, but severity escalated to 'high'
    const worsened = makeIssue({ severity: 'high' });
    const { newIssues, baselinedIssues } = filterNewIssues([worsened], baseline);

    expect(newIssues).toHaveLength(1);
    expect(baselinedIssues).toHaveLength(0);
  });

  it('does NOT treat an improved severity as new', () => {
    // Severity decreased: high → warning. Should remain baselined.
    const original = makeIssue({ severity: 'high' });
    const baseline = createBaseline([original]);

    const improved = makeIssue({ severity: 'warning' });
    const { newIssues, baselinedIssues } = filterNewIssues([improved], baseline);

    expect(baselinedIssues).toHaveLength(1);
    expect(newIssues).toHaveLength(0);
  });

  it('treats same severity as baselined (not new)', () => {
    const issue = makeIssue({ severity: 'warning' });
    const baseline = createBaseline([issue]);
    const { newIssues, baselinedIssues } = filterNewIssues([makeIssue({ severity: 'warning' })], baseline);
    expect(baselinedIssues).toHaveLength(1);
    expect(newIssues).toHaveLength(0);
  });

  it('matches baselines created under a different checkout root', () => {
    const baselineIssue = makeIssue({
      filePaths: ['C:\\git\\repo\\CLAUDE.md'],
      evidence: ['In file: C:\\git\\repo\\CLAUDE.md'],
    });
    const activeIssue = makeIssue({
      filePaths: ['/home/runner/work/repo/CLAUDE.md'],
      evidence: ['In file: /home/runner/work/repo/CLAUDE.md'],
    });

    const baseline = createBaseline([baselineIssue], 'C:\\git\\repo');
    const { newIssues, baselinedIssues } = filterNewIssues(
      [activeIssue],
      baseline,
      '/home/runner/work/repo',
    );

    expect(newIssues).toHaveLength(0);
    expect(baselinedIssues).toHaveLength(1);
  });

  it('returns all issues as new when baseline is empty', () => {
    const { newIssues, baselinedIssues } = filterNewIssues([makeIssue()], []);
    expect(newIssues).toHaveLength(1);
    expect(baselinedIssues).toHaveLength(0);
  });

  it('returns empty arrays when issue list is empty', () => {
    const baseline = createBaseline([makeIssue()]);
    const { newIssues, baselinedIssues } = filterNewIssues([], baseline);
    expect(newIssues).toHaveLength(0);
    expect(baselinedIssues).toHaveLength(0);
  });
});

// ── assertValidBaseline ───────────────────────────────────────────────────────

describe('assertValidBaseline', () => {
  it('accepts a valid baseline array', () => {
    const valid = createBaseline([makeIssue()]);
    expect(() => assertValidBaseline(valid)).not.toThrow();
  });

  it('accepts an empty array (no issues baselined)', () => {
    expect(() => assertValidBaseline([])).not.toThrow();
  });

  it('throws when value is not an array', () => {
    expect(() => assertValidBaseline({})).toThrow('JSON array');
    expect(() => assertValidBaseline(null)).toThrow('JSON array');
    expect(() => assertValidBaseline('string')).toThrow('JSON array');
  });

  it('throws a clear error when an entry is missing fingerprint', () => {
    const invalid = [{ category: 'duplicate', title: 'Test' }];
    expect(() => assertValidBaseline(invalid)).toThrow('fingerprint');
  });

  it('throws a clear error when an entry is missing category', () => {
    const invalid = [{ fingerprint: 'abc123', title: 'Test' }];
    expect(() => assertValidBaseline(invalid)).toThrow('category');
  });

  it('throws when an entry is not an object', () => {
    expect(() => assertValidBaseline(['string-entry'])).toThrow('index 0');
  });

  it('includes the entry index in the error for easier debugging', () => {
    const mixed = [
      createBaseline([makeIssue()])[0]!, // valid
      { title: 'bad entry' }, // missing fingerprint and category
    ];
    expect(() => assertValidBaseline(mixed)).toThrow('index 1');
  });
});
