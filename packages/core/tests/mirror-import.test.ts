/**
 * pcic-1ik0.10: the mirrored-files finding is advisory. Its CLAUDE.md import
 * recipe runs only on an explicit opt-in (`applyFixRecipe(..., { optIn })`,
 * i.e. `promptci fix --issue <id>`), edits only a repo-root CLAUDE.md copy of
 * the repo-root AGENTS.md, never .claude/CLAUDE.md or GEMINI.md, and is
 * refused for every shape where the edit would add, lose or move text.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../src/scan.js';
import { applyFixRecipe, isRepairable, planMirrorImport } from '../src/fix-engine.js';
import { computeFingerprint } from '../src/baseline.js';
import { importRecipeTarget } from '../src/mirror-import.js';
import type { PromptCiIssue } from '../src/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.resolve(__dirname, '../../../examples', name);
const isMirror = (i: PromptCiIssue) => (i.tags ?? []).includes('mirrored-files');
const DOTCLAUDE =
  ".claude/CLAUDE.md: not edited (it is not in AGENTS.md's directory, so relative @ paths in the shared text would resolve from another directory after the edit)";

async function mirrorOf(root: string): Promise<PromptCiIssue> {
  const mirrors = (await scan({ repoPath: root })).issues.filter(isMirror);
  expect(mirrors, 'one mirror finding').toHaveLength(1);
  return mirrors[0]!;
}

/** Copy a fixture, apply the mirror recipe with the opt-in, rescan. */
async function optInFix(name: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `promptci-import-${name}-`));
  try {
    fs.cpSync(fixture(name), root, { recursive: true });
    const before = await scan({ repoPath: root });
    const mirror = before.issues.find(isMirror)!;
    const files: Record<string, string> = {};
    for (const change of await applyFixRecipe(mirror, root, { optIn: true })) {
      fs.writeFileSync(change.filePath, change.newContent);
      files[path.relative(root, change.filePath).replace(/\\/g, '/')] = change.newContent;
    }
    const after = await scan({ repoPath: root });
    const beforeKeys = new Set(before.issues.map((i) => computeFingerprint(i, root)));
    const added = after.issues.filter((i) => !beforeKeys.has(computeFingerprint(i, root)));
    return { before, after, files, added, untouched: fs.readdirSync(root) };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('the mirrored-files finding is advisory', () => {
  it.each(['fixture-mirror-import', 'fixture-mirror-import-gemini', 'fixture-mirrored-instructions'])(
    '%s: autoApplySafe false, and no edit without the opt-in',
    async (name) => {
      const mirror = await mirrorOf(fixture(name));
      expect(mirror.autoApplySafe).toBe(false);
      expect(isRepairable(mirror)).toBe(false);
      expect(await applyFixRecipe(mirror, fixture(name))).toEqual([]);
    },
  );

  it('says cautiously where the import loads, suggests the exact line and the opt-in command', async () => {
    const mirror = await mirrorOf(fixture('fixture-mirror-import-gemini'));
    expect(mirror.recommendation).toContain('the line `@AGENTS.md`');
    expect(mirror.recommendation).toContain(`promptci fix --issue ${mirror.id}`);
    expect(mirror.recommendation).toContain('when the session starts at the repository root');
    expect(mirror.recommendation).toContain('needs a one-time approval');
    expect(mirror.recommendation).toContain('GEMINI.md: keep its text');
    expect(mirror.recommendation).not.toMatch(/loads? in place/);
  });

  it('a .claude/CLAUDE.md mirror: the finding says it is not edited, and why', async () => {
    const mirror = await mirrorOf(fixture('fixture-mirror-refuse-dotclaude'));
    expect(mirror.recommendation).toContain('.claude/CLAUDE.md is not edited by `promptci fix`');
    expect(mirror.recommendation).toContain('relative @ paths in the shared text would resolve from another directory');
    expect(mirror.recommendation).not.toContain('@../AGENTS.md');
  });
});

describe('the opt-in import edit (fixtures)', () => {
  it('fixture-mirror-import: CLAUDE.md becomes one import; the score goes up; nothing new', async () => {
    const { before, after, files, added } = await optInFix('fixture-mirror-import');
    expect(files).toEqual({ 'CLAUDE.md': '@AGENTS.md\n' });
    expect(added).toEqual([]);
    expect(after.healthScore).toBeGreaterThan(before.healthScore);
    expect(after.issues.filter((i) => i.category === 'duplicate')).toEqual([]);
    expect(after.issues.filter((i) => i.id.startsWith('per-file-behavior'))).toEqual([]);
  });

  it('fixture-mirror-import-extra: a trailing Claude-only section stays, below the import', async () => {
    const { files, added } = await optInFix('fixture-mirror-import-extra');
    expect(files['CLAUDE.md']).toMatch(/^@AGENTS\.md\n\n## Claude Code only\n\nUse the `\/review` slash command/);
    expect(added).toEqual([]);
  });

  it('fixture-mirror-import-kept-import: a live @AGENTS.md in a kept section is not "already imported"; the line goes on top', async () => {
    const { files, added } = await optInFix('fixture-mirror-import-kept-import');
    expect(files['CLAUDE.md']).toMatch(/^@AGENTS\.md\n\n## Claude notes\n/);
    expect(files['CLAUDE.md']).toMatch(/\n@AGENTS\.md\n$/);
    expect(added).toEqual([]);
  });

  it('fixture-mirror-import-gemini: GEMINI.md keeps its text; only CLAUDE.md is edited', async () => {
    const root = fixture('fixture-mirror-import-gemini');
    const plan = await planMirrorImport(await mirrorOf(root), root);
    expect(plan.changes.map((c) => path.basename(c.filePath))).toEqual(['CLAUDE.md']);
    expect(plan.untouched).toEqual(['GEMINI.md: not edited (an @ import in GEMINI.md does not load in every Gemini tool)']);
    const { files, added } = await optInFix('fixture-mirror-import-gemini');
    expect(Object.keys(files)).toEqual(['CLAUDE.md']);
    expect(added).toEqual([]);
  });

  it('fixture-mirror-import-pre-example: an @AGENTS.md shown inside <pre> does not stop the real import (review B1)', async () => {
    const { files, added } = await optInFix('fixture-mirror-import-pre-example');
    expect(files['CLAUDE.md']).toMatch(/^@AGENTS\.md\n\n## Claude notes\n/);
    expect(files['CLAUDE.md']).toContain('<pre>\n@AGENTS.md\n</pre>');
    expect(added).toEqual([]);
  });

  it('fixture-mirror-import-subtree: a trailing Claude-only section and its subsection stay', async () => {
    const { files, added } = await optInFix('fixture-mirror-import-subtree');
    expect(files['CLAUDE.md']).toMatch(/^@AGENTS\.md\n\n## Claude Code only\n[\s\S]*\n### Slash commands\n/);
    expect(added).toEqual([]);
  });

  it('fixture-mirror-import-clean: a repository that already imports stays clean', async () => {
    const report = await scan({ repoPath: fixture('fixture-mirror-import-clean') });
    expect(report.issues.filter((i) => i.category === 'duplicate')).toEqual([]);
    expect(report.issues.filter((i) => i.id.startsWith('per-file-behavior') || i.title.startsWith('Missing critical guidance'))).toEqual([]);
  });
});

describe('refused shapes: a mirror finding, and no edit even with the opt-in (fixtures)', () => {
  it.each([
    ['fixture-mirror-refuse-canonical-extra', 'CLAUDE.md lacks text that AGENTS.md has (Codex sandbox, Cursor background agents); an import would add it'],
    ['fixture-mirror-refuse-preamble', 'CLAUDE.md lacks text that AGENTS.md has ((text before the first heading)); an import would add it'],
    ['fixture-mirror-refuse-nested-kept', '"Exceptions" sits under a section being removed; it would read as part of AGENTS.md'],
    ['fixture-mirror-refuse-copy-first', 'a section only CLAUDE.md has comes before "Agent Guidelines"; it would move'],
    ['fixture-mirror-refuse-middle', 'a section only CLAUDE.md has comes before "Database rules"; it would move'],
    ['fixture-mirror-refuse-comment-import', 'a section only CLAUDE.md has comes before "Agent Guidelines"; it would move'],
    ['fixture-mirror-refuse-circular', 'AGENTS.md imports CLAUDE.md (circular)'],
    ['fixture-mirror-refuse-dotclaude', DOTCLAUDE],
    ['fixture-mirror-refuse-dotclaude-relative', DOTCLAUDE],
    ['fixture-mirror-refuse-canonical-dup', 'AGENTS.md has the same section more than once; consolidate it there first'],
    ['fixture-mirror-refuse-reordered', 'CLAUDE.md has the sections of AGENTS.md in another order (or more than once)'],
    ['fixture-mirrored-drift', 'CLAUDE.md lacks text that AGENTS.md has (Database rules); an import would add it'],
  ])('%s', async (name, reason) => {
    const root = fixture(name);
    const mirror = await mirrorOf(root);
    expect(mirror.autoApplySafe).toBe(false);
    const plan = await planMirrorImport(mirror, root);
    expect(plan.changes).toEqual([]);
    expect(plan.refusals).toEqual([reason]);
    expect(await applyFixRecipe(mirror, root, { optIn: true })).toEqual([]);
  });
});

describe('importRecipeTarget: which copies the recipe may edit', () => {
  it('only a repo-root CLAUDE.md, importing the repo-root AGENTS.md', () => {
    expect(importRecipeTarget('CLAUDE.md', 'AGENTS.md')).toBe('AGENTS.md');
    expect(importRecipeTarget('.claude/CLAUDE.md', 'AGENTS.md')).toBeUndefined();
    expect(importRecipeTarget('packages/api/CLAUDE.md', 'AGENTS.md')).toBeUndefined();
    expect(importRecipeTarget('GEMINI.md', 'AGENTS.md')).toBeUndefined();
    expect(importRecipeTarget('CLAUDE.md', 'docs/AGENTS.md')).toBeUndefined();
    expect(importRecipeTarget('.github/copilot-instructions.md', 'AGENTS.md')).toBeUndefined();
  });
});
