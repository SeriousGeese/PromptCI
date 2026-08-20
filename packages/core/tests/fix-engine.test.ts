import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyFixRecipe, isRepairable, resolveSafePath } from '../src/fix-engine.js';
import type { PromptCiIssue } from '../src/types.js';

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

describe('applyFixRecipe — duplicate consolidation', () => {
  let dir: string;
  beforeEach(async () => { dir = await makeTempDir(); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  function dupIssue(locations: PromptCiIssue['locations']): PromptCiIssue {
    return issue({
      id: 'dup-1',
      category: 'duplicate',
      filePaths: [...new Set(locations.map((l) => l.filePath))],
      locations,
    });
  }

  it('replaces the non-canonical copy with a pointer to AGENTS.md', async () => {
    const body = '## Testing\nRun all tests before done.\n';
    await fs.writeFile(path.join(dir, 'AGENTS.md'), body, 'utf-8');
    await fs.writeFile(path.join(dir, 'CLAUDE.md'), body, 'utf-8');

    const changes = await applyFixRecipe(
      dupIssue([
        { filePath: 'AGENTS.md', startLine: 1, endLine: 2 },
        { filePath: 'CLAUDE.md', startLine: 1, endLine: 2 },
      ]),
      dir,
    );

    // Only the non-canonical file is rewritten.
    expect(changes).toHaveLength(1);
    expect(path.basename(changes[0]!.filePath)).toBe('CLAUDE.md');
    expect(changes[0]!.newContent).toContain('See canonical instructions in [AGENTS.md]');
    expect(changes[0]!.newContent).toContain('## Testing'); // heading preserved
    expect(changes[0]!.newContent).not.toContain('Run all tests before done.');
  });

  // Item 3: two duplicate ranges in the SAME file must merge into ONE change.
  // Computing one change per location from the original content and writing
  // them in sequence would clobber all but the last.
  it('merges multiple same-file duplicate ranges into a single change', async () => {
    await fs.writeFile(path.join(dir, 'AGENTS.md'), '## Alpha\nalpha body\n', 'utf-8');
    await fs.writeFile(
      path.join(dir, 'CLAUDE.md'),
      '## Alpha\nalpha body\n## Beta\nbeta body\n## Gamma\ngamma body\n',
      'utf-8',
    );

    const changes = await applyFixRecipe(
      dupIssue([
        { filePath: 'AGENTS.md', startLine: 1, endLine: 2 },
        { filePath: 'CLAUDE.md', startLine: 1, endLine: 2 }, // Alpha
        { filePath: 'CLAUDE.md', startLine: 5, endLine: 6 }, // Gamma
      ]),
      dir,
    );

    // Exactly one merged change for CLAUDE.md, not two conflicting rewrites.
    expect(changes).toHaveLength(1);
    const out = changes[0]!.newContent;
    expect(out.match(/See canonical instructions in \[AGENTS\.md\]/g)).toHaveLength(2);
    expect(out).toContain('## Beta');
    expect(out).toContain('beta body'); // untouched middle section survives
    expect(out).not.toContain('alpha body');
    expect(out).not.toContain('gamma body');
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
