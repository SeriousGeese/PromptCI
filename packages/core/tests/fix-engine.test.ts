import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyFixRecipe, isRepairable, planMirrorImport, resolveSafePath } from '../src/fix-engine.js';
import type { PromptCiIssue } from '../src/types.js';
import { MIRRORED_FILES_TAG } from '../src/duplicates.js';

function staleIssue(overrides: Partial<PromptCiIssue> = {}): PromptCiIssue {
  return {
    id: 'stale-abc123def456',
    severity: 'warning',
    category: 'stale_instruction',
    title: 'Instruction may reference outdated content',
    summary: 'This instruction may reference outdated content.',
    filePaths: ['CLAUDE.md'],
    locations: [{ filePath: 'CLAUDE.md', startLine: 1, endLine: 5 }],
    evidence: ['Year reference(s) that may be outdated: 2021, 2022'],
    recommendation: 'Review this section for accuracy.',
    confidence: 0.6,
    ...overrides,
  };
}

function issue(overrides: Partial<PromptCiIssue> = {}): PromptCiIssue {
  return {
    id: 'x',
    severity: 'warning',
    category: 'security',
    title: 't',
    summary: 's',
    filePaths: [],
    locations: [],
    evidence: [],
    recommendation: 'r',
    confidence: 0.9,
    ...overrides,
  };
}

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'promptci-fixengine-test-'));
}

/**
 * BUG-14: this recipe used to rewrite every year in the flagged section to a
 * hardcoded '2026'. It could not distinguish a stale instruction from a
 * copyright line, a release date, or a version pin, and its source range
 * (2019–2023) did not even match the detector's (2019–2025).
 */
describe('applyFixRecipe — stale years are advisory, never auto-rewritten', () => {
  it('produces no file changes for a stale_instruction issue', async () => {
    const changes = await applyFixRecipe(staleIssue(), process.cwd());
    expect(changes).toEqual([]);
  });

  it('produces no file changes even when year evidence is present', async () => {
    const changes = await applyFixRecipe(
      staleIssue({ evidence: ['Year reference(s) that may be outdated: 2020'] }),
      process.cwd(),
    );
    expect(changes).toEqual([]);
  });
});

describe('applyFixRecipe — .gitignore recipes', () => {
  let dir: string;
  beforeEach(async () => { dir = await makeTempDir(); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('appends the baseline-preserving .promptci stanza when missing', async () => {
    await fs.writeFile(path.join(dir, '.gitignore'), 'node_modules/\n', 'utf-8');
    const changes = await applyFixRecipe(issue({ id: 'security-pack-no-promptci-gitignore' }), dir);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.newContent).toContain('node_modules/');
    expect(changes[0]!.newContent).toContain('**/.promptci/*');
    expect(changes[0]!.newContent).toContain('!**/.promptci/baseline.json');
  });

  it('is a no-op when .promptci/ is already ignored', async () => {
    await fs.writeFile(path.join(dir, '.gitignore'), '.promptci/\n', 'utf-8');
    const changes = await applyFixRecipe(issue({ id: 'security-pack-no-promptci-gitignore' }), dir);
    expect(changes).toEqual([]);
  });

  it('appends each unignored directory named in the evidence', async () => {
    await fs.writeFile(path.join(dir, '.gitignore'), 'node_modules/\n', 'utf-8');
    const changes = await applyFixRecipe(
      issue({
        id: 'security-pack-unignored-dirs',
        category: 'context_bloat',
        evidence: [
          'Directory "dist" exists but is not ignored in .gitignore.',
          'Directory "coverage" exists but is not ignored in .gitignore.',
        ],
      }),
      dir,
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]!.newContent).toContain('dist/');
    expect(changes[0]!.newContent).toContain('coverage/');
  });

  // The fix must use the same segment-based matching as the detector: a line
  // like `mydist/` must not suppress adding `dist/`, or the fix silently
  // no-ops on an issue the detector keeps flagging forever.
  it('appends a directory even when another entry contains its name as a substring', async () => {
    await fs.writeFile(path.join(dir, '.gitignore'), 'mydist/\n', 'utf-8');
    const changes = await applyFixRecipe(
      issue({
        id: 'security-pack-unignored-dirs',
        category: 'context_bloat',
        evidence: ['Directory "dist" exists but is not ignored in .gitignore.'],
      }),
      dir,
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]!.newContent).toContain('mydist/\ndist/');
  });

  it('appends the .promptci stanza even when a substring-similar entry exists', async () => {
    await fs.writeFile(path.join(dir, '.gitignore'), 'foo.promptci/\n', 'utf-8');
    const changes = await applyFixRecipe(issue({ id: 'security-pack-no-promptci-gitignore' }), dir);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.newContent).toContain('**/.promptci/*');
  });

  it('treats an existing globstar .promptci stanza as covered', async () => {
    await fs.writeFile(path.join(dir, '.gitignore'), '**/.promptci/*\n!**/.promptci/baseline.json\n', 'utf-8');
    const changes = await applyFixRecipe(issue({ id: 'security-pack-no-promptci-gitignore' }), dir);
    expect(changes).toEqual([]);
  });
});

describe('applyFixRecipe — mirrored CLAUDE.md import (pcic-1ik0.10: opt-in only, never a link)', () => {
  let dir: string;
  beforeEach(async () => { dir = await makeTempDir(); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  async function write(files: Record<string, string>): Promise<void> {
    for (const [rel, body] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), body, 'utf-8');
    }
  }

  /** A mirrored-files finding over these files, canonical first (advisory, as the detector emits it). */
  function mirror(...files: string[]): PromptCiIssue {
    return issue({
      id: 'duplicate-mirror',
      category: 'duplicate',
      filePaths: files,
      locations: files.map((filePath) => ({ filePath, startLine: 1, endLine: 2 })),
      tags: [MIRRORED_FILES_TAG],
      autoApplySafe: false,
    });
  }

  const apply = async (finding: PromptCiIssue, optIn = true) =>
    Object.fromEntries(
      (await applyFixRecipe(finding, dir, { optIn })).map((c) => [path.relative(dir, c.filePath).replace(/\\/g, '/'), c.newContent]),
    );
  const refusals = async (finding: PromptCiIssue) => (await planMirrorImport(finding, dir)).refusals;

  const AGENTS = '# Guide\n\n## Testing\nRun all tests before done.\n\n## Style\nUse Prettier defaults.\n';
  const DOTCLAUDE =
    ".claude/CLAUDE.md: not edited (it is not in AGENTS.md's directory, so relative @ paths in the shared text would resolve from another directory after the edit)";

  it('makes no edit without the opt-in, even for an exact copy', async () => {
    await write({ 'AGENTS.md': AGENTS, 'CLAUDE.md': AGENTS });
    expect(await apply(mirror('AGENTS.md', 'CLAUDE.md'), false)).toEqual({});
  });

  it('with the opt-in, replaces an exact root CLAUDE.md copy with one @AGENTS.md import', async () => {
    await write({ 'AGENTS.md': AGENTS, 'CLAUDE.md': AGENTS, '.gitignore': 'node_modules/\n*.log\n!AGENTS.md\n' });
    expect(await apply(mirror('AGENTS.md', 'CLAUDE.md'))).toEqual({ 'CLAUDE.md': '@AGENTS.md\n' });
  });

  it('never edits a .claude/CLAUDE.md copy, even an exact one, and says why', async () => {
    await write({ 'AGENTS.md': AGENTS, '.claude/CLAUDE.md': AGENTS });
    expect(await apply(mirror('AGENTS.md', '.claude/CLAUDE.md'))).toEqual({});
    expect(await refusals(mirror('AGENTS.md', '.claude/CLAUDE.md'))).toEqual([
      ".claude/CLAUDE.md: not edited (it is not in AGENTS.md's directory, so relative @ paths in the shared text would resolve from another directory after the edit)",
    ]);
  });

  it('keeps a trailing top-level Claude-only section below the import, with one blank line', async () => {
    await write({ 'AGENTS.md': AGENTS, 'CLAUDE.md': `${AGENTS}\n## Claude only\nUse /review.\n` });
    expect(await apply(mirror('AGENTS.md', 'CLAUDE.md'))).toEqual({ 'CLAUDE.md': '@AGENTS.md\n\n## Claude only\nUse /review.\n' });
  });

  it('a bare @AGENTS.md line inside a dropped shared section does not suppress the import (review 1A)', async () => {
    const withImportLine = '## Shared\nRead the canonical file:\n@AGENTS.md\n\n## Style\nUse Prettier defaults.\n';
    await write({ 'AGENTS.md': withImportLine, 'CLAUDE.md': withImportLine });
    expect(await apply(mirror('AGENTS.md', 'CLAUDE.md'))).toEqual({ 'CLAUDE.md': '@AGENTS.md\n' });
  });

  it('an existing import line on top is kept, not doubled; front matter and CRLF are kept', async () => {
    await write({
      'AGENTS.md': AGENTS,
      'CLAUDE.md': `---\r\ntitle: x\r\n---\r\n@AGENTS.md\r\n\r\n${AGENTS.replace(/\n/g, '\r\n')}`,
    });
    expect(await apply(mirror('AGENTS.md', 'CLAUDE.md'))).toEqual({ 'CLAUDE.md': '---\r\ntitle: x\r\n---\r\n@AGENTS.md\r\n' });
  });

  it.each([
    ['<pre>', '<pre>\n@AGENTS.md\n</pre>'],
    ['<div>', '<div>\n@AGENTS.md\n</div>'],
    ['an HTML comment', '<!--\n@AGENTS.md\n-->'],
    ['a fence', '```\n@AGENTS.md\n```'],
    ['a plain line in a kept section', '@AGENTS.md'],
  ])('writes the import even when a kept section shows @AGENTS.md inside %s (review B1)', async (_label, shown) => {
    const claude = `${AGENTS}\n## Claude notes\nAn import looks like:\n\n${shown}\n`;
    await write({ 'AGENTS.md': AGENTS, 'CLAUDE.md': claude });
    expect(await apply(mirror('AGENTS.md', 'CLAUDE.md'))).toEqual({
      'CLAUDE.md': `@AGENTS.md\n\n## Claude notes\nAn import looks like:\n\n${shown}\n`,
    });
  });

  it('keeps a trailing Claude-only section with its own subsection', async () => {
    await write({ 'AGENTS.md': AGENTS, 'CLAUDE.md': `${AGENTS}\n## Claude only\nUse /review.\n\n### Commands\nUse /test.\n` });
    expect(await apply(mirror('AGENTS.md', 'CLAUDE.md'))).toEqual({
      'CLAUDE.md': '@AGENTS.md\n\n## Claude only\nUse /review.\n\n### Commands\nUse /test.\n',
    });
  });

  it('a relative import in shared text is fine for the root CLAUDE.md (same directory as AGENTS.md)', async () => {
    const shared = `${AGENTS}\n## More\n@docs/style.md\n`;
    await write({ 'AGENTS.md': shared, 'CLAUDE.md': shared, 'docs/style.md': '# Style\n' });
    expect(await apply(mirror('AGENTS.md', 'CLAUDE.md'))).toEqual({ 'CLAUDE.md': '@AGENTS.md\n' });
  });

  it('never edits GEMINI.md, Copilot or Cursor copies; edits the CLAUDE.md beside them', async () => {
    await write({ 'AGENTS.md': AGENTS, 'CLAUDE.md': AGENTS, 'GEMINI.md': AGENTS, '.github/copilot-instructions.md': AGENTS });
    const finding = mirror('AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.github/copilot-instructions.md');
    expect(await apply(finding)).toEqual({ 'CLAUDE.md': '@AGENTS.md\n' });
    expect((await planMirrorImport(finding, dir)).untouched).toEqual([
      'GEMINI.md: not edited (an @ import in GEMINI.md does not load in every Gemini tool)',
      '.github/copilot-instructions.md: not edited (its tool loads no @ import)',
    ]);
  });

  it.each<[string, Record<string, string>, string[], string]>([
    ['the only import is inside an HTML comment (review 1B)', { 'AGENTS.md': AGENTS, 'CLAUDE.md': `<!--\n@AGENTS.md\n-->\n\n${AGENTS}` }, ['AGENTS.md', 'CLAUDE.md'], 'a section only CLAUDE.md has comes before "Guide"; it would move'],
    ['AGENTS.md has sections the copy lacks (review 3A)', { 'AGENTS.md': `${AGENTS}\n## Codex sandbox\nNo network.\n`, 'CLAUDE.md': AGENTS }, ['AGENTS.md', 'CLAUDE.md'], 'CLAUDE.md lacks text that AGENTS.md has (Codex sandbox); an import would add it'],
    ['the preamble differs by one word (review 3B)', { 'AGENTS.md': `Binds every coding agent.\n\n${AGENTS}`, 'CLAUDE.md': `Binds no coding agent.\n\n${AGENTS}` }, ['AGENTS.md', 'CLAUDE.md'], 'CLAUDE.md lacks text that AGENTS.md has ((text before the first heading)); an import would add it'],
    ['a copy-only subsection sits under a removed section (review 4A)', { 'AGENTS.md': AGENTS, 'CLAUDE.md': `${AGENTS}\n### Exceptions\nNot under scripts/seed/.\n` }, ['AGENTS.md', 'CLAUDE.md'], '"Exceptions" sits under a section being removed; it would read as part of AGENTS.md'],
    ['a copy-only first section would move (review 4B)', { 'AGENTS.md': AGENTS, 'CLAUDE.md': `## Binding\nEverything below binds.\n\n${AGENTS}` }, ['AGENTS.md', 'CLAUDE.md'], 'a section only CLAUDE.md has comes before "Guide"; it would move'],
    ['a copy-only middle section would move', { 'AGENTS.md': AGENTS, 'CLAUDE.md': AGENTS.replace('## Style', '## Claude only\nUse /review.\n\n## Style') }, ['AGENTS.md', 'CLAUDE.md'], 'a section only CLAUDE.md has comes before "Style"; it would move'],
    ['a drifted section (same heading, other text)', { 'AGENTS.md': AGENTS, 'CLAUDE.md': AGENTS.replace('Run all tests', 'Run some tests') }, ['AGENTS.md', 'CLAUDE.md'], 'CLAUDE.md lacks text that AGENTS.md has (Testing); an import would add it'],
    ['a .claude/CLAUDE.md copy whose shared text holds a relative import (review B2)', { 'AGENTS.md': `${AGENTS}\n## More\n@docs/style.md\n`, '.claude/CLAUDE.md': `${AGENTS}\n## More\n@docs/style.md\n`, 'docs/style.md': '# Style\n' }, ['AGENTS.md', '.claude/CLAUDE.md'], DOTCLAUDE],
    ['a .claude/CLAUDE.md copy with an inline @ mention in shared prose', { 'AGENTS.md': `${AGENTS}\n## More\nFollow the style guide in @docs/style.md whenever you edit a source file.\n`, '.claude/CLAUDE.md': `${AGENTS}\n## More\nFollow the style guide in @docs/style.md whenever you edit a source file.\n`, 'docs/style.md': '# Style\n' }, ['AGENTS.md', '.claude/CLAUDE.md'], DOTCLAUDE],
    ['a .claude/CLAUDE.md copy with an import after a tag-led line', { 'AGENTS.md': `${AGENTS}\n## More\nLoad the line below:\n<br>\n@docs/style.md\n`, '.claude/CLAUDE.md': `${AGENTS}\n## More\nLoad the line below:\n<br>\n@docs/style.md\n`, 'docs/style.md': '# Style\n' }, ['AGENTS.md', '.claude/CLAUDE.md'], DOTCLAUDE],
    ['AGENTS.md holds the same section twice', { 'AGENTS.md': `${AGENTS}\n## Style\nUse Prettier defaults.\n`, 'CLAUDE.md': `${AGENTS}\n## Style\nUse Prettier defaults.\n` }, ['AGENTS.md', 'CLAUDE.md'], 'AGENTS.md has the same section more than once; consolidate it there first'],
    ['the shared sections are in another order', { 'AGENTS.md': AGENTS, 'CLAUDE.md': '# Guide\n\n## Style\nUse Prettier defaults.\n\n## Testing\nRun all tests before done.\n' }, ['AGENTS.md', 'CLAUDE.md'], 'CLAUDE.md has the sections of AGENTS.md in another order (or more than once)'],
    ['a shared section appears twice in the copy', { 'AGENTS.md': AGENTS, 'CLAUDE.md': `${AGENTS}\n## Style\nUse Prettier defaults.\n` }, ['AGENTS.md', 'CLAUDE.md'], 'CLAUDE.md has the sections of AGENTS.md in another order (or more than once)'],
    ['AGENTS.md imports CLAUDE.md (circular)', { 'AGENTS.md': `${AGENTS}\n## More\n@CLAUDE.md\n`, 'CLAUDE.md': `${AGENTS}\n## More\n@CLAUDE.md\n` }, ['AGENTS.md', 'CLAUDE.md'], 'AGENTS.md imports CLAUDE.md (circular)'],
    ['the copy is a CLAUDE.md below the root (external import)', { 'AGENTS.md': AGENTS, 'packages/api/CLAUDE.md': AGENTS }, ['AGENTS.md', 'packages/api/CLAUDE.md'], 'packages/api/CLAUDE.md: not edited (a CLAUDE.md below the root imports AGENTS.md as an external file)'],
    ['the canonical file is not the root AGENTS.md', { 'docs/AGENTS.md': AGENTS, 'CLAUDE.md': AGENTS }, ['docs/AGENTS.md', 'CLAUDE.md'], 'the canonical file is docs/AGENTS.md, not the repository-root AGENTS.md'],
    ['two AGENTS.md candidates', { 'AGENTS.md': AGENTS, 'sub/AGENTS.md': AGENTS, 'CLAUDE.md': AGENTS }, ['AGENTS.md', 'sub/AGENTS.md', 'CLAUDE.md'], 'more than one AGENTS.md in the group: the canonical file is ambiguous'],
    ['the canonical file is missing (unfetched)', { 'CLAUDE.md': AGENTS }, ['AGENTS.md', 'CLAUDE.md'], 'AGENTS.md cannot be read (or is empty) here'],
    ['the .gitignore ignores AGENTS.md', { 'AGENTS.md': AGENTS, 'CLAUDE.md': AGENTS, '.gitignore': 'AGENTS.md\n' }, ['AGENTS.md', 'CLAUDE.md'], 'the root .gitignore may ignore AGENTS.md'],
    ['the copy repeats nothing any more', { 'AGENTS.md': AGENTS, 'CLAUDE.md': '## Other\nOther text.\n' }, ['AGENTS.md', 'CLAUDE.md'], 'CLAUDE.md lacks text that AGENTS.md has (Guide, Testing, Style); an import would add it'],
  ])('refuses when %s', async (_label, files, members, reason) => {
    await write(files);
    expect(await refusals(mirror(...members))).toEqual([reason]);
    expect(await apply(mirror(...members))).toEqual({});
  });

  it('refuses a per-section duplicate (no mirrored-files tag), with or without the opt-in', async () => {
    await write({ 'AGENTS.md': AGENTS, 'CLAUDE.md': AGENTS });
    expect(await apply({ ...mirror('AGENTS.md', 'CLAUDE.md'), tags: [] })).toEqual({});
  });
});

describe('resolveSafePath — containment guard', () => {
  it('rejects paths that escape the repo root', () => {
    const root = process.cwd();
    expect(() => resolveSafePath(root, '../outside.md')).toThrow(/Path traversal/);
    expect(() => resolveSafePath(root, path.resolve(root, '..', 'evil.md'))).toThrow(/Path traversal/);
  });

  it('accepts paths inside the repo root', () => {
    const root = process.cwd();
    expect(resolveSafePath(root, 'CLAUDE.md')).toBe(path.resolve(root, 'CLAUDE.md'));
  });

  it('applyFixRecipe surfaces the containment guard for an escaping location', async () => {
    await expect(
      applyFixRecipe(
        issue({
          id: 'dup-escape',
          category: 'duplicate',
          filePaths: ['AGENTS.md', '../evil.md'],
          locations: [
            { filePath: 'AGENTS.md', startLine: 1, endLine: 2 },
            { filePath: '../evil.md', startLine: 1, endLine: 2 },
          ],
        }),
        process.cwd(),
      ),
    ).rejects.toThrow(/Path traversal/);
  });
});

describe('isRepairable', () => {
  it('is true only when the issue is explicitly marked autoApplySafe', () => {
    expect(isRepairable(issue({ autoApplySafe: true }))).toBe(true);
    expect(isRepairable(issue({ autoApplySafe: false }))).toBe(false);
    expect(isRepairable(issue())).toBe(false); // field absent
  });

  it('is false for an advisory stale finding even though it carries a fixRecipe', () => {
    expect(isRepairable(staleIssue({ fixRecipe: 'Review the years in this section.' }))).toBe(false);
  });
});
