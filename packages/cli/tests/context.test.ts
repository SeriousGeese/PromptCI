import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'promptci-context-cli-test-'));
}

describe('runContextAnalyze', () => {
  let tmpDir: string;
  let stdoutOutput: string;
  let exitCode: number | undefined;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    stdoutOutput = '';
    exitCode = undefined;

    vi.spyOn(process, 'exit').mockImplementation((code?: number | string) => {
      exitCode = typeof code === 'number' ? code : 0;
      throw new Error(`process.exit(${code})`);
    });

    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutOutput += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    });

    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('prints deterministic context analysis without writing scan reports', async () => {
    await fs.writeFile(path.join(tmpDir, 'AGENTS.md'), '# Rules\nRun pnpm test.', 'utf-8');
    await fs.writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ packageManager: 'pnpm@9.15.9', scripts: { test: 'vitest run' } }),
      'utf-8',
    );

    const { runContextAnalyze } = await import('../src/commands/context.js');
    await runContextAnalyze({ scanPath: tmpDir });

    const reportExists = await fs.access(path.join(tmpDir, '.promptci', 'report.json')).then(() => true).catch(() => false);
    expect(stdoutOutput).toContain('Context analysis complete');
    expect(stdoutOutput).toContain('Package manager: pnpm');
    expect(reportExists).toBe(false);
  });

  it('prints JSON analysis when requested', async () => {
    await fs.writeFile(path.join(tmpDir, 'AGENTS.md'), '# Rules\nRun pnpm test.', 'utf-8');

    const { runContextAnalyze } = await import('../src/commands/context.js');
    await runContextAnalyze({ scanPath: tmpDir, json: true });

    const parsed = JSON.parse(stdoutOutput) as { metrics: { instructionFileCount: number } };
    expect(parsed.metrics.instructionFileCount).toBe(1);
  });

  it('exits non-zero when path does not exist', async () => {
    const { runContextAnalyze } = await import('../src/commands/context.js');
    let threw = false;
    try {
      await runContextAnalyze({ scanPath: path.join(tmpDir, 'missing') });
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    expect(exitCode).toBe(1);
  });
});

describe('runContextOptimize', () => {
  let tmpDir: string;
  let stdoutOutput: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    stdoutOutput = '';

    vi.spyOn(process, 'exit').mockImplementation((code?: number | string) => {
      throw new Error(`process.exit(${code})`);
    });

    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutOutput += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    });

    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('prints message when no cache optimization changes needed', async () => {
    await fs.writeFile(path.join(tmpDir, 'AGENTS.md'), '# Rules\nAlways use strict typing.', 'utf-8');

    const { runContextOptimize } = await import('../src/commands/context.js');
    await runContextOptimize({ scanPath: tmpDir });

    expect(stdoutOutput).toContain('No cache optimization changes needed.');
  });

  it('outputs a diff of proposed changes in dry-run mode without modifying files', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'AGENTS.md'),
      '# Rules\n\n## Tasks\nCurrent Branch: main\nActive Task: caching',
      'utf-8'
    );

    const { runContextOptimize } = await import('../src/commands/context.js');
    await runContextOptimize({ scanPath: tmpDir, dryRun: true });

    expect(stdoutOutput).toContain('Proposed caching optimization changes');
    expect(stdoutOutput).toContain('[Dry Run] Simulating optimization for');

    // original file should not have been updated on disk
    const content = await fs.readFile(path.join(tmpDir, 'AGENTS.md'), 'utf-8');
    expect(content).toContain('Current Branch: main');

    // no new Docs directory or files should be created
    const docsFileExists = await fs.access(path.join(tmpDir, 'Docs', 'tasks.md')).then(() => true).catch(() => false);
    expect(docsFileExists).toBe(false);
  });

  it('applies optimization changes to files on disk when dry-run is false', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'AGENTS.md'),
      '# Rules\n\n## Tasks\nCurrent Branch: main\nActive Task: caching',
      'utf-8'
    );

    const { runContextOptimize } = await import('../src/commands/context.js');
    await runContextOptimize({ scanPath: tmpDir, dryRun: false });

    expect(stdoutOutput).toContain('Applying caching optimization changes');
    expect(stdoutOutput).toContain('Applied change to');

    // original file should have been modified
    const origContent = await fs.readFile(path.join(tmpDir, 'AGENTS.md'), 'utf-8');
    expect(origContent).not.toContain('Current Branch: main');
    expect(origContent).toContain('For details, see [Docs/tasks.md](Docs/tasks.md).');

    // new file should be created
    const newContent = await fs.readFile(path.join(tmpDir, 'Docs', 'tasks.md'), 'utf-8');
    expect(newContent).toContain('# Tasks');
    expect(newContent).toContain('Current Branch: main');
  });
});
