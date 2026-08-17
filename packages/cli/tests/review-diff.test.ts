import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { runReviewDiff } from '../src/commands/review-diff.js';

vi.mock('node:child_process');

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'promptci-review-test-'));
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

    // Create default config in temp dir
    const configDir = path.join(tmpDir, '.promptci');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'config.json'),
      JSON.stringify({ severityThreshold: 'info', projectType: 'auto' }),
      'utf-8'
    );

    // Spy on process.exit
    vi.spyOn(process, 'exit').mockImplementation((code?: number | string) => {
      exitCode = typeof code === 'number' ? code : 0;
      throw new Error(`process.exit(${code})`);
    });

    // Spy on consoles
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
    vi.mocked(execSync).mockImplementation((() => {
      throw new Error('Not a git repository');
    }) as unknown as typeof execSync);

    await expect(runReviewDiff({ baseBranch: 'main', scanPath: tmpDir, json: false, failOnRegression: false }))
      .rejects.toThrow('process.exit(1)');

    expect(exitCode).toBe(1);
    expect(stderrOutput).toContain('not inside a git repository');
  });

  it('identifies resolved issues and reports score improvements', async () => {
    // Base CLAUDE.md has stale year 2023 (1 warning issue)
    // Current CLAUDE.md has current year 2026 (0 issues)
    await fs.writeFile(
      path.join(tmpDir, 'CLAUDE.md'),
      '## Rules\nEnsure 2026 compatibility guidelines.\n',
      'utf-8'
    );

    vi.mocked(execSync).mockImplementation(((cmd: string, options?: { encoding?: string }) => {
      const encoding = options?.encoding;
      if (cmd.includes('rev-parse')) {
        return encoding === 'utf8' ? 'true\n' : Buffer.from('true\n');
      }
      if (cmd.includes('ls-tree')) {
        return encoding === 'utf8' ? 'CLAUDE.md\n.promptci/config.json\n' : Buffer.from('CLAUDE.md\n.promptci/config.json\n');
      }
      if (cmd.includes('show main:CLAUDE.md')) {
        const content = '## Rules\nEnsure 2023 compatibility guidelines.\n';
        return encoding === 'utf8' ? content : Buffer.from(content);
      }
      if (cmd.includes('show main:.promptci/config.json')) {
        const content = JSON.stringify({ severityThreshold: 'info', projectType: 'auto' });
        return encoding === 'utf8' ? content : Buffer.from(content);
      }
      return encoding === 'utf8' ? 'success' : Buffer.from('success');
    }) as unknown as typeof execSync);

    await runReviewDiff({ baseBranch: 'main', scanPath: tmpDir, json: false, failOnRegression: false });

    expect(stdoutOutput).toContain('Health Score:');
    expect(stdoutOutput).toContain('New Issues:    0');
    expect(stdoutOutput).toContain('Resolved:      1');
    expect(stdoutOutput).toContain('RESOLVED');
    expect(stdoutOutput).toContain('Instruction may reference outdated content');
  });

  it('identifies regressions (new issues) and exits 1 if failOnRegression is true', async () => {
    // Base CLAUDE.md has 2026 (0 issues)
    // Current CLAUDE.md has stale year 2023 (1 warning issue)
    await fs.writeFile(
      path.join(tmpDir, 'CLAUDE.md'),
      '## Rules\nEnsure 2023 compatibility guidelines.\n',
      'utf-8'
    );

    vi.mocked(execSync).mockImplementation(((cmd: string, options?: { encoding?: string }) => {
      const encoding = options?.encoding;
      if (cmd.includes('rev-parse')) {
        return encoding === 'utf8' ? 'true\n' : Buffer.from('true\n');
      }
      if (cmd.includes('ls-tree')) {
        return encoding === 'utf8' ? 'CLAUDE.md\n.promptci/config.json\n' : Buffer.from('CLAUDE.md\n.promptci/config.json\n');
      }
      if (cmd.includes('show main:CLAUDE.md')) {
        const content = '## Rules\nEnsure 2026 compatibility guidelines.\n';
        return encoding === 'utf8' ? content : Buffer.from(content);
      }
      if (cmd.includes('show main:.promptci/config.json')) {
        const content = JSON.stringify({ severityThreshold: 'info', projectType: 'auto' });
        return encoding === 'utf8' ? content : Buffer.from(content);
      }
      return encoding === 'utf8' ? 'success' : Buffer.from('success');
    }) as unknown as typeof execSync);

    await expect(
      runReviewDiff({ baseBranch: 'main', scanPath: tmpDir, json: false, failOnRegression: true })
    ).rejects.toThrow('process.exit(1)');

    expect(exitCode).toBe(1);
    expect(stdoutOutput).toContain('New Issues:    1');
    expect(stderrOutput).toContain('Regression detected in instruction files');
  });

  it('prints structured delta comparison JSON if json flag is true', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'CLAUDE.md'),
      '## Rules\nEnsure 2023 compatibility guidelines.\n',
      'utf-8'
    );

    vi.mocked(execSync).mockImplementation(((cmd: string, options?: { encoding?: string }) => {
      const encoding = options?.encoding;
      if (cmd.includes('rev-parse')) {
        return encoding === 'utf8' ? 'true\n' : Buffer.from('true\n');
      }
      if (cmd.includes('ls-tree')) {
        return encoding === 'utf8' ? 'CLAUDE.md\n.promptci/config.json\n' : Buffer.from('CLAUDE.md\n.promptci/config.json\n');
      }
      if (cmd.includes('show main:CLAUDE.md')) {
        const content = '## Rules\nEnsure 2026 guidelines.\n';
        return encoding === 'utf8' ? content : Buffer.from(content);
      }
      if (cmd.includes('show main:.promptci/config.json')) {
        const content = JSON.stringify({ severityThreshold: 'info', projectType: 'auto' });
        return encoding === 'utf8' ? content : Buffer.from(content);
      }
      return encoding === 'utf8' ? 'success' : Buffer.from('success');
    }) as unknown as typeof execSync);

    await runReviewDiff({ baseBranch: 'main', scanPath: tmpDir, json: true, failOnRegression: false });

    const report = JSON.parse(stdoutOutput);
    expect(report.baseScore).toBeGreaterThan(report.currentScore);
    expect(report.scoreDelta).toBeLessThan(0);
    expect(report.newIssuesCount).toBe(1);
    expect(report.newIssues[0].category).toBe('stale_instruction');
  });
});
