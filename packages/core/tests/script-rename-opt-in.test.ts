/**
 * pcic-1ik0.18 (owner decision 2026-11-15: opt-in only). The script-rename
 * edit is never applied unattended: `promptci fix` and an autopilot skip it,
 * `promptci fix --issue <id>` (`applyFixRecipe` with `optIn`) applies it. The
 * finding still names the candidate.
 *
 * The pairs are the ones the second-model review of #208 had
 * `promptci fix --no-interactive` write: each rewrites a command into a
 * different, existing command whenever the wrong sibling is the unique nearest
 * script. Oracle: none of them is ever written unattended, whichever way the
 * edit rules judge the pair.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scan } from '../src/scan.js';
import { applyFixRecipe, isRepairable, isScriptRenameRecipe, requiresOptIn } from '../src/fix-engine.js';
import type { PromptCiIssue } from '../src/types.js';
import { makeTempRepo, writeFile } from './ai-config-helpers.js';

const tempRepos: string[] = [];
afterEach(() => {
  for (const dir of tempRepos.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function repoWith(files: Record<string, string>): string {
  const repo = makeTempRepo('promptci-rename-opt-in-');
  tempRepos.push(repo);
  for (const [rel, content] of Object.entries(files)) writeFile(repo, rel, content);
  return repo;
}

async function commandIssues(repo: string): Promise<PromptCiIssue[]> {
  const { issues } = await scan({ repoPath: repo, projectType: 'typescript' });
  return issues.filter((i) => i.category === 'command_validity');
}

/** Everything an unattended caller would write: every recipe it is handed, without the opt-in. */
async function unattended(repo: string, issues: PromptCiIssue[]): Promise<number> {
  let written = 0;
  for (const issue of issues) {
    for (const change of await applyFixRecipe(issue, repo)) {
      fs.writeFileSync(change.filePath, change.newContent, 'utf-8');
      written += 1;
    }
  }
  return written;
}

// [as written in the instruction file, the script the manifest defines]
const PAIRS: Array<[string, string]> = [
  // transposition, any length
  ['test:from', 'test:form'],
  ['warp', 'wrap'],
  ['build:ws', 'build:sw'],
  // one interior letter, a 4-letter word to 5
  ['test:rest', 'test:reset'],
  ['db:seed', 'db:speed'],
  ['build:intl', 'build:intel'],
  ['deploy:sage', 'deploy:stage'],
  // the review found these through the rule function alone
  ['sign', 'sing'],
  ['unite', 'untie'],
  ['stat', 'start'],
  ['lose', 'loose'],
];

describe('a rename between two real script names is never applied unattended', () => {
  it.each(PAIRS)('%s -> %s', async (written, defined) => {
    const text = `# Agents\n\n\`\`\`bash\nnpm run ${written}\n\`\`\`\n`;
    const repo = repoWith({
      'package.json': JSON.stringify({ name: 'app', scripts: { [defined]: 'x', build: 'tsc' } }),
      'AGENTS.md': text,
    });
    const issues = await commandIssues(repo);
    expect(issues).toHaveLength(1);
    const issue = issues[0]!;
    expect(issue.autoApplySafe).not.toBe(true);
    expect(isRepairable(issue)).toBe(false);
    // The finding still names the candidate.
    expect(`${issue.summary} ${issue.recommendation}`).toContain(`"${defined}"`);

    expect(await unattended(repo, issues)).toBe(0);
    expect(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf-8')).toBe(text);

    // Every listed pair still carries the edit (that is what made it a live
    // risk); named, it applies.
    expect(isScriptRenameRecipe(issue)).toBe(true);
    expect(requiresOptIn(issue)).toBe(true);
    expect(issue.recommendation).toContain(`promptci fix --issue ${issue.id}`);
    for (const change of await applyFixRecipe(issue, repo, { optIn: true })) {
      fs.writeFileSync(change.filePath, change.newContent, 'utf-8');
    }
    expect(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf-8')).toBe(
      text.replace(`npm run ${written}`, `npm run ${defined}`),
    );
  });

  it('gates on the category and the edit, not on autoApplySafe: a stored finding from an older core is not applied', async () => {
    const repo = repoWith({ 'package.json': JSON.stringify({ name: 'app', scripts: { build: 'tsc' } }), 'AGENTS.md': 'npm run bulid\n' });
    const older: PromptCiIssue = {
      id: 'x',
      severity: 'warning',
      category: 'command_validity',
      title: 't',
      summary: 's',
      filePaths: [],
      locations: [],
      evidence: [],
      recommendation: 'r',
      confidence: 0.8,
      autoApplySafe: true,
      fixEdits: [{ filePath: 'AGENTS.md', line: 1, find: 'npm run bulid', replace: 'npm run build' }],
    };
    expect(isScriptRenameRecipe(older)).toBe(true);
    expect(await applyFixRecipe(older, repo)).toEqual([]);
    const [change] = await applyFixRecipe(older, repo, { optIn: true });
    expect(change!.newContent).toBe('npm run build\n');
  });

  it('leaves the other fixEdits recipe (a moved link) unattended-safe', async () => {
    const repo = repoWith({
      'package.json': JSON.stringify({ name: 'app', scripts: { build: 'tsc' } }),
      'AGENTS.md': '# Agents\n\nSee [the runbook](./docs/runbook.md) first.\n',
      'ops/runbook.md': '# Runbook\n',
    });
    const { issues } = await scan({ repoPath: repo, projectType: 'typescript' });
    const link = issues.find((i) => i.fixEdits !== undefined)!;
    expect(link.autoApplySafe).toBe(true);
    expect(isScriptRenameRecipe(link)).toBe(false);
    expect(requiresOptIn(link)).toBe(false);
    expect(await applyFixRecipe(link, repo)).toHaveLength(1);
  });
});
