/**
 * pcic-1ik0.7 (issue 155): a broken inline link that was the LAST inline link
 * in its file, with another inline link above it, was reported at the first
 * link's line and got no edit. `NESTED_MD_LINK_RE` could start at the earlier
 * link and run to the last one, so the match offset was the first link's while
 * the captured target was the last link's; `movedLinkEdit`, handed the wrong
 * line, found no `](target)` on it and offered nothing.
 *
 * Two oracles, both asserting the reported line AND the edit:
 * - `examples/fixture-moved-link-dogfood/` is the dogfood fixture repository's
 *   CLAUDE.md as it was when the bug was seen on prod (promptci-dogfood-fixture
 *   at 3767dab): link on line 31, the earlier `[AGENTS.md](./AGENTS.md)` on 10.
 * - the six file shapes from the table in the issue 155 comment, each in a
 *   repository where `docs/onboarding-checklist.md` is the only file of that name.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { scan } from '../src/scan.js';
import { applyFixRecipe, isRepairable } from '../src/fix-engine.js';
import type { PromptCiIssue } from '../src/types.js';
import { makeTempRepo, writeFile } from './ai-config-helpers.js';

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../examples/fixture-moved-link-dogfood',
);

const TITLE = 'Broken file reference: onboarding-checklist.md';
const FIND = '](onboarding-checklist.md)';
const REPLACE = '](./docs/onboarding-checklist.md)';

const tempRepos: string[] = [];
afterEach(() => {
  for (const dir of tempRepos.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function repoWith(files: Record<string, string>): string {
  const repo = makeTempRepo('promptci-moved-link-');
  tempRepos.push(repo);
  for (const [rel, content] of Object.entries(files)) writeFile(repo, rel, content);
  return repo;
}

async function checklistFinding(repo: string): Promise<PromptCiIssue> {
  const { issues } = await scan({ repoPath: repo, projectType: 'typescript' });
  const matching = issues.filter((i) => i.title === TITLE);
  expect(matching, issues.map((i) => i.title).join(' | ')).toHaveLength(1);
  return matching[0]!;
}

/** The file text the finding's recipe produces, computed without writing. */
async function applied(issue: PromptCiIssue, repo: string): Promise<string> {
  expect(isRepairable(issue)).toBe(true);
  const changes = await applyFixRecipe(issue, repo);
  expect(changes.map((c) => c.filePath)).toEqual([path.join(repo, 'CLAUDE.md')]);
  return changes[0]!.newContent;
}

describe('examples/fixture-moved-link-dogfood (the dogfood CLAUDE.md shape)', () => {
  it('reports line 31, not line 10, and offers the one moved-link edit', async () => {
    const claudePath = path.join(FIXTURE, 'CLAUDE.md');
    const claude = fs.readFileSync(claudePath, 'utf-8');
    const lines = claude.split('\n');
    // The fixture's shape is the point: pin it so an edit to the file cannot
    // quietly turn this into a case the bug never affected.
    expect(lines[9]).toBe('See canonical instructions in [AGENTS.md](./AGENTS.md) for details.');
    expect(lines[30]).toBe('New joiners start with the [onboarding checklist](onboarding-checklist.md).');
    expect(lines.slice(31).join('\n')).not.toContain('](');

    const issue = await checklistFinding(FIXTURE);
    expect(issue.locations).toEqual([{ filePath: claudePath, startLine: 31 }]);
    expect(issue.autoApplySafe).toBe(true);
    expect(issue.fixEdits).toEqual([{ filePath: claudePath, line: 31, find: FIND, replace: REPLACE }]);
    expect(await applied(issue, FIXTURE)).toBe(claude.replace(FIND, REPLACE));
  });
});

describe('the six file shapes from issue 155', () => {
  const LINK = 'New joiners start with the [onboarding checklist](onboarding-checklist.md).';
  const EARLIER = 'See [AGENTS.md](./AGENTS.md) for details.';

  // [row, CLAUDE.md, the broken link's line]
  const ROWS: Array<[string, string, number]> = [
    ['earlier link, then the broken link', `# CLAUDE.md\n\n${EARLIER}\n\n## B\n\n${LINK}\n`, 7],
    [
      'earlier link, broken link, the earlier link repeated after it',
      `# CLAUDE.md\n\n${EARLIER}\n\n## B\n\n${LINK}\n\n${EARLIER}\n`,
      7,
    ],
    [
      'earlier link under its own heading, broken link under another',
      `# CLAUDE.md\n\n## A\n\n${EARLIER}\n\n## B\n\n${LINK}\n`,
      9,
    ],
    ['earlier link, three lines of prose, broken link', `# CLAUDE.md\n\n${EARLIER}\n\nOne.\nTwo.\nThree.\n\n${LINK}\n`, 9],
    [
      'earlier link to a different existing file, broken link',
      `# CLAUDE.md\n\nSee [the runbook](./docs/runbook.md) first.\n\n## B\n\n${LINK}\n`,
      7,
    ],
    ['earlier link and broken link with no heading between', `# CLAUDE.md\n\n${EARLIER}\n\n${LINK}\n`, 5],
  ];

  it.each(ROWS)('%s: reports its own line and offers the edit', async (_row, claude, line) => {
    expect(claude.split('\n')[line - 1]).toBe(LINK);
    const repo = repoWith({
      'package.json': JSON.stringify({ name: 'app', scripts: { build: 'tsc' } }),
      'AGENTS.md': '# Agents\n',
      'CLAUDE.md': claude,
      'docs/runbook.md': '# Runbook\n',
      'docs/onboarding-checklist.md': '# Onboarding\n',
    });
    const claudePath = path.join(repo, 'CLAUDE.md');
    const issue = await checklistFinding(repo);
    expect(issue.locations).toEqual([{ filePath: claudePath, startLine: line }]);
    expect(issue.autoApplySafe).toBe(true);
    expect(issue.fixEdits).toEqual([{ filePath: claudePath, line, find: FIND, replace: REPLACE }]);
    expect(await applied(issue, repo)).toBe(claude.replace(FIND, REPLACE));
  });
});
