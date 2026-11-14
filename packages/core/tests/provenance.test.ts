/**
 * Provenance records and their rules (pcic-kvv3.1, pcic-kvv3.4; issue #162).
 *
 * Nothing here reads the clock. The 90-day expiry runs from
 * `scripts/check-provenance.mjs` on a schedule: inside `pnpm test` it would turn
 * every build red on the day the records age out, and a rebuild of an old tagged
 * release would fail with it.
 */

import { describe, expect, it } from 'vitest';
import { DETECTORS } from '../src/detectors.js';
import {
  CHECK_PROVENANCE,
  PROVENANCE_MAX_AGE_DAYS,
  PROVENANCE_TOOLS,
  daysSince,
  provenanceDateProblems,
  provenanceExpiringSoon,
  provenanceFor,
  provenanceProblems,
  provenanceStatus,
  provenanceStructureProblems,
} from '../src/index.js';
import type { CheckProvenance, ProvenanceSource } from '../src/index.js';

const source = (over: Partial<ProvenanceSource> = {}): ProvenanceSource => ({
  url: 'https://example.com/docs',
  title: 'Docs',
  readOn: '2026-11-01',
  stance: 'supports',
  note: 'It says so.',
  ...over,
});

const record = (over: Partial<CheckProvenance> = {}): CheckProvenance => ({
  id: 'demo',
  detector: 'duplicates',
  title: 'Demo',
  kind: 'tool-fact',
  claim: 'A tool reads a file.',
  appliesTo: ['claude-code'],
  sources: [source()],
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

describe('provenanceStatus', () => {
  it('derives what a record stands on', () => {
    expect(provenanceStatus(record())).toBe('sourced');
    expect(provenanceStatus(record({ unverified: true, sources: [] }))).toBe('unverified');
    expect(provenanceStatus(record({ refuted: true, sources: [source({ stance: 'contradicts' })] }))).toBe('refuted');
    expect(provenanceStatus(record({ kind: 'repo-fact', appliesTo: 'all', sources: [] }))).toBe('repo-fact');
  });
});

describe('provenanceStructureProblems: what counts as sourced', () => {
  it('passes a tool-fact with a supporting source', () => {
    expect(provenanceStructureProblems([record()])).toEqual([]);
  });

  it('does not count a contradicting or context-only source as a source', () => {
    expect(provenanceStructureProblems([record({ sources: [source({ stance: 'contradicts' })] })])).toHaveLength(1);
    expect(provenanceStructureProblems([record({ sources: [source({ stance: 'context' })] })])).toHaveLength(1);
    expect(provenanceStructureProblems([record({ sources: [] })])).toHaveLength(1);
  });

  it('counts a supporting source for a tool-fact even next to a contradicting one', () => {
    expect(provenanceStructureProblems([record({ sources: [source(), source({ stance: 'contradicts', url: 'https://example.com/b' })] })])).toEqual([]);
  });

  it('needs an eval for an opinion: a supporting documentation page is not enough', () => {
    expect(provenanceStructureProblems([record({ kind: 'opinion' })])).toHaveLength(1);
    expect(provenanceStructureProblems([record({ kind: 'opinion', sources: [], evals: ['evals/foo.md'] })])).toEqual([]);
  });

  it('lets an unverified opinion keep related documentation, but not an unverified tool-fact', () => {
    expect(provenanceStructureProblems([record({ kind: 'opinion', unverified: true, sources: [source(), source({ stance: 'context', url: 'https://e.com/c' })] })])).toEqual([]);
    expect(provenanceStructureProblems([record({ unverified: true, sources: [source({ stance: 'context' })] })])).toEqual([]);
    expect(provenanceStructureProblems([record({ unverified: true })])).toHaveLength(1);
    expect(provenanceStructureProblems([record({ unverified: true, sources: [source({ stance: 'contradicts' })] })])).toHaveLength(1);
  });

  it('accepts refuted only with a contradicting source and nothing supporting', () => {
    const contradicting = source({ stance: 'contradicts' });
    expect(provenanceStructureProblems([record({ refuted: true, sources: [contradicting] })])).toEqual([]);
    expect(provenanceStructureProblems([record({ refuted: true, sources: [source({ stance: 'context' })] })])).toHaveLength(1);
    expect(provenanceStructureProblems([record({ refuted: true, sources: [contradicting, source()] })])).toHaveLength(1);
    expect(provenanceStructureProblems([record({ refuted: true, unverified: true, sources: [contradicting] })]).length).toBeGreaterThan(0);
  });

  it('exempts repo-fact records from needing a source', () => {
    expect(provenanceStructureProblems([record({ kind: 'repo-fact', appliesTo: 'all', sources: [] })])).toEqual([]);
  });

  it('rejects dates that are not real, and a record verified before a source it cites was read', () => {
    expect(provenanceStructureProblems([record({ lastVerified: { date: 'soon', by: 't' } })])).toHaveLength(1);
    expect(provenanceStructureProblems([record({ kind: 'repo-fact', appliesTo: 'all', sources: [], lastVerified: { date: '2026-02-30', by: 't' } })])).toHaveLength(1);
    expect(provenanceStructureProblems([record({ sources: [source({ readOn: 'x' })] })])).toHaveLength(1);
    expect(provenanceStructureProblems([record({ sources: [source({ readOn: '2026-11-05' })] })])).toHaveLength(1);
  });
});

describe('provenanceDateProblems: the clock', () => {
  it('passes a fresh record', () => {
    expect(provenanceDateProblems([record()], '2026-11-13')).toEqual([]);
  });

  it('fails a tool-fact or opinion verified more than 90 days ago, naming the check and the sources to re-read', () => {
    const stale = record({ id: 'ai-config-mcp', lastVerified: { date: '2026-01-01', by: 'test' } });
    const [problem] = provenanceDateProblems([stale], '2026-11-13');
    expect(problem).toContain('ai-config-mcp');
    expect(problem).toContain('days old');
    expect(problem).toContain('https://example.com/docs');
    expect(provenanceDateProblems([record({ kind: 'opinion', lastVerified: { date: '2026-01-01', by: 't' } })], '2026-11-13')).toHaveLength(1);
  });

  it('expires unverified and refuted records too', () => {
    const old = { date: '2026-01-01', by: 't' };
    expect(provenanceDateProblems([record({ unverified: true, sources: [], lastVerified: old })], '2026-11-13')).toHaveLength(1);
  });

  it('allows exactly the limit and fails one day past it', () => {
    const at = (today: string) => provenanceDateProblems([record({ lastVerified: { date: '2026-08-15', by: 't' } })], today);
    expect(daysSince('2026-08-15', '2026-11-13')).toBe(PROVENANCE_MAX_AGE_DAYS);
    expect(at('2026-11-13')).toEqual([]);
    expect(at('2026-11-14')).toHaveLength(1);
  });

  it('exempts repo-fact records from expiry', () => {
    const fact = record({ kind: 'repo-fact', appliesTo: 'all', sources: [], lastVerified: { date: '2025-01-01', by: 't' } });
    expect(provenanceDateProblems([fact], '2026-11-13')).toEqual([]);
  });

  it('rejects a lastVerified or a read date in the future', () => {
    expect(provenanceDateProblems([record({ lastVerified: { date: '2026-12-01', by: 't' } })], '2026-11-13').length).toBeGreaterThan(0);
    expect(provenanceDateProblems([record({ sources: [source({ readOn: '2026-12-01' })] })], '2026-11-13').length).toBeGreaterThan(0);
  });

  it('provenanceProblems is the structure problems plus the date problems', () => {
    const bad = record({ sources: [], lastVerified: { date: '2026-01-01', by: 't' } });
    expect(provenanceProblems([bad], '2026-11-13')).toHaveLength(2);
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

  it('passes the structure rules: every tool-fact has a supporting source, every opinion an eval, otherwise it says unverified or refuted', () => {
    expect(provenanceStructureProblems(CHECK_PROVENANCE)).toEqual([]);
  });

  it('has unique ids that start with the detector id, and well-formed fields', () => {
    const seen = new Set<string>();
    for (const r of CHECK_PROVENANCE) {
      expect(seen.has(r.id), `duplicate id ${r.id}`).toBe(false);
      seen.add(r.id);
      expect(r.id === r.detector || r.id.startsWith(`${r.detector}/`), `${r.id} must be ${r.detector} or ${r.detector}/<family>`).toBe(true);
      expect(r.claim.trim().length, `${r.id} claim`).toBeGreaterThan(20);
      expect(r.claim.trim().split(/(?<=[.!?])\s+/).length, `${r.id}: one sentence`).toBe(1);
      if (r.appliesTo !== 'all' && r.appliesTo !== 'n/a') {
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

  it('does not repeat a source (one page may bear on several parts of a claim, each with its own note)', () => {
    const dupes = CHECK_PROVENANCE.flatMap((r) => {
      const keys = r.sources.map((s) => `${s.stance} ${s.url} ${s.note}`);
      return keys.filter((k, i) => keys.indexOf(k) !== i).map((k) => `${r.id}: ${k}`);
    });
    expect(dupes).toEqual([]);
  });

  it('carries the Gemini CLI replacement notice on every record about gemini-cli', () => {
    const missing = CHECK_PROVENANCE.filter(
      (r) => Array.isArray(r.appliesTo) && r.appliesTo.includes('gemini-cli') && !r.caveat?.includes('Antigravity'),
    ).map((r) => r.id);
    expect(missing).toEqual([]);
  });
});
