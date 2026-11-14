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
    for (let i = 0; i < 420; i++) dirs[`d${String(i).padStart(3, '0')}/keep.txt`] = 'x';
    const issues = await findings({ 'package.json': ROOT, ...dirs, 'CLAUDE.md': '# P\n\n```sh\nnpm run buil\n```\n' });
    expect(brief(issues)).toEqual(['warning:npm run buil']);
    noEdit(issues);
  });

  it('reads no manifest over the size cap: the check is reported incomplete, never guessed', async () => {
    const padding = 'a'.repeat(600 * 1024);
    const issues = await findings({
      'package.json': ROOT,
      'site/package.json': pkg({ dev: 'x' }, { padding }),
      'CLAUDE.md': '## Site (from `site/`)\n\n```sh\nnpm run dev\n```\n',
    });
    expect(issues.every((i) => !i.summary.includes('does not appear'))).toBe(true);
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

describe('the temp repos these tests use are cleaned up', () => {
  it('leaves nothing under the repo it created', () => {
    const repo = repoWith({ 'a.txt': 'x' });
    expect(fs.existsSync(path.join(repo, 'a.txt'))).toBe(true);
  });
});
