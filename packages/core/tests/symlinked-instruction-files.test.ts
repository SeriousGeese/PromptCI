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
import { detectAgentPractices } from '../src/agent-practices.js';
import { detectContextBloat } from '../src/context-bloat.js';
import type { InstructionFile } from '../src/types.js';
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

function synthetic(rel: string, content: string, fileType: InstructionFile['fileType'], aliasOf?: string): InstructionFile {
  return {
    path: `/repo/${rel}`,
    relativePath: rel,
    fileType,
    content,
    sections: [],
    lineCount: content.split('\n').length,
    charCount: content.length,
    estimatedTokens: Math.round(content.length / 4),
    ...(aliasOf !== undefined ? { aliasOf } : {}),
  };
}

// Tool-specific checks look at an alias under its OWN name, against the real content.
describe('tool-specific checks see aliases (platform independent)', () => {
  const BIG = `# Rules\n\n${'Keep the code readable and the diffs small.\n'.repeat(200)}`; // ~9k chars > Windsurf's 6k

  it('applies the Windsurf size limit to .windsurfrules -> AGENTS.md', () => {
    const agents = synthetic('AGENTS.md', BIG, 'agents');
    const alias = synthetic('.windsurfrules', BIG, 'windsurf', 'AGENTS.md');
    const plain = detectContextBloat([agents]);
    const withAlias = detectContextBloat([agents], undefined, [alias]);
    expect(plain.filter((i) => /Windsurf/.test(i.title))).toEqual([]);
    const windsurf = withAlias.filter((i) => /Windsurf/.test(i.title));
    expect(windsurf).toHaveLength(1);
    expect(windsurf[0]!.filePaths).toEqual([alias.path]);
    // The total and the generic per-file checks still count the content once.
    expect(withAlias.filter((i) => !/Windsurf/.test(i.title))).toEqual(plain);
  });

  it('applies the Copilot line limit to copilot-instructions.md -> AGENTS.md', () => {
    const body = `# Rules\n${'- keep it simple\n'.repeat(1_100)}`;
    const agents = synthetic('AGENTS.md', body, 'agents');
    const alias = synthetic('.github/copilot-instructions.md', body, 'copilot', 'AGENTS.md');
    expect(detectContextBloat([agents]).filter((i) => /Copilot/.test(i.title))).toEqual([]);
    expect(detectContextBloat([agents], undefined, [alias]).filter((i) => /Copilot/.test(i.title))).toHaveLength(1);
  });

  it('does not repeat a check when the real file is already that tool\'s file', () => {
    const windsurf = synthetic('.windsurfrules', BIG, 'windsurf');
    const alias = synthetic('rules/windsurf-copy.md', BIG, 'windsurf', '.windsurfrules');
    expect(detectContextBloat([windsurf], undefined, [alias])).toEqual(detectContextBloat([windsurf]));
  });

  const GUIDED =
    '# Dev\n\nAlways run the tests and verify the change before you say it is done. Be honest about failures: report failures honestly. ' +
    'Prefer focused diffs, keep scope tight, and read a file before you edit it. Ask when unsure.\n';

  it('runs the per-agent behavior checks for CLAUDE.md -> AGENTS.md', () => {
    const agents = synthetic('AGENTS.md', '# Agents\n\nBe nice. Use TypeScript.\n', 'agents');
    const guide = synthetic('CONTRIBUTING.md', GUIDED, 'unknown');
    const alias = synthetic('CLAUDE.md', agents.content, 'claude', 'AGENTS.md');
    const noAlias = detectAgentPractices([agents, guide]).filter((i) => i.title.includes('CLAUDE.md'));
    const withAlias = detectAgentPractices([agents, guide], [alias]).filter((i) => i.title.includes('CLAUDE.md'));
    expect(noAlias).toEqual([]);
    expect(withAlias.length).toBeGreaterThan(0);
    expect(withAlias[0]!.filePaths[0]).toBe(alias.path);
  });

  it('stays quiet when the aliased content has the guidance', () => {
    const agents = synthetic('AGENTS.md', GUIDED, 'agents');
    const alias = synthetic('CLAUDE.md', GUIDED, 'claude', 'AGENTS.md');
    expect(detectAgentPractices([agents], [alias])).toEqual(detectAgentPractices([agents]));
  });
});

describe('report output for aliases (platform independent)', () => {
  function reportWithAlias() {
    const real = synthetic('docs/rules/x.md', '# X\n\nSome rules.\n', 'unknown');
    const alias = { ...synthetic('.github/instructions/x.md', '', 'copilot', 'docs/rules/x.md'), lineCount: 0, charCount: 0, estimatedTokens: 0 };
    return {
      schemaVersion: '0.1' as const,
      generatedAt: '2026-01-01T00:00:00.000Z',
      repoPath: '/repo',
      projectType: 'unknown' as const,
      healthScore: { score: 100, label: 'Excellent' } as never,
      metrics: { estimatedInstructionTokens: real.estimatedTokens, instructionFileCount: 1, largestInstructionFiles: [] },
      filesScanned: [real, alias],
      issues: [],
      topFixes: [],
    };
  }

  it('counts only real files in the "Files scanned" header and labels the alias', () => {
    const md = generateMarkdownReport(reportWithAlias());
    expect(md).toContain('**Files scanned:** 1');
    expect(md).toContain('(symlink to `docs/rules/x.md`)');
  });

  it('writes forward-slash paths and a POSIX aliasOf into report.json', () => {
    const json = JSON.parse(generateJsonReport(reportWithAlias())) as {
      filesScanned: Array<{ path: string; aliasOf?: string; charCount: number }>;
    };
    expect(json.filesScanned.map((f) => f.path)).toEqual(['docs/rules/x.md', '.github/instructions/x.md']);
    expect(json.filesScanned[1]).toMatchObject({ aliasOf: 'docs/rules/x.md', charCount: 0 });
  });
});

describe('a linked directory is never scanned twice', () => {
  function junctionRepo(): string {
    const repo = tempRepo({
      'AGENTS.md': AGENTS,
      '.cursor/rules/style.md': '# Style\n\nPrefer small functions and descriptive names across the codebase.\n',
    });
    // A junction on Windows (no privilege needed), a directory symlink elsewhere.
    fs.symlinkSync(path.join(repo, '.cursor', 'rules'), path.join(repo, '.clinerules'), 'junction');
    return repo;
  }

  it('scans the content once, under the name that crosses no link, and aliases the other', async () => {
    const { files, aliases } = await scanFilesWithAliases({ repoPath: junctionRepo() });
    expect(files.map((f) => f.relativePath)).toEqual(['.cursor/rules/style.md', 'AGENTS.md']);
    expect(aliases.map((f) => [f.relativePath, f.aliasOf])).toEqual([['.clinerules/style.md', '.cursor/rules/style.md']]);
  });

  it('produces the same findings as without the linked directory, and lists the alias with zeroed counts', async () => {
    const withLink = await scan({ repoPath: junctionRepo() });
    const plainRepo = tempRepo({
      'AGENTS.md': AGENTS,
      '.cursor/rules/style.md': '# Style\n\nPrefer small functions and descriptive names across the codebase.\n',
    });
    const plain = await scan({ repoPath: plainRepo });
    expect(withLink.issues.map((i) => i.id)).toEqual(plain.issues.map((i) => i.id));
    expect(withLink.metrics.instructionFileCount).toBe(plain.metrics.instructionFileCount);
    const alias = withLink.filesScanned.find((f) => f.aliasOf !== undefined)!;
    expect(alias).toMatchObject({ relativePath: '.clinerules/style.md', charCount: 0, estimatedTokens: 0, lineCount: 0 });
    const summed = withLink.filesScanned.reduce((n, f) => n + f.estimatedTokens, 0);
    expect(summed).toBe(plain.filesScanned.reduce((n, f) => n + f.estimatedTokens, 0));
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
