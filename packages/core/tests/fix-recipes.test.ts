/**
 * pcic-oonz: the two mechanical fix recipes.
 *
 * Until now only cross-file duplicate consolidation and the two .gitignore
 * recipes were `autoApplySafe`, so on most repositories `promptci fix` had
 * nothing to offer. These two cover the commonest mechanical breakages in
 * instruction files — a mistyped package script and a link whose target moved —
 * and both are gated on the replacement being UNAMBIGUOUS. The ambiguous twin
 * of each case must stay advisory, and the applied output is asserted
 * byte-for-byte: a fix engine that rewrites the wrong text is worse than one
 * that rewrites nothing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { scan } from '../src/scan.js';
import { applyFixRecipe, isRepairable } from '../src/fix-engine.js';
import { closestUniqueMatch, damerauLevenshtein } from '../src/close-match.js';
import type { PromptCiIssue } from '../src/types.js';
import { makeTempRepo, writeFile } from './ai-config-helpers.js';

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../examples/fixture-fix-recipes',
);

const tempRepos: string[] = [];
afterEach(() => {
  for (const dir of tempRepos.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function repoWith(files: Record<string, string>): string {
  const repo = makeTempRepo('promptci-fix-recipes-');
  tempRepos.push(repo);
  for (const [rel, content] of Object.entries(files)) writeFile(repo, rel, content);
  return repo;
}

async function issuesIn(repo: string): Promise<PromptCiIssue[]> {
  return (await scan({ repoPath: repo, projectType: 'typescript' })).issues;
}

/** Applies every auto-applicable recipe in `issues` and returns the file's new text. */
async function applyAll(repo: string, issues: PromptCiIssue[], relPath: string): Promise<string> {
  for (const issue of issues.filter(isRepairable)) {
    for (const change of await applyFixRecipe(issue, repo)) {
      fs.writeFileSync(change.filePath, change.newContent, 'utf-8');
    }
  }
  return fs.readFileSync(path.join(repo, relPath), 'utf-8');
}

const commandIssues = (issues: PromptCiIssue[]): PromptCiIssue[] =>
  issues.filter((i) => i.category === 'command_validity');
const brokenRefIssues = (issues: PromptCiIssue[]): PromptCiIssue[] =>
  issues.filter((i) => i.category === 'structure' && i.title.startsWith('Broken '));

const MANIFEST = JSON.stringify({
  name: 'app',
  scripts: { build: 'tsc', lint: 'eslint .', typecheck: 'tsc --noEmit' },
});

// ── The closeness rule ───────────────────────────────────────────────────────

describe('closestUniqueMatch', () => {
  it('counts an adjacent transposition as one edit', () => {
    expect(damerauLevenshtein('bulid', 'build')).toBe(1);
    expect(damerauLevenshtein('tets', 'test')).toBe(1);
    expect(damerauLevenshtein('build', 'build')).toBe(0);
    expect(damerauLevenshtein('', 'abc')).toBe(3);
  });

  it('matches across separator and case differences', () => {
    expect(closestUniqueMatch('type-check', ['typecheck', 'build'])).toBe('typecheck');
    expect(closestUniqueMatch('Build', ['build', 'lint'])).toBe('build');
  });

  it('returns nothing when two candidates are equally close', () => {
    expect(closestUniqueMatch('check:deb', ['check:dev', 'check:web'])).toBeUndefined();
  });

  it('returns nothing beyond two edits, or for a short name', () => {
    expect(closestUniqueMatch('deploy', ['build', 'lint'])).toBeUndefined();
    // 'dev' is within one edit of 'den', but two edits on a 3-character name is
    // a different word; the length floor keeps the rule from guessing.
    expect(closestUniqueMatch('dev', ['test', 'lint'])).toBeUndefined();
  });

  it('ignores a candidate spelled exactly like the missing name', () => {
    expect(closestUniqueMatch('build', ['build'])).toBeUndefined();
  });
});

// ── Recipe 1: a mistyped package-manager script ──────────────────────────────

describe('command_validity: mistyped script with one close match', () => {
  it('marks the finding auto-applicable and rewrites exactly that token', async () => {
    const repo = repoWith({
      'package.json': MANIFEST,
      'AGENTS.md': '# Agents\n\n```bash\nnpm run bulid\n```\n',
    });
    const issues = commandIssues(await issuesIn(repo));
    expect(issues).toHaveLength(1);
    const issue = issues[0]!;
    expect(issue.autoApplySafe).toBe(true);
    expect(isRepairable(issue)).toBe(true);
    expect(issue.summary).toContain('The closest script name the manifest defines is "build".');
    expect(issue.fixEdits).toEqual([
      { filePath: path.join(repo, 'AGENTS.md'), line: 4, find: 'npm run bulid', replace: 'npm run build' },
    ]);

    expect(await applyAll(repo, issues, 'AGENTS.md')).toBe('# Agents\n\n```bash\nnpm run build\n```\n');
  });

  it('rewrites a prose mention and leaves the rest of the sentence alone', async () => {
    const repo = repoWith({
      'package.json': MANIFEST,
      'AGENTS.md': '# Agents\n\nAlways run pnpm typecheeck before you push.\n',
    });
    const issues = commandIssues(await issuesIn(repo));
    expect(issues).toHaveLength(1);
    expect(await applyAll(repo, issues, 'AGENTS.md')).toBe(
      '# Agents\n\nAlways run pnpm typecheck before you push.\n',
    );
  });

  it('keeps the command prefix, so a flag-bearing command still rewrites in place', async () => {
    const repo = repoWith({
      'package.json': MANIFEST,
      'AGENTS.md': '# Agents\n\n```bash\nnpm run --silent bulid\n```\n',
    });
    const issues = commandIssues(await issuesIn(repo));
    expect(issues[0]!.fixEdits?.[0]).toMatchObject({
      find: 'npm run --silent bulid',
      replace: 'npm run --silent build',
    });
    expect(await applyAll(repo, issues, 'AGENTS.md')).toContain('npm run --silent build');
  });

  it('stays advisory when two scripts are equally close', async () => {
    const repo = repoWith({
      'package.json': JSON.stringify({
        name: 'app',
        scripts: { 'check:dev': 'node x', 'check:web': 'node y' },
      }),
      'AGENTS.md': '# Agents\n\n```bash\nnpm run check:deb\n```\n',
    });
    const issues = commandIssues(await issuesIn(repo));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.autoApplySafe).toBeUndefined();
    expect(issues[0]!.fixEdits).toBeUndefined();
    expect(await applyFixRecipe(issues[0]!, repo)).toEqual([]);
  });

  it('stays advisory when no script is close', async () => {
    const repo = repoWith({
      'package.json': MANIFEST,
      'AGENTS.md': '# Agents\n\n```bash\nnpm run deploy-to-staging-cluster\n```\n',
    });
    const issues = commandIssues(await issuesIn(repo));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.autoApplySafe).toBeUndefined();
  });

  it('stays advisory for the slash shorthand, which documents several scripts at once', async () => {
    const repo = repoWith({
      'package.json': MANIFEST,
      'AGENTS.md': '# Agents\n\n```bash\nnpm run lint/bulid\n```\n',
    });
    const issues = commandIssues(await issuesIn(repo));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.autoApplySafe).toBeUndefined();
  });

  it('stays advisory when the same command appears twice on one line', async () => {
    const repo = repoWith({
      'package.json': MANIFEST,
      'AGENTS.md': '# Agents\n\nUse `npm run bulid` — yes, `npm run bulid`.\n',
    });
    const issues = commandIssues(await issuesIn(repo));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.autoApplySafe).toBeUndefined();
  });
});

// ── Recipe 2: a link whose target moved ──────────────────────────────────────

describe('structure: broken link whose basename is unique in the tree', () => {
  it('re-points the link at the file, relative to the linking file', async () => {
    const repo = repoWith({
      'package.json': MANIFEST,
      'AGENTS.md': '# Agents\n\nSee [the runbook](./docs/runbook.md) first.\n',
      'ops/runbook.md': '# Runbook\n',
    });
    const issues = brokenRefIssues(await issuesIn(repo));
    expect(issues).toHaveLength(1);
    const issue = issues[0]!;
    expect(issue.autoApplySafe).toBe(true);
    expect(issue.fixEdits).toEqual([
      {
        filePath: path.join(repo, 'AGENTS.md'),
        line: 3,
        find: '](./docs/runbook.md)',
        replace: '](./ops/runbook.md)',
      },
    ]);

    expect(await applyAll(repo, issues, 'AGENTS.md')).toBe(
      '# Agents\n\nSee [the runbook](./ops/runbook.md) first.\n',
    );
  });

  it('computes the path from the linking file, not the repo root, and keeps a fragment', async () => {
    const repo = repoWith({
      'package.json': MANIFEST,
      '.claude/CLAUDE.md': '# Claude\n\n[deploy steps](../docs/runbook.md#rollback)\n',
      'ops/runbook.md': '# Runbook\n',
    });
    const issues = brokenRefIssues(await issuesIn(repo));
    expect(issues).toHaveLength(1);
    expect(await applyAll(repo, issues, '.claude/CLAUDE.md')).toBe(
      '# Claude\n\n[deploy steps](../ops/runbook.md#rollback)\n',
    );
  });

  it('stays advisory for a nested-link target that carries link syntax', async () => {
    // Seen live on a real repository: the nested-link pattern captures
    // `([detail](docs/runbook.md` as the target. Splicing a replacement into
    // that `](` would corrupt the link it belongs to.
    const repo = repoWith({
      'package.json': MANIFEST,
      'AGENTS.md': '# Agents\n\n[[the runbook]([detail](docs/runbook.md)\n',
      'ops/runbook.md': '# Runbook\n',
    });
    const issues = brokenRefIssues(await issuesIn(repo));
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) expect(issue.autoApplySafe).toBeUndefined();
  });

  it('stays advisory when two files share the basename', async () => {
    const repo = repoWith({
      'package.json': MANIFEST,
      'AGENTS.md': '# Agents\n\nSee [the checklist](./docs/checklist.md).\n',
      'ops/checklist.md': '# Ops\n',
      'qa/checklist.md': '# QA\n',
    });
    const issues = brokenRefIssues(await issuesIn(repo));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.autoApplySafe).toBeUndefined();
    expect(await applyFixRecipe(issues[0]!, repo)).toEqual([]);
  });

  it('stays advisory when the only candidate is gitignored', async () => {
    const repo = repoWith({
      'package.json': MANIFEST,
      '.gitignore': 'local/\n',
      'AGENTS.md': '# Agents\n\nSee [the runbook](./docs/runbook.md).\n',
      'local/runbook.md': '# Local\n',
    });
    const issues = brokenRefIssues(await issuesIn(repo));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.autoApplySafe).toBeUndefined();
  });

  it('stays advisory when one grouped occurrence of the target is not rewritable', async () => {
    const repo = repoWith({
      'package.json': MANIFEST,
      // One finding covers both links (they name the same target). The second
      // carries a link title, a form the recipe does not reassemble, so the
      // whole finding stays advisory rather than fixing half of it.
      'AGENTS.md':
        '# Agents\n\n[the runbook](./docs/runbook.md)\n\n[again](./docs/runbook.md "The Runbook")\n',
      'ops/runbook.md': '# Runbook\n',
    });
    const issues = brokenRefIssues(await issuesIn(repo));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.autoApplySafe).toBeUndefined();
    expect(await applyFixRecipe(issues[0]!, repo)).toEqual([]);
  });

  it('rewrites the link and leaves a separate code-span mention of the old path reported', async () => {
    const repo = repoWith({
      'package.json': MANIFEST,
      'AGENTS.md': '# Agents\n\nSee [the runbook](./docs/runbook.md); the file is `docs/runbook.md`.\n',
      'ops/runbook.md': '# Runbook\n',
    });
    const issues = brokenRefIssues(await issuesIn(repo));
    // The link and the code span are different text, so they are different
    // findings: the link's is mechanical, the prose one is not.
    const [link, span] = [
      issues.find((i) => i.autoApplySafe === true)!,
      issues.find((i) => i.autoApplySafe !== true)!,
    ];
    expect(issues).toHaveLength(2);
    expect(link.fixEdits?.[0]?.find).toBe('](./docs/runbook.md)');
    expect(span.fixEdits).toBeUndefined();
    expect(await applyAll(repo, [link], 'AGENTS.md')).toBe(
      '# Agents\n\nSee [the runbook](./ops/runbook.md); the file is `docs/runbook.md`.\n',
    );
  });

  it('rewrites every link occurrence of one moved target, across files', async () => {
    const repo = repoWith({
      'package.json': MANIFEST,
      'AGENTS.md': '# Agents\n\n[runbook](./docs/runbook.md)\n',
      'CLAUDE.md': '# Claude\n\n[runbook](./docs/runbook.md)\n',
      'ops/runbook.md': '# Runbook\n',
    });
    const issues = brokenRefIssues(await issuesIn(repo));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.fixEdits).toHaveLength(2);
    expect(await applyAll(repo, issues, 'AGENTS.md')).toContain('](./ops/runbook.md)');
    expect(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf-8')).toContain('](./ops/runbook.md)');
  });
});

// ── The engine's own safety rules ────────────────────────────────────────────

describe('applyFixRecipe — line-anchored edits are all-or-nothing', () => {
  it('applies nothing when the anchored text is no longer on its line', async () => {
    const repo = repoWith({
      'package.json': MANIFEST,
      'AGENTS.md': '# Agents\n\n```bash\nnpm run bulid\n```\n',
    });
    const issues = commandIssues(await issuesIn(repo));
    // Someone edits the file between the scan and the fix.
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Agents\n\nnothing here\n', 'utf-8');
    expect(await applyFixRecipe(issues[0]!, repo)).toEqual([]);
  });

  it('applies nothing when one of several edits cannot be applied', async () => {
    const repo = repoWith({
      'package.json': MANIFEST,
      'AGENTS.md': '# Agents\n\n[runbook](./docs/runbook.md)\n',
      'CLAUDE.md': '# Claude\n\n[runbook](./docs/runbook.md)\n',
      'ops/runbook.md': '# Runbook\n',
    });
    const issues = brokenRefIssues(await issuesIn(repo));
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# Claude\n\nno link\n', 'utf-8');
    expect(await applyFixRecipe(issues[0]!, repo)).toEqual([]);
  });

  it('refuses an edit whose path escapes the repo root', async () => {
    const repo = repoWith({ 'package.json': MANIFEST, 'AGENTS.md': '# Agents\n' });
    const issue: PromptCiIssue = {
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
      fixEdits: [{ filePath: '../outside.md', line: 1, find: 'a', replace: 'b' }],
    };
    await expect(applyFixRecipe(issue, repo)).rejects.toThrow(/Path traversal/);
  });

  it('preserves CRLF line endings and the rest of the file byte-for-byte', async () => {
    const repo = repoWith({
      'package.json': MANIFEST,
      'AGENTS.md': '# Agents\r\n\r\n```bash\r\nnpm run bulid\r\n```\r\n\r\nTrailing prose, no newline at EOF.',
    });
    const issues = commandIssues(await issuesIn(repo));
    expect(await applyAll(repo, issues, 'AGENTS.md')).toBe(
      '# Agents\r\n\r\n```bash\r\nnpm run build\r\n```\r\n\r\nTrailing prose, no newline at EOF.',
    );
  });
});

// ── The committed fixture ────────────────────────────────────────────────────

describe('fixture-fix-recipes', () => {
  it('offers exactly one auto-applicable fix per recipe and leaves the twins advisory', async () => {
    const issues = await issuesIn(FIXTURE);

    const commands = commandIssues(issues);
    expect(commands.filter((i) => i.autoApplySafe === true).map((i) => i.fixEdits?.[0]?.replace)).toEqual([
      'npm run build',
    ]);
    // The ambiguous and the unrecognisable command are both still reported.
    expect(commands.filter((i) => i.autoApplySafe !== true)).toHaveLength(2);

    const refs = brokenRefIssues(issues);
    expect(refs.filter((i) => i.autoApplySafe === true).map((i) => i.fixEdits?.[0]?.replace)).toEqual([
      '](./ops/runbook.md)',
    ]);
    expect(refs.filter((i) => i.autoApplySafe !== true).map((i) => i.title)).toEqual([
      'Broken file reference: checklist.md',
    ]);
  });

  it('does not modify the committed fixture when the fixes are computed', async () => {
    const before = fs.readFileSync(path.join(FIXTURE, 'AGENTS.md'), 'utf-8');
    const issues = (await issuesIn(FIXTURE)).filter(isRepairable);
    const changes = (await Promise.all(issues.map((i) => applyFixRecipe(i, FIXTURE)))).flat();
    expect(changes.length).toBeGreaterThan(0);
    // applyFixRecipe only COMPUTES changes; nothing is written.
    expect(fs.readFileSync(path.join(FIXTURE, 'AGENTS.md'), 'utf-8')).toBe(before);
  });
});
