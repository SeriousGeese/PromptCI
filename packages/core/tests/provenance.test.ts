/**
 * Provenance records and their expiry test (pcic-kvv3.1, pcic-kvv3.4; issue #162).
 *
 * The last block is the expiry test itself and reads the real clock: it is meant
 * to go red when a tool-fact or opinion check is left unverified for more than 90
 * days, so that re-verifying is a build failure and not something to remember.
 */

import { describe, expect, it } from 'vitest';
import { DETECTORS } from '../src/detectors.js';
import {
  CHECK_PROVENANCE,
  PROVENANCE_MAX_AGE_DAYS,
  PROVENANCE_TOOLS,
  daysSince,
  provenanceExpiringSoon,
  provenanceFor,
  provenanceProblems,
} from '../src/index.js';
import type { CheckProvenance } from '../src/index.js';

const record = (over: Partial<CheckProvenance> = {}): CheckProvenance => ({
  id: 'demo',
  detector: 'duplicates',
  title: 'Demo',
  kind: 'tool-fact',
  claim: 'A tool reads a file.',
  appliesTo: ['claude-code'],
  sources: [{ url: 'https://example.com/docs', title: 'Docs', readOn: '2026-11-01', stance: 'supports', note: 'It says so.' }],
  lastVerified: { date: '2026-11-01', by: 'test' },
  ...over,
});

describe('daysSince', () => {
  it('counts whole days and rejects what is not a date', () => {
    expect(daysSince('2026-11-01', '2026-11-13')).toBe(12);
    expect(daysSince('2026-02-30', '2026-11-13')).toBeUndefined();
    expect(daysSince('11/01/2026', '2026-11-13')).toBeUndefined();
  });
});

describe('provenanceProblems', () => {
  it('passes a fresh sourced tool-fact', () => {
    expect(provenanceProblems([record()], '2026-11-13')).toEqual([]);
  });

  it('fails a tool-fact or opinion verified more than 90 days ago, naming the check and the sources to re-read', () => {
    const stale = record({ id: 'ai-config-mcp', lastVerified: { date: '2026-01-01', by: 'test' } });
    const [problem] = provenanceProblems([stale], '2026-11-13');
    expect(problem).toContain('ai-config-mcp');
    expect(problem).toContain('days old');
    expect(problem).toContain('https://example.com/docs');
    expect(provenanceProblems([record({ kind: 'opinion', lastVerified: { date: '2026-01-01', by: 't' } })], '2026-11-13')).toHaveLength(1);
  });

  it('allows exactly the limit and fails one day past it', () => {
    const at = (today: string) => provenanceProblems([record({ lastVerified: { date: '2026-08-15', by: 't' } })], today);
    expect(daysSince('2026-08-15', '2026-11-13')).toBe(PROVENANCE_MAX_AGE_DAYS);
    expect(at('2026-11-13')).toEqual([]);
    expect(at('2026-11-14')).toHaveLength(1);
  });

  it('exempts repo-fact records from expiry and from needing a source', () => {
    const fact = record({ kind: 'repo-fact', appliesTo: 'all', sources: [], lastVerified: { date: '2025-01-01', by: 't' } });
    expect(provenanceProblems([fact], '2026-11-13')).toEqual([]);
  });

  it('fails a tool-fact or opinion with no source that is not explicitly unverified', () => {
    expect(provenanceProblems([record({ sources: [] })], '2026-11-13')).toHaveLength(1);
    expect(provenanceProblems([record({ kind: 'opinion', sources: [] })], '2026-11-13')).toHaveLength(1);
    expect(provenanceProblems([record({ sources: [], unverified: true })], '2026-11-13')).toEqual([]);
    expect(provenanceProblems([record({ kind: 'opinion', sources: [], evals: ['evals/foo.md'] })], '2026-11-13')).toEqual([]);
  });

  it('fails a record that says unverified and lists a source', () => {
    expect(provenanceProblems([record({ unverified: true })], '2026-11-13')).toHaveLength(1);
  });

  it('does not let a malformed date dodge expiry, for any kind', () => {
    expect(provenanceProblems([record({ lastVerified: { date: 'soon', by: 't' } })], '2026-11-13')).toHaveLength(1);
    expect(provenanceProblems([record({ kind: 'repo-fact', lastVerified: { date: 'soon', by: 't' } })], '2026-11-13')).toHaveLength(1);
    expect(
      provenanceProblems([record({ sources: [{ url: 'https://e.com', title: 't', readOn: 'x', stance: 'supports', note: 'n' }] })], '2026-11-13'),
    ).toHaveLength(1);
  });
});

describe('provenanceExpiringSoon', () => {
  it('lists non-repo-fact records within 30 days of the limit, for the monthly triage', () => {
    const today = '2026-11-13';
    const soon = record({ id: 'soon', lastVerified: { date: '2026-09-10', by: 't' } }); // 64 days old
    const fresh = record({ id: 'fresh', lastVerified: { date: '2026-11-01', by: 't' } });
    const fact = record({ id: 'fact', kind: 'repo-fact', appliesTo: 'all', lastVerified: { date: '2025-01-01', by: 't' } });
    expect(provenanceExpiringSoon([soon, fresh, fact], today).map((r) => r.id)).toEqual(['soon']);
    // The window is inclusive: exactly 30 days left (60 days old) counts, 31 days left does not.
    const edge = record({ id: 'edge', lastVerified: { date: '2026-09-14', by: 't' } }); // 60 days old
    const before = record({ id: 'before', lastVerified: { date: '2026-09-15', by: 't' } }); // 59 days old
    expect(provenanceExpiringSoon([edge, before], today).map((r) => r.id)).toEqual(['edge']);
  });
});

describe('the registry', () => {
  it('has a record for every detector and none for a detector that does not exist', () => {
    const ids = new Set(DETECTORS.map((d) => d.id));
    const missing = [...ids].filter((id) => provenanceFor(id).length === 0);
    const stray = CHECK_PROVENANCE.filter((r) => !ids.has(r.detector)).map((r) => `${r.id} -> ${r.detector}`);
    expect({ missing, stray }).toEqual({ missing: [], stray: [] });
  });

  it('has unique ids that start with the detector id, and well-formed fields', () => {
    const seen = new Set<string>();
    for (const r of CHECK_PROVENANCE) {
      expect(seen.has(r.id), `duplicate id ${r.id}`).toBe(false);
      seen.add(r.id);
      expect(r.id === r.detector || r.id.startsWith(`${r.detector}/`), `${r.id} must be ${r.detector} or ${r.detector}/<family>`).toBe(true);
      expect(r.claim.trim().length, `${r.id} claim`).toBeGreaterThan(20);
      expect(r.claim.trim().split(/(?<=[.!?])\s+/).length, `${r.id}: one sentence`).toBe(1);
      if (r.appliesTo !== 'all') {
        expect(r.appliesTo.length, `${r.id} appliesTo`).toBeGreaterThan(0);
        for (const tool of r.appliesTo) expect(PROVENANCE_TOOLS).toContain(tool);
      }
      if (r.kind === 'repo-fact') expect(r.appliesTo, `${r.id}: a repo-fact applies to all`).toBe('all');
      for (const s of r.sources) expect(s.url, `${r.id} source`).toMatch(/^https:\/\/\S+$/);
      for (const t of r.thresholds ?? []) {
        if (t.source !== 'unverified') expect(t.source.url).toMatch(/^https:\/\//);
      }
    }
  });

  it('never records a source read in the future', () => {
    const today = new Date().toISOString().slice(0, 10);
    const future = CHECK_PROVENANCE.flatMap((r) =>
      [...r.sources.map((s) => s.readOn), r.lastVerified.date].filter((d) => d > today).map((d) => `${r.id}: ${d}`),
    );
    expect(future).toEqual([]);
  });
});

describe('expiry test (pcic-kvv3.4)', () => {
  it('no tool-fact or opinion check is older than 90 days or lacks a source or an explicit unverified', () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(provenanceProblems(CHECK_PROVENANCE, today)).toEqual([]);
  });
});
