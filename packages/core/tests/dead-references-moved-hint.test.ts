/**
 * pcic-1ik0.4 (issue 159): a dead reference whose last segment names exactly
 * one file or directory in the repository gets a hint, for every reference form.
 * Only the text changes: a code span is never rewritten (see the review note
 * below). The corpus shapes the issue lists are asserted as they are written
 * there, and the ambiguous twin of each stays quiet.
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
  it('hints the one candidate, edits nothing, stays quiet where it is ambiguous', async () => {
    const issues = await brokenIn(FIXTURE);
    expect(issues.map((i) => i.title).sort()).toEqual([
      'Broken directory reference: plans/',
      'Broken file reference: billing.ts',
      'Broken file reference: deploy.sh',
      'Broken file reference: release.sh',
      'Broken file reference: setup.md',
    ]);

    // Missing prefix: a hint. A code span is prose, so it is never edited.
    const deploy = byTitle(issues, 'Broken file reference: deploy.sh');
    expect(deploy.summary).toContain('The only file named "deploy.sh" in the repository is "tools/scripts/deploy.sh"; it may be what was meant.');
    expect(deploy.autoApplySafe).toBeUndefined();
    expect(deploy.fixEdits).toBeUndefined();

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

/**
 * Review of the first version: a code-span path is prose. It can be relative to
 * a package or to a directory the text `cd`s into, and the detector's own
 * suffix rule already treats a path that ends a longer one as imprecise, so a
 * rewrite was a guess. A code span is hinted and never edited.
 */
describe('code spans are hinted, never rewritten', () => {
  const SCRIPT_REPO = { 'tools/scripts/deploy.sh': '#!/bin/sh\n' };

  it('names the candidate and offers no edit, from the root, a dot-directory or a nested file', async () => {
    for (const rel of ['AGENTS.md', '.claude/CLAUDE.md', 'packages/app/AGENTS.md']) {
      const content = '# A\n\nRun `scripts/deploy.sh`.\n';
      const repo = repoWith({ ...SCRIPT_REPO, [rel]: content });
      const file: InstructionFile = {
        path: path.join(repo, rel),
        fileType: 'agents',
        content,
        sections: [],
        lineCount: 4,
        charCount: content.length,
        estimatedTokens: 10,
      };
      const [issue] = detectDeadReferences([file], repo);
      expect(issue!.summary, rel).toContain('"tools/scripts/deploy.sh"');
      expect(issue!.autoApplySafe, rel).toBeUndefined();
      expect(issue!.fixEdits, rel).toBeUndefined();
    }
  });

  it('does not repoint a path relative to a package ("inside each package")', async () => {
    // Review example 1: `seed.js` used to get an edit to packages/api/scripts/seed.js.
    const original = '# A\n\nInside each package, `src/lib/db.ts` holds the client and `scripts/seed.js` seeds it.\n';
    const repo = repoWith({
      'AGENTS.md': original,
      'packages/api/src/lib/db.ts': 'x\n',
      'packages/api/scripts/seed.js': 'x\n',
    });
    const issues = await brokenIn(repo);
    for (const issue of issues) expect(issue.autoApplySafe).toBeUndefined();
    expect(await applyAll(repo, issues, 'AGENTS.md')).toBe(original);
  });

  it('does not repoint a path that follows a `cd`', async () => {
    // Review example 2: an edit to tools/scripts/deploy.sh breaks the command for anyone who ran the cd.
    const original = '# A\n\n```bash\ncd tools\n```\n\nThen run `scripts/deploy.sh`.\n';
    const repo = repoWith({ ...SCRIPT_REPO, 'AGENTS.md': original });
    const issues = await brokenIn(repo);
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) expect(issue.autoApplySafe).toBeUndefined();
    expect(await applyAll(repo, issues, 'AGENTS.md')).toBe(original);
  });

  it('names no candidate when two files end with the written path', async () => {
    const repo = repoWith({
      ...SCRIPT_REPO,
      'other/scripts/deploy.sh': '#!/bin/sh\n',
      'AGENTS.md': '# A\n\nRun `scripts/deploy.sh`.\n',
    });
    // Same basename twice: ambiguous, no hint.
    const [issue] = await brokenIn(repo);
    expect(issue!.summary).not.toContain('may be what was meant');
  });

  it('does not name a candidate the repository ignores', async () => {
    const repo = repoWith({
      '.gitignore': 'generated/\n',
      'generated/scripts/deploy.sh': '#!/bin/sh\n',
      'AGENTS.md': '# A\n\nRun `scripts/deploy.sh`.\n',
    });
    const [issue] = await brokenIn(repo);
    expect(issue!.summary).not.toContain('may be what was meant');
  });

  it('does not name a copy under a fixture, test, example or vendor tree', async () => {
    for (const dir of ['test/fixtures', 'tests', 'examples/demo', 'vendor/lib', '__fixtures__']) {
      const repo = repoWith({ [`${dir}/scripts/release.sh`]: '#!/bin/sh\n', 'AGENTS.md': '# A\n\nRun `scripts/release.sh`.\n' });
      const [issue] = await brokenIn(repo);
      expect(issue!.summary, dir).not.toContain('may be what was meant');
    }
    // The real file wins over its fixture copy: it is the only candidate left.
    const both = repoWith({
      'tools/scripts/release.sh': '#!/bin/sh\n',
      'test/fixtures/scripts/release.sh': '#!/bin/sh\n',
      'AGENTS.md': '# A\n\nRun `scripts/release.sh`.\n',
    });
    const [issue] = await brokenIn(both);
    expect(issue!.summary).toContain('is "tools/scripts/release.sh"');
    // A reference that already points into such a tree may be repaired from it.
    const into = repoWith({ 'test/fixtures/a.md': 'x\n', 'AGENTS.md': '# A\n\nSee `test/fixtures/old/a.md`.\n' });
    expect((await brokenIn(into))[0]!.summary).toContain('"test/fixtures/a.md"');
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
