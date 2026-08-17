import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runFix } from '../src/commands/fix.js';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'promptci-fix-test-'));
}

describe('runFix CLI command', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    // Create default .promptci config
    const configDir = path.join(tmpDir, '.promptci');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'config.json'),
      JSON.stringify({ severityThreshold: 'info', projectType: 'auto' }),
      'utf-8'
    );
    // Write a dummy instruction file to enable scanning detectors
    await fs.writeFile(path.join(tmpDir, 'CLAUDE.md'), '## Rules\n', 'utf-8');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('automatically applies missing .promptci/ gitignore fix in non-interactive mode', async () => {
    const gitignorePath = path.join(tmpDir, '.gitignore');
    await fs.writeFile(gitignorePath, 'node_modules/\n', 'utf-8');

    await runFix({ scanPath: tmpDir, interactive: false });

    const content = await fs.readFile(gitignorePath, 'utf-8');
    expect(content).toContain('.promptci/');
    expect(content).toContain('node_modules/');
  });

  it('automatically ignores unignored output directories in non-interactive mode', async () => {
    const gitignorePath = path.join(tmpDir, '.gitignore');
    await fs.writeFile(gitignorePath, 'node_modules/\n', 'utf-8');

    // Create unignored dir (e.g. dist)
    const distPath = path.join(tmpDir, 'dist');
    await fs.mkdir(distPath, { recursive: true });

    await runFix({ scanPath: tmpDir, interactive: false });

    const content = await fs.readFile(gitignorePath, 'utf-8');
    expect(content).toContain('dist/');
  });

  // BUG-14: stale-year findings are advisory. `fix` used to blind-substitute
  // every matched year with the current one, which corrupted copyright lines,
  // release dates, and version pins indiscriminately.
  it('does not rewrite years in instruction files — stale findings are advisory', async () => {
    const claudeMdPath = path.join(tmpDir, 'CLAUDE.md');
    const original =
      '## Coding Rules\n' +
      'Follow guidelines for the 2023 release cycle.\n' +
      '\n' +
      'Copyright 2021 Example Corp. Shipped in 2020.\n';
    await fs.writeFile(claudeMdPath, original, 'utf-8');

    await runFix({ scanPath: tmpDir, interactive: false });

    const content = await fs.readFile(claudeMdPath, 'utf-8');
    expect(content).toBe(original);
  });

  it('consolidates duplicate sections across files, replacing secondary sections with links', async () => {
    const agentsPath = path.join(tmpDir, 'AGENTS.md');
    const claudePath = path.join(tmpDir, 'CLAUDE.md');

    const duplicateBody = 
      '## Testing Conventions\n' +
      'Run all tests before saying work is done. Ensure coverage matches or exceeds 80%.\n' +
      'Always document design constraints in the codebase.\n';

    await fs.writeFile(agentsPath, duplicateBody, 'utf-8');
    await fs.writeFile(claudePath, duplicateBody, 'utf-8');

    await runFix({ scanPath: tmpDir, interactive: false });

    const agentsContent = await fs.readFile(agentsPath, 'utf-8');
    const claudeContent = await fs.readFile(claudePath, 'utf-8');

    // Canonical (AGENTS.md) should remain fully intact
    expect(agentsContent).toContain('Run all tests before saying work is done.');
    
    // Non-canonical (CLAUDE.md) should be replaced with a markdown link pointer
    expect(claudeContent).toContain('See canonical instructions in [AGENTS.md]');
    expect(claudeContent).toContain('./AGENTS.md');
    expect(claudeContent).not.toContain('Ensure coverage matches or exceeds 80%.');
  });

  it('prompts user in interactive mode and applies changes on confirmation', async () => {
    const gitignorePath = path.join(tmpDir, '.gitignore');
    await fs.writeFile(gitignorePath, 'node_modules/\n', 'utf-8');

    // Answer 'y' (yes)
    await runFix({ scanPath: tmpDir, interactive: true, answers: ['y'] });

    const content = await fs.readFile(gitignorePath, 'utf-8');
    expect(content).toContain('.promptci/');
  });

  it('prompts user in interactive mode and skips changes on rejection', async () => {
    const gitignorePath = path.join(tmpDir, '.gitignore');
    await fs.writeFile(gitignorePath, 'node_modules/\n', 'utf-8');

    // Answer 'n' (no)
    await runFix({ scanPath: tmpDir, interactive: true, answers: ['n'] });

    const content = await fs.readFile(gitignorePath, 'utf-8');
    expect(content).toBe('node_modules/\n');
  });

  it('does not modify files when --dry-run is specified', async () => {
    const gitignorePath = path.join(tmpDir, '.gitignore');
    await fs.writeFile(gitignorePath, 'node_modules/\n', 'utf-8');

    await runFix({ scanPath: tmpDir, dryRun: true });

    const content = await fs.readFile(gitignorePath, 'utf-8');
    expect(content).toBe('node_modules/\n');
  });

  describe('LLM fix support', () => {
    let exitCode: number | undefined;
    let originalEnv: Record<string, string | undefined>;

    beforeEach(() => {
      exitCode = undefined;
      originalEnv = { ...process.env };
      process.env.OPENAI_API_KEY = 'mock-openai';
      vi.spyOn(process, 'exit').mockImplementation((code?: number | string) => {
        exitCode = typeof code === 'number' ? code : 0;
        throw new Error(`process.exit(${code})`);
      });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
      process.env = originalEnv;
    });

    it('fails if llm is true but no issueId is specified', async () => {
      await expect(runFix({ scanPath: tmpDir, llm: true })).rejects.toThrow('process.exit(1)');
      expect(exitCode).toBe(1);
    });

    it('successfully applies vague guidance fix using mocked OpenAI fetch call', async () => {
      // Set up a vague guidance file
      const claudeMdPath = path.join(tmpDir, 'CLAUDE.md');
      await fs.writeFile(
        claudeMdPath,
        '# Coding Guidelines\nEnsure you write clean code.\n',
        'utf-8'
      );

      const { scan } = await import('@promptci/core');
      const report = await scan({ repoPath: tmpDir });
      const vagueIssue = report.issues.find(i => i.category === 'vague_guidance');
      expect(vagueIssue).toBeDefined();

      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    changes: [
                      {
                        filePath: 'CLAUDE.md',
                        newSection: '# Coding Guidelines\nFollow all project rules and verify with tests.\n'
                      }
                    ]
                  })
                }
              }
            ]
          }),
        } as Response;
      });

      await runFix({
        scanPath: tmpDir,
        llm: true,
        issueId: vagueIssue!.id,
        interactive: true,
        answers: ['y']
      });

      const updatedContent = await fs.readFile(claudeMdPath, 'utf-8');
      expect(updatedContent).toContain('Follow all project rules and verify with tests.');
      expect(updatedContent).not.toContain('Ensure you write clean code.');
    });

    it('blocks edits to non-instruction files', async () => {
      const claudeMdPath = path.join(tmpDir, 'CLAUDE.md');
      await fs.writeFile(
        claudeMdPath,
        '# Coding Guidelines\nEnsure you write clean code.\n',
        'utf-8'
      );

      const { scan } = await import('@promptci/core');
      const report = await scan({ repoPath: tmpDir });
      const vagueIssue = report.issues.find(i => i.category === 'vague_guidance');
      expect(vagueIssue).toBeDefined();

      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    changes: [
                      {
                        filePath: 'package.json', // Not allowed!
                        newSection: '{}'
                      }
                    ]
                  })
                }
              }
            ]
          }),
        } as Response;
      });

      await expect(
        runFix({
          scanPath: tmpDir,
          llm: true,
          issueId: vagueIssue!.id,
          interactive: true,
          answers: ['y']
        })
      ).rejects.toThrow('Safety Guard: Editing non-instruction file "package.json" is blocked.');
    });
  });
});
