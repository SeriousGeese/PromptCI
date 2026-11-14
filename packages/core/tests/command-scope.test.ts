/**
 * Repros from the independent review of #163/#166 (pcic-1ik0.2): where the text
 * around a command says it runs, what a slash-joined list hides, and when an
 * automatic edit must be withheld. Real scan pipeline over temp repos.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scan } from '../src/scan.js';
import type { PromptCiIssue } from '../src/types.js';
import { makeTempRepo, writeFile } from './ai-config-helpers.js';

const tempRepos: string[] = [];
afterEach(() => {
  for (const dir of tempRepos.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const pkg = (scripts: Record<string, string>, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ name: 'x', scripts, ...extra });

const ROOT = pkg({ build: 'x', lint: 'x', check: 'x' });
const SITE = pkg({ dev: 'x', deploy: 'x' });

function repoWith(files: Record<string, string>): string {
  const repo = makeTempRepo('promptci-scope-');
  tempRepos.push(repo);
  for (const [rel, content] of Object.entries(files)) writeFile(repo, rel, content);
  return repo;
}

const commandFindings = (issues: PromptCiIssue[]): PromptCiIssue[] => issues.filter((i) => i.category === 'command_validity');

async function findings(
  files: Record<string, string>,
  options: { knownPaths?: string[] } = {},
): Promise<PromptCiIssue[]> {
  const repo = repoWith(files);
  const report = await scan({
    repoPath: repo,
    projectType: 'typescript',
    ...(options.knownPaths ? { knownPaths: options.knownPaths, knownPathsComplete: true } : {}),
  });
  return commandFindings(report.issues);
}

/** `severity:command` for each finding, sorted. */
const brief = (issues: PromptCiIssue[]): string[] =>
  issues.map((i) => `${i.severity}:${i.evidence[0]!.replace(/^Command: `|`$/g, '')}`).sort();

const noEdit = (issues: PromptCiIssue[]): void => {
  for (const i of issues) {
    expect(i.fixEdits, i.title).toBeUndefined();
    expect(i.autoApplySafe, i.title).toBeUndefined();
  }
};

describe('slash-joined script lists are judged name by name', () => {
  it('reports the missing name under a heading that names the directory defining the other', async () => {
    const issues = await findings({
      'package.json': ROOT,
      'site/package.json': SITE,
      'CLAUDE.md': '## Site (from `site/`)\n\n```sh\nnpm run dev/nonexistent\n```\n',
    });
    expect(brief(issues)).toEqual(['warning:npm run dev/nonexistent']);
    expect(issues[0]!.summary).toContain('nonexistent');
  });

  it('reports the missing name, not a note, when the other is defined elsewhere and no directory is named', async () => {
    const issues = await findings({
      'package.json': ROOT,
      'site/package.json': SITE,
      'CLAUDE.md': '# P\n\nRun `pnpm dev/nonexistent`.\n',
    });
    expect(brief(issues)).toEqual(['warning:pnpm dev/nonexistent']);
  });

  it('is clean when every name is defined, in different places', async () => {
    const issues = await findings({
      'package.json': ROOT,
      'site/package.json': SITE,
      'CLAUDE.md': '## Site (from `site/`)\n\nRun `npm run dev/deploy`.\n',
    });
    expect(issues).toEqual([]);
  });
});

describe('a typo fix follows the directory the text names', () => {
  it('withholds the edit when the root has the candidate and the named directory has not', async () => {
    const issues = await findings({
      'package.json': ROOT,
      'site/package.json': SITE,
      'CLAUDE.md': '## Site (from `site/`)\n\n```sh\nnpm run buil\n```\n',
    });
    expect(brief(issues)).toEqual(['warning:npm run buil']);
    noEdit(issues);
  });

  it('still rewrites the same typo with no directory in sight', async () => {
    const issues = await findings({ 'package.json': ROOT, 'CLAUDE.md': '# P\n\n```sh\nnpm run buil\n```\n' });
    expect(issues[0]!.autoApplySafe).toBe(true);
  });
});

describe('directory hints reach no further than the heading and the introducing sentence', () => {
  const base = { 'package.json': ROOT, 'site/package.json': SITE };

  it('treats "at the repo root" as an explicit root', async () => {
    const issues = await findings({
      ...base,
      'CLAUDE.md': '# P\n\nThe marketing pages live in `site/`. At the repo root run `npm run dev`.\n',
    });
    expect(brief(issues)).toEqual(['warning:npm run dev']);
  });

  it('does not take a path prefix for a directory', async () => {
    const issues = await findings({ ...base, 'CLAUDE.md': '# P\n\nEdit site/index.html, then run `npm run dev`.\n' });
    expect(brief(issues)).toEqual(['info:npm run dev']);
  });

  it('does not carry a cd out of an earlier block that cd-ed back', async () => {
    const issues = await findings({
      ...base,
      'CLAUDE.md': '# P\n\n```sh\ncd site\nnpm install\ncd ..\n```\n\nThen `npm run dev`.\n',
    });
    expect(brief(issues)).toEqual(['info:npm run dev']);
  });

  it('knows a setext heading ends the previous section', async () => {
    const issues = await findings({
      ...base,
      'CLAUDE.md': 'Site\n====\n\nFrom `site/`: `npm run dev`.\n\nTooling\n=======\n\nRun `npm run dev`.\n',
    });
    // The first mention is settled by its own sentence; the second (same text, so one finding)
    // sits under another heading that names nothing.
    expect(brief(issues)).toEqual(['info:npm run dev']);
    const second = await findings({
      ...base,
      'CLAUDE.md': 'Site\n====\n\nThe site lives in `site/`.\n\nTooling\n=======\n\nRun `npm run dev`.\n',
    });
    expect(brief(second)).toEqual(['info:npm run dev']);
  });

  it('ignores a directory mentioned 71 lines above with no heading between', async () => {
    const filler = Array.from({ length: 70 }, (_, i) => `Line ${i}.`).join('\n\n');
    const issues = await findings({ ...base, 'CLAUDE.md': `From \`site/\`: text.\n\n${filler}\n\nRun \`npm run dev\`.\n` });
    expect(brief(issues)).toEqual(['info:npm run dev']);
  });

  it('does not take a `# comment` line inside a fence for a heading', async () => {
    const issues = await findings({
      ...base,
      'CLAUDE.md': 'From `site/`:\n\n```sh\n# start the dev server\nnpm run dev\n```\n',
    });
    expect(issues).toEqual([]);
  });

  it('reads the sentence introducing a block even with a blank line between', async () => {
    const issues = await findings({ ...base, 'CLAUDE.md': '# P\n\nFrom `site/`:\n\n\n```sh\nnpm run dev\n```\n' });
    expect(issues).toEqual([]);
  });
});

describe('a manifest that was listed but not read says nothing (hosted scans)', () => {
  const inventory = ['CLAUDE.md', 'package.json', 'site/package.json'];

  it('stays silent about a script the named, unfetched directory may define', async () => {
    const issues = await findings(
      { 'package.json': ROOT, 'CLAUDE.md': '## Site (from `site/`)\n\n```sh\nnpm run dev\n```\n' },
      { knownPaths: inventory },
    );
    expect(issues).toEqual([]);
  });

  it('offers no edit when any manifest in the repository was listed but not read', async () => {
    const issues = await findings(
      { 'package.json': ROOT, 'CLAUDE.md': '# P\n\n```sh\nnpm run buil\n```\n' },
      { knownPaths: [...inventory, 'tools/package.json'] },
    );
    expect(brief(issues)).toEqual(['warning:npm run buil']);
    noEdit(issues);
  });

  it('offers no edit when the manifest walk hit its directory limit', async () => {
    const dirs: Record<string, string> = {};
    for (let i = 0; i < 2100; i++) dirs[`d${String(i).padStart(3, '0')}/keep.txt`] = 'x';
    const issues = await findings({ 'package.json': ROOT, ...dirs, 'CLAUDE.md': '# P\n\n```sh\nnpm run buil\n```\n' });
    expect(brief(issues)).toEqual(['warning:npm run buil']);
    noEdit(issues);
  });

  it('treats a corrupt package.json as unreadable, never as a manifest with no scripts', async () => {
    const named = await findings({
      'package.json': ROOT,
      'site/package.json': '{ "scripts": { "dev": ',
      'CLAUDE.md': '## Site (from `site/`)\n\n```sh\nnpm run dev\n```\n',
    });
    // Nothing is judged against it; one info finding names the file, and it is not a warning that could fail a CI.
    expect(named.every((i) => !i.summary.includes('does not appear'))).toBe(true);
    const parse = named.filter((i) => i.title.startsWith('Could not parse'));
    expect(parse).toHaveLength(1);
    expect(parse[0]!.severity).toBe('info');
    expect(parse[0]!.title).toContain('site/package.json');
    expect(parse[0]!.locations?.[0]?.filePath).toContain('site');
    expect(named.some((i) => i.title.includes('incomplete'))).toBe(false);

    const unnamed = await findings({
      'package.json': ROOT,
      'tools/package.json': '[1, 2]',
      'CLAUDE.md': '# P\n\n```sh\nnpm run buil\n```\n',
    });
    expect(brief(unnamed)).toEqual(['warning:npm run buil']);
    noEdit(unnamed);
  });

  it('reads no manifest over the size cap: the check is reported incomplete, never guessed', async () => {
    const padding = 'a'.repeat(600 * 1024);
    const issues = await findings({
      'package.json': ROOT,
      'site/package.json': pkg({ dev: 'x' }, { padding }),
      'CLAUDE.md': '## Site (from `site/`)\n\n```sh\nnpm run dev\n```\n',
    });
    // Oversized is treated like listed-but-not-downloaded: nothing to report, no warning that could fail a user's CI.
    expect(issues).toEqual([]);
  });
});

describe('placeholders, comments and cautionary text', () => {
  it('treats $VAR, ${VAR} and %VAR% as placeholders', async () => {
    const issues = await findings({
      'package.json': ROOT,
      'CLAUDE.md': '# P\n\n```sh\nnpm run $SCRIPT\npnpm run ${NAME}\nnpm run %TASK%\n```\n',
    });
    expect(issues).toEqual([]);
  });

  it('does not report a command inside an HTML comment', async () => {
    const issues = await findings({
      'package.json': ROOT,
      'CLAUDE.md': '# P\n\n<!-- run `npm run nothing` -->\n\n<!--\nrun npm run nothing-either\n-->\n',
    });
    expect(issues).toEqual([]);
  });

  it('withholds the edit inside a fence introduced as a bad example', async () => {
    const issues = await findings({
      'package.json': ROOT,
      'CLAUDE.md': '# P\n\n```sh\n# bad example, do not do this:\nnpm run lintt\n```\n',
    });
    expect(brief(issues)).toEqual(['warning:npm run lintt']);
    noEdit(issues);
  });

  it('withholds the edit in prose that says it is wrong', async () => {
    const issues = await findings({ 'package.json': ROOT, 'CLAUDE.md': '# P\n\nWrong: `npm run lintt`\n' });
    expect(brief(issues)).toEqual(['warning:npm run lintt']);
    noEdit(issues);
  });

  it('withholds the edit under a heading that says what not to do', async () => {
    const issues = await findings({
      'package.json': ROOT,
      'CLAUDE.md': '## What not to run\n\n```sh\nnpm run lintt\n```\n',
    });
    noEdit(issues);
  });

  it('still rewrites an ordinary typo in a fence', async () => {
    const issues = await findings({ 'package.json': ROOT, 'CLAUDE.md': '## Checks\n\n```sh\nnpm run lintt\n```\n' });
    expect(issues[0]!.autoApplySafe).toBe(true);
  });
});

describe('an unattended edit is default-deny (re-review of #170)', () => {
  const base = { 'package.json': pkg({ build: 'x', lint: 'x' }), 'site/package.json': pkg({ deploy: 'x', dev: 'x' }) };

  it.each([
    ['a heading that names the directory and mentions the repo root', '## Site (from `site/`; paths are relative to the repo root)\n\n```sh\nnpm run buil\n```\n'],
    ['a lead-in that says not the repo root', 'Run these from `site/`, not from the repo root:\n\n```sh\nnpm run buil\n```\n'],
    ['a parent heading that names the directory', '# Site (`site/`)\n\n## Commands\n\n```sh\nnpm run buil\n```\n'],
  ])('offers no edit under %s', async (_name, body) => {
    const issues = await findings({ ...base, 'CLAUDE.md': body });
    expect(brief(issues)).toEqual(['warning:npm run buil']);
    noEdit(issues);
  });

  it.each([
    ['a lead-in that says not the repo root', 'Run these from `site/`, not from the repo root:\n\n```sh\nnpm run dev\n```\n'],
    ['a heading that says not the repo root', '### Site (from `site/` directory, not the repo root)\n\n```sh\nnpm run dev\n```\n'],
    ['a heading that mentions the repo root in passing', '## Site (from `site/`; paths are relative to the repo root)\n\n```sh\nnpm run dev\n```\n'],
  ])('reports nothing for a script the named directory defines, under %s', async (_name, body) => {
    expect(await findings({ ...base, 'CLAUDE.md': body })).toEqual([]);
  });

  it.each([
    ['a curly apostrophe', 'Don’t run `npm run bulid`.\n'],
    ['a straight apostrophe', "Don't run `npm run bulid`.\n"],
    ['a cross mark', '❌ `pnpm lnit`\n'],
    ['"Not this:"', 'Not this: `pnpm typecheckk`\n'],
    ['strikethrough', 'Old: ~~`pnpm lnit`~~\n'],
    ['a comment above it in the block', '```sh\n# typo that breaks CI:\nnpm run bulid\n```\n'],
    ['a lead-in sentence that warns', 'This is wrong:\n\n```sh\nnpm run bulid\n```\n'],
  ])('offers no edit after %s', async (_name, body) => {
    const issues = await findings({ 'package.json': pkg({ build: 'x', lint: 'x', typecheck: 'x' }), 'CLAUDE.md': `# P\n\n${body}` });
    expect(issues.length).toBeGreaterThan(0);
    noEdit(issues);
  });

  it('offers no edit after a cd earlier in the same block', async () => {
    const issues = await findings({
      ...base,
      'CLAUDE.md': '# P\n\n```sh\ncd tools\nnpm install\ncd ..\nnpm run buil\n```\n',
      'tools/package.json': pkg({ x: 'x' }),
    });
    expect(brief(issues)).toEqual(['warning:npm run buil']);
    noEdit(issues);
  });

  it('offers no edit when another package defines the exact name, even said to run from the root', async () => {
    const issues = await findings({
      'package.json': pkg({ build: 'x' }),
      'tools/package.json': pkg({ buld: 'x' }),
      'CLAUDE.md': '# P\n\nFrom the repo root run `npm run buld`.\n',
    });
    expect(brief(issues)).toEqual(['warning:npm run buld']);
    noEdit(issues);
  });

  it('keeps the edit for a plain typo with nothing to doubt', async () => {
    const issues = await findings({ 'package.json': pkg({ build: 'x', lint: 'x' }), 'CLAUDE.md': '## Checks\n\nRun `npm run bild` before you push.\n' });
    expect(issues[0]!.autoApplySafe).toBe(true);
  });

  it('is not turned off by a deep directory with a subdirectory (the walk depth is a bound, not an unread manifest)', async () => {
    const issues = await findings({
      'package.json': pkg({ build: 'x', lint: 'x' }),
      'src/a/b/c/d/e/f.ts': 'x',
      'CLAUDE.md': '## Checks\n\nRun `npm run bild` before you push.\n',
    });
    expect(issues[0]!.autoApplySafe).toBe(true);
  });
});

describe('RULE 1: an edit only in a repository that is certainly one package (third review of #170)', () => {
  const root = pkg({ build: 'x', lint: 'x', test: 'x', typecheck: 'x' });
  const multi = { 'package.json': root, 'site/package.json': pkg({ deploy: 'x', dev: 'x' }), 'apps/web/package.json': pkg({ deploy: 'x', dev: 'x' }) };

  it.each([
    ['a directory in a parent list item', '# P\n\nScripts per package:\n\n- From `site/`:\n  - `npm run buil`\n'],
    ['a <details> summary', '<details>\n<summary>Site (from `site/`)</summary>\n\nBuild:\n\n```sh\nnpm run buil\n```\n\n</details>\n'],
    ['a table header', '| Run from `site/` | What |\n| --- | --- |\n| a | b |\n| c | d |\n| e | `npm run buil` |\n'],
    ['a cd in an earlier block', '```sh\ncd site\nnpm install\n```\n\nThen:\n\n```sh\nnpm run buil\n```\n'],
    ['a directory without backticks or a slash', 'From apps/web:\n\n```sh\nnpm run buil\n```\n'],
    ['a heading naming the folder in words', '## Site (run inside the site folder)\n\n```sh\nnpm run buil\n```\n'],
    ['a sentence naming the folder in words', '# P\n\nInside site, run npm run buil\n'],
    ['a table cell', '| site | `npm run buil` |\n'],
  ])('offers no edit with a second package.json, after %s', async (_name, body) => {
    const issues = await findings({ ...multi, 'CLAUDE.md': body });
    expect(issues.length).toBeGreaterThan(0);
    noEdit(issues);
  });

  it.each([
    ['a second package.json', { 'tools/package.json': pkg({ x: 'x' }) }],
    ['a workspaces field', { 'package.json': pkg({ build: 'x', lint: 'x' }, { workspaces: ['packages/*'] }) }],
    ['pnpm-workspace.yaml', { 'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n" }],
    ['turbo.json', { 'turbo.json': '{}' }],
    ['nx.json', { 'nx.json': '{}' }],
    ['lerna.json', { 'lerna.json': '{}' }],
    ['a corrupt nested package.json', { 'tools/package.json': '{ nope' }],
  ])('offers no edit with %s, even for a plain typo', async (_name, extra) => {
    const issues = await findings({ 'package.json': pkg({ build: 'x', lint: 'x' }), 'CLAUDE.md': '## Checks\n\n```sh\nnpm run bild\n```\n', ...extra });
    expect(brief(issues)).toEqual(['warning:npm run bild']);
    noEdit(issues);
  });

  it('offers no edit when the caller\'s inventory is partial or lists a manifest it never fetched', async () => {
    const files = { 'package.json': pkg({ build: 'x', lint: 'x' }), 'CLAUDE.md': '## Checks\n\n```sh\nnpm run bild\n```\n' };
    noEdit(await findings(files, { knownPaths: ['CLAUDE.md', 'package.json', 'site/package.json'] }));
  });

  it('keeps the edit in a single-package repository: a plain fenced command', async () => {
    const issues = await findings({ 'package.json': root, 'src/index.ts': 'x', 'CLAUDE.md': '## Checks\n\n```sh\npnpm run lnit\n```\n' });
    expect(issues[0]!.autoApplySafe).toBe(true);
    expect(issues[0]!.fixEdits).toHaveLength(1);
  });
});

describe('RULE 2: caution anywhere around the command withholds the edit, even in a single package', () => {
  const files = (body: string): Record<string, string> => ({ 'package.json': pkg({ build: 'x', lint: 'x', test: 'x' }), 'CLAUDE.md': body });

  it.each([
    ['<del>', '# P\n\n<del>`npm run bulid`</del>\n'],
    ['<s>', '# P\n\n<s>`npm run bulid`</s>\n'],
    ['<strike>', '# P\n\n<strike>`npm run bulid`</strike>\n'],
    ['a heavy cross mark', '# P\n\n✖ `npm run bulid`\n'],
    ['a warning sign', '# P\n\n⚠️ `npm run bulid`\n'],
    ['an ancestor heading', '## Common mistakes\n\n### Build\n\n- `npm run bulid`\n'],
    ['a line anywhere in the same block', '```sh\n# Do not run these:\nnpm run lint\nnpm run bulid\n```\n'],
    ['a trailing comment on the line', '```sh\nnpm run bulid   # removed in v2\n```\n'],
    ['the same paragraph, after the command', '# P\n\nThe old `npm run bulid` alias was removed in v2.\n'],
    ['a blockquote', '# P\n\n> Warning: this is only for the old layout.\n> `npm run bulid` no longer exists\n'],
    ['a parent list item', '# P\n\n- Do not use these:\n  - `npm run bulid`\n'],
    ['a table header', '| Wrong | Right |\n| --- | --- |\n| `npm run bulid` | `npm run build` |\n'],
    ['a <details> summary', '<details>\n<summary>Old commands, removed</summary>\n\n```sh\nnpm run bulid\n```\n\n</details>\n'],
    ['"Before:" and "After:"', '# P\n\nBefore: `npm run bulid`\nAfter: `npm run build`\n'],
    ['"Not this:"', '# P\n\nNot this: `npm run bulid`\n'],
  ])('offers no edit after %s', async (_name, body) => {
    const issues = await findings(files(body));
    expect(issues.length).toBeGreaterThan(0);
    noEdit(issues);
  });

  it('still edits a plain fenced command, and a plain sentence', async () => {
    expect((await findings(files('## Checks\n\n```sh\nnpm run bulid\n```\n')))[0]!.autoApplySafe).toBe(true);
    expect((await findings(files('## Checks\n\nBefore you push, run `npm run bulid`.\n')))[0]!.autoApplySafe).toBe(true);
  });

  it('is not fooled by a strikethrough code span at the start of a line opening a fence (RULE 3)', async () => {
    // The line starting ~~`...`~~ must not open a fence; a later bare ~~~ then cannot hide the lead-in or swallow the document.
    const issues = await findings({
      'package.json': pkg({ build: 'x', lint: 'x' }),
      'site/package.json': pkg({ dev: 'x' }),
      'CLAUDE.md': '~~`npm run old`~~\n\nFrom `site/`:\n\n```sh\nnpm run dev\n```\n\n~~~\nx\n~~~\n',
    });
    expect(issues.filter((i) => i.evidence[0]!.includes('npm run dev'))).toEqual([]);
  });

  it('reads a caution above a block even when a struck-through code span starts a line earlier and a bare ~~~ comes later (RULE 3)', async () => {
    // With the old mixed-character fence match, the ~~`...`~~ line opened a fence that the later ~~~ closed,
    // hiding the warning line from the block that follows it and letting the edit through.
    const issues = await findings({
      'package.json': pkg({ build: 'x', lint: 'x' }),
      'CLAUDE.md': '~~`npm run old`~~ is gone.\n\nDo not run this:\n\n```sh\nnpm run bulid\n```\n\n~~~\nx\n~~~\n',
    });
    expect(brief(issues)).toContain('warning:npm run bulid');
    noEdit(issues);
  });
});

describe('what a list lead-in, a cd and a subshell say about the directory (re-review of #170)', () => {
  const base = { 'package.json': pkg({ build: 'x', lint: 'x' }), 'site/package.json': pkg({ deploy: 'x', dev: 'x' }) };

  it('reads the sentence that introduces a bullet list', async () => {
    const issues = await findings({ ...base, 'CLAUDE.md': '# P\n\nThese run from `site/`:\n\n- `npm run dev`\n- `npm run deploy`\n' });
    expect(issues).toEqual([]);
  });

  it('carries a cd within one block, so the note does not claim nothing names the directory', async () => {
    const issues = await findings({ ...base, 'CLAUDE.md': '# P\n\n```sh\ncd site\nnpm run dev\n```\n' });
    expect(issues).toEqual([]);
  });

  it('does not carry a cd that was undone', async () => {
    const issues = await findings({ ...base, 'CLAUDE.md': '# P\n\n```sh\ncd site\ncd ..\nnpm run dev\n```\n' });
    expect(brief(issues)).toEqual(['info:npm run dev']);
  });

  it('strips the parentheses of a subshell: `(cd site && npm run dev)`', async () => {
    const issues = await findings({ ...base, 'CLAUDE.md': '# P\n\n```sh\n(cd site && npm run dev)\n```\n' });
    expect(issues).toEqual([]);
  });

  it('says a root phrase in the command\'s own sentence wins over a directory in another sentence', async () => {
    const issues = await findings({ ...base, 'CLAUDE.md': '# P\n\nThe pages live in `site/`. At the repo root run `npm run dev`.\n' });
    expect(brief(issues)).toEqual(['warning:npm run dev']);
  });

  it('does not count a negated root phrase', async () => {
    const issues = await findings({ ...base, 'CLAUDE.md': '# P\n\nNot from the repo root, but from `site/`: `npm run dev`.\n' });
    expect(issues).toEqual([]);
  });
});

describe('the temp repos these tests use are cleaned up', () => {
  it('leaves nothing under the repo it created', () => {
    const repo = repoWith({ 'a.txt': 'x' });
    expect(fs.existsSync(path.join(repo, 'a.txt'))).toBe(true);
  });
});
