import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runReviewDiff } from '../src/commands/review-diff.js';

/**
 * pcic-1ik0.3 follow-up: a pull request that pins one of several actions, or
 * adds one agent-practice rule, improves a grouped finding. `review-diff
 * --fail-on-regression` (the GitHub Action's gate) must not read that as a new
 * finding. Real git repositories, like review-diff.test.ts.
 */

const SHA = '0123456789abcdef0123456789abcdef01234567';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim();
}

async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf-8');
  }
}

function commitAll(dir: string, message: string): void {
  git(['add', '-A'], dir);
  git(['commit', '-m', message, '--no-verify'], dir);
}

const workflow = (...uses: string[]) =>
  ['jobs:', '  t:', '    runs-on: ubuntu-latest', '    steps:', ...uses.map((u) => `      - uses: ${u}`)].join('\n') + '\n';

describe('review-diff --fail-on-regression and grouped findings', () => {
  let tmpDir: string;
  let exitCode: number | undefined;
  let stdout: string;

  beforeEach(async () => {
    tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'promptci-review-grouped-')));
    exitCode = undefined;
    stdout = '';
    vi.spyOn(process, 'exit').mockImplementation((code?: number | string) => {
      exitCode = typeof code === 'number' ? code : 0;
      throw new Error(`process.exit(${code})`);
    });
    vi.spyOn(console, 'log').mockImplementation((...msg) => {
      stdout += msg.join(' ') + '\n';
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    });
    git(['init', '--initial-branch=main'], tmpDir);
    git(['config', 'user.email', 'test@example.com'], tmpDir);
    git(['config', 'user.name', 'PromptCI Test'], tmpDir);
    git(['config', 'commit.gpgsign', 'false'], tmpDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function reviewChange(base: Record<string, string>, head: Record<string, string>): Promise<void> {
    await writeFiles(tmpDir, base);
    commitAll(tmpDir, 'base');
    git(['branch', 'base-branch'], tmpDir);
    await writeFiles(tmpDir, head);
    commitAll(tmpDir, 'head');
    await runReviewDiff({ baseBranch: 'base-branch', scanPath: tmpDir, json: false, failOnRegression: true });
  }

  it('passes when the head pins one of two unpinned actions', async () => {
    await reviewChange(
      { 'AGENTS.md': '# Rules\nUse TypeScript.\n', '.github/workflows/ci.yml': workflow('a/one@v1', 'b/two@v2') },
      { '.github/workflows/ci.yml': workflow(`a/one@${SHA}`, 'b/two@v2') },
    );
    expect(exitCode).toBeUndefined();
    expect(stdout).toContain('New Issues:    0');
  });

  it('passes when the head adds one agent-practice rule', async () => {
    await reviewChange(
      { 'AGENTS.md': '# Rules\nUse TypeScript.\n' },
      { 'AGENTS.md': '# Rules\nUse TypeScript.\nIf you are unsure, ask before proceeding.\n' },
    );
    expect(exitCode).toBeUndefined();
    expect(stdout).toContain('New Issues:    0');
  });
});
