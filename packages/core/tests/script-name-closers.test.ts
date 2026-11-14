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

  it('still reports a missing script that carries a closing quote, and its fix keeps the quote', async () => {
    const repo = repoWith({
      'package.json': MANIFEST,
      'AGENTS.md': '# Agents\n\nBuild: `beforeBuildCommand: "npm run build && npm run build-frontedn"`\n',
    });
    const issues = (await commandIssues(repo)).filter((i) => i.category === 'command_validity');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.summary).toContain('npm script "build-frontedn" does not appear');
    // Every edit offered changes letters, never punctuation alone, and the
    // quote that closes the config value survives.
    for (const edit of issues[0]!.fixEdits ?? []) {
      expect(edit.find).toBe('npm run build-frontedn');
      expect(edit.replace).toBe('npm run build-frontend');
    }
    for (const issue of issues.filter(isRepairable)) {
      for (const change of await applyFixRecipe(issue, repo)) {
        fs.writeFileSync(change.filePath, change.newContent, 'utf-8');
      }
    }
    expect(issues[0]!.autoApplySafe).toBe(true);
    expect(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf-8')).toBe(
      '# Agents\n\nBuild: `beforeBuildCommand: "npm run build && npm run build-frontend"`\n',
    );
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
