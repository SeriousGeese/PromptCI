/**
 * pcic-csf: `ScanOptions.knownPaths` — a caller-supplied file inventory the
 * scan consults instead of the filesystem for every existence check.
 *
 * A hosted scan fetches only the instruction files into a temp directory, so
 * without this every other path reads as missing and the scan reports
 * references, commands and config targets as broken that are merely absent
 * from the temp dir. The tests below scan a root that holds ONLY instruction
 * files and check that a listed path is treated as present while an unlisted
 * one is still reported — and that the security pack and the gitignore checker
 * read the same inventory as the rest.
 *
 * pcic-e6xa: the inventory reaches the detectors through RepoTree, which is
 * also the one place any of them touches the filesystem.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PathInventory, normalizeKnownPath } from '../src/known-paths.js';
import { RepoTree } from '../src/repo-tree.js';
import { createGitIgnoreChecker } from '../src/gitignore.js';
import { scan } from '../src/scan.js';
import type { PromptCiIssue, ScanInput } from '../src/types.js';
import { makeTempRepo, writeFile } from './ai-config-helpers.js';

describe('normalizeKnownPath', () => {
  it.each<[string, string | null]>([
    ['AGENTS.md', 'AGENTS.md'],
    ['./AGENTS.md', 'AGENTS.md'],
    ['docs//guide.md', 'docs/guide.md'],
    // A list built on Windows means the same repository, not one file named `a\b`.
    ['docs\\guide.md', 'docs/guide.md'],
    ['', ''],
    // Not a path inside the repository.
    ['/etc/passwd', null],
    ['\\\\host\\share\\x', null],
    ['C:/secrets.txt', null],
    ['../outside.md', null],
    ['docs/../../outside.md', null],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeKnownPath(input)).toBe(expected);
  });
});

describe('PathInventory', () => {
  const inventory = new PathInventory(['src/lib/db.ts', '.github/workflows/ci.yml', 'README.md'], true);

  it('implies every directory on the way to a listed file', () => {
    expect(inventory.classify('src')).toBe('dir');
    expect(inventory.classify('src/lib')).toBe('dir');
    expect(inventory.classify('.github/workflows')).toBe('dir');
    expect(inventory.classify('')).toBe('dir');
  });

  it('classifies listed files as files and unlisted paths as absent when complete', () => {
    expect(inventory.classify('README.md')).toBe('file');
    expect(inventory.classify('src/lib/db.ts')).toBe('file');
    expect(inventory.classify('src/lib/gone.ts')).toBe('absent');
  });

  it('leaves unlisted paths unknown when the list is partial', () => {
    expect(new PathInventory(['README.md']).classify('src/lib/db.ts')).toBe('unknown');
  });

  it('treats a listed path that is also a prefix of another as a directory', () => {
    // Contradictory input: `a/b` can only hold `a/b/c` if it is a directory.
    expect(new PathInventory(['a/b', 'a/b/c'], true).classify('a/b')).toBe('dir');
  });

  it('ignores entries that are not repo-relative paths', () => {
    const outside = new PathInventory(['/etc/passwd', '../x', 'kept.md'], true);
    expect(outside.listedFiles()).toEqual(['kept.md']);
  });
});

describe('RepoTree backed by an inventory', () => {
  it('answers from the inventory for a root that holds nothing', () => {
    // A path that genuinely does not exist on this machine: with a complete
    // inventory the filesystem is never consulted, so it still resolves.
    const tree = new RepoTree(path.join(makeTempRepo('promptci-knownpaths-'), 'never-created'), {
      knownPaths: ['scripts/build.sh', 'docs/guide.md'],
      knownPathsComplete: true,
    });
    expect(tree.isFile('scripts/build.sh')).toBe(true);
    expect(tree.isDir('scripts')).toBe(true);
    expect(tree.isDir('scripts/build.sh')).toBe(false);
    expect(tree.exists('scripts/gone.sh')).toBe(false);
    expect(tree.lookup('scripts/gone.sh').state).toBe('missing');
  });

  it('says a listed-but-unfetched file is unfetched, never missing', () => {
    const root = makeTempRepo('promptci-knownpaths-');
    const tree = new RepoTree(root, { knownPaths: ['Makefile'], knownPathsComplete: true });
    // The difference that matters: "I know it is there, I have not got it" must
    // not collapse into "it is absent", or a hosted scan reports a file it
    // never downloaded as missing. It is also not `unreadable`: nothing failed,
    // so there is nothing for the scan to name in a warning.
    expect(tree.readText('Makefile').state).toBe('unfetched');
    expect(tree.readText('nope.txt').state).toBe('missing');
  });

  it('merges a partial inventory with what is on disk', () => {
    const root = makeTempRepo('promptci-knownpaths-');
    writeFile(root, 'on-disk.md', '# here');
    const tree = new RepoTree(root, { knownPaths: ['listed-only.md'] });
    expect(tree.isFile('on-disk.md')).toBe(true);
    expect(tree.isFile('listed-only.md')).toBe(true);
    expect(tree.exists('neither.md')).toBe(false);
    expect(tree.readText('on-disk.md')).toEqual({ state: 'found', content: '# here' });
  });

  it('refuses an inventory path that leaves the repository', () => {
    const tree = new RepoTree(makeTempRepo('promptci-knownpaths-'), {
      knownPaths: ['../outside.md'],
      knownPathsComplete: true,
    });
    expect(tree.exists('../outside.md')).toBe(false);
  });

  it('reads a trailing-slash entry as a directory with no files of its own', () => {
    const tree = new RepoTree(makeTempRepo('promptci-knownpaths-'), {
      knownPaths: ['coverage/', 'nested/empty/'],
      knownPathsComplete: true,
    });
    expect(tree.isDir('coverage')).toBe(true);
    expect(tree.isFile('coverage')).toBe(false);
    // The directories on the way to an explicitly named one are implied too.
    expect(tree.isDir('nested')).toBe(true);
    expect(tree.isDir('nested/empty')).toBe(true);
    expect(tree.exists('coverage/anything')).toBe(false);
  });

  it('reads .gitignore rules from the inventory source, not the filesystem', () => {
    const root = makeTempRepo('promptci-knownpaths-');
    writeFile(root, '.gitignore', 'data/*.db\n');
    const onDisk = createGitIgnoreChecker(new RepoTree(root));
    expect(onDisk('data/app.db')).toBe(true);
    // The same root, but the inventory says there is no .gitignore at all.
    const listed = createGitIgnoreChecker(new RepoTree(root, { knownPaths: ['README.md'], knownPathsComplete: true }));
    expect(listed('data/app.db')).toBe(false);
  });
});

/** Scan a root that holds only instruction files, as a server-side scan does. */
async function scanInstructionsOnly(
  instructions: Record<string, string>,
  options: Pick<ScanInput, 'knownPaths' | 'knownPathsComplete'> = {},
): Promise<PromptCiIssue[]> {
  const root = makeTempRepo('promptci-knownpaths-scan-');
  for (const [rel, content] of Object.entries(instructions)) writeFile(root, rel, content);
  const report = await scan({ repoPath: root, ...options });
  return report.issues;
}

const AGENTS = [
  '# AGENTS.md',
  '',
  'Build with `node scripts/build.mjs`, then read [the guide](docs/guide.md).',
  '',
  'Never print or commit secrets, API keys, or credentials.',
  '',
  'Do not commit .promptci reports to the repository.',
  '',
  'The guide that moved is [here](docs/gone.md).',
  '',
].join('\n');

describe('a scan over a root holding only instruction files (pcic-csf)', () => {
  const ids = (issues: PromptCiIssue[], category: string): string[] =>
    issues.filter((i) => i.category === category).map((i) => i.title).sort();
  const evidence = (issues: PromptCiIssue[]): string =>
    issues.flatMap((i) => [i.summary, ...i.evidence]).join('\n');

  it('reports every unfetched path as broken without the inventory', async () => {
    const issues = await scanInstructionsOnly({ 'AGENTS.md': AGENTS });
    // The baseline this option exists to fix: nothing but AGENTS.md is on disk,
    // so the real `scripts/build.mjs` and `docs/guide.md` read as missing too.
    expect(evidence(issues)).toContain('docs/guide.md');
    expect(evidence(issues)).toContain('scripts/build.mjs');
  });

  it('reports only the genuinely missing path once the inventory is given', async () => {
    const issues = await scanInstructionsOnly(
      { 'AGENTS.md': AGENTS },
      {
        knownPaths: ['AGENTS.md', 'scripts/build.mjs', 'docs/guide.md', 'package.json'],
        knownPathsComplete: true,
      },
    );
    const text = evidence(issues);
    expect(text).not.toContain('docs/guide.md');
    expect(text).not.toContain('scripts/build.mjs');
    // `docs/gone.md` is not in the inventory, so it is still reported.
    expect(text).toContain('docs/gone.md');
    expect(ids(issues, 'command_validity')).toEqual([]);
  });

  it('feeds the security pack the same inventory', async () => {
    const withSignals = await scanInstructionsOnly(
      { 'AGENTS.md': AGENTS },
      {
        knownPaths: ['AGENTS.md', '.env', 'supabase/migrations/0001_init.sql', 'coverage/index.html', '.gitignore'],
        knownPathsComplete: true,
      },
    );
    // `.env` and `supabase/migrations` are not on disk; the inventory says the
    // repository has them, so the matching signals fire.
    const titles = withSignals.map((i) => i.title);
    expect(titles).toContain('Missing Supabase service role safeguard');
    // `.gitignore` is listed but was not fetched, so the scan says nothing
    // about what it does or does not ignore rather than guessing.
    expect(titles).not.toContain('Missing .promptci/ ignore in .gitignore');
    expect(titles).not.toContain('Unignored build, output, or coverage directories');
  });

  it('still reports an unignored build directory when .gitignore IS fetched', async () => {
    const root = makeTempRepo('promptci-knownpaths-scan-');
    writeFile(root, 'AGENTS.md', AGENTS);
    writeFile(root, '.gitignore', 'node_modules/\n.promptci/\n');
    const report = await scan({
      repoPath: root,
      knownPaths: ['AGENTS.md', '.gitignore', 'coverage/index.html'],
      knownPathsComplete: true,
    });
    const unignored = report.issues.find((i) => i.id === 'security-pack-unignored-dirs');
    expect(unignored?.evidence.join('\n')).toContain('coverage');
  });

  it('falls back to the filesystem for unlisted paths while the list is partial', async () => {
    const root = makeTempRepo('promptci-knownpaths-scan-');
    writeFile(root, 'AGENTS.md', AGENTS);
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'gone.md'), '# actually here');
    const report = await scan({ repoPath: root, knownPaths: ['scripts/build.mjs', 'docs/guide.md'] });
    const text = report.issues.flatMap((i) => [i.summary, ...i.evidence]).join('\n');
    // Listed: believed. Unlisted but on disk: found anyway.
    expect(text).not.toContain('scripts/build.mjs');
    expect(text).not.toContain('docs/gone.md');
  });
});
