import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runExplain } from '../src/commands/explain.js';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'promptci-explain-test-'));
}

describe('promptci explain CLI command', () => {
  let tmpDir: string;
  let stdoutOutput: string;
  let stderrOutput: string;
  let exitCode: number | undefined;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    stdoutOutput = '';
    stderrOutput = '';
    exitCode = undefined;
    originalEnv = { ...process.env };

    // Set up a basic instruction file with vague guidance to trigger issues
    await fs.writeFile(
      path.join(tmpDir, 'CLAUDE.md'),
      '# Guidance\nEnsure you write clean code at all times.\n',
      'utf-8'
    );

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

    vi.spyOn(console, 'warn').mockImplementation((...msg) => {
      stderrOutput += msg.join(' ') + '\n';
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.env = originalEnv;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('fails and exits 1 if neither OpenAI nor Anthropic API key is set', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    let errorThrown = false;
    try {
      await runExplain({ scanPath: tmpDir });
    } catch {
      errorThrown = true;
    }

    expect(errorThrown).toBe(true);
    expect(exitCode).toBe(1);
    expect(stderrOutput).toContain('Please set OPENAI_API_KEY or ANTHROPIC_API_KEY to use this feature.');
  });

  it('sends metadata and prints explanation plan using OpenAI model', async () => {
    process.env.OPENAI_API_KEY = 'mock-openai-key';
    delete process.env.ANTHROPIC_API_KEY;

    let lastFetchUrl = '';
    let lastFetchOptions: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      lastFetchUrl = String(url);
      lastFetchOptions = init;
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: '1. Replace vague rules\n2. Fix formatting\n3. Consolidate sections\n',
              },
            },
          ],
        }),
      } as Response;
    });

    await runExplain({ scanPath: tmpDir });

    expect(lastFetchUrl).toBe('https://api.openai.com/v1/chat/completions');
    expect(lastFetchOptions.headers['Authorization']).toBe('Bearer mock-openai-key');

    const body = JSON.parse(lastFetchOptions.body);
    expect(body.model).toBe('gpt-4o');
    // Ensure no file content was sent in the prompt
    expect(body.messages[1].content).not.toContain('Ensure you write clean code');
    expect(body.messages[1].content).toContain('vague_guidance');

    expect(stderrOutput).toContain('Warning: PromptCI is sending scan results metadata');
    expect(stdoutOutput).toContain('PromptCI LLM Cleanup Roadmap:');
    expect(stdoutOutput).toContain('Replace vague rules');
  });

  it('sends metadata and prints explanation plan using Anthropic model', async () => {
    delete process.env.OPENAI_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'mock-anthropic-key';

    let lastFetchUrl = '';
    let lastFetchOptions: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      lastFetchUrl = String(url);
      lastFetchOptions = init;
      return {
        ok: true,
        json: async () => ({
          content: [
            {
              type: 'text',
              text: '1. Update framework references\n2. Add build instruction\n',
            },
          ],
        }),
      } as Response;
    });

    await runExplain({ scanPath: tmpDir });

    expect(lastFetchUrl).toBe('https://api.anthropic.com/v1/messages');
    expect(lastFetchOptions.headers['x-api-key']).toBe('mock-anthropic-key');

    const body = JSON.parse(lastFetchOptions.body);
    expect(body.model).toBe('claude-3-5-sonnet-latest');
    expect(body.messages[0].content).not.toContain('Ensure you write clean code');
    expect(body.messages[0].content).toContain('vague_guidance');

    expect(stdoutOutput).toContain('PromptCI LLM Cleanup Roadmap:');
    expect(stdoutOutput).toContain('Update framework references');
  });
});
