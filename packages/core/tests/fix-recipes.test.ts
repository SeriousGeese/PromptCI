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
import { closestUniqueMatch, damerauLevenshtein, isMechanicalRename } from '../src/close-match.js';
import type { PromptCiIssue } from '../src/types.js';
import { canSymlink, makeTempRepo, trySymlink, writeFile } from './ai-config-helpers.js';

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

/**
 * Review finding M1: a unique nearest neighbour is NOT enough to rewrite. Most
 * one-edit neighbours of a script name are a real sibling script, and silently
 * running the wrong one is worse than reporting and leaving it. Every pair below
 * passes `closestUniqueMatch` and must still be refused.
 */
describe('isMechanicalRename', () => {
  it.each([
    ['bulid', 'build', 'a transposition'],
    ['typecheeck', 'typecheck', 'a doubled letter in a long name'],
    ['test:e3e', 'test:e2e', 'a mid-name digit in one segment'],
    ['type-check', 'typecheck', 'a separator difference'],
    ['Build', 'build', 'a case difference'],
  ])('accepts %s -> %s (%s)', (missing, candidate) => {
    expect(isMechanicalRename(missing, candidate)).toBe(true);
  });

  it.each([
    ['test:api', 'test:app', 'another real word in a short segment'],
    ['db:up', 'db:rm', 'two edits in a short name'],
    ['test:unit', 'test:init', 'another real word in a short segment'],
    ['test', 'dist', 'two edits in a short name'],
    ['test', 'best', 'another real word in a short segment'],
    ['build:v1', 'build:v2', 'a trailing-digit version suffix'],
    ['test:py2', 'test:py3', 'a trailing-digit target suffix'],
    ['build', 'build:web', 'a different number of segments'],
    ['test:unit', 'lint:unit', 'a difference in the scoping segment, short'],
  ])('refuses %s -> %s (%s)', (missing, candidate) => {
    expect(isMechanicalRename(missing, candidate)).toBe(false);
  });

  it('still names each refused candidate as the closest match', () => {
    // The pairs above are refused for AUTO-APPLY only; the matcher that decides
    // whether a candidate is worth mentioning still finds them.
    expect(closestUniqueMatch('test:api', ['test:app', 'lint'])).toBe('test:app');
    expect(closestUniqueMatch('build:v1', ['build:v2', 'lint'])).toBe('build:v2');
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

  it('keeps test:e3e -> test:e2e auto-applicable', async () => {
    const repo = repoWith({
      'package.json': JSON.stringify({ name: 'app', scripts: { 'test:e2e': 'playwright test' } }),
      'AGENTS.md': '# Agents\n\n```bash\npnpm test:e3e\n```\n',
    });
    const issues = commandIssues(await issuesIn(repo));
    expect(issues[0]!.autoApplySafe).toBe(true);
    expect(await applyAll(repo, issues, 'AGENTS.md')).toContain('pnpm test:e2e');
  });

  /**
   * Review finding M1 end to end: each of these is a unique nearest neighbour,
   * so the old rule would have rewritten the command to a DIFFERENT, real
   * script. The finding must stay advisory and name the candidate only in the
   * recommendation, cautiously.
   */
  it.each([
    ['test:api', 'test:app'],
    ['db:up', 'db:rm'],
    ['test:unit', 'test:init'],
    // `test` itself is a package-manager BUILTIN, so `pnpm run test` is never
    // reported at all; `lint` exercises the same one- and two-edit short-name
    // rules end to end (the reviewer's `test`/`best`/`dist` pairs are covered
    // directly in the isMechanicalRename table above).
    ['lint', 'link'],
    ['lint', 'dist'],
    ['build:v1', 'build:v2'],
    ['test:py2', 'test:py3'],
  ])('stays advisory for %s when the manifest only defines the sibling %s', async (missing, defined) => {
    const repo = repoWith({
      'package.json': JSON.stringify({ name: 'app', scripts: { [defined]: 'echo hi' } }),
      'AGENTS.md': `# Agents\n\n\`\`\`bash\npnpm run ${missing}\n\`\`\`\n`,
    });
    const issues = commandIssues(await issuesIn(repo));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.autoApplySafe).toBeUndefined();
    expect(issues[0]!.fixEdits).toBeUndefined();
    expect(await applyFixRecipe(issues[0]!, repo)).toEqual([]);
    // Named, but only as something to check — never as a verdict.
    expect(issues[0]!.recommendation).toContain(`The manifest defines "${defined}"`);
    expect(issues[0]!.recommendation).toContain('check before changing it');
    expect(issues[0]!.summary).not.toContain(defined);
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

  /**
   * Review finding L4: a `--filter` that selects several packages runs the
   * script in ALL of them, so a candidate only one of them defines would leave
   * the command broken everywhere else.
   */
  describe('with a --filter selecting several workspaces', () => {
    const workspace = {
      'package.json': JSON.stringify({ name: 'root', private: true, scripts: { build: 'tsc -b' } }),
      'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
    };

    it('stays advisory when only some selected packages define the candidate', async () => {
      const repo = repoWith({
        ...workspace,
        'packages/a/package.json': JSON.stringify({ name: 'a', scripts: { lint: 'eslint .' } }),
        'packages/b/package.json': JSON.stringify({ name: 'b', scripts: { test: 'vitest run' } }),
        'AGENTS.md': '# Agents\n\n```bash\npnpm --filter "packages/*" lnit\n```\n',
      });
      const issues = commandIssues(await issuesIn(repo));
      expect(issues).toHaveLength(1);
      expect(issues[0]!.autoApplySafe).toBeUndefined();
    });

    it('names the candidate but offers no edit when every selected package defines it', async () => {
      const repo = repoWith({
        ...workspace,
        'packages/a/package.json': JSON.stringify({ name: 'a', scripts: { lint: 'eslint .' } }),
        'packages/b/package.json': JSON.stringify({ name: 'b', scripts: { lint: 'eslint .' } }),
        'AGENTS.md': '# Agents\n\n```bash\npnpm --filter "packages/*" lnit\n```\n',
      });
      const issues = commandIssues(await issuesIn(repo));
      expect(issues).toHaveLength(1);
      // Default-deny (pcic-1ik0.2): the closest name must come from the ROOT manifest, and here it
      // comes from the selected workspaces, so it is named in the recommendation and never applied.
      expect(issues[0]!.autoApplySafe).toBeUndefined();
      expect(issues[0]!.fixEdits).toBeUndefined();
      expect(issues[0]!.recommendation).toContain('lint');
    });
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

describe('command_validity: no rewrite where the surroundings change what the command means (pcic-1ik0.2)', () => {
  const advisory = async (agents: string, extra: Record<string, string> = {}): Promise<PromptCiIssue> => {
    const repo = repoWith({ 'package.json': MANIFEST, 'AGENTS.md': agents, ...extra });
    const issues = commandIssues(await issuesIn(repo));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.autoApplySafe).toBeUndefined();
    expect(issues[0]!.fixEdits).toBeUndefined();
    expect(isRepairable(issues[0]!)).toBe(false);
    expect(await applyFixRecipe(issues[0]!, repo)).toEqual([]);
    return issues[0]!;
  };

  it('inside an HTML comment: not reported at all', async () => {
    for (const body of ['<!-- run `npm run bulid` once -->', '<!--\nrun npm run bulid\n-->']) {
      const repo = repoWith({ 'package.json': MANIFEST, 'AGENTS.md': `# Agents\n\n${body}\n` });
      expect(commandIssues(await issuesIn(repo))).toEqual([]);
    }
  });

  it('inside an indented block', async () => {
    const issue = await advisory('# Agents\n\nRun it:\n\n    run npm run bulid\n');
    expect(issue.recommendation).toContain('indented block');
  });

  it('after a cd, inside a fence or inline', async () => {
    const issue = await advisory('# Agents\n\n```bash\ncd site && npm run bulid\n```\n', { 'site/package.json': MANIFEST });
    expect(issue.recommendation).toContain('another directory');
    await advisory('# Agents\n\nRun `cd site && npm run bulid` first.\n', { 'site/package.json': MANIFEST });
  });

  it('with a directory flag, spaced, attached or with an equals sign', async () => {
    await advisory('# Agents\n\n```bash\nnpm run --prefix site bulid\n```\n', { 'site/package.json': MANIFEST });
    await advisory('# Agents\n\n```bash\npnpm -Csite run bulid\n```\n', { 'site/package.json': MANIFEST });
    await advisory('# Agents\n\n```bash\npnpm -C site run bulid\n```\n', { 'site/package.json': MANIFEST });
    await advisory('# Agents\n\n```bash\nyarn --cwd=site bulid\n```\n', { 'site/package.json': MANIFEST });
  });

  it('in a repository with a second package.json, whatever the text says', async () => {
    const issue = await advisory('# Agents\n\n## Site (from `site/` directory)\n\n```bash\nnpm run bulid\n```\n', {
      'site/package.json': JSON.stringify({ name: 'site', scripts: { dev: 'x' } }),
    });
    expect(issue.recommendation).toContain('more than one package');
  });

  it('still rewrites a plain command in a fence and in prose', async () => {
    const repo = repoWith({ 'package.json': MANIFEST, 'AGENTS.md': '# Agents\n\n```bash\nnpm run bulid\n```\n' });
    expect(commandIssues(await issuesIn(repo))[0]!.autoApplySafe).toBe(true);
  });
});

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

  /**
   * pcic-1ik0.7 (issue 155): with an inline link EARLIER in the file, the last
   * broken link was reported at the first link's line and got no edit, because
   * the nested-link pattern started at the first link and ended at the last.
   */
  describe('a broken link that is the last inline link after an earlier one', () => {
    const CASES: Array<[string, string, number]> = [
      [
        'earlier link, heading, prose',
        '# CLAUDE.md\n\nSee [AGENTS.md](./AGENTS.md) for details.\n\n## B\n\nNew joiners start with the [onboarding checklist](onboarding-checklist.md).\n',
        7,
      ],
      [
        'earlier link, three lines of prose',
        '# CLAUDE.md\n\nSee [AGENTS.md](./AGENTS.md).\n\nOne.\nTwo.\nThree.\nStart with the [onboarding checklist](onboarding-checklist.md).\n',
        8,
      ],
      [
        'earlier link and the broken link on adjacent lines',
        '# C\n\nSee [AGENTS.md](./AGENTS.md).\n[onboarding checklist](onboarding-checklist.md)\n',
        4,
      ],
      [
        'earlier link on the same line as the broken one',
        '# C\n\nSee [AGENTS.md](./AGENTS.md) and [onboarding checklist](onboarding-checklist.md).\n',
        3,
      ],
    ];

    it.each(CASES)('reports its own line and offers the edit: %s', async (_name, claude, line) => {
      const repo = repoWith({
        'package.json': MANIFEST,
        'AGENTS.md': '# Agents\n',
        'CLAUDE.md': claude,
        'docs/onboarding-checklist.md': '# Onboarding\n',
      });
      const issues = brokenRefIssues(await issuesIn(repo));
      expect(issues).toHaveLength(1);
      const issue = issues[0]!;
      expect(issue.locations).toEqual([{ filePath: path.join(repo, 'CLAUDE.md'), startLine: line }]);
      expect(issue.autoApplySafe).toBe(true);
      expect(issue.fixEdits).toEqual([
        {
          filePath: path.join(repo, 'CLAUDE.md'),
          line,
          find: '](onboarding-checklist.md)',
          replace: '](./docs/onboarding-checklist.md)',
        },
      ]);
      expect(await applyAll(repo, issues, 'CLAUDE.md')).toBe(
        claude.replace('](onboarding-checklist.md)', '](./docs/onboarding-checklist.md)'),
      );
    });

    it('is unchanged when a link follows the broken one', async () => {
      const claude =
        '# C\n\nSee [AGENTS.md](./AGENTS.md).\n\nStart with [the checklist](onboarding-checklist.md).\n\nAlso [AGENTS.md](./AGENTS.md).\n';
      const repo = repoWith({
        'package.json': MANIFEST,
        'AGENTS.md': '# Agents\n',
        'CLAUDE.md': claude,
        'docs/onboarding-checklist.md': '# Onboarding\n',
      });
      const issues = brokenRefIssues(await issuesIn(repo));
      expect(issues).toHaveLength(1);
      expect(issues[0]!.locations).toEqual([{ filePath: path.join(repo, 'CLAUDE.md'), startLine: 5 }]);
      expect(issues[0]!.autoApplySafe).toBe(true);
    });
  });

  /** pcic-1ik0.4 review: row 5 of the table in issue 155. */
  it('reports line 9 and offers the edit with an earlier link AND a code span to another missing file above it', async () => {
    const claude =
      '# CLAUDE.md\n\nSee [AGENTS.md](./AGENTS.md) for details.\n\nThe script `scripts/gone.sh` is stale.\n\n## B\n\nNew joiners start with the [onboarding checklist](onboarding-checklist.md).\n';
    const repo = repoWith({
      'package.json': MANIFEST,
      'AGENTS.md': '# Agents\n',
      'CLAUDE.md': claude,
      'docs/onboarding-checklist.md': '# Onboarding\n',
    });
    const issue = brokenRefIssues(await issuesIn(repo)).find((i) => i.title.includes('onboarding-checklist'))!;
    expect(issue.locations).toEqual([{ filePath: path.join(repo, 'CLAUDE.md'), startLine: 9 }]);
    expect(issue.autoApplySafe).toBe(true);
    expect(await applyAll(repo, [issue], 'CLAUDE.md')).toBe(
      claude.replace('](onboarding-checklist.md)', '](./docs/onboarding-checklist.md)'),
    );
  });

  /**
   * pcic-1ik0.4 review (B2): sample text is reported but never rewritten. A
   * fenced block and a code span were covered; so are an indented code block and
   * an HTML comment, for the link recipe and the script-rename recipe alike.
   */
  describe('sample text is reported but never rewritten', () => {
    const LINK = '[the runbook](./docs/runbook.md)';
    const MOVED = '](./ops/runbook.md)';

    async function linkCase(body: string): Promise<{ issue: PromptCiIssue; after: string }> {
      const original = `# Agents\n\n${body}\n`;
      const repo = repoWith({ 'package.json': MANIFEST, 'AGENTS.md': original, 'ops/runbook.md': '# Runbook\n' });
      const issues = brokenRefIssues(await issuesIn(repo));
      expect(issues).toHaveLength(1);
      return { issue: issues[0]!, after: await applyAll(repo, issues, 'AGENTS.md') };
    }

    it.each([
      ['an indented code block (4 spaces)', `Write it like this:\n\n    See ${LINK}.`],
      ['an indented code block (tab)', `Write it like this:\n\n\tSee ${LINK}.`],
      ['a single-line HTML comment', `<!-- old: ${LINK} -->`],
      ['a multi-line HTML comment', `<!--\nold notes\nSee ${LINK}\n-->`],
      ['an unterminated HTML comment', `<!-- the rest is hidden\nSee ${LINK}`],
    ])('leaves a link in %s alone', async (_name, body) => {
      const { issue, after } = await linkCase(body);
      expect(issue.autoApplySafe).toBeUndefined();
      expect(issue.fixEdits).toBeUndefined();
      expect(after).toBe(`# Agents\n\n${body}\n`);
    });

    it('does not let `<!--` inside a code span or a fence swallow the rest of the file', async () => {
      for (const prefix of ['Comments start with `<!--`.\n\n', '```html\n<!-- a comment in an example\n```\n\n']) {
        const body = `${prefix}See ${LINK}.`;
        const { issue, after } = await linkCase(body);
        expect(issue.autoApplySafe, prefix).toBe(true);
        expect(after, prefix).toBe(`# Agents\n\n${body.replace('](./docs/runbook.md)', MOVED)}\n`);
      }
      // A script rename after the same text is still repaired.
      const original = '# Agents\n\nComments start with `<!--`.\n\n```bash\nnpm run bulid\n```\n';
      const repo = repoWith({ 'package.json': MANIFEST, 'AGENTS.md': original });
      const issues = commandIssues(await issuesIn(repo));
      expect(await applyAll(repo, issues, 'AGENTS.md')).toBe(original.replace('bulid', 'build'));
    });

    it('still hides a real comment that follows such text', async () => {
      const { issue, after } = await linkCase(`Comments start with \`<!--\`.\n\n<!-- old: ${LINK} -->`);
      expect(issue.autoApplySafe).toBeUndefined();
      expect(after).toContain(`<!-- old: ${LINK} -->`);
    });

    it('still rewrites a link after a comment has closed, and a normal line', async () => {
      const body = `<!-- note -->\nSee ${LINK}.`;
      const { issue, after } = await linkCase(body);
      expect(issue.autoApplySafe).toBe(true);
      expect(after).toBe(`# Agents\n\n${body.replace('](./docs/runbook.md)', MOVED)}\n`);
    });

    it('keeps the whole finding advisory when one occurrence is sample text', async () => {
      const { issue, after } = await linkCase(`See ${LINK}.\n\n    Also ${LINK}.`);
      expect(issue.autoApplySafe).toBeUndefined();
      expect(after).toBe(`# Agents\n\nSee ${LINK}.\n\n    Also ${LINK}.\n`);
    });

    it('does not rewrite a mistyped script inside an HTML comment, but does in a fenced block', async () => {
      const comment = '# Agents\n\n<!-- old: run `npm run bulid` -->\n';
      const repo = repoWith({ 'package.json': MANIFEST, 'AGENTS.md': comment });
      // A command in a comment no reader sees is not even reported (pcic-1ik0.2).
      const hidden = commandIssues(await issuesIn(repo));
      expect(hidden).toEqual([]);
      expect(await applyAll(repo, hidden, 'AGENTS.md')).toBe(comment);

      const fenced = '# Agents\n\n```bash\nnpm run bulid\n```\n';
      const repo2 = repoWith({ 'package.json': MANIFEST, 'AGENTS.md': fenced });
      const issues = commandIssues(await issuesIn(repo2));
      expect(issues.some((i) => i.autoApplySafe === true)).toBe(true);
      expect(await applyAll(repo2, issues, 'AGENTS.md')).toBe('# Agents\n\n```bash\nnpm run build\n```\n');
    });
  });

  /** pcic-1ik0.4 review (b): a fixture or vendored copy is not where the file moved to. */
  describe('the candidate is never a fixture, test, example or vendor copy', () => {
    it.each(['test/fixtures', 'tests', 'examples/demo', 'vendor/lib'])('ignores a copy under %s', async (dir) => {
      const repo = repoWith({
        'package.json': MANIFEST,
        'AGENTS.md': '# Agents\n\nSee [the runbook](./docs/runbook.md).\n',
        [`${dir}/runbook.md`]: '# Runbook\n',
      });
      const [issue] = brokenRefIssues(await issuesIn(repo));
      expect(issue!.autoApplySafe).toBeUndefined();
      expect(issue!.summary).not.toContain('may be what was meant');
    });

    it('treats docs/spec as documentation, not a fixture tree', async () => {
      const repo = repoWith({
        'package.json': MANIFEST,
        'AGENTS.md': '# Agents\n\nSee [protocol](./protocol.md).\n',
        'docs/spec/protocol.md': '# Protocol\n',
      });
      const issues = brokenRefIssues(await issuesIn(repo));
      expect(issues[0]!.summary).toContain('"docs/spec/protocol.md"');
      expect(await applyAll(repo, issues, 'AGENTS.md')).toBe('# Agents\n\nSee [protocol](./docs/spec/protocol.md).\n');
    });

    it('rewrites to the real file when a fixture copy also exists', async () => {
      const repo = repoWith({
        'package.json': MANIFEST,
        'AGENTS.md': '# Agents\n\nSee [the runbook](./docs/runbook.md).\n',
        'ops/runbook.md': '# Runbook\n',
        'test/fixtures/runbook.md': '# Fixture\n',
      });
      const issues = brokenRefIssues(await issuesIn(repo));
      expect(await applyAll(repo, issues, 'AGENTS.md')).toBe('# Agents\n\nSee [the runbook](./ops/runbook.md).\n');
    });
  });

  /** Review finding M3: a link inside a fence or a code span is sample text. */
  it('leaves a link inside a fenced code block alone', async () => {
    const original = '# Agents\n\n```markdown\n[the runbook](./docs/runbook.md)\n```\n';
    const repo = repoWith({
      'package.json': MANIFEST,
      'AGENTS.md': original,
      'ops/runbook.md': '# Runbook\n',
    });
    const issues = brokenRefIssues(await issuesIn(repo));
    // Still reported — a stale example is worth knowing about — but not rewritten.
    expect(issues).toHaveLength(1);
    expect(issues[0]!.autoApplySafe).toBeUndefined();
    expect(await applyAll(repo, issues, 'AGENTS.md')).toBe(original);
  });

  it('leaves a link inside an inline code span alone', async () => {
    const original = '# Agents\n\nWrite it as `[the runbook](./docs/runbook.md)` in your own file.\n';
    const repo = repoWith({
      'package.json': MANIFEST,
      'AGENTS.md': original,
      'ops/runbook.md': '# Runbook\n',
    });
    const issues = brokenRefIssues(await issuesIn(repo));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.autoApplySafe).toBeUndefined();
    expect(await applyAll(repo, issues, 'AGENTS.md')).toBe(original);
  });

  /** Review finding M2: the computed target is written in raw, so it must need no escaping. */
  it.each([
    ['my docs', 'a space'],
    ['notes(old)', 'parentheses'],
    ['notes[v2]', 'brackets'],
    ['notes#1', 'a hash'],
    ['notes%20', 'a percent'],
    // `?`, `<`, `>` and a backtick are rejected by the same character class;
    // Windows cannot create a directory named for any of them, so they are not
    // exercised through the filesystem here.
  ])('stays advisory when the new path would contain %s (%s)', async (dirName) => {
    const repo = repoWith({
      'package.json': MANIFEST,
      'AGENTS.md': '# Agents\n\nSee [the runbook](./docs/runbook.md).\n',
      [`${dirName}/runbook.md`]: '# Runbook\n',
    });
    const issues = brokenRefIssues(await issuesIn(repo));
    const link = issues.find((i) => i.title === 'Broken file reference: runbook.md');
    expect(link).toBeDefined();
    expect(link!.autoApplySafe).toBeUndefined();
  });

  /** Review finding L2: a file is never the fix for a link inside itself. */
  it('stays advisory when the only candidate is the linking file', async () => {
    const original = '# Agents\n\nSee [the guide](./docs/AGENTS.md).\n';
    const repo = repoWith({ 'package.json': MANIFEST, 'AGENTS.md': original });
    const issues = brokenRefIssues(await issuesIn(repo));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.autoApplySafe).toBeUndefined();
  });

  /** Review finding L3: only links to a FILE are re-pointed. */
  it('stays advisory for a directory link', async () => {
    const repo = repoWith({
      'package.json': MANIFEST,
      'AGENTS.md': '# Agents\n\nThe API lives in [the api dir](./src/api/), see also `src/lib/`.\n',
      'src/lib/keep.ts': 'export {};\n',
    });
    const issues = brokenRefIssues(await issuesIn(repo));
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) expect(issue.autoApplySafe).toBeUndefined();
  });

  it('stays advisory for an extension-less link, even when a file of that name exists', async () => {
    const repo = repoWith({
      'package.json': MANIFEST,
      'AGENTS.md': '# Agents\n\nRun [the hook](./hooks/precommit) first.\n',
      'hooks/sub/precommit': '#!/bin/sh\n',
    });
    const issues = brokenRefIssues(await issuesIn(repo));
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

  /**
   * Review finding L7: the lexical containment check cannot see a symlink. An
   * in-root instruction file committed as a link to somewhere outside must not
   * be written through — the same policy reads already follow.
   */
  it.runIf(canSymlink)('refuses to write through a symlink that leaves the root', async () => {
    const outside = makeTempRepo('promptci-fix-outside-');
    tempRepos.push(outside);
    fs.writeFileSync(path.join(outside, 'target.md'), 'alpha beta\n', 'utf-8');
    const repo = repoWith({ 'package.json': MANIFEST });
    expect(trySymlink(path.join(outside, 'target.md'), path.join(repo, 'AGENTS.md'))).toBe(true);

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
      fixEdits: [{ filePath: 'AGENTS.md', line: 1, find: 'beta', replace: 'gamma' }],
    };
    expect(await applyFixRecipe(issue, repo)).toEqual([]);
    expect(fs.readFileSync(path.join(outside, 'target.md'), 'utf-8')).toBe('alpha beta\n');
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

  /**
   * Review finding L1: `String.replace(find, replace)` treats `$&`, `$1` and
   * `$$` in the replacement as replacement-PATTERN syntax, so a `$` in a path
   * or script name was silently corrupted. The splice is by index.
   */
  it('writes a replacement containing $ literally', async () => {
    const repo = repoWith({
      'package.json': MANIFEST,
      'AGENTS.md': '# Agents\n\nSee [the notes]($tmp/notes.md).\n',
      'cash$dir/notes.md': '# Notes\n',
    });
    const issues = brokenRefIssues(await issuesIn(repo));
    const link = issues.find((i) => i.fixEdits !== undefined);
    expect(link?.fixEdits?.[0]?.replace).toBe('](./cash$dir/notes.md)');
    expect(await applyAll(repo, [link!], 'AGENTS.md')).toBe(
      '# Agents\n\nSee [the notes](./cash$dir/notes.md).\n',
    );
  });

  it('applies a replacement containing $& verbatim', async () => {
    const repo = repoWith({ 'package.json': MANIFEST, 'AGENTS.md': 'alpha beta\n' });
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
      fixEdits: [{ filePath: 'AGENTS.md', line: 1, find: 'beta', replace: '$& $1 $$' }],
    };
    const [change] = await applyFixRecipe(issue, repo);
    expect(change!.newContent).toBe('alpha $& $1 $$\n');
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
    // The tied, the real-sibling and the unrecognisable command are all still reported.
    expect(commands.filter((i) => i.autoApplySafe !== true)).toHaveLength(3);
    // The real-sibling case names its candidate, cautiously, in the recommendation only.
    const sibling = commands.find((i) => i.summary.includes('migrate:db'))!;
    expect(sibling.autoApplySafe).toBeUndefined();
    expect(sibling.recommendation).toContain('The manifest defines "migrate:up"');

    const refs = brokenRefIssues(issues);
    expect(refs.filter((i) => i.autoApplySafe === true).map((i) => i.fixEdits?.[0]?.replace)).toEqual([
      '](./ops/runbook.md)',
    ]);
    expect(refs.filter((i) => i.autoApplySafe !== true).map((i) => i.title).sort()).toEqual([
      'Broken file reference: checklist.md',
      // Its target moved exactly like the runbook's, but the link is inside a
      // fence, so it is reported and left alone.
      'Broken file reference: release-notes.md',
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
