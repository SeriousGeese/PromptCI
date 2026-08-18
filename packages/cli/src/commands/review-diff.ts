import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { scan, filterNewIssues, createBaseline } from '@promptci/core';
import type { IssueSeverity, PromptCiIssue } from '@promptci/core';
import { loadConfig, type CliConfig } from '../config.js';
import { meetsThreshold } from '../summary.js';

const SEVERITY_VALUES: IssueSeverity[] = ['info', 'warning', 'high', 'critical'];

function isValidSeverity(v: string): v is IssueSeverity {
  return (SEVERITY_VALUES as string[]).includes(v);
}

export type ReviewDiffOptions = {
  baseBranch: string;
  scanPath?: string;
  json: boolean;
  failOnRegression: boolean;
  /**
   * Absolute severity gate over the head side, with the same meaning as
   * `scan --fail-on`. Independent of --fail-on-regression: a branch can be
   * regression-free and still sit above the threshold it inherited.
   */
  failOn?: IssueSeverity;
  /**
   * Compare the working tree (including uncommitted edits) instead of the HEAD
   * commit. Useful locally; wrong in CI, where uncommitted noise would be
   * reported as a regression introduced by the PR.
   */
  workingTree?: boolean;
};

/**
 * Runs git with an argument vector — never a shell string. Branch names reach
 * this command from `--base`, and the previous implementation interpolated
 * them into `execSync` strings.
 */
function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

/**
 * Checks out `commit` into a throwaway worktree.
 *
 * This replaces the old approach of copying an allowlist of "scanner-relevant"
 * files into an otherwise empty temp directory. Detectors like
 * dead-references, command-validity and security-pack do live filesystem
 * existence checks against the scan root, so in a skeleton directory nearly
 * every referenced source file looked missing: the base side fabricated
 * findings, which inflated "resolved" and suppressed real "new" — feeding
 * --fail-on-regression, the GitHub Action's headline gate.
 */
function addWorktree(repoRoot: string, commit: string, dir: string): void {
  git(['worktree', 'add', '--detach', dir, commit], repoRoot);
}

/**
 * True when the checkout has no full history (`actions/checkout` default, or
 * `git clone --depth`). Both flavours are reported: `--depth` writes
 * .git/shallow, and a partial clone advertises a promisor filter.
 */
function isShallowClone(repoRoot: string): boolean {
  try {
    return git(['rev-parse', '--is-shallow-repository'], repoRoot) === 'true';
  } catch {
    return false;
  }
}

function removeWorktree(repoRoot: string, dir: string): void {
  try {
    git(['worktree', 'remove', '--force', dir], repoRoot);
  } catch {
    // Fall through to the plain rm below; `worktree prune` cleans the metadata.
  }
}

export async function runReviewDiff(options: ReviewDiffOptions): Promise<void> {
  const rawPath = options.scanPath ?? process.cwd();
  const resolvedPath = path.resolve(rawPath);

  // Validate before the two scans and the temporary worktrees, not after them.
  if (options.failOn !== undefined && !isValidSeverity(options.failOn)) {
    console.error(
      `Error: invalid --fail-on value "${options.failOn}". Must be one of: ${SEVERITY_VALUES.join(', ')}`,
    );
    process.exit(1);
  }

  // 1. Verify git repository and locate its root
  let repoRoot: string;
  try {
    repoRoot = path.resolve(git(['rev-parse', '--show-toplevel'], resolvedPath));
  } catch {
    console.error(`Error: Path "${resolvedPath}" is not inside a git repository, or git is not installed.`);
    process.exit(1);
  }

  // Scanning a subdirectory must scan the matching subdirectory on the base
  // side, not the whole checkout.
  const relFromRoot = path.relative(repoRoot, resolvedPath);

  // 2. Resolve the base ref to a concrete commit
  let baseCommit: string;
  try {
    baseCommit = git(['rev-parse', '--verify', `${options.baseBranch}^{commit}`], repoRoot);
  } catch {
    // The overwhelmingly common cause in CI is a shallow checkout: actions/checkout
    // defaults to fetch-depth 1 and fetches only the PR head, so origin/main does
    // not exist locally. Say so instead of leaving the consumer to guess.
    const shallow = isShallowClone(repoRoot);
    console.error(`Error: Could not resolve base branch/commit "${options.baseBranch}".`);
    if (shallow) {
      console.error(
        'This checkout is shallow, so the base ref is not present locally. ' +
          'In GitHub Actions, use `actions/checkout` with `fetch-depth: 0`; ' +
          'locally, run `git fetch --unshallow`.',
      );
    } else {
      console.error(
        `Fetch it first (e.g. \`git fetch origin ${options.baseBranch.replace(/^origin\//, '')}\`), ` +
          'or pass a ref that exists in this checkout via --base.',
      );
    }
    process.exit(1);
  }

  // 3. Resolve the head side. Default is the HEAD commit — scanning the working
  //    tree made every uncommitted edit look like a regression the PR introduced.
  let headCommit: string | undefined;
  if (!options.workingTree) {
    try {
      headCommit = git(['rev-parse', '--verify', 'HEAD^{commit}'], repoRoot);
    } catch {
      console.error('Error: Could not resolve HEAD. Use --working-tree to compare uncommitted files.');
      process.exit(1);
    }
  }

  // 4. Load the project config ONCE and scan both sides with it. The base scan
  //    used to hardcode projectType 'auto' with no include/exclude while the
  //    head scan used the project config — asymmetric inputs on two sides of a
  //    diff produce differences that are purely configuration artifacts.
  let config: CliConfig;
  try {
    config = await loadConfig(resolvedPath);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const tempParent = await fs.mkdtemp(path.join(os.tmpdir(), 'promptci-review-'));
  const baseWorktree = path.join(tempParent, 'base');
  const headWorktree = path.join(tempParent, 'head');
  const createdWorktrees: string[] = [];

  // Declared outside the try so the gates can fire AFTER the finally has run.
  // process.exit() inside a try skips its finally, so every gated failure used
  // to leave the two temporary worktrees registered in the consumer's repo.
  let failed = false;

  try {
    try {
      addWorktree(repoRoot, baseCommit, baseWorktree);
      createdWorktrees.push(baseWorktree);
      if (headCommit) {
        addWorktree(repoRoot, headCommit, headWorktree);
        createdWorktrees.push(headWorktree);
      }
    } catch (err) {
      console.error(
        `Error: Could not check out a temporary worktree: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      // `return`, not process.exit(): exit() inside the try would skip the
      // finally below, and when the SECOND worktree add is the one that failed
      // the first is already registered — exiting here used to leave it (and
      // the temp directory) behind in the consumer's repository.
      process.exitCode = 1;
      return;
    }

    const baseScanRoot = path.join(baseWorktree, relFromRoot);
    const headScanRoot = headCommit ? path.join(headWorktree, relFromRoot) : resolvedPath;

    const scanOptions = {
      projectType: config.projectType,
      include: config.include,
      exclude: config.exclude,
    };

    const baseReport = await scan({ repoPath: baseScanRoot, ...scanOptions });
    const currentReport = await scan({ repoPath: headScanRoot, ...scanOptions });

    // 5. Compute Deltas
    //
    // Fingerprints include file paths, so both sides must normalise to the
    // same strings. Not every detector reports absolute paths (security-pack
    // emits a bare '.gitignore', for example) — running those through
    // path.relative() resolves them against process.cwd() and produces a
    // different '../..' prefix per scan root, which made identical findings
    // fingerprint differently on the two sides of the diff.
    const toRelative = (filePath: string, rootPath: string): string => {
      const rel = path.isAbsolute(filePath) ? path.relative(rootPath, filePath) : filePath;
      return rel.replace(/\\/g, '/');
    };

    const makeIssuesRelative = (issues: PromptCiIssue[], rootPath: string): PromptCiIssue[] => {
      return issues.map(issue => ({
        ...issue,
        filePaths: issue.filePaths.map(fp => toRelative(fp, rootPath)),
        locations: issue.locations.map(loc => ({
          ...loc,
          filePath: toRelative(loc.filePath, rootPath),
        })),
      }));
    };

    const makeIssuesAbsolute = (issues: PromptCiIssue[], rootPath: string): PromptCiIssue[] => {
      return issues.map(issue => {
        const absoluteFilePaths = issue.filePaths.map(fp => path.resolve(rootPath, fp));
        const absoluteLocations = issue.locations.map(loc => ({
          ...loc,
          filePath: path.resolve(rootPath, loc.filePath),
        }));
        return {
          ...issue,
          filePaths: absoluteFilePaths,
          locations: absoluteLocations,
        };
      });
    };

    const relativeBaseIssues = makeIssuesRelative(baseReport.issues, baseScanRoot);
    const relativeCurrentIssues = makeIssuesRelative(currentReport.issues, headScanRoot);

    const baseScore = baseReport.healthScore;
    const currentScore = currentReport.healthScore;
    const scoreDelta = currentScore - baseScore;

    const baseBaseline = createBaseline(relativeBaseIssues);
    const currentBaseline = createBaseline(relativeCurrentIssues);

    const { newIssues: relativeNewIssues } = filterNewIssues(relativeCurrentIssues, baseBaseline);
    const { newIssues: relativeResolvedIssues } = filterNewIssues(relativeBaseIssues, currentBaseline);

    // Report paths against the user's real checkout, not the temporary worktree.
    const newIssues = makeIssuesAbsolute(relativeNewIssues, resolvedPath);
    const resolvedIssues = makeIssuesAbsolute(relativeResolvedIssues, resolvedPath);

    // 6. Output Results
    if (options.json) {
      const output = {
        baseScore,
        currentScore,
        scoreDelta,
        newIssuesCount: newIssues.length,
        resolvedIssuesCount: resolvedIssues.length,
        newIssues: newIssues.map(i => ({
          id: i.id,
          category: i.category,
          severity: i.severity,
          title: i.title,
          summary: i.summary,
          filePaths: i.filePaths,
          locations: i.locations,
        })),
        resolvedIssues: resolvedIssues.map(i => ({
          id: i.id,
          category: i.category,
          severity: i.severity,
          title: i.title,
        })),
      };
      process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    } else {
      console.log(`PromptCI Branch Review (compared to ${options.baseBranch})`);
      console.log('--------------------------------------------------');

      let scoreColor = '\x1b[32m'; // green
      if (scoreDelta < 0) scoreColor = '\x1b[31m'; // red
      else if (scoreDelta === 0) scoreColor = '\x1b[0m'; // normal

      console.log(`Health Score:  ${baseScore} -> ${currentScore} (${scoreColor}${scoreDelta >= 0 ? '+' : ''}${scoreDelta}\x1b[0m points)`);
      console.log(`New Issues:    ${newIssues.length}`);
      console.log(`Resolved:      ${resolvedIssues.length}`);

      if (newIssues.length > 0) {
        console.log('\n[+] New Issues:');
        for (const issue of newIssues) {
          const locStr = issue.locations.length > 0
            ? `${issue.locations[0].filePath}:${issue.locations[0].startLine ?? ''}`
            : issue.filePaths.join(', ');

          const sevColor = issue.severity === 'critical' || issue.severity === 'high' ? '\x1b[31m' : '\x1b[33m';
          console.log(`  - ${sevColor}${issue.severity.toUpperCase()}\x1b[0m: ${issue.title} (${locStr})`);
          console.log(`    Summary:   ${issue.summary}`);
          console.log(`    Recommend: ${issue.recommendation}`);
        }
      }

      if (resolvedIssues.length > 0) {
        console.log('\n[-] Resolved Issues:');
        for (const issue of resolvedIssues) {
          console.log(`  - \x1b[32mRESOLVED\x1b[0m: ${issue.title}`);
        }
      }
    }

    // 7. Exit Code Enforcement
    //
    // The two gates are independent and both are evaluated: a branch that
    // introduces no regression can still carry pre-existing issues above the
    // --fail-on threshold, and the GitHub Action passes both at once.
    if (options.failOnRegression && (scoreDelta < 0 || newIssues.length > 0)) {
      failed = true;
      if (!options.json) {
        console.error('\n\x1b[31mFailed: Regression detected in instruction files.\x1b[0m');
      }
    }

    const failOn = options.failOn;
    if (failOn) {
      const matching = currentReport.issues.filter(i => meetsThreshold(i.severity, failOn)).length;
      if (matching > 0) {
        failed = true;
        if (!options.json) {
          console.error(
            `\n\x1b[31mFailed: ${matching} issue(s) at or above "${failOn}" threshold ` +
              `on this branch.\x1b[0m`,
          );
        }
      }
    }

  } finally {
    // 8. Clean up worktrees and the temp directory
    for (const dir of createdWorktrees) {
      removeWorktree(repoRoot, dir);
    }
    try {
      await fs.rm(tempParent, { recursive: true, force: true });
    } catch {
      // ignore
    }
    try {
      git(['worktree', 'prune'], repoRoot);
    } catch {
      // ignore
    }
  }

  // Gates fire only after cleanup has run.
  if (failed) {
    process.exit(1);
  }
}
