/**
 * pcic-2b6.14: the alias-grouping rules of scanFilesWithAliases, exercised on
 * every platform. Creating real file symlinks needs a privilege on Windows, so
 * here the fast-glob listing and the real-path lookup are stubbed: a "link" is
 * a plain file the stub reports as a symlink whose real path is another file.
 * symlinked-instruction-files.test.ts covers the same behavior with real links.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTempRepo, writeFile } from './ai-config-helpers.js';

type Kind = 'file' | 'link';
const listing: { entries: Array<{ rel: string; kind: Kind }>; real: Record<string, string> } = {
  entries: [],
  real: {},
};

vi.mock('fast-glob', () => ({
  default: vi.fn(async () =>
    listing.entries.map(({ rel, kind }) => ({
      path: rel,
      name: path.basename(rel),
      dirent: { isFile: () => kind === 'file', isSymbolicLink: () => kind === 'link' },
    })),
  ),
}));

vi.mock('../src/path-containment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/path-containment.js')>();
  return {
    ...actual,
    // The scanner's own real-path lookup; the stub resolves the "links".
    realPath: (p: string) => listing.real[path.basename(p)] ?? actual.realPath(p),
  };
});

const { scanFilesWithAliases } = await import('../src/scanner.js');

const BODY = '# Rules\n\nRun the tests before you push.\n';
const tempDirs: string[] = [];

function setup(files: Record<string, string>, entries: Array<[string, Kind]>, real: Record<string, string> = {}): string {
  const repo = makeTempRepo('promptci-alias-grouping-');
  tempDirs.push(repo);
  for (const [rel, content] of Object.entries(files)) writeFile(repo, rel, content);
  listing.entries = entries.map(([rel, kind]) => ({ rel, kind }));
  listing.real = real;
  return repo;
}

beforeEach(() => {
  listing.entries = [];
  listing.real = {};
});
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('scanFilesWithAliases grouping', () => {
  it('makes a link to a discovered file an alias of it, scanned once', async () => {
    const repo = setup(
      { 'AGENTS.md': BODY, 'CLAUDE.md': BODY },
      [['AGENTS.md', 'file'], ['CLAUDE.md', 'link']],
      { 'CLAUDE.md': 'REAL:AGENTS.md', 'AGENTS.md': 'REAL:AGENTS.md' },
    );
    const { files, aliases } = await scanFilesWithAliases({ repoPath: repo });
    expect(files.map((f) => f.relativePath)).toEqual(['AGENTS.md']);
    expect(aliases.map((f) => [f.relativePath, f.aliasOf, f.fileType])).toEqual([['CLAUDE.md', 'AGENTS.md', 'claude']]);
  });

  it('scans a link whose target is not discovered, typed by the link name', async () => {
    const repo = setup(
      { 'CLAUDE.md': BODY },
      [['CLAUDE.md', 'link']],
      { 'CLAUDE.md': 'REAL:docs/rules.txt' },
    );
    const { files, aliases } = await scanFilesWithAliases({ repoPath: repo });
    expect(files.map((f) => [f.relativePath, f.fileType])).toEqual([['CLAUDE.md', 'claude']]);
    expect(aliases).toEqual([]);
  });

  it('aliases later links to the first link of an undiscovered target (path order)', async () => {
    const repo = setup(
      { 'CLAUDE.md': BODY, '.cursorrules': BODY, 'GEMINI.md': BODY },
      [['GEMINI.md', 'link'], ['CLAUDE.md', 'link'], ['.cursorrules', 'link']],
      { 'CLAUDE.md': 'REAL:t', '.cursorrules': 'REAL:t', 'GEMINI.md': 'REAL:t' },
    );
    const { files, aliases } = await scanFilesWithAliases({ repoPath: repo });
    expect(files.map((f) => f.relativePath)).toEqual(['.cursorrules']);
    expect(aliases.map((f) => [f.relativePath, f.aliasOf])).toEqual([
      ['CLAUDE.md', '.cursorrules'],
      ['GEMINI.md', '.cursorrules'],
    ]);
  });

  it('keeps a link to a different file separate from the discovered file', async () => {
    const repo = setup(
      { 'AGENTS.md': BODY, 'CLAUDE.md': '# Claude\n\nOther content.\n' },
      [['AGENTS.md', 'file'], ['CLAUDE.md', 'link']],
      { 'CLAUDE.md': 'REAL:elsewhere.txt', 'AGENTS.md': 'REAL:AGENTS.md' },
    );
    const { files, aliases } = await scanFilesWithAliases({ repoPath: repo });
    expect(files.map((f) => f.relativePath)).toEqual(['AGENTS.md', 'CLAUDE.md']);
    expect(aliases).toEqual([]);
  });

  it('skips a link that cannot be read (dangling or a directory)', async () => {
    const repo = setup({ 'AGENTS.md': BODY }, [['AGENTS.md', 'file'], ['CLAUDE.md', 'link'], ['docs', 'link']]);
    fs.mkdirSync(path.join(repo, 'docs'));
    const { files, aliases } = await scanFilesWithAliases({ repoPath: repo });
    expect(files.map((f) => f.relativePath)).toEqual(['AGENTS.md']);
    expect(aliases).toEqual([]);
  });
});
