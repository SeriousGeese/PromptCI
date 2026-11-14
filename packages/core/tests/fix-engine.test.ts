import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyFixRecipe, isRepairable, resolveSafePath } from '../src/fix-engine.js';
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

describe('applyFixRecipe — duplicate consolidation (pcic-1ik0.10: import, never a link)', () => {
  let dir: string;
  beforeEach(async () => { dir = await makeTempDir(); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  async function write(files: Record<string, string>): Promise<void> {
    for (const [rel, body] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), body, 'utf-8');
    }
  }

  /** A mirrored-files finding over these files, canonical first. */
  function mirror(...files: string[]): PromptCiIssue {
    return issue({
      id: 'duplicate-mirror',
      category: 'duplicate',
      filePaths: files,
      locations: files.map((filePath) => ({ filePath, startLine: 1, endLine: 2 })),
      tags: [MIRRORED_FILES_TAG],
      autoApplySafe: true,
    });
  }

  const apply = async (finding: PromptCiIssue) =>
    Object.fromEntries((await applyFixRecipe(finding, dir)).map((c) => [path.relative(dir, c.filePath).replace(/\\/g, '/'), c.newContent]));

  it('replaces a CLAUDE.md that copies AGENTS.md with one @AGENTS.md import', async () => {
    const body = '# Guide\n\n## Testing\nRun all tests before done.\n';
    await write({ 'AGENTS.md': body, 'CLAUDE.md': body, '.gitignore': 'node_modules/\n*.log\n.promptci/*\n!AGENTS.md\n' });
    expect(await apply(mirror('AGENTS.md', 'CLAUDE.md'))).toEqual({ 'CLAUDE.md': '@AGENTS.md\n' });
  });

  it('keeps a section only the copy has, below the import, with one blank line', async () => {
    await write({
      'AGENTS.md': '## Alpha\nalpha body\n\n## Gamma\ngamma body\n',
      'CLAUDE.md': '## Alpha\nalpha body\n\n## Beta\nbeta body (Claude only)\n\n## Gamma\ngamma body\n',
    });
    expect(await apply(mirror('AGENTS.md', 'CLAUDE.md'))).toEqual({
      'CLAUDE.md': '@AGENTS.md\n\n## Beta\nbeta body (Claude only)\n',
    });
  });

  it('writes the import Gemini CLI documents for GEMINI.md, and a relative path for a nested copy', async () => {
    const body = '## Testing\nRun all tests before done.\n';
    await write({ 'AGENTS.md': body, 'GEMINI.md': body, '.claude/CLAUDE.md': body, 'docs/GEMINI.md': body });
    expect(await apply(mirror('AGENTS.md', 'GEMINI.md', '.claude/CLAUDE.md', 'docs/GEMINI.md'))).toEqual({
      'GEMINI.md': '@./AGENTS.md\n',
      '.claude/CLAUDE.md': '@../AGENTS.md\n',
      'docs/GEMINI.md': '@../AGENTS.md\n',
    });
  });

  it('makes no edit at all when one section has drifted (same heading, different text)', async () => {
    await write({
      'AGENTS.md': '## Rules\nMigrations are never edited after merge.\n\n## Tests\nRun pnpm test.\n',
      'CLAUDE.md': '## Rules\nMigrations are always edited after merge.\n\n## Tests\nRun pnpm test.\n',
    });
    expect(await apply(mirror('AGENTS.md', 'CLAUDE.md'))).toEqual({});
  });

  it('keeps a section whose fenced code lost its indentation', async () => {
    const fence = (i: string) => `## Run\n\`\`\`python\nif x:\n${i}run()\n\`\`\`\n`;
    await write({ 'AGENTS.md': fence('    '), 'CLAUDE.md': fence('') });
    expect(await apply(mirror('AGENTS.md', 'CLAUDE.md'))).toEqual({});
  });

  it('does not add a second import, keeps front matter on top and keeps CRLF', async () => {
    await write({
      'AGENTS.md': '## Alpha\nalpha body\n',
      'CLAUDE.md': '@AGENTS.md\n\n## Alpha\nalpha body\n',
      'GEMINI.md': '---\ntitle: x\n---\r\n## Alpha\r\nalpha body\r\n',
    });
    expect(await apply(mirror('AGENTS.md', 'CLAUDE.md', 'GEMINI.md'))).toEqual({
      'CLAUDE.md': '@AGENTS.md\n',
      'GEMINI.md': '---\r\ntitle: x\r\n---\r\n@./AGENTS.md\r\n',
    });
  });

  it.each([
    ['a per-section duplicate (no mirrored-files tag)', async () => {
      await write({ 'AGENTS.md': '## A\na\n', 'CLAUDE.md': '## A\na\n' });
      return { ...mirror('AGENTS.md', 'CLAUDE.md'), tags: [] };
    }],
    ['a copy whose tool has no import (Copilot)', async () => {
      await write({ 'AGENTS.md': '## A\na\n', 'CLAUDE.md': '## A\na\n', '.github/copilot-instructions.md': '## A\na\n' });
      return mirror('AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md');
    }],
    ['a canonical file that is not AGENTS.md', async () => {
      await write({ 'CLAUDE.md': '## A\na\n', 'GEMINI.md': '## A\na\n' });
      return mirror('CLAUDE.md', 'GEMINI.md');
    }],
    ['two AGENTS.md candidates', async () => {
      await write({ 'AGENTS.md': '## A\na\n', 'sub/AGENTS.md': '## A\na\n', 'CLAUDE.md': '## A\na\n' });
      return mirror('AGENTS.md', 'sub/AGENTS.md', 'CLAUDE.md');
    }],
    ['a canonical file missing on disk (unfetched)', async () => {
      await write({ 'CLAUDE.md': '## A\na\n' });
      return mirror('AGENTS.md', 'CLAUDE.md');
    }],
    ['a copy that no longer repeats anything', async () => {
      await write({ 'AGENTS.md': '## A\na\n', 'CLAUDE.md': '## B\nb\n' });
      return mirror('AGENTS.md', 'CLAUDE.md');
    }],
    ['a section reflowed in the copy (byte-identical rule: different text)', async () => {
      await write({
        'AGENTS.md': '## Rules\nKeep each change small and\nfocused on one task.\n',
        'CLAUDE.md': '## Rules\nKeep each change small and focused\non one task.\n',
      });
      return mirror('AGENTS.md', 'CLAUDE.md');
    }],
    ['a nested list flattened in the copy', async () => {
      await write({ 'AGENTS.md': '## Steps\n- build\n  - pnpm build\n', 'CLAUDE.md': '## Steps\n- build\n- pnpm build\n' });
      return mirror('AGENTS.md', 'CLAUDE.md');
    }],
    ['a canonical file the .gitignore ignores by name', async () => {
      await write({ 'AGENTS.md': '## A\na\n', 'CLAUDE.md': '## A\na\n', '.gitignore': 'node_modules/\nAGENTS.md\n' });
      return mirror('AGENTS.md', 'CLAUDE.md');
    }],
    ['a canonical file the .gitignore ignores by glob or directory', async () => {
      await write({ 'pkg/AGENTS.md': '## A\na\n', 'pkg/CLAUDE.md': '## A\na\n', '.gitignore': '/pkg/\n' });
      return mirror('pkg/AGENTS.md', 'pkg/CLAUDE.md');
    }],
    ['one copy fine and one stale (all or nothing)', async () => {
      await write({ 'AGENTS.md': '## A\na\n', 'CLAUDE.md': '## A\na\n', 'GEMINI.md': '## B\nb\n' });
      return mirror('AGENTS.md', 'CLAUDE.md', 'GEMINI.md');
    }],
  ])('makes no edit for %s', async (_label, setup) => {
    expect(await applyFixRecipe(await setup(), dir)).toEqual([]);
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
