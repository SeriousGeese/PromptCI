/**
 * pcic-2b6.14: instruction files committed as symlinks (`CLAUDE.md -> AGENTS.md`,
 * `.cursorrules -> AGENTS.md`) used to be skipped entirely — fast-glob with
 * `followSymbolicLinks: false` never lists a symlinked FILE as a file.
 *
 * Real file symlinks need a privilege on Windows, so those cases skip there
 * (CI on Linux runs them); the grouping rules themselves are also covered
 * platform-independently in symlink-alias-grouping.test.ts.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanFiles, scanFilesWithAliases } from '../src/scanner.js';
import { scan } from '../src/scan.js';
import { buildRepoContext } from '../src/repo-context.js';
import { generateJsonReport, generateMarkdownReport } from '../src/report.js';
import { canSymlink, makeTempRepo, trySymlink, writeFile } from './ai-config-helpers.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempRepo(files: Record<string, string>): string {
  const repo = makeTempRepo('promptci-symlink-files-');
  tempDirs.push(repo);
  for (const [rel, content] of Object.entries(files)) writeFile(repo, rel, content);
  return repo;
}

/** Link `<repo>/<link>` to the repo-relative `target` (a relative symlink, as `ln -s` writes it). */
function linkTo(repo: string, link: string, target: string): void {
  const linkPath = path.join(repo, link);
  const rel = path.relative(path.dirname(linkPath), path.join(repo, target));
  expect(trySymlink(rel, linkPath)).toBe(true);
}

const AGENTS = [
  '# Agents',
  '',
  '## Build',
  '',
  'Run `pnpm build` before you push. Keep diffs focused and prefer small commits so reviews stay quick.',
  'Always run the tests and report failures honestly; never claim success when checks are skipped.',
  'Read a file before you edit it, and verify the change before you say it is done.',
  '',
  '## Testing',
  '',
  'Write a regression test for every bug fix. Run the whole suite before opening a pull request, and',
  'keep the suite deterministic: no network, no clock, no randomness in tests or detectors.',
  '',
].join('\n');

describe.skipIf(!canSymlink)('symlinked instruction files (pcic-2b6.14)', () => {
  it('lists CLAUDE.md -> AGENTS.md as an alias and scans the content once', async () => {
    const repo = tempRepo({ 'AGENTS.md': AGENTS });
    linkTo(repo, 'CLAUDE.md', 'AGENTS.md');

    const { files, aliases } = await scanFilesWithAliases({ repoPath: repo });
    expect(files.map((f) => f.relativePath)).toEqual(['AGENTS.md']);
    expect(aliases).toHaveLength(1);
    expect(aliases[0]!.relativePath).toBe('CLAUDE.md');
    expect(aliases[0]!.aliasOf).toBe('AGENTS.md');
    expect(aliases[0]!.fileType).toBe('claude');
    expect(aliases[0]!.content).toBe(AGENTS);
    // The long-standing API returns each distinct file once.
    expect((await scanFiles({ repoPath: repo })).map((f) => f.relativePath)).toEqual(['AGENTS.md']);
  });

  it.each(['.cursorrules', '.windsurfrules', 'GEMINI.md'])('lists %s -> AGENTS.md as an alias', async (name) => {
    const repo = tempRepo({ 'AGENTS.md': AGENTS });
    linkTo(repo, name, 'AGENTS.md');
    const { files, aliases } = await scanFilesWithAliases({ repoPath: repo });
    expect(files.map((f) => f.relativePath)).toEqual(['AGENTS.md']);
    expect(aliases.map((f) => [f.relativePath, f.aliasOf])).toEqual([[name, 'AGENTS.md']]);
  });

  it('treats the real file as canonical whichever side is the link (AGENTS.md -> CLAUDE.md)', async () => {
    const repo = tempRepo({ 'CLAUDE.md': AGENTS });
    linkTo(repo, 'AGENTS.md', 'CLAUDE.md');
    const { files, aliases } = await scanFilesWithAliases({ repoPath: repo });
    expect(files.map((f) => f.relativePath)).toEqual(['CLAUDE.md']);
    expect(aliases.map((f) => [f.relativePath, f.aliasOf])).toEqual([['AGENTS.md', 'CLAUDE.md']]);
  });

  it('gives the same findings as the real file alone: no double counting, no self-duplicates', async () => {
    const withLink = tempRepo({ 'AGENTS.md': AGENTS });
    linkTo(withLink, 'CLAUDE.md', 'AGENTS.md');
    linkTo(withLink, '.cursorrules', 'AGENTS.md');
    const plain = tempRepo({ 'AGENTS.md': AGENTS });

    const linked = await scan({ repoPath: withLink });
    const baseline = await scan({ repoPath: plain });
    expect(linked.issues.map((i) => i.id)).toEqual(baseline.issues.map((i) => i.id));
    expect(linked.healthScore).toBe(baseline.healthScore);
    expect(linked.metrics.instructionFileCount).toBe(1);
    expect(linked.metrics.estimatedInstructionTokens).toBe(baseline.metrics.estimatedInstructionTokens);
    // No finding names the alias and the file together (e.g. "duplicate sections").
    expect(linked.issues.some((i) => i.id.startsWith('duplicate'))).toBe(false);
    expect(linked.issues.some((i) => i.filePaths.some((p) => /CLAUDE\.md$|\.cursorrules$/.test(p)))).toBe(false);
  });

  it('lists the aliases in the report inventory', async () => {
    const repo = tempRepo({ 'AGENTS.md': AGENTS });
    linkTo(repo, 'CLAUDE.md', 'AGENTS.md');
    const report = await scan({ repoPath: repo });
    expect(report.filesScanned.map((f) => f.relativePath).sort()).toEqual(['AGENTS.md', 'CLAUDE.md']);
    expect(generateMarkdownReport(report)).toContain('(symlink to `AGENTS.md`)');
    const json = JSON.parse(generateJsonReport(report)) as {
      filesScanned: Array<{ path: string; aliasOf?: string }>;
    };
    expect(json.filesScanned.filter((f) => f.aliasOf !== undefined).map((f) => f.aliasOf)).toEqual(['AGENTS.md']);
  });

  it('scans a link to an in-repo file outside the patterns under the LINK path', async () => {
    const repo = tempRepo({
      // A broken link, so a finding proves the content was scanned.
      'docs/ai-rules.txt': '# Rules\n\nRead [the guide](docs/missing-guide.md) first.\n',
    });
    linkTo(repo, 'CLAUDE.md', 'docs/ai-rules.txt');
    const { files, aliases } = await scanFilesWithAliases({ repoPath: repo });
    expect(files.map((f) => [f.relativePath, f.fileType])).toEqual([['CLAUDE.md', 'claude']]);
    expect(aliases).toEqual([]);
    const report = await scan({ repoPath: repo });
    const deadRef = report.issues.find((i) => /missing-guide\.md/.test(i.evidence.join(' ')));
    expect(deadRef).toBeDefined();
    expect(deadRef!.filePaths.map((p) => path.basename(p))).toEqual(['CLAUDE.md']);
  });

  it('scans the first of several links to the same undiscovered target and aliases the rest', async () => {
    const repo = tempRepo({ 'docs/ai-rules.txt': AGENTS });
    linkTo(repo, 'CLAUDE.md', 'docs/ai-rules.txt');
    linkTo(repo, '.cursorrules', 'docs/ai-rules.txt');
    const { files, aliases } = await scanFilesWithAliases({ repoPath: repo });
    expect(files.map((f) => f.relativePath)).toEqual(['.cursorrules']);
    expect(aliases.map((f) => [f.relativePath, f.aliasOf])).toEqual([['CLAUDE.md', '.cursorrules']]);
  });

  it('scans the link when its target was excluded', async () => {
    const repo = tempRepo({ 'AGENTS.md': AGENTS });
    linkTo(repo, 'CLAUDE.md', 'AGENTS.md');
    const { files, aliases } = await scanFilesWithAliases({ repoPath: repo, exclude: ['AGENTS.md'] });
    expect(files.map((f) => f.relativePath)).toEqual(['CLAUDE.md']);
    expect(aliases).toEqual([]);
  });

  it('skips a link whose target is outside the repo', async () => {
    const outside = makeTempRepo('promptci-symlink-outside-');
    tempDirs.push(outside);
    writeFile(outside, 'secret.md', '# Outside\n\nOUTSIDE-MARKER\n');
    const repo = tempRepo({ 'AGENTS.md': AGENTS });
    expect(trySymlink(path.join(outside, 'secret.md'), path.join(repo, 'CLAUDE.md'))).toBe(true);
    const { files, aliases } = await scanFilesWithAliases({ repoPath: repo });
    expect(files.map((f) => f.relativePath)).toEqual(['AGENTS.md']);
    expect(aliases).toEqual([]);
    const report = await scan({ repoPath: repo });
    expect(report.filesScanned.map((f) => f.relativePath)).toEqual(['AGENTS.md']);
    expect(JSON.stringify(report.issues)).not.toContain('OUTSIDE-MARKER');
  });

  it('skips a dangling link and a link to a directory', async () => {
    const repo = tempRepo({ 'AGENTS.md': AGENTS, 'docs/placeholder.txt': '' });
    expect(trySymlink(path.join(repo, 'nope.md'), path.join(repo, 'CLAUDE.md'))).toBe(true);
    // README.md pointing at a directory (type 'file' is a hint only on Windows).
    fs.symlinkSync(path.join(repo, 'docs'), path.join(repo, 'README.md'));
    const { files, aliases } = await scanFilesWithAliases({ repoPath: repo });
    expect(files.map((f) => f.relativePath)).toEqual(['AGENTS.md']);
    expect(aliases).toEqual([]);
  });

  it('reaches symlinked files under a rules directory too', async () => {
    const repo = tempRepo({
      'AGENTS.md': AGENTS,
      'shared/style.md': '# Style\n\nPrefer small functions and descriptive names across the codebase.\n',
    });
    linkTo(repo, '.cursor/rules/style.md', 'shared/style.md');
    const context = await buildRepoContext({ repoPath: repo });
    expect(context.files.map((f) => f.relativePath)).toContain('.cursor/rules/style.md');
  });
});

describe('a linked directory is never scanned as a file', () => {
  it('ignores a directory link whose name matches a file pattern', async () => {
    const repo = tempRepo({ 'AGENTS.md': AGENTS, 'rules-src/inner.md': '# Inner\n\nINNER-MARKER\n' });
    fs.mkdirSync(path.join(repo, 'prompts'), { recursive: true });
    // A junction on Windows (no privilege needed), a directory symlink elsewhere.
    fs.symlinkSync(path.join(repo, 'rules-src'), path.join(repo, 'prompts', 'rules.md'), 'junction');
    const { files, aliases } = await scanFilesWithAliases({ repoPath: repo });
    expect(files.map((f) => f.relativePath)).toEqual(['AGENTS.md']);
    expect(aliases).toEqual([]);
  });
});
