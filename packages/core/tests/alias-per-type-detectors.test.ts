/**
 * pcic-2b6.15 (follow-ups to #127):
 *
 * 1. File-type-specific checks run for each symlink ALIAS under the alias's own
 *    type, against the real content, without repeating generic findings.
 * 2. A checkout without symlink support (Windows without `core.symlinks`) writes
 *    a link as a small file holding the target path; that file is treated as an
 *    alias so Windows and Linux scans agree.
 *
 * Almost everything here is platform independent (synthetic aliases, and text
 * files standing in for links); only the real-symlink parity test needs link
 * support and skips without it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scan } from '../src/scan.js';
import { foldTextSymlinks, parseSections, scanFilesWithAliases } from '../src/scanner.js';
import { configDisablesSymlinks, symlinkPathsInIndex } from '../src/git-symlinks.js';
import type { GitSymlinkOracle } from '../src/git-symlinks.js';
import { detectAgentPractices } from '../src/agent-practices.js';
import { detectWindsurfRules } from '../src/windsurf-detector.js';
import { DETECTORS } from '../src/detectors.js';
import { aliasesWithNewType, withTypeAliases } from '../src/alias-files.js';
import type { RepoContext } from '../src/repo-context.js';
import type { FileType, InstructionFile } from '../src/types.js';
import { canSymlink, makeTempRepo, trySymlink, writeFile } from './ai-config-helpers.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempRepo(files: Record<string, string>): string {
  const repo = makeTempRepo('promptci-alias-types-');
  tempDirs.push(repo);
  for (const [rel, content] of Object.entries(files)) writeFile(repo, rel, content);
  return repo;
}

/** A repo whose own git config says symlinks are off: how a Windows checkout without link support looks. */
function noLinkRepo(files: Record<string, string>): string {
  const repo = tempRepo(files);
  writeFile(repo, '.git/config', '[core]\n\trepositoryformatversion = 0\n\tsymlinks = false\n');
  return repo;
}

function synthetic(rel: string, content: string, fileType: FileType, aliasOf?: string): InstructionFile {
  const p = `/repo/${rel}`;
  return {
    path: p,
    relativePath: rel,
    fileType,
    content,
    sections: parseSections(content, p, rel),
    lineCount: content.split('\n').length,
    charCount: content.length,
    estimatedTokens: Math.round(content.length / 4),
    ...(aliasOf !== undefined ? { aliasOf } : {}),
  };
}

/** Just the context fields the detectors under test read. */
function contextOf(files: InstructionFile[], aliasFiles: InstructionFile[]): RepoContext {
  return { files, aliasFiles, onDemandFiles: [] } as unknown as RepoContext;
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

/** Two language headings in one always-on file: what the Windsurf scope check looks for. */
const MULTI_LANGUAGE = [
  '# Rules',
  '',
  '## Python',
  '',
  'Use type hints and keep functions short and focused on a single task.',
  '',
  '## TypeScript',
  '',
  'Prefer strict mode and avoid `any`; keep modules small and cohesive.',
  '',
].join('\n');

describe('aliasesWithNewType / withTypeAliases', () => {
  const agents = synthetic('AGENTS.md', 'x', 'agents');
  const claudeAlias = synthetic('CLAUDE.md', 'x', 'claude', 'AGENTS.md');
  const windsurfAlias = synthetic('.windsurfrules', 'x', 'windsurf', 'AGENTS.md');
  const isWindsurf = (type: FileType) => type === 'windsurf';

  it('keeps an alias whose own type qualifies while the real file\'s does not', () => {
    expect(aliasesWithNewType([agents], [claudeAlias, windsurfAlias], isWindsurf)).toEqual([windsurfAlias]);
  });

  it('drops an alias whose real file already qualifies (no repeat of a generic check)', () => {
    const windsurf = synthetic('.windsurfrules', 'x', 'windsurf');
    const copy = synthetic('rules/copy.md', 'x', 'windsurf', '.windsurfrules');
    expect(aliasesWithNewType([windsurf], [copy], isWindsurf)).toEqual([]);
  });

  it('keeps an alias whose real file is not among the files (an on-demand body, say)', () => {
    expect(aliasesWithNewType([], [windsurfAlias], isWindsurf)).toEqual([windsurfAlias]);
  });

  it('returns the same array when there is nothing to add', () => {
    const files = [agents];
    expect(withTypeAliases(files, [claudeAlias], isWindsurf)).toBe(files);
    expect(withTypeAliases(files, undefined, isWindsurf)).toBe(files);
    expect(withTypeAliases(files, [windsurfAlias], isWindsurf)).toEqual([agents, windsurfAlias]);
  });
});

describe('windsurf scope check runs for .windsurfrules -> AGENTS.md', () => {
  const agents = synthetic('AGENTS.md', MULTI_LANGUAGE, 'agents');
  const alias = synthetic('.windsurfrules', MULTI_LANGUAGE, 'windsurf', 'AGENTS.md');

  it('reports the alias, against the real content, and nothing without the alias', () => {
    expect(detectWindsurfRules(contextOf([agents], []))).toEqual([]);
    const issues = detectWindsurfRules(contextOf([agents], [alias]));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.filePaths).toEqual([alias.path]);
    expect(issues[0]!.evidence[0]).toContain('Python, TypeScript');
  });

  it('does not report an alias of another tool\'s file, or an alias of a file that is already a Windsurf file', () => {
    const claude = synthetic('CLAUDE.md', MULTI_LANGUAGE, 'claude', 'AGENTS.md');
    expect(detectWindsurfRules(contextOf([agents], [claude]))).toEqual([]);

    const real = synthetic('.windsurfrules', MULTI_LANGUAGE, 'windsurf');
    const copy = synthetic('.windsurf/rules/copy.md', MULTI_LANGUAGE, 'windsurf', '.windsurfrules');
    expect(detectWindsurfRules(contextOf([real], [copy]))).toHaveLength(1); // the real file only
  });

  it('gives the alias the id a real .windsurfrules would have (stable across platforms), distinct from AGENTS.md\'s', () => {
    const real = synthetic('.windsurfrules', MULTI_LANGUAGE, 'windsurf');
    const other = synthetic('.windsurf/rules/other.md', MULTI_LANGUAGE, 'windsurf');
    const ids = detectWindsurfRules(contextOf([real, other], [])).map((i) => i.id);
    expect(new Set(ids).size).toBe(2);
    expect(detectWindsurfRules(contextOf([agents], [alias]))[0]!.id).toBe(detectWindsurfRules(contextOf([real], []))[0]!.id);
  });
});

describe('the Claude-tag check sees an alias that is a different tool\'s file', () => {
  const TAGGED = '# Rules\n\nUse <claude:thinking> blocks before answering. Keep diffs focused and verify before finishing.\n';
  const tagIssues = (files: InstructionFile[], aliases: InstructionFile[]) =>
    detectAgentPractices(files, aliases).filter((i) => i.title.startsWith('Claude-specific XML tag'));

  it('flags AGENTS.md -> CLAUDE.md: every other tool reads it as an AGENTS.md', () => {
    const claude = synthetic('CLAUDE.md', TAGGED, 'claude');
    const alias = synthetic('AGENTS.md', TAGGED, 'agents', 'CLAUDE.md');
    expect(tagIssues([claude], [])).toEqual([]);
    const issues = tagIssues([claude], [alias]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.filePaths).toEqual([alias.path]);
    expect(issues[0]!.evidence[0]).toContain('in agents file');
  });

  it('does not repeat the real file\'s finding for an alias of a file that is already not Claude\'s', () => {
    const agents = synthetic('AGENTS.md', TAGGED, 'agents');
    const cursorAlias = synthetic('.cursorrules', TAGGED, 'cursor', 'AGENTS.md');
    const claudeAlias = synthetic('CLAUDE.md', TAGGED, 'claude', 'AGENTS.md');
    expect(tagIssues([agents], [])).toHaveLength(1);
    expect(tagIssues([agents], [cursorAlias, claudeAlias])).toHaveLength(1);
  });

  it('leaves a README alias alone (README files document the tags)', () => {
    const readme = synthetic('README.md', TAGGED, 'readme');
    const alias = synthetic('CLAUDE.md', TAGGED, 'claude', 'README.md');
    expect(tagIssues([readme], [alias])).toEqual([]);
  });

  it('does not run the Copilot agent-behavior check for copilot-instructions.md -> AGENTS.md (the link is not Copilot-only)', () => {
    const body = '# Rules\n\n## Agent Behavior\n\nAlways run the tests and verify the change before you say it is done. Report failures honestly.\n';
    const agents = synthetic('AGENTS.md', body, 'agents');
    const alias = synthetic('.github/copilot-instructions.md', body, 'copilot', 'AGENTS.md');
    const behavior = (files: InstructionFile[], aliases: InstructionFile[]) =>
      detectAgentPractices(files, aliases).filter((i) => i.id.startsWith('copilot-agent-behavior-'));
    expect(behavior([agents], [])).toEqual([]);
    expect(behavior([agents], [alias])).toEqual([]);
    // The same file as a REAL copilot-instructions.md is still flagged.
    const real = synthetic('.github/copilot-instructions.md', body, 'copilot');
    expect(behavior([real], [])).toHaveLength(1);
  });
});

describe('type-gated generic detectors see an alias only when the real file\'s type is not in the set', () => {
  const DATED = '# Notes\n\nLast updated: 2026-01-15\n\nKeep diffs focused and run the tests before you push.\n';
  const run = (id: string, files: InstructionFile[], aliases: InstructionFile[]) =>
    DETECTORS.find((d) => d.id === id)!.run(contextOf(files, aliases));

  it('checks CLAUDE.md -> README.md as the CLAUDE.md it is (README is not an instruction type)', () => {
    const readme = synthetic('README.md', DATED, 'readme');
    const alias = synthetic('CLAUDE.md', DATED, 'claude', 'README.md');
    expect(run('prompt-cache-friendliness', [readme], [])).toEqual([]);
    const issues = run('prompt-cache-friendliness', [readme], [alias]);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.filePaths[0] === alias.path)).toBe(true);
  });

  it('reports the content once when the real file is already an instruction file', () => {
    const agents = synthetic('AGENTS.md', DATED, 'agents');
    const alias = synthetic('CLAUDE.md', DATED, 'claude', 'AGENTS.md');
    const plain = run('prompt-cache-friendliness', [agents], []);
    expect(plain.length).toBeGreaterThan(0);
    expect(run('prompt-cache-friendliness', [agents], [alias])).toEqual(plain);
  });

  it.each(['within-section-dedup', 'negative-instructions', 'buried-critical', 'prompt-cache-friendliness'])(
    '%s: an alias of an instruction file adds nothing',
    (id) => {
      const agents = synthetic('AGENTS.md', AGENTS, 'agents');
      const alias = synthetic('CLAUDE.md', AGENTS, 'claude', 'AGENTS.md');
      expect(run(id, [agents], [alias])).toEqual(run(id, [agents], []));
    },
  );
});

describe('text symlinks (a link checked out without symlink support)', () => {
  const scanned = async (files: Record<string, string>) => scanFilesWithAliases({ repoPath: noLinkRepo(files) });
  const rels = (list: InstructionFile[]) => list.map((f) => f.relativePath);

  it.each([
    ['the bare path', 'AGENTS.md'],
    ['the path with a trailing newline', 'AGENTS.md\n'],
    ['a ./ prefix', './AGENTS.md'],
    ['CRLF line endings', 'AGENTS.md\r\n'],
    ['surrounding blank space', '\n  AGENTS.md  \n\n'],
  ])('treats CLAUDE.md holding %s as an alias of AGENTS.md', async (_label, content) => {
    const { files, aliases } = await scanned({ 'AGENTS.md': AGENTS, 'CLAUDE.md': content });
    expect(rels(files)).toEqual(['AGENTS.md']);
    expect(aliases).toHaveLength(1);
    expect(aliases[0]).toMatchObject({ relativePath: 'CLAUDE.md', aliasOf: 'AGENTS.md', fileType: 'claude' });
  });

  it('gives the alias the real content and sections (so tool-specific checks see the real text)', async () => {
    const { aliases } = await scanned({ 'AGENTS.md': AGENTS, '.windsurfrules': 'AGENTS.md\n' });
    const alias = aliases[0]!;
    expect(alias.fileType).toBe('windsurf');
    expect(alias.content).toBe(AGENTS);
    expect(alias.charCount).toBe(AGENTS.length);
    expect(alias.sections.map((s) => s.heading)).toEqual(['Agents', 'Build', 'Testing']);
    expect(alias.sections.every((s) => s.filePath === alias.path && s.relativePath === '.windsurfrules')).toBe(true);
  });

  it('reads a target the way git stores it: relative to the link\'s directory', async () => {
    const { files, aliases } = await scanned({ 'AGENTS.md': AGENTS, '.github/copilot-instructions.md': '../AGENTS.md\n' });
    expect(rels(files)).toEqual(['AGENTS.md']);
    expect(aliases[0]).toMatchObject({ relativePath: '.github/copilot-instructions.md', aliasOf: 'AGENTS.md', fileType: 'copilot' });
  });

  it('resolves a chain to the final real file', async () => {
    const { files, aliases } = await scanned({ 'AGENTS.md': AGENTS, 'GEMINI.md': 'AGENTS.md', 'CLAUDE.md': 'GEMINI.md' });
    expect(rels(files)).toEqual(['AGENTS.md']);
    expect(aliases.map((a) => [a.relativePath, a.aliasOf])).toEqual([['CLAUDE.md', 'AGENTS.md'], ['GEMINI.md', 'AGENTS.md']]);
  });

  it('two links to the same file are both aliases of it', async () => {
    const { files, aliases } = await scanned({ 'AGENTS.md': AGENTS, 'CLAUDE.md': 'AGENTS.md', '.cursorrules': 'AGENTS.md' });
    expect(rels(files)).toEqual(['AGENTS.md']);
    expect(aliases.map((a) => [a.relativePath, a.aliasOf, a.fileType])).toEqual([
      ['.cursorrules', 'AGENTS.md', 'cursor'],
      ['CLAUDE.md', 'AGENTS.md', 'claude'],
    ]);
  });

  describe('a genuine short file is never mistaken for a link', () => {
    it.each([
      ['a path with no such discovered file', { 'AGENTS.md': AGENTS, 'CLAUDE.md': 'docs/rules.md' }],
      ['a path to a file the scan did not discover', { 'AGENTS.md': AGENTS, 'docs/rules.md': '# Rules\n', 'CLAUDE.md': 'docs/rules.md' }],
      ['the right name in prose', { 'AGENTS.md': AGENTS, 'CLAUDE.md': 'See AGENTS.md' }],
      ['the path plus a second line', { 'AGENTS.md': AGENTS, 'CLAUDE.md': 'AGENTS.md\nFollow it.' }],
      ['the path inside backticks', { 'AGENTS.md': AGENTS, 'CLAUDE.md': '`AGENTS.md`' }],
      ['the path in a different case', { 'AGENTS.md': AGENTS, 'CLAUDE.md': 'agents.md' }],
      ['an absolute path', { 'AGENTS.md': AGENTS, 'CLAUDE.md': '/AGENTS.md' }],
      ['a drive path', { 'AGENTS.md': AGENTS, 'CLAUDE.md': 'C:/repo/AGENTS.md' }],
      ['a backslash path', { 'AGENTS.md': AGENTS, '.github/copilot-instructions.md': '..\\AGENTS.md' }],
      ['a path out of the repo', { 'AGENTS.md': AGENTS, 'CLAUDE.md': '../AGENTS.md' }],
      ['an empty file', { 'AGENTS.md': AGENTS, 'CLAUDE.md': '' }],
      ['a file that names itself', { 'AGENTS.md': AGENTS, 'CLAUDE.md': 'CLAUDE.md' }],
      ['a two-file cycle', { 'CLAUDE.md': 'AGENTS.md', 'AGENTS.md': 'CLAUDE.md' }],
    ])('%s', async (_label, repoFiles) => {
      const { files, aliases } = await scanned(repoFiles);
      expect(aliases).toEqual([]);
      expect(rels(files).sort()).toEqual(Object.keys(repoFiles).filter((rel) => rel !== 'docs/rules.md').sort());
    });

    it('a path longer than 260 characters', async () => {
      const long = `${'a/'.repeat(140)}AGENTS.md`;
      const { aliases } = await scanned({ 'AGENTS.md': AGENTS, [long]: '# x\n', 'CLAUDE.md': long });
      expect(aliases).toEqual([]);
    });

    it('a real instruction file that happens to be short', async () => {
      const { files, aliases } = await scanned({ 'AGENTS.md': AGENTS, 'CLAUDE.md': '# Claude\n\nFollow AGENTS.md for the rules.\n' });
      expect(aliases).toEqual([]);
      expect(rels(files)).toEqual(['AGENTS.md', 'CLAUDE.md']);
    });
  });

  it('stays linear with a thousand text links and long chains', async () => {
    const repoFiles: Record<string, string> = { 'AGENTS.md': AGENTS };
    for (let n = 0; n < 1000; n++) repoFiles[`.cursor/rules/r${n}.md`] = n % 2 === 0 ? '../../AGENTS.md' : `r${n - 1}.md`;
    const repo = noLinkRepo(repoFiles);
    const started = performance.now();
    const { files, aliases } = await scanFilesWithAliases({ repoPath: repo });
    const elapsed = performance.now() - started;
    expect(rels(files)).toEqual(['AGENTS.md']);
    expect(aliases).toHaveLength(1000);
    expect(new Set(aliases.map((a) => a.aliasOf))).toEqual(new Set(['AGENTS.md']));
    expect(elapsed, `${elapsed.toFixed(0)} ms`).toBeLessThan(15_000);
  }, 60_000);

  it('keeps the other files of a repo that has a cycle scanned as plain files', async () => {
    const { files, aliases } = await scanned({ 'AGENTS.md': 'CLAUDE.md', 'CLAUDE.md': 'AGENTS.md', 'README.md': '# Readme\n\nA project.\n' });
    expect(aliases).toEqual([]);
    expect(rels(files)).toEqual(['AGENTS.md', 'CLAUDE.md', 'README.md']);
  });

  it('is listed with zeroed counts, counts the real content once, and does not change the findings', async () => {
    const linked = await scan({ repoPath: noLinkRepo({ 'AGENTS.md': AGENTS, 'CLAUDE.md': 'AGENTS.md\n' }) });
    const plain = await scan({ repoPath: tempRepo({ 'AGENTS.md': AGENTS }) });
    const alias = linked.filesScanned.find((f) => f.aliasOf !== undefined)!;
    expect(alias).toMatchObject({ relativePath: 'CLAUDE.md', aliasOf: 'AGENTS.md', charCount: 0, estimatedTokens: 0, lineCount: 0, content: '' });
    expect(linked.metrics.instructionFileCount).toBe(plain.metrics.instructionFileCount);
    expect(linked.metrics.estimatedInstructionTokens).toBe(plain.metrics.estimatedInstructionTokens);
    // Only the CLAUDE.md-specific checks (the per-agent behavior checks) may add findings for the alias.
    const extra = linked.issues.filter((i) => !plain.issues.some((p) => p.id === i.id));
    expect(extra.every((i) => i.filePaths.some((p) => p.endsWith('CLAUDE.md')))).toBe(true);
  });

  it('runs a tool-specific check for a text-symlinked alias: .windsurfrules -> AGENTS.md', async () => {
    const linked = await scan({ repoPath: noLinkRepo({ 'AGENTS.md': MULTI_LANGUAGE, '.windsurfrules': 'AGENTS.md\n' }) });
    const plain = await scan({ repoPath: tempRepo({ 'AGENTS.md': MULTI_LANGUAGE }) });
    const scope = (issues: typeof linked.issues) => issues.filter((i) => i.id.startsWith('ai-config-windsurf-scope-'));
    expect(scope(plain.issues)).toEqual([]);
    expect(scope(linked.issues)).toHaveLength(1);
    expect(scope(linked.issues)[0]!.filePaths[0]).toMatch(/\.windsurfrules$/);
  });
});

// Windows (text links) and Linux (real links) must agree on the same committed repo.
describe.skipIf(!canSymlink)('Windows and Linux checkouts of the same links scan alike', () => {
  const FILES = { 'AGENTS.md': MULTI_LANGUAGE, 'README.md': '# Readme\n\nA project.\n' };

  function linkedRepos(): { real: string; text: string } {
    const real = tempRepo(FILES);
    expect(trySymlink('AGENTS.md', path.join(real, '.windsurfrules'))).toBe(true);
    expect(trySymlink('AGENTS.md', path.join(real, 'CLAUDE.md'))).toBe(true);
    expect(trySymlink('../AGENTS.md', path.join(real, '.github', 'copilot-instructions.md'))).toBe(true);
    const text = noLinkRepo({
      ...FILES,
      '.windsurfrules': 'AGENTS.md',
      'CLAUDE.md': 'AGENTS.md',
      '.github/copilot-instructions.md': '../AGENTS.md',
    });
    return { real, text };
  }

  it('lists the same files, aliases, finding ids and counts', async () => {
    const { real, text } = linkedRepos();
    const [a, b] = [await scan({ repoPath: real }), await scan({ repoPath: text })];
    const shape = (report: typeof a) => ({
      ids: report.issues.map((i) => i.id).sort(),
      files: report.filesScanned.map((f) => [f.relativePath, f.fileType, f.aliasOf ?? null, f.charCount, f.lineCount, f.estimatedTokens]),
      metrics: report.metrics.instructionFileCount,
      score: report.healthScore,
    });
    expect(shape(b)).toEqual(shape(a));
    expect(shape(b).files.filter((f) => f[2] !== null)).toHaveLength(3);
  });
});

// \u2500\u2500 review round \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/** A git index (version 2 or 3) with the given entries: enough of the format for the reader. */
function indexBuffer(entries: Array<{ path: string; mode: number }>, version = 2): Buffer {
  const header = Buffer.alloc(12);
  header.write('DIRC', 0, 'latin1');
  header.writeUInt32BE(version, 4);
  header.writeUInt32BE(entries.length, 8);
  const parts: Buffer[] = [header];
  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8');
    const body = Buffer.alloc(Math.ceil((62 + name.length + 1) / 8) * 8);
    body.writeUInt32BE(entry.mode, 24);
    body.writeUInt16BE(Math.min(name.length, 0xfff), 60);
    name.copy(body, 62);
    parts.push(body);
  }
  parts.push(Buffer.alloc(20)); // trailing checksum
  return Buffer.concat(parts);
}

const LINK = 0o120000;
const FILE = 0o100644;

describe('configDisablesSymlinks', () => {
  it.each([
    ['core.symlinks = false', '[core]\n\tsymlinks = false\n', true],
    ['no / off / 0, any case', '[core]\n\tSymlinks = NO\n', true],
    ['a trailing comment', '[core]\n\tsymlinks = false ; autodetected\n', true],
    ['CRLF line endings', '[core]\r\n\tsymlinks = false\r\n', true],
    ['the last value wins', '[core]\n\tsymlinks = false\n\tsymlinks = true\n', false],
    ['true', '[core]\n\tsymlinks = true\n', false],
    ['a bare key (true by git rules)', '[core]\n\tsymlinks\n', false],
    ['unset', '[core]\n\tfilemode = false\n', false],
    ['another section', '[remote "origin"]\n\tsymlinks = false\n', false],
    ['a commented line', '[core]\n\t# symlinks = false\n', false],
    ['a core subsection', '[core "x"]\n\tsymlinks = false\n', false],
  ])('%s', (_label, config, expected) => {
    expect(configDisablesSymlinks(config)).toBe(expected);
  });
});

describe('symlinkPathsInIndex', () => {
  it('lists the paths whose mode is a symlink', () => {
    const index = indexBuffer([{ path: 'AGENTS.md', mode: FILE }, { path: 'CLAUDE.md', mode: LINK }, { path: 'docs/long/name.md', mode: LINK }]);
    expect([...symlinkPathsInIndex(index)!].sort()).toEqual(['CLAUDE.md', 'docs/long/name.md']);
  });

  it('reads version 3 and a name past the 12-bit length field', () => {
    const long = `${'d/'.repeat(2100)}x.md`;
    expect([...symlinkPathsInIndex(indexBuffer([{ path: long, mode: LINK }], 3))!]).toEqual([long]);
  });

  it('answers undefined for another version, another file, or a truncated index', () => {
    expect(symlinkPathsInIndex(indexBuffer([{ path: 'a', mode: LINK }], 4))).toBeUndefined();
    expect(symlinkPathsInIndex(Buffer.from('not an index at all'))).toBeUndefined();
    expect(symlinkPathsInIndex(indexBuffer([{ path: 'a', mode: LINK }, { path: 'b', mode: LINK }]).subarray(0, 90))).toBeUndefined();
  });
});

describe('a text file is a link only when the repository says so', () => {
  const files = { 'AGENTS.md': AGENTS, 'CLAUDE.md': 'AGENTS.md\n' };
  const aliasesOf = async (repo: string) => (await scanFilesWithAliases({ repoPath: repo })).aliases.map((a) => a.relativePath);

  it('leaves a one-line pointer file alone when there is no git repository', async () => {
    expect(await aliasesOf(tempRepo(files))).toEqual([]);
  });

  it.each([
    ['core.symlinks = true', '[core]\n\tsymlinks = true\n'],
    ['no core.symlinks key', '[core]\n\tbare = false\n'],
  ])('leaves a pointer file alone with %s in the repo config', async (_label, config) => {
    const repo = tempRepo(files);
    writeFile(repo, '.git/config', config);
    expect(await aliasesOf(repo)).toEqual([]);
  });

  it('folds it with core.symlinks = false in the repo config', async () => {
    expect(await aliasesOf(noLinkRepo(files))).toEqual(['CLAUDE.md']);
  });

  it('folds it when the index records mode 120000, with no config', async () => {
    const repo = tempRepo(files);
    writeFile(repo, '.git/HEAD', 'ref: refs/heads/main');
    fs.writeFileSync(path.join(repo, '.git', 'index'), indexBuffer([{ path: 'AGENTS.md', mode: FILE }, { path: 'CLAUDE.md', mode: LINK }]));
    expect(await aliasesOf(repo)).toEqual(['CLAUDE.md']);
  });

  it('keeps a tracked regular file real even with core.symlinks = false (the index is authoritative)', async () => {
    const repo = noLinkRepo(files);
    fs.writeFileSync(path.join(repo, '.git', 'index'), indexBuffer([{ path: 'AGENTS.md', mode: FILE }, { path: 'CLAUDE.md', mode: FILE }]));
    expect(await aliasesOf(repo)).toEqual([]);
  });

  it('falls back to the config when the index is a version it does not read', async () => {
    const repo = noLinkRepo(files);
    fs.writeFileSync(path.join(repo, '.git', 'index'), indexBuffer([{ path: 'CLAUDE.md', mode: FILE }], 4));
    expect(await aliasesOf(repo)).toEqual(['CLAUDE.md']);
  });

  it('reads the config of a linked worktree through .git/commondir', async () => {
    const repo = tempRepo(files);
    const common = path.join(repo, 'common.git');
    fs.mkdirSync(path.join(common, 'worktrees', 'w'), { recursive: true });
    fs.writeFileSync(path.join(common, 'config'), '[core]\n\tsymlinks = false\n');
    fs.writeFileSync(path.join(common, 'worktrees', 'w', 'commondir'), '../..\n');
    const work = path.join(repo, 'work');
    for (const [rel, content] of Object.entries(files)) writeFile(work, rel, content);
    fs.writeFileSync(path.join(work, '.git'), `gitdir: ${path.join(common, 'worktrees', 'w')}\n`);
    expect(await aliasesOf(work)).toEqual(['CLAUDE.md']);
  });

  it('finds the repository above a subdirectory scan, with index paths relative to the repository root', async () => {
    const repo = tempRepo({ 'pkg/AGENTS.md': AGENTS, 'pkg/CLAUDE.md': 'AGENTS.md' });
    writeFile(repo, '.git/HEAD', 'ref: refs/heads/main');
    fs.writeFileSync(path.join(repo, '.git', 'index'), indexBuffer([{ path: 'pkg/CLAUDE.md', mode: LINK }]));
    expect(await aliasesOf(path.join(repo, 'pkg'))).toEqual(['CLAUDE.md']);
  });
});

describe('text link resolution follows git and Linux semantics', () => {
  const scanned = async (repoFiles: Record<string, string>) => scanFilesWithAliases({ repoPath: noLinkRepo(repoFiles) });

  it('resolves relative to the link\'s own directory only (no repo-root fallback)', async () => {
    // `.github/copilot-instructions.md` containing `AGENTS.md` points at `.github/AGENTS.md`, which does not exist.
    const { files, aliases } = await scanned({ 'AGENTS.md': AGENTS, '.github/copilot-instructions.md': 'AGENTS.md' });
    expect(aliases).toEqual([]);
    expect(files.map((f) => f.relativePath)).toEqual(['.github/copilot-instructions.md', 'AGENTS.md']);
  });

  const chain = (links: number) => Object.fromEntries([
    ['AGENTS.md', AGENTS],
    ...Array.from({ length: links }, (_, n) => [`.cursor/rules/r${n}.md`, n === 0 ? '../../AGENTS.md' : `r${n - 1}.md`]),
  ]);

  it('follows a chain of up to 8 links and leaves a longer one alone', async () => {
    const eight = await scanned(chain(8)); // r7 is 8 links from AGENTS.md
    expect(eight.files.map((f) => f.relativePath)).toEqual(['AGENTS.md']);
    expect(eight.aliases).toHaveLength(8);
    const nine = await scanned(chain(9)); // r8 would need 9: it stays a plain file, the other eight fold
    expect(nine.aliases).toHaveLength(8);
    expect(nine.files.map((f) => f.relativePath)).toEqual(['.cursor/rules/r8.md', 'AGENTS.md']);
  });
});

describe('foldTextSymlinks rebuilds a re-pointed alias in full', () => {
  it('gives an alias of a text link the real content, sections and type of ITS OWN name', () => {
    const stub = synthetic('CLAUDE.md', 'AGENTS.md', 'claude');
    const real = synthetic('AGENTS.md', AGENTS, 'agents');
    const viaStub = synthetic('.windsurfrules', 'AGENTS.md', 'windsurf', 'CLAUDE.md'); // a real link to the text link: it read the stub
    const yes: GitSymlinkOracle = { isSymlink: (rel) => rel === 'CLAUDE.md' };
    const folded = foldTextSymlinks([stub, real], [viaStub], yes);
    expect(folded.files.map((f) => f.relativePath)).toEqual(['AGENTS.md']);
    const byName = Object.fromEntries(folded.aliases.map((a) => [a.relativePath, a]));
    for (const name of ['CLAUDE.md', '.windsurfrules']) {
      expect(byName[name]!.aliasOf, name).toBe('AGENTS.md');
      expect(byName[name]!.content, name).toBe(AGENTS);
      expect(byName[name]!.charCount, name).toBe(AGENTS.length);
      expect(byName[name]!.sections.map((s) => s.heading), name).toEqual(['Agents', 'Build', 'Testing']);
      expect(byName[name]!.sections.every((s) => s.filePath === byName[name]!.path), name).toBe(true);
    }
    expect(byName['.windsurfrules']!.fileType).toBe('windsurf');
  });

  it('folds nothing when the oracle says no', () => {
    const stub = synthetic('CLAUDE.md', 'AGENTS.md', 'claude');
    const real = synthetic('AGENTS.md', AGENTS, 'agents');
    const folded = foldTextSymlinks([stub, real], [], { isSymlink: () => false });
    expect(folded.aliases).toEqual([]);
    expect(folded.files).toHaveLength(2);
  });
});

describe('several links to one file give one finding per check', () => {
  const TAGGED = '# Rules\n\nUse <claude:thinking> blocks. Keep diffs focused and verify before finishing.\n';
  const DATED = '# Notes\n\nLast updated: 2026-01-15\n\nKeep diffs focused and run the tests before you push.\n';

  it('the Claude-tag check lists every alias of CLAUDE.md in one finding', () => {
    const claude = synthetic('CLAUDE.md', TAGGED, 'claude');
    const aliases = [
      synthetic('AGENTS.md', TAGGED, 'agents', 'CLAUDE.md'),
      synthetic('.cursorrules', TAGGED, 'cursor', 'CLAUDE.md'),
      synthetic('GEMINI.md', TAGGED, 'gemini', 'CLAUDE.md'),
    ];
    const issues = detectAgentPractices([claude], aliases).filter((i) => i.title.startsWith('Claude-specific XML tag'));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.filePaths).toEqual(aliases.map((a) => a.path).sort());
    expect(issues[0]!.locations).toHaveLength(3);
    expect(issues[0]!.evidence[0]).toContain('cursor, agents, gemini');
    // Stable: the id comes from the first alias by path.
    const first = [...aliases].sort((x, y) => x.path.localeCompare(y.path))[0]!;
    expect(issues[0]!.id).toBe(detectAgentPractices([claude], [first]).find((i) => i.title.startsWith('Claude-specific'))!.id);
  });

  it('the Windsurf check lists every Windsurf alias of one file in one finding', () => {
    const agents = synthetic('AGENTS.md', MULTI_LANGUAGE, 'agents');
    const a = synthetic('.windsurfrules', MULTI_LANGUAGE, 'windsurf', 'AGENTS.md');
    const b = synthetic('.windsurf/rules/main.md', MULTI_LANGUAGE, 'windsurf', 'AGENTS.md');
    const issues = detectWindsurfRules(contextOf([agents], [a, b]));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.filePaths).toEqual([b.path, a.path].sort());
  });

  it('a generic type-gated detector reads the content once however many links point at it', () => {
    const readme = synthetic('README.md', DATED, 'readme');
    const aliases = [
      synthetic('CLAUDE.md', DATED, 'claude', 'README.md'),
      synthetic('AGENTS.md', DATED, 'agents', 'README.md'),
      synthetic('.cursorrules', DATED, 'cursor', 'README.md'),
    ];
    const run = (as: InstructionFile[]) => DETECTORS.find((d) => d.id === 'prompt-cache-friendliness')!.run(contextOf([readme], as));
    // The first alias by path stands in for the group.
    const first = [...aliases].sort((x, y) => x.path.localeCompare(y.path))[0]!;
    const one = run([first]);
    expect(one.length).toBeGreaterThan(0);
    expect(run(aliases)).toEqual(one);
    expect(one.every((i) => i.filePaths[0] === first.path)).toBe(true);
  });
});
