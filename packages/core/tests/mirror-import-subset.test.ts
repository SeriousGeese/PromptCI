/**
 * pcic-5rop.64: the mirror import's explicit `subset` mode. After a
 * consolidation, AGENTS.md holds CLAUDE.md's rules plus the other tools', so
 * CLAUDE.md is a subset of it. The default import refuses that (it would add
 * text Claude did not read); `subset` makes the edit and reports what Claude
 * gains. Every other refusal still holds in subset mode.
 *
 * Oracle: the expected file text and `gained` list are written out by hand
 * for each shape, and each refusal is the exact reason string.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../src/scan.js';
import { applyFixRecipe, planMirrorImport } from '../src/fix-engine.js';
import { computeFingerprint } from '../src/baseline.js';
import { consolidateWithImport, subsetImportCaveat } from '../src/mirror-import.js';
import type { PromptCiIssue } from '../src/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.resolve(__dirname, '../../../examples', name);
const isMirror = (i: PromptCiIssue) => (i.tags ?? []).includes('mirrored-files');
const PATHS = { copyRel: 'CLAUDE.md', canonicalRel: 'AGENTS.md', importPath: 'AGENTS.md' };

const A = '## Stack\n\nTypeScript HTTP API on Fastify with PostgreSQL through Drizzle ORM.\n';
const B = '## Commands\n\nRun `pnpm lint`, `pnpm typecheck` and `pnpm test` before saying a change is done.\n';
const C = '## Codex sandbox\n\nCodex runs without network access, so vendor every fixture it needs.\n';
const D = '## Cursor background agents\n\nBackground agents still run the unit tests before opening a pull request.\n';
const TAIL = '## Claude Code only\n\nUse the `/review` slash command before asking for a human review.\n';
const join = (...sections: string[]) => sections.join('\n');

async function mirrorOf(root: string): Promise<PromptCiIssue> {
  const mirrors = (await scan({ repoPath: root })).issues.filter(isMirror);
  expect(mirrors, 'one mirror finding').toHaveLength(1);
  return mirrors[0]!;
}

function tempRepo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-import-subset-'));
  for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(root, rel), text);
  return root;
}

describe('consolidateWithImport: subset mode accepts a copy that skips canonical sections', () => {
  it.each([
    ['a gap at the end', join(A, B, C, D), join(A, B), '@AGENTS.md\n', ['Codex sandbox', 'Cursor background agents']],
    ['a gap in the middle', join(A, B, C, D), join(A, C), '@AGENTS.md\n', ['Commands', 'Cursor background agents']],
    ['a gap at the start', join(A, B, C), join(B, C), '@AGENTS.md\n', ['Stack']],
    ['a kept Claude-only tail', join(A, B, C), join(A, B, TAIL), `@AGENTS.md\n\n${TAIL}`, ['Codex sandbox']],
    ['a canonical preamble the copy lacks', `Shared rules for every agent.\n\n${join(A, B)}`, join(A, B), '@AGENTS.md\n', ['(text before the first heading)']],
    ['front matter stays on top', join(A, B, C), `---\ndescription: x\n---\n${join(A, B)}`, '---\ndescription: x\n---\n@AGENTS.md\n', ['Codex sandbox']],
    ['CRLF line endings are kept', join(A, B, C), join(A, B).replace(/\n/g, '\r\n'), '@AGENTS.md\r\n', ['Codex sandbox']],
  ])('%s', (_name, canonical, copy, expected, gained) => {
    const exact = consolidateWithImport(copy, canonical, PATHS);
    expect(exact.ok).toBe(false);
    if (!exact.ok) expect(exact.reason).toMatch(/^CLAUDE\.md lacks text that AGENTS\.md has \(.+\); an import would add it$/);
    const result = consolidateWithImport(copy, canonical, PATHS, { subset: true });
    expect(result).toMatchObject({ ok: true, newContent: expected, gained });
  });

  it('a copy that already imports AGENTS.md on top gains nothing: Claude Code reads those sections already (review of PR 224)', () => {
    const result = consolidateWithImport(`@AGENTS.md\n\n${join(A, B)}`, join(A, B, C), PATHS, { subset: true });
    expect(result).toEqual({ ok: true, newContent: '@AGENTS.md\n', dropped: ['Stack', 'Commands'], kept: [], gained: [] });
  });

  it('a complete copy: subset mode makes the same edit as the default, and gains nothing', () => {
    for (const [canonical, copy] of [
      [join(A, B, C), join(A, B, C)],
      [join(A, B), join(A, B, TAIL)],
    ] as const) {
      const exact = consolidateWithImport(copy, canonical, PATHS);
      const subset = consolidateWithImport(copy, canonical, PATHS, { subset: true });
      expect(exact).toMatchObject({ ok: true, gained: [] });
      expect(subset).toEqual(exact);
    }
  });

  it.each([
    ['drift: a section under a canonical heading with other text', join(A, B, C), join(A, B.replace('before saying', 'after saying')), '"Commands" differs between CLAUDE.md and AGENTS.md (drift)'],
    ['the copied sections in another order', join(A, B, C), join(B, A), 'CLAUDE.md has the sections of AGENTS.md in another order (or more than once)'],
    ['a copied section twice', join(A, B, C), join(A, A), 'CLAUDE.md has the sections of AGENTS.md in another order (or more than once)'],
    ['a Claude-only section before a copied one', join(A, B, C), join(TAIL, A), 'a section only CLAUDE.md has comes before "Stack"; it would move'],
    ['a Claude-only section nested under a copied one', join(A, B, C), join(A, '### Exceptions\n\nNone.\n'), '"Exceptions" sits under a section being removed; it would read as part of AGENTS.md'],
    ['nothing copied', join(A, B), TAIL, 'CLAUDE.md repeats nothing from AGENTS.md'],
    ['a canonical section twice', join(A, B, A), join(A), 'AGENTS.md has the same section more than once; consolidate it there first'],
    ['a canonical file that imports the copy', `@CLAUDE.md\n\n${join(A, B)}`, join(A), 'AGENTS.md imports CLAUDE.md (circular)'],
  ])('still refused in subset mode: %s', (_name, canonical, copy, reason) => {
    expect(consolidateWithImport(copy, canonical, PATHS, { subset: true })).toEqual({ ok: false, reason });
  });

  it('still refused in subset mode: a copy in another directory', () => {
    const result = consolidateWithImport(join(A), join(A, B), { copyRel: 'sub/CLAUDE.md', canonicalRel: 'AGENTS.md', importPath: '../AGENTS.md' }, { subset: true });
    expect(result).toEqual({
      ok: false,
      reason: "sub/CLAUDE.md is not in AGENTS.md's directory: relative @ paths in the shared text would resolve from another directory after the edit",
    });
  });
});

describe('planMirrorImport and applyFixRecipe: subset mode on real files', () => {
  it('fixture-mirror-refuse-canonical-extra: refused by default; with subset, one import line and the gained sections', async () => {
    const root = fixture('fixture-mirror-refuse-canonical-extra');
    const mirror = await mirrorOf(root);
    const plain = await planMirrorImport(mirror, root);
    expect(plain).toEqual({
      changes: [],
      refusals: ['CLAUDE.md lacks text that AGENTS.md has (Codex sandbox, Cursor background agents); an import would add it'],
      untouched: [],
      gained: [],
    });
    const subset = await planMirrorImport(mirror, root, { subset: true });
    expect(subset.refusals).toEqual([]);
    expect(subset.gained).toEqual(['Codex sandbox', 'Cursor background agents']);
    expect(subset.changes.map((c) => [path.basename(c.filePath), c.newContent])).toEqual([['CLAUDE.md', '@AGENTS.md\n']]);
  });

  it.each([
    ['fixture-mirrored-drift', '"Database rules" differs between CLAUDE.md and AGENTS.md (drift)'],
    ['fixture-mirror-refuse-reordered', 'CLAUDE.md has the sections of AGENTS.md in another order (or more than once)'],
    ['fixture-mirror-refuse-copy-first', 'a section only CLAUDE.md has comes before "Agent Guidelines"; it would move'],
    ['fixture-mirror-refuse-nested-kept', '"Exceptions" sits under a section being removed; it would read as part of AGENTS.md'],
    ['fixture-mirror-refuse-circular', 'AGENTS.md imports CLAUDE.md (circular)'],
    ['fixture-mirror-refuse-canonical-dup', 'AGENTS.md has the same section more than once; consolidate it there first'],
  ])('%s: still refused with subset', async (name, reason) => {
    const root = fixture(name);
    const mirror = await mirrorOf(root);
    const plan = await planMirrorImport(mirror, root, { subset: true });
    expect(plan.changes).toEqual([]);
    expect(plan.gained).toEqual([]);
    expect(plan.refusals).toEqual([reason]);
    expect(await applyFixRecipe(mirror, root, { optIn: true, importSubset: true })).toEqual([]);
  });

  it('applyFixRecipe: subset needs the opt-in too; with both, the edit lands, the score rises and nothing new appears', async () => {
    // The consolidated shape: the canonical-extra fixture's CLAUDE.md (a subset of its AGENTS.md)
    // plus a Claude-only tail, which must stay below the import.
    const src = fixture('fixture-mirror-refuse-canonical-extra');
    const claude = fs.readFileSync(path.join(src, 'CLAUDE.md'), 'utf-8');
    const root = tempRepo({ 'AGENTS.md': fs.readFileSync(path.join(src, 'AGENTS.md'), 'utf-8'), 'CLAUDE.md': join(claude, TAIL) });
    try {
      const before = await scan({ repoPath: root });
      const mirror = before.issues.find(isMirror)!;
      expect(mirror).toBeDefined();
      expect(await applyFixRecipe(mirror, root, { importSubset: true })).toEqual([]);
      expect(await applyFixRecipe(mirror, root, { optIn: true })).toEqual([]);
      const changes = await applyFixRecipe(mirror, root, { optIn: true, importSubset: true });
      expect(changes.map((c) => [path.basename(c.filePath), c.newContent])).toEqual([['CLAUDE.md', `@AGENTS.md\n\n${TAIL}`]]);
      for (const change of changes) fs.writeFileSync(change.filePath, change.newContent);
      const after = await scan({ repoPath: root });
      const beforeKeys = new Set(before.issues.map((i) => computeFingerprint(i, root)));
      expect(after.issues.filter((i) => !beforeKeys.has(computeFingerprint(i, root)))).toEqual([]);
      expect(after.issues.filter((i) => i.category === 'duplicate')).toEqual([]);
      expect(after.healthScore).toBeGreaterThanOrEqual(before.healthScore);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('subsetImportCaveat', () => {
  it('names every gained section and says nothing in CLAUDE.md is lost', () => {
    expect(subsetImportCaveat(['Codex sandbox', 'Cursor background agents'])).toBe(
      'CLAUDE.md has fewer sections than AGENTS.md, so after this import Claude Code also reads the 2 sections only ' +
        'AGENTS.md has: Codex sandbox, Cursor background agents. Nothing in CLAUDE.md is lost: every section the edit ' +
        'removes is the same text in AGENTS.md, and any section only CLAUDE.md has stays below the import.',
    );
    expect(subsetImportCaveat(['Codex sandbox'])).toContain('also reads the section only AGENTS.md has: Codex sandbox.');
  });

  it('is empty when nothing is gained', () => {
    expect(subsetImportCaveat([])).toBe('');
  });
});
