import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runUpdate } from '../src/commands/update.js';
import * as globalConfig from '../src/global-config.js';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

vi.mock('../src/global-config.js');
vi.mock('node:child_process');
vi.mock('node:fs/promises');

describe('runUpdate', () => {
  let exitCode: number | undefined;
  let stdoutOutput: string;
  let stderrOutput: string;

  beforeEach(() => {
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

    vi.mocked(globalConfig.readGlobalConfig).mockResolvedValue({});
    vi.mocked(globalConfig.writeGlobalConfig).mockResolvedValue(undefined as unknown as void);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fails and exits 1 if source directory is not configured', async () => {
    await expect(runUpdate({})).rejects.toThrow('process.exit(1)');
    expect(exitCode).toBe(1);
    expect(stderrOutput).toContain('PromptCI source directory not configured');
  });

  it('fails and exits 1 if source directory does not contain pnpm-workspace.yaml', async () => {
    vi.mocked(fs.access).mockRejectedValue(new Error('no access'));

    await expect(runUpdate({ source: '/invalid-path' })).rejects.toThrow('process.exit(1)');
    expect(exitCode).toBe(1);
    expect(stderrOutput).toContain('Directory does not look like the PromptCI repo');
  });

  it('runs update steps successfully and repairs bin dir if necessary', async () => {
    vi.mocked(fs.access).mockResolvedValue(undefined);

    const execCommands: string[] = [];
    vi.mocked(execSync).mockImplementation(((cmd: string) => {
      execCommands.push(cmd);
      if (cmd === 'pnpm config get global-bin-dir') {
        return Buffer.from('/configured/bin');
      }
      if (cmd === 'where pnpm' || cmd === 'which pnpm') {
        return Buffer.from('/configured/bin/pnpm');
      }
      return Buffer.from('success');
    }) as unknown as typeof execSync);

    // Mock PATH to contain the global bin dir so no repair trigger runs
    const origPath = process.env.PATH;
    process.env.PATH = `/configured/bin${path.delimiter}/other/paths`;

    try {
      await runUpdate({ source: '/repo' });
    } finally {
      process.env.PATH = origPath;
    }

    expect(globalConfig.writeGlobalConfig).toHaveBeenCalledWith(
      expect.objectContaining({ sourceDir: path.resolve('/repo') })
    );

    expect(execCommands).toContain('git pull origin main');
    expect(execCommands).toContain('pnpm install');
    expect(execCommands).toContain('pnpm build');
    expect(execCommands).toContain('pnpm link --global');
    expect(stdoutOutput).toContain('updated successfully');
  });

  it('fails update and exits 1 if an execSync step fails', async () => {
    vi.mocked(fs.access).mockResolvedValue(undefined);

    vi.mocked(execSync).mockImplementation(((cmd: string) => {
      if (cmd === 'pnpm config get global-bin-dir') {
        return Buffer.from('/some/bin');
      }
      if (cmd.startsWith('git pull')) {
        throw new Error('git error');
      }
      return Buffer.from('success');
    }) as unknown as typeof execSync);

    await expect(runUpdate({ source: '/repo' })).rejects.toThrow('process.exit(1)');
    expect(exitCode).toBe(1);
    expect(stdoutOutput).toContain('FAILED');
    expect(stderrOutput).toContain('Update failed at: git pull');
  });
});
