/**
 * pcic-1ik0.12: a command quoted inside prose or config text keeps the closing
 * quote on its last token. On tizuio/TizuMark-Markdown-Editor (ARCHITECTURE.md
 * line 167) the scanner reported `build-frontend"` as a missing script and the
 * script-rename recipe offered to delete the quote. The script exists, so there
 * must be no finding, and no edit may ever change punctuation only.
 */

import * as fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { scan } from '../src/scan.js';
import { applyFixRecipe, isRepairable } from '../src/fix-engine.js';
import type { PromptCiIssue } from '../src/types.js';
import { makeTempRepo, writeFile } from './ai-config-helpers.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../examples/fixture-script-name-closers',
);

describe('fixture-script-name-closers (pcic-1ik0.12)', () => {
  it('reports only the quoted typo, under its bare name, with no edit', async () => {
    const issues = await commandIssues(FIXTURE);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.category).toBe('command_validity');
    expect(issues[0]!.summary).toContain('npm script "build-frontedn" does not appear');
    expect(issues[0]!.fixEdits).toBeUndefined();
    expect(issues[0]!.autoApplySafe).toBeUndefined();
  });
});

const tempRepos: string[] = [];
afterEach(() => {
  for (const dir of tempRepos.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function repoWith(files: Record<string, string>): string {
  const repo = makeTempRepo('promptci-closers-');
  tempRepos.push(repo);
  for (const [rel, content] of Object.entries(files)) writeFile(repo, rel, content);
  return repo;
}

async function commandIssues(repo: string): Promise<PromptCiIssue[]> {
  const report = await scan({ repoPath: repo, projectType: 'typescript' });
  return report.issues.filter((i) => i.category === 'command_validity' || i.category === 'manifest_consistency');
}

const MANIFEST = JSON.stringify({
  name: 'app',
  scripts: { 'build-frontend': 'node scripts/build-frontend.mjs', 'build:renderer': 'node r.mjs', build: 'tsc' },
});

describe('a closing quote, backtick or bracket is not part of a script name (pcic-1ik0.12)', () => {
  it.each([
    ['the TizuMark line: a quoted config value in a code span', '`beforeBuildCommand: "npm run build:renderer && npm run build-frontend"`'],
    ['a single-quoted value in a code span', "`cmd: 'npm run build && npm run build-frontend'`"],
    ['a bracketed command in a code span', '`[npm run build && npm run build-frontend]`'],
    ['a parenthesised command in a code span', '`(npm run build && pnpm build-frontend)`'],
    ['several closers in a code span', '`{"a": ["npm run build && npm run build-frontend"]}`'],
  ])('reports nothing for %s', async (_label, line) => {
    const repo = repoWith({ 'package.json': MANIFEST, 'AGENTS.md': `# Agents\n\nBuild: ${line}\n` });
    expect(await commandIssues(repo)).toEqual([]);
  });

  it('reports nothing for the JSON-style fixture in a bare fence', async () => {
    const repo = repoWith({
      'package.json': MANIFEST,
      'AGENTS.md': '# Agents\n\n```\n"build": "npm run build-frontend"\nnpm run build-frontend"\n```\n',
    });
    expect(await commandIssues(repo)).toEqual([]);
  });

  it('still reports a missing script that carries a closing quote, under its bare name, and never rewrites it', async () => {
    const text = '# Agents\n\nBuild: `beforeBuildCommand: "npm run build && npm run build-frontedn"`\n';
    const repo = repoWith({ 'package.json': MANIFEST, 'AGENTS.md': text });
    const issues = (await commandIssues(repo)).filter((i) => i.category === 'command_validity');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.summary).toContain('npm script "build-frontedn" does not appear');
    // Named as the close match, but the token as written carried a quote, so
    // the finding is advisory.
    expect(issues[0]!.recommendation).toContain('build-frontend');
    expect(issues[0]!.fixEdits).toBeUndefined();
    expect(issues[0]!.autoApplySafe).toBeUndefined();
    expect(issues.filter(isRepairable)).toEqual([]);
    expect(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf-8')).toBe(text);
  });

  it('keeps the edit for the same typo with no punctuation around it (the guard is what blocks the quoted cases)', async () => {
    const repo = repoWith({ 'package.json': MANIFEST, 'AGENTS.md': '# Agents\n\n```bash\nnpm run build-frontedn\n```\n' });
    const issues = (await commandIssues(repo)).filter((i) => i.category === 'command_validity');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.autoApplySafe).toBe(false);
    for (const change of await applyFixRecipe(issues[0]!, repo, { optIn: true })) fs.writeFileSync(change.filePath, change.newContent, 'utf-8');
    expect(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf-8')).toBe('# Agents\n\n```bash\nnpm run build-frontend\n```\n');
  });

  /**
   * PR #209 review (BLOCKING 1): stripping only the trailing closer turned a
   * quoted typo into `"build-frontedn`, which the recipe then rewrote to
   * `npm run build-frontend"`, dropping the opening quote and keeping the
   * closing one, with autoApplySafe. A name that was quoted or bracketed is
   * reported but never rewritten.
   */
  const QUOTED_MANIFEST = JSON.stringify({
    name: 'app',
    scripts: { 'build-frontend': 'x', typecheck: 'tsc', test: 'vitest', build: 'tsc' },
  });
  it.each([
    ['a double-quoted typo in a bash fence', '```bash\nnpm run "build-frontedn"\n```'],
    ['a single-quoted typo with arguments', "```bash\nnpm run 'typechekc' -- --watch\n```"],
    ['a double-quoted separator variant in a code span', 'Check with `npm run "type-check"`.'],
    ['pnpm with a quoted typo', '```bash\npnpm "build-frontedn"\n```'],
    ['yarn run with a quoted typo', '```bash\nyarn run "build-frontedn"\n```'],
    ['a parenthesised typo', '```bash\nnpm run (build-frontedn)\n```'],
  ])('offers no edit for %s', async (_label, body) => {
    const repo = repoWith({ 'package.json': QUOTED_MANIFEST, 'AGENTS.md': `# Agents\n\n${body}\n` });
    const before = fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf-8');
    const issues = (await commandIssues(repo)).filter((i) => i.category === 'command_validity');
    for (const issue of issues) {
      expect(issue.fixEdits).toBeUndefined();
      expect(issue.autoApplySafe).toBeUndefined();
      expect(await applyFixRecipe(issue, repo)).toEqual([]);
    }
    expect(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf-8')).toBe(before);
  });

  // PR #209 delta review: a bracketed word is a placeholder, not a script name.
  // Stripping `[`…`]` as a matched pair hid the bracket from SCRIPT_PATTERN_RE.
  it.each([
    ['a code span', 'Run `npm run [script-name]` for any script.'],
    ['a bash fence', '```bash\nnpm run [script]\n```'],
    ['pnpm in a bash fence', '```bash\npnpm [command]\n```'],
    ['yarn in a bash fence', '```bash\nyarn [script]\n```'],
    ['pnpm run in a code span', 'Use `pnpm run [name]`.'],
    ['prose', 'To run one task, run npm run [task] from the root.'],
    ['a brace placeholder', '```bash\nnpm run {name}\n```'],
  ])('reports nothing for a bracketed placeholder in %s', async (_label, body) => {
    const repo = repoWith({ 'package.json': QUOTED_MANIFEST, 'AGENTS.md': `# Agents\n\n${body}\n` });
    expect(await commandIssues(repo)).toEqual([]);
  });

  it('still reports a missing name followed by a stray closing bracket', async () => {
    const repo = repoWith({ 'package.json': QUOTED_MANIFEST, 'AGENTS.md': '# Agents\n\n```bash\nnpm run tset]\n```\n' });
    const issues = (await commandIssues(repo)).filter((i) => i.category === 'command_validity');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.summary).toContain('npm script "tset" does not appear');
  });

  // PR #209 delta review: the half of the guard that looks inside the names.
  // An unmatched opener or a quote mid-token survives the strip; main rewrote
  // both to `npm run build-frontend`, deleting the quote.
  it.each([
    ['an opening quote only', 'npm run "build-frontedn'],
    ['a quote inside the token', 'npm run build"frontedn'],
  ])('offers no edit for %s', async (_label, line) => {
    const text = `# Agents\n\n\`\`\`bash\n${line}\n\`\`\`\n`;
    const repo = repoWith({ 'package.json': QUOTED_MANIFEST, 'AGENTS.md': text });
    for (const issue of (await commandIssues(repo)).filter((i) => i.category === 'command_validity')) {
      expect(issue.fixEdits).toBeUndefined();
      expect(issue.autoApplySafe).toBeUndefined();
    }
    expect(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf-8')).toBe(text);
  });

  it('reports nothing for a quoted script name that exists (a matched leading quote is stripped too)', async () => {
    for (const body of ['```bash\nnpm run "build-frontend"\n```', "```bash\nnpm run 'typecheck' -- --watch\n```", '`pnpm "build-frontend"`']) {
      const repo = repoWith({ 'package.json': QUOTED_MANIFEST, 'AGENTS.md': `# Agents\n\n${body}\n` });
      expect(await commandIssues(repo), body).toEqual([]);
    }
  });

  it('never offers an edit for a quoted script name, which only punctuation would "fix"', async () => {
    const repo = repoWith({
      'package.json': MANIFEST,
      'AGENTS.md': '# Agents\n\n```bash\nnpm run "bulid"\n```\n',
    });
    for (const issue of (await commandIssues(repo)).filter((i) => i.category === 'command_validity')) {
      expect(issue.fixEdits).toBeUndefined();
      expect(issue.autoApplySafe).toBeUndefined();
    }
  });
});
