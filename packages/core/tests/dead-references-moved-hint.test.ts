/**
 * pcic-1ik0.4 (issue 159): a dead reference whose last segment names exactly
 * one file or directory in the repository gets a hint, and a code-span path
 * that is only missing a prefix gets a mechanical edit.
 *
 * The corpus shapes the issue lists are asserted as they are written there:
 * the hint is text for every form, the edit is the narrow case, and the
 * ambiguous twin of each stays quiet.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { scan } from '../src/scan.js';
import { applyFixRecipe, isRepairable } from '../src/fix-engine.js';
import { detectDeadReferences } from '../src/dead-references.js';
import type { InstructionFile, PromptCiIssue } from '../src/types.js';
import { makeTempRepo, writeFile } from './ai-config-helpers.js';

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../examples/fixture-moved-refs',
);

const tempRepos: string[] = [];
afterEach(() => {
  for (const dir of tempRepos.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function repoWith(files: Record<string, string>): string {
  const repo = makeTempRepo('promptci-moved-hint-');
  tempRepos.push(repo);
  for (const [rel, content] of Object.entries(files)) writeFile(repo, rel, content);
  return repo;
}

async function brokenIn(repo: string): Promise<PromptCiIssue[]> {
  const { issues } = await scan({ repoPath: repo, projectType: 'typescript' });
  return issues.filter((i) => i.category === 'structure' && i.title.startsWith('Broken '));
}

const byTitle = (issues: PromptCiIssue[], title: string): PromptCiIssue => {
  const found = issues.find((i) => i.title === title);
  if (!found) throw new Error(`no finding "${title}" in: ${issues.map((i) => i.title).join(' | ')}`);
  return found;
};

async function applyAll(repo: string, issues: PromptCiIssue[], relPath: string): Promise<string> {
  for (const issue of issues.filter(isRepairable)) {
    for (const change of await applyFixRecipe(issue, repo)) {
      fs.writeFileSync(change.filePath, change.newContent, 'utf-8');
    }
  }
  return fs.readFileSync(path.join(repo, relPath), 'utf-8');
}

describe('examples/fixture-moved-refs', () => {
  it('hints the one candidate, edits only the prefix-wrong code span, stays quiet elsewhere', async () => {
    const issues = await brokenIn(FIXTURE);
    expect(issues.map((i) => i.title).sort()).toEqual([
      'Broken directory reference: plans/',
      'Broken file reference: billing.ts',
      'Broken file reference: deploy.sh',
      'Broken file reference: release.sh',
      'Broken file reference: setup.md',
    ]);

    // Missing prefix only: hint AND the edit.
    const deploy = byTitle(issues, 'Broken file reference: deploy.sh');
    expect(deploy.summary).toContain('The only file named "deploy.sh" in the repository is "tools/scripts/deploy.sh"; it may be what was meant.');
    expect(deploy.autoApplySafe).toBe(true);
    expect(deploy.fixEdits).toEqual([
      {
        filePath: path.join(FIXTURE, 'AGENTS.md'),
        line: 3,
        find: '`scripts/deploy.sh`',
        replace: '`tools/scripts/deploy.sh`',
      },
    ]);

    // A directory segment in the middle is missing: a hint, not an edit.
    const billing = byTitle(issues, 'Broken file reference: billing.ts');
    expect(billing.summary).toContain('is "src/main/services/billing.ts"; it may be what was meant.');
    expect(billing.autoApplySafe).toBeUndefined();
    expect(billing.fixEdits).toBeUndefined();

    // Two files share the written suffix: neither is named, nothing is edited.
    const setup = byTitle(issues, 'Broken file reference: setup.md');
    expect(setup.summary).not.toContain('may be what was meant');
    expect(setup.fixEdits).toBeUndefined();

    // A directory reference names the one directory of that name.
    const plans = byTitle(issues, 'Broken directory reference: plans/');
    expect(plans.summary).toContain('The only directory named "plans" in the repository is ".agents/plans/"; it may be what was meant.');
    expect(plans.fixEdits).toBeUndefined();

    // Sample text in a fenced block is reported and hinted, never rewritten.
    const release = byTitle(issues, 'Broken file reference: release.sh');
    expect(release.summary).toContain('"tools/scripts/release.sh"');
    expect(release.fixEdits).toBeUndefined();
    expect(release.autoApplySafe).toBeUndefined();
  });
});

describe('prefix-wrong code span edit', () => {
  const SCRIPT_REPO = { 'tools/scripts/deploy.sh': '#!/bin/sh\n' };

  it('applies byte-for-byte and leaves every other line alone', async () => {
    const original = '# Agents\r\n\r\nDeploy with `scripts/deploy.sh`, then see `docs/x.md` (not a ref).\r\nBye\r\n';
    const repo = repoWith({ ...SCRIPT_REPO, 'AGENTS.md': original });
    const issues = (await brokenIn(repo)).filter((i) => i.title === 'Broken file reference: deploy.sh');
    expect(issues).toHaveLength(1);
    expect(await applyAll(repo, issues, 'AGENTS.md')).toBe(original.replace('`scripts/deploy.sh`', '`tools/scripts/deploy.sh`'));
  });

  it('works from a top-level dot-directory instruction file', async () => {
    const repo = repoWith({ ...SCRIPT_REPO, '.claude/CLAUDE.md': '# C\n\nRun `scripts/deploy.sh`.\n' });
    const [issue] = await brokenIn(repo);
    expect(issue!.autoApplySafe).toBe(true);
  });

  it('stays a hint from an instruction file in a nested directory (the span may be relative to it)', async () => {
    // Built by hand: whether discovery lists a nested AGENTS.md is not what this asserts.
    const content = '# A\n\nRun `scripts/deploy.sh`.\n';
    const repo = repoWith({ ...SCRIPT_REPO, 'packages/app/AGENTS.md': content });
    const file: InstructionFile = {
      path: path.join(repo, 'packages/app/AGENTS.md'),
      fileType: 'agents',
      content,
      sections: [],
      lineCount: 4,
      charCount: content.length,
      estimatedTokens: 10,
    };
    const [issue] = detectDeadReferences([file], repo);
    expect(issue!.summary).toContain('"tools/scripts/deploy.sh"');
    expect(issue!.autoApplySafe).toBeUndefined();

    // The same text from the repository root IS repaired.
    const rootFile = { ...file, path: path.join(repo, 'AGENTS.md') };
    expect(detectDeadReferences([rootFile], repo)[0]!.autoApplySafe).toBe(true);
  });

  it('stays a hint when two files end with the written path', async () => {
    const repo = repoWith({
      ...SCRIPT_REPO,
      'other/scripts/deploy.sh': '#!/bin/sh\n',
      'AGENTS.md': '# A\n\nRun `scripts/deploy.sh`.\n',
    });
    const [issue] = await brokenIn(repo);
    expect(issue!.autoApplySafe).toBeUndefined();
    expect(issue!.summary).not.toContain('may be what was meant');
  });

  it('ignores a candidate the repository ignores', async () => {
    const repo = repoWith({
      '.gitignore': 'generated/\n',
      'generated/scripts/deploy.sh': '#!/bin/sh\n',
      'AGENTS.md': '# A\n\nRun `scripts/deploy.sh`.\n',
    });
    const [issue] = await brokenIn(repo);
    expect(issue!.summary).not.toContain('may be what was meant');
    expect(issue!.autoApplySafe).toBeUndefined();
  });

  it('stays a hint when the span carries a :line suffix, a leading ./ or a repeat on the line', async () => {
    for (const line of ['Run `scripts/deploy.sh:12`.', 'Run `./scripts/deploy.sh`.']) {
      const repo = repoWith({ ...SCRIPT_REPO, 'AGENTS.md': `# A\n\n${line}\n` });
      const issues = await brokenIn(repo);
      for (const issue of issues) expect(issue.autoApplySafe).toBeUndefined();
    }
    const twice = repoWith({ ...SCRIPT_REPO, 'AGENTS.md': '# A\n\nRun `scripts/deploy.sh` or `scripts/deploy.sh`.\n' });
    const [issue] = await brokenIn(twice);
    expect(issue!.autoApplySafe).toBeUndefined();
  });

  it('is all-or-nothing: one occurrence that cannot be edited keeps the whole finding advisory', async () => {
    const repo = repoWith({
      ...SCRIPT_REPO,
      'AGENTS.md': '# A\n\nRun `scripts/deploy.sh`.\n\n```md\nRun `scripts/deploy.sh`.\n```\n',
    });
    const [issue] = await brokenIn(repo);
    expect(issue!.autoApplySafe).toBeUndefined();
    expect(issue!.fixEdits).toBeUndefined();
  });

  it('does not touch a reference that resolves', async () => {
    const repo = repoWith({ ...SCRIPT_REPO, 'AGENTS.md': '# A\n\nRun `tools/scripts/deploy.sh`.\n' });
    expect(await brokenIn(repo)).toEqual([]);
  });
});

describe('hint on the corpus shapes', () => {
  it.each([
    // [reference as written in the corpus, file it names, the one file of that name, kind]
    ['src/lib/utils/netUtil.ts', 'src/utils/netUtil.ts'],
    ['ai/index.md', 'docs/index.md'],
    ['src/services/SpoolmanIntegrationService.ts', 'src/main/services/SpoolmanIntegrationService.ts'],
    ['src/renderer/src/gridController.ts', 'src/renderer/src/renderer/gridController.ts'],
    ['src/renderer/src/shortcutButtons.ts', 'src/renderer/src/renderer/shortcutButtons.ts'],
    ['src/renderer/src/perPrinterStorage.ts', 'src/renderer/src/renderer/perPrinterStorage.ts'],
    ['crd-ui.juanda.co/llms.txt', 'packages/crd-ui/llms.txt'],
  ])('names the one file for `%s`', async (written, actual) => {
    const repo = repoWith({ 'AGENTS.md': `# A\n\nSee \`${written}\`.\n`, [actual]: 'x\n', 'src/keep.txt': 'x\n', 'src/lib/keep.txt': 'x\n' });
    const issues = await brokenIn(repo);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.summary).toContain(`is "${actual}"; it may be what was meant.`);
    expect(issues[0]!.recommendation).toContain(`"${actual}"`);
    // None of these is a missing prefix, so none gets an edit.
    expect(issues[0]!.autoApplySafe).toBeUndefined();
  });

  it('names the one directory for `docs/plans/`', async () => {
    const repo = repoWith({
      'AGENTS.md': '# A\n\nNever write to `docs/plans/`.\n',
      'docs/guide.md': 'x\n',
      '.agents/plans/one.md': 'x\n',
    });
    const [issue] = await brokenIn(repo);
    expect(issue!.summary).toContain('The only directory named "plans" in the repository is ".agents/plans/"; it may be what was meant.');
  });

  it('names nothing when two files share the name', async () => {
    const repo = repoWith({
      'AGENTS.md': '# A\n\nSee `src/lib/utils/netUtil.ts`.\n',
      'src/utils/netUtil.ts': 'x\n',
      'app/netUtil.ts': 'x\n',
      'src/lib/keep.txt': 'x\n',
    });
    const [issue] = await brokenIn(repo);
    expect(issue!.summary).not.toContain('may be what was meant');
  });

  it('names nothing when the name exists nowhere', async () => {
    const repo = repoWith({ 'AGENTS.md': '# A\n\nSee `scripts/gone.sh`.\n', 'src/keep.txt': 'x\n' });
    const [issue] = await brokenIn(repo);
    expect(issue!.summary).not.toContain('may be what was meant');
  });
});
