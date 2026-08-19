import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { runReviewDiff } from '../src/commands/review-diff.js';

/**
 * These tests drive real git repositories rather than mocking execSync.
 *
 * The bug being fixed (issue #13) was entirely about fidelity: the base side
 * was reconstructed as a skeleton directory holding only an allowlist of
 * files, so detectors that check the filesystem fabricated findings. A mocked
 * `git show` cannot show that — only a real checkout can.
 */

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  }).trim();
}

async function makeTempDir(): Promise<string> {
  // realpath: macOS /var → /private/var, which would break path comparisons
  // against git's own view of the worktree root.
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'promptci-review-test-')));
}

async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf-8');
  }
}

async function initRepo(dir: string): Promise<void> {
  git(['init', '--initial-branch=main'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'PromptCI Test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
}

function commitAll(dir: string, message: string): void {
  git(['add', '-A'], dir);
  git(['commit', '-m', message, '--no-verify'], dir);
}

describe('runReviewDiff CLI command', () => {
  let tmpDir: string;
  let exitCode: number | undefined;
  let stdoutOutput: string;
  let stderrOutput: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    exitCode = undefined;
    stdoutOutput = '';
    stderrOutput = '';

    vi.spyOn(process, 'exit').mockImplementation((code?: number | string) => {
      exitCode = typeof code === 'number' ? code : 0;
      throw new Error(`process.exit(${code})`);
    });

    vi.spyOn(console, 'log').mockImplementation((...msg) => {
      stdoutOutput += msg.join(' ') + '\n';
    });

    vi.spyOn(console, 'error').mockImplementation((...msg) => {
      stderrOutput += msg.join(' ') + '\n';
    });

    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutOutput += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('exits 1 and prints an error if target path is not inside a git repository', async () => {
    await expect(
      runReviewDiff({ baseBranch: 'main', scanPath: tmpDir, json: false, failOnRegression: false }),
    ).rejects.toThrow('process.exit(1)');

    expect(exitCode).toBe(1);
    expect(stderrOutput).toContain('not inside a git repository');
  });

  it('exits 1 when the base ref does not exist', async () => {
    await initRepo(tmpDir);
    await writeFiles(tmpDir, { 'CLAUDE.md': '## Rules\nEnsure 2026 compatibility.\n' });
    commitAll(tmpDir, 'initial');

    await expect(
      runReviewDiff({ baseBranch: 'no-such-branch', scanPath: tmpDir, json: false, failOnRegression: false }),
    ).rejects.toThrow('process.exit(1)');

    expect(exitCode).toBe(1);
    expect(stderrOutput).toContain('Could not resolve base branch/commit "no-such-branch"');
  });

  it('identifies resolved issues and reports score improvements', async () => {
    await initRepo(tmpDir);
    await writeFiles(tmpDir, { 'CLAUDE.md': '## Rules\nEnsure 2023 compatibility guidelines.\n' });
    commitAll(tmpDir, 'base');
    git(['branch', 'base-branch'], tmpDir);

    await writeFiles(tmpDir, { 'CLAUDE.md': '## Rules\nEnsure 2026 compatibility guidelines.\n' });
    commitAll(tmpDir, 'head');

    await runReviewDiff({
      baseBranch: 'base-branch',
      scanPath: tmpDir,
      json: false,
      failOnRegression: false,
    });

    expect(stdoutOutput).toContain('Health Score:');
    expect(stdoutOutput).toContain('New Issues:    0');
    expect(stdoutOutput).toContain('Resolved:      1');
    expect(stdoutOutput).toContain('RESOLVED');
    expect(stdoutOutput).toContain('Instruction may reference outdated content');
  });

  it('handles --path naming a subdirectory absent in the base commit', async () => {
    await initRepo(tmpDir);
    await writeFiles(tmpDir, { 'CLAUDE.md': '## Rules\nUse TypeScript.\n' });
    commitAll(tmpDir, 'base');
    git(['branch', 'base-branch'], tmpDir);

    // HEAD adds a brand-new subdirectory whose instruction file has a finding.
    await writeFiles(tmpDir, { 'sub/CLAUDE.md': '## Rules\nEnsure 2023 compatibility guidelines.\n' });
    commitAll(tmpDir, 'head adds sub/');

    // Scanning sub/ must not crash even though the base commit has no sub/.
    await runReviewDiff({
      baseBranch: 'base-branch',
      scanPath: path.join(tmpDir, 'sub'),
      json: false,
      failOnRegression: false,
    });

    // The absence is noted, and the finding under sub/ is reported as new
    // (the base side is empty, so it cannot be paired away as pre-existing).
    expect(stderrOutput).toContain('does not exist in the base commit');
    expect(stdoutOutput).toContain('[+] New Issues:');
    expect(stdoutOutput).toContain('Instruction may reference outdated content');
    expect(stdoutOutput).not.toContain('New Issues:    0');
  });

  it('identifies regressions (new issues) and exits 1 if failOnRegression is true', async () => {
    await initRepo(tmpDir);
    await writeFiles(tmpDir, { 'CLAUDE.md': '## Rules\nEnsure 2026 compatibility guidelines.\n' });
    commitAll(tmpDir, 'base');
    git(['branch', 'base-branch'], tmpDir);

    await writeFiles(tmpDir, { 'CLAUDE.md': '## Rules\nEnsure 2023 compatibility guidelines.\n' });
    commitAll(tmpDir, 'head');

    await expect(
      runReviewDiff({
        baseBranch: 'base-branch',
        scanPath: tmpDir,
        json: false,
        failOnRegression: true,
      }),
    ).rejects.toThrow('process.exit(1)');

    expect(exitCode).toBe(1);
    expect(stdoutOutput).toContain('New Issues:    1');
    expect(stderrOutput).toContain('Regression detected in instruction files');
  });

  it('prints structured delta comparison JSON if json flag is true', async () => {
    await initRepo(tmpDir);
    await writeFiles(tmpDir, { 'CLAUDE.md': '## Rules\nEnsure 2026 guidelines.\n' });
    commitAll(tmpDir, 'base');
    git(['branch', 'base-branch'], tmpDir);

    await writeFiles(tmpDir, { 'CLAUDE.md': '## Rules\nEnsure 2023 compatibility guidelines.\n' });
    commitAll(tmpDir, 'head');

    await runReviewDiff({
      baseBranch: 'base-branch',
      scanPath: tmpDir,
      json: true,
      failOnRegression: false,
    });

    const report = JSON.parse(stdoutOutput);
    expect(report.baseScore).toBeGreaterThan(report.currentScore);
    expect(report.scoreDelta).toBeLessThan(0);
    expect(report.newIssuesCount).toBe(1);
    expect(report.newIssues[0].category).toBe('stale_instruction');
    // Paths are reported against the user's checkout, not the temp worktree.
    expect(report.newIssues[0].filePaths[0]).toContain(tmpDir);
  });

  // BUG-13a: the base side used to be a skeleton directory holding only an
  // allowlist of files, so detectors doing filesystem existence checks saw
  // every referenced source file as missing and fabricated base-side findings.
  it('does not fabricate base-side findings for files the allowlist excluded', async () => {
    await initRepo(tmpDir);
    await writeFiles(tmpDir, {
      // Markdown links to non-markdown sources: present in the repo, but
      // absent from the old base-side skeleton, which only copied an allowlist
      // of files (*.md, package.json, …).
      'CLAUDE.md': '# Rules\n\nSee [the entrypoint](src/index.ts) and [helpers](src/util.ts).\n',
      'src/index.ts': 'export const main = () => 0;\n',
      'src/util.ts': 'export const help = () => 1;\n',
    });
    commitAll(tmpDir, 'base');
    git(['branch', 'base-branch'], tmpDir);

    // An unrelated follow-up commit: the instruction file and the sources it
    // references are byte-identical on both sides.
    await writeFiles(tmpDir, { 'CHANGELOG.md': '# Changelog\n' });
    commitAll(tmpDir, 'head');

    await runReviewDiff({
      baseBranch: 'base-branch',
      scanPath: tmpDir,
      json: true,
      failOnRegression: false,
    });

    const report = JSON.parse(stdoutOutput);
    // Same tree of instruction files and sources on both sides — the dead
    // reference detector must resolve src/index.ts and src/util.ts identically.
    // Against the old skeleton base dir it reported two "Broken file
    // reference" findings that only the head side could resolve, which showed
    // up as a 7-point score jump and two phantom "resolved" issues.
    expect(report.baseScore).toBe(report.currentScore);
    expect(report.newIssuesCount).toBe(0);
    expect(report.resolvedIssuesCount).toBe(0);
    expect(JSON.stringify(report)).not.toContain('Broken file reference');
  });

  // BUG-13b: the base scan hardcoded projectType 'auto' with no include/exclude
  // while the head scan used the project config, so exclusions applied to only
  // one side of the diff.
  it('applies the project config to both sides of the diff', async () => {
    await initRepo(tmpDir);
    await writeFiles(tmpDir, {
      '.promptci/config.json': JSON.stringify({ exclude: ['CLAUDE.md'] }),
      'CLAUDE.md': '## Rules\nEnsure 2023 compatibility guidelines.\n',
    });
    commitAll(tmpDir, 'base');
    git(['branch', 'base-branch'], tmpDir);

    await writeFiles(tmpDir, { 'CLAUDE.md': '## Rules\nEnsure 2026 compatibility guidelines.\n' });
    commitAll(tmpDir, 'head');

    await runReviewDiff({
      baseBranch: 'base-branch',
      scanPath: tmpDir,
      json: true,
      failOnRegression: false,
    });

    const report = JSON.parse(stdoutOutput);
    // CLAUDE.md is excluded on both sides, so its stale-year finding must not
    // show up as "resolved" on the base side only.
    expect(report.newIssuesCount).toBe(0);
    expect(report.resolvedIssuesCount).toBe(0);
  });

  // BUG-13c: the head side scanned the working tree, so uncommitted edits were
  // reported as regressions the branch introduced.
  it('ignores uncommitted working-tree edits by default', async () => {
    await initRepo(tmpDir);
    await writeFiles(tmpDir, { 'CLAUDE.md': '## Rules\nEnsure 2026 compatibility guidelines.\n' });
    commitAll(tmpDir, 'base');
    git(['branch', 'base-branch'], tmpDir);

    // Uncommitted regression: stale year, never committed.
    await writeFiles(tmpDir, { 'CLAUDE.md': '## Rules\nEnsure 2023 compatibility guidelines.\n' });

    await runReviewDiff({
      baseBranch: 'base-branch',
      scanPath: tmpDir,
      json: true,
      failOnRegression: false,
    });

    const report = JSON.parse(stdoutOutput);
    expect(report.newIssuesCount).toBe(0);
    expect(report.scoreDelta).toBe(0);
  });

  it('includes uncommitted edits when --working-tree is passed', async () => {
    await initRepo(tmpDir);
    await writeFiles(tmpDir, { 'CLAUDE.md': '## Rules\nEnsure 2026 compatibility guidelines.\n' });
    commitAll(tmpDir, 'base');
    git(['branch', 'base-branch'], tmpDir);

    await writeFiles(tmpDir, { 'CLAUDE.md': '## Rules\nEnsure 2023 compatibility guidelines.\n' });

    await runReviewDiff({
      baseBranch: 'base-branch',
      scanPath: tmpDir,
      json: true,
      failOnRegression: false,
      workingTree: true,
    });

    const report = JSON.parse(stdoutOutput);
    expect(report.newIssuesCount).toBe(1);
    expect(report.newIssues[0].category).toBe('stale_instruction');
  });

  it('leaves no worktrees behind', async () => {
    await initRepo(tmpDir);
    await writeFiles(tmpDir, { 'CLAUDE.md': '## Rules\nEnsure 2026 compatibility guidelines.\n' });
    commitAll(tmpDir, 'base');
    git(['branch', 'base-branch'], tmpDir);

    await runReviewDiff({
      baseBranch: 'base-branch',
      scanPath: tmpDir,
      json: true,
      failOnRegression: false,
    });

    const worktrees = git(['worktree', 'list'], tmpDir).split('\n').filter(Boolean);
    expect(worktrees).toHaveLength(1);
  });

  // ── --fail-on: absolute severity gate, independent of the regression gate ──

  it('exits 1 when the branch has issues at or above --fail-on, even with no regression', async () => {
    await initRepo(tmpDir);
    await writeFiles(tmpDir, { 'CLAUDE.md': '## Rules\nEnsure 2023 compatibility guidelines.\n' });
    commitAll(tmpDir, 'base');
    git(['branch', 'base-branch'], tmpDir);

    await expect(
      runReviewDiff({
        baseBranch: 'base-branch',
        scanPath: tmpDir,
        json: false,
        // No regression — the finding is inherited from the base — but the
        // absolute threshold is still breached.
        failOnRegression: true,
        failOn: 'warning',
      }),
    ).rejects.toThrow('process.exit(1)');

    expect(exitCode).toBe(1);
    expect(stdoutOutput).toContain('New Issues:    0');
    expect(stderrOutput).toContain('at or above "warning" threshold');
    expect(stderrOutput).not.toContain('Regression detected');
  });

  it('does not exit 1 when no issue reaches the --fail-on threshold', async () => {
    await initRepo(tmpDir);
    await writeFiles(tmpDir, { 'CLAUDE.md': '## Rules\nEnsure 2023 compatibility guidelines.\n' });
    commitAll(tmpDir, 'base');
    git(['branch', 'base-branch'], tmpDir);

    await runReviewDiff({
      baseBranch: 'base-branch',
      scanPath: tmpDir,
      json: false,
      failOnRegression: true,
      failOn: 'critical',
    });

    expect(exitCode).toBeUndefined();
  });

  it('rejects an invalid --fail-on value before scanning', async () => {
    await initRepo(tmpDir);
    await writeFiles(tmpDir, { 'CLAUDE.md': '## Rules\n' });
    commitAll(tmpDir, 'base');

    await expect(
      runReviewDiff({
        baseBranch: 'main',
        scanPath: tmpDir,
        json: false,
        failOnRegression: false,
        failOn: 'blocker' as never,
      }),
    ).rejects.toThrow('process.exit(1)');

    expect(exitCode).toBe(1);
    expect(stderrOutput).toContain('invalid --fail-on value "blocker"');
  });

  it('removes the temporary worktrees even when a gate fails the run', async () => {
    await initRepo(tmpDir);
    await writeFiles(tmpDir, { 'CLAUDE.md': '## Rules\nEnsure 2026 compatibility guidelines.\n' });
    commitAll(tmpDir, 'base');
    git(['branch', 'base-branch'], tmpDir);

    await writeFiles(tmpDir, { 'CLAUDE.md': '## Rules\nEnsure 2023 compatibility guidelines.\n' });
    commitAll(tmpDir, 'head');

    await expect(
      runReviewDiff({
        baseBranch: 'base-branch',
        scanPath: tmpDir,
        json: false,
        failOnRegression: true,
      }),
    ).rejects.toThrow('process.exit(1)');

    const worktrees = git(['worktree', 'list'], tmpDir).split('\n').filter(Boolean);
    expect(worktrees).toHaveLength(1);
  });

  it('points at the fetch fix when the base ref is missing', async () => {
    await initRepo(tmpDir);
    await writeFiles(tmpDir, { 'CLAUDE.md': '## Rules\n' });
    commitAll(tmpDir, 'initial');

    await expect(
      runReviewDiff({
        baseBranch: 'origin/main',
        scanPath: tmpDir,
        json: false,
        failOnRegression: false,
      }),
    ).rejects.toThrow('process.exit(1)');

    expect(stderrOutput).toContain('git fetch origin main');
  });

  it('scans the matching subdirectory on both sides when --path is nested', async () => {
    await initRepo(tmpDir);
    await writeFiles(tmpDir, {
      'README.md': '# Root\n',
      'packages/app/CLAUDE.md': '## Rules\nEnsure 2023 compatibility guidelines.\n',
    });
    commitAll(tmpDir, 'base');
    git(['branch', 'base-branch'], tmpDir);

    await writeFiles(tmpDir, {
      'packages/app/CLAUDE.md': '## Rules\nEnsure 2026 compatibility guidelines.\n',
    });
    commitAll(tmpDir, 'head');

    await runReviewDiff({
      baseBranch: 'base-branch',
      scanPath: path.join(tmpDir, 'packages', 'app'),
      json: true,
      failOnRegression: false,
    });

    const report = JSON.parse(stdoutOutput);
    expect(report.newIssuesCount).toBe(0);
    expect(report.resolvedIssuesCount).toBe(1);
  });

  // #64: base-fetch robustness against a depth-1 (shallow) clone.
  //
  // Reproduces the GitHub Action's environment: actions/checkout does a
  // single-branch, depth-1 fetch of the PR head, so neither origin/main nor the
  // base commit is present locally. The action's fallback fetch (same refspec)
  // must bring in enough for review-diff to compare against origin/main. Uses a
  // real `git clone --depth 1` over a file:// URL — a local-path clone would
  // silently ignore --depth and hardlink the whole history, hiding the bug.
  it('resolves origin/<base> in a depth-1 clone after the fallback fetch (#64)', async () => {
    const originRepo = await makeTempDir();
    const consumer = await makeTempDir();
    try {
      // Origin: main (base, clean) then a feature branch (PR head) that
      // introduces a stale-year regression.
      await initRepo(originRepo);
      await writeFiles(originRepo, { 'CLAUDE.md': '## Rules\nEnsure 2026 compatibility guidelines.\n' });
      commitAll(originRepo, 'base');
      git(['checkout', '-b', 'feature'], originRepo);
      await writeFiles(originRepo, { 'CLAUDE.md': '## Rules\nEnsure 2023 compatibility guidelines.\n' });
      commitAll(originRepo, 'head');
      git(['checkout', 'main'], originRepo);

      // Depth-1, single-branch clone of the head — the actions/checkout default.
      const url = pathToFileURL(originRepo).href;
      git(['clone', '--depth', '1', '--single-branch', '--branch', 'feature', url, consumer], os.tmpdir());

      // Preconditions: the checkout is shallow and origin/main is absent — the
      // exact state that makes the fallback fetch necessary.
      expect(git(['rev-parse', '--is-shallow-repository'], consumer)).toBe('true');
      expect(() => git(['rev-parse', '--verify', 'origin/main^{commit}'], consumer)).toThrow();

      // The action's fallback fetch, byte-for-byte the same refspec as action.yml.
      git(['fetch', '--no-tags', '--prune', 'origin', '+refs/heads/main:refs/remotes/origin/main'], consumer);

      await runReviewDiff({
        baseBranch: 'origin/main',
        scanPath: consumer,
        json: true,
        failOnRegression: false,
      });

      const report = JSON.parse(stdoutOutput);
      // The head's stale year is a regression the base does not have.
      expect(report.newIssuesCount).toBeGreaterThan(0);
    } finally {
      await fs.rm(originRepo, { recursive: true, force: true });
      await fs.rm(consumer, { recursive: true, force: true });
    }
  });

  // #64: the fallback fetch hardcodes the remote name `origin`. actions/checkout
  // always uses `origin`, so this never bites in the action's real environment,
  // but the constraint is worth pinning: a differently named remote makes the
  // origin-targeted fetch fail, and the documented workaround (fetch via the
  // real remote name into refs/remotes/origin/<base>) restores it.
  it('the fallback fetch requires the remote to be named origin (#64 constraint)', async () => {
    const originRepo = await makeTempDir();
    const consumer = await makeTempDir();
    try {
      await initRepo(originRepo);
      await writeFiles(originRepo, { 'CLAUDE.md': '## Rules\nEnsure 2026 compatibility guidelines.\n' });
      commitAll(originRepo, 'base');
      git(['checkout', '-b', 'feature'], originRepo);
      await writeFiles(originRepo, { 'CLAUDE.md': '## Rules\nEnsure 2025 compatibility guidelines.\n' });
      commitAll(originRepo, 'head');
      git(['checkout', 'main'], originRepo);

      const url = pathToFileURL(originRepo).href;
      // Name the remote `upstream`, not `origin`.
      git(['clone', '--depth', '1', '--single-branch', '--branch', 'feature',
        '--origin', 'upstream', url, consumer], os.tmpdir());

      // With no `origin` remote, the action's hardcoded-origin fetch errors.
      expect(() =>
        git(['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'], consumer),
      ).toThrow();

      // Documented workaround: fetch via the actual remote name into the same
      // origin/<base> tracking ref the action compares against.
      git(['fetch', '--no-tags', 'upstream', '+refs/heads/main:refs/remotes/origin/main'], consumer);
      expect(git(['rev-parse', '--verify', 'origin/main^{commit}'], consumer)).toBeTruthy();
    } finally {
      await fs.rm(originRepo, { recursive: true, force: true });
      await fs.rm(consumer, { recursive: true, force: true });
    }
  });
});
