import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runDoctor, MIN_NODE_MAJOR } from '../src/commands/doctor.js';
import * as authConfig from '../src/auth-config.js';
import * as globalConfig from '../src/global-config.js';

vi.mock('../src/auth-config.js');
vi.mock('../src/global-config.js');

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'promptci-doctor-test-'));
}

describe('promptci doctor CLI command', () => {
  let tmpDir: string;
  let stdoutOutput: string;
  let stderrOutput: string;
  let exitCode: number | undefined;
  let originalVersions: typeof process.versions;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    stdoutOutput = '';
    stderrOutput = '';
    exitCode = undefined;
    originalVersions = { ...process.versions };
    originalEnv = { ...process.env };

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

    vi.mocked(authConfig.readAuthConfig).mockResolvedValue({});
    vi.mocked(authConfig.getAuthToken).mockResolvedValue(null);
    // No dashboard URL unless a test configures one — doctor must not phone home.
    vi.mocked(globalConfig.readGlobalConfig).mockResolvedValue({});
    delete process.env.PROMPTCI_API_URL;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    Object.defineProperty(process, 'versions', {
      value: originalVersions,
      configurable: true,
    });
    process.env = originalEnv;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('passes cleanly when Node version, config, gitignore, and keys are configured', async () => {
    // 1. Set up Node version to 22
    Object.defineProperty(process, 'versions', {
      value: { node: '22.0.0' },
      configurable: true,
    });

    // 2. Set up valid config
    const configDir = path.join(tmpDir, '.promptci');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'config.json'),
      JSON.stringify({ severityThreshold: 'warning', projectType: 'typescript' }),
      'utf-8'
    );

    // 3. Set up gitignore containing .promptci/
    await fs.writeFile(path.join(tmpDir, '.gitignore'), 'node_modules/\n.promptci/\n', 'utf-8');

    // 4. Set up mock env keys and auth
    process.env.OPENAI_API_KEY = 'mock-key';
    process.env.PROMPTCI_API_URL = 'https://dashboard.promptci.test';

    // Mock global fetch
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return { ok: true } as Response;
    });

    await runDoctor({ scanPath: tmpDir });

    expect(stdoutOutput).toContain(`Node.js version >= ${MIN_NODE_MAJOR}`);
    // Item 7: doctor reports the RUNNING CLI version (from its own package.json),
    // not whatever a globally-linked `promptci` on PATH resolves to.
    expect(stdoutOutput).toMatch(/PromptCI CLI version \(running\): \d+\.\d+\.\d+/);
    expect(stdoutOutput).toContain('Config file schema: Valid configuration file found');
    expect(stdoutOutput).toContain('Gitignore protection: .promptci/ is ignored in .gitignore');
    expect(stdoutOutput).toContain('LLM API Keys: Configured');
    expect(stdoutOutput).toContain('Diagnostics passed: Local setup is healthy!');
  });

  it(`fails if Node.js version is < ${MIN_NODE_MAJOR}`, async () => {
    Object.defineProperty(process, 'versions', {
      value: { node: `${MIN_NODE_MAJOR - 1}.0.0` },
      configurable: true,
    });

    // Valid config
    const configDir = path.join(tmpDir, '.promptci');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'config.json'),
      JSON.stringify({ severityThreshold: 'warning' }),
      'utf-8'
    );
    await fs.writeFile(path.join(tmpDir, '.gitignore'), '.promptci/\n', 'utf-8');

    let errorThrown = false;
    try {
      await runDoctor({ scanPath: tmpDir });
    } catch {
      errorThrown = true;
    }

    expect(errorThrown).toBe(true);
    expect(exitCode).toBe(1);
    expect(stdoutOutput).toContain('Node.js version is too old');
    expect(stderrOutput).toContain('Diagnostics failed: Critical configuration issues detected.');
  });

  it('fails if .promptci/config.json is invalid JSON', async () => {
    Object.defineProperty(process, 'versions', {
      value: { node: '22.0.0' },
      configurable: true,
    });

    // Invalid config file
    const configDir = path.join(tmpDir, '.promptci');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(configDir, 'config.json'), '{ invalid json }', 'utf-8');
    await fs.writeFile(path.join(tmpDir, '.gitignore'), '.promptci/\n', 'utf-8');

    let errorThrown = false;
    try {
      await runDoctor({ scanPath: tmpDir });
    } catch {
      errorThrown = true;
    }

    expect(errorThrown).toBe(true);
    expect(exitCode).toBe(1);
    expect(stdoutOutput).toContain('Config file schema: Invalid configuration');
    expect(stderrOutput).toContain('Diagnostics failed: Critical configuration issues detected.');
  });

  it('fails if .promptci/ is not ignored in .gitignore', async () => {
    Object.defineProperty(process, 'versions', {
      value: { node: '22.0.0' },
      configurable: true,
    });

    // Valid config but gitignore is empty
    const configDir = path.join(tmpDir, '.promptci');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'config.json'),
      JSON.stringify({ severityThreshold: 'warning' }),
      'utf-8'
    );
    await fs.writeFile(path.join(tmpDir, '.gitignore'), 'node_modules/\n', 'utf-8');

    let errorThrown = false;
    try {
      await runDoctor({ scanPath: tmpDir });
    } catch {
      errorThrown = true;
    }

    expect(errorThrown).toBe(true);
    expect(exitCode).toBe(1);
    expect(stdoutOutput).toContain('Gitignore protection: .promptci/ is not ignored in .gitignore');
  });

  it('passes if .gitignore ignores .promptci in different valid patterns', async () => {
    Object.defineProperty(process, 'versions', {
      value: { node: '22.0.0' },
      configurable: true,
    });

    const configDir = path.join(tmpDir, '.promptci');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'config.json'),
      JSON.stringify({ severityThreshold: 'warning' }),
      'utf-8'
    );

    // Test with /.promptci (without trailing slash, absolute from root)
    await fs.writeFile(path.join(tmpDir, '.gitignore'), '/.promptci\n', 'utf-8');

    await runDoctor({ scanPath: tmpDir });

    expect(stdoutOutput).toContain('Gitignore protection: .promptci/ is ignored in .gitignore');
  });

  it('reports warning if dashboard connection pings fail', async () => {
    Object.defineProperty(process, 'versions', {
      value: { node: '22.0.0' },
      configurable: true,
    });

    const configDir = path.join(tmpDir, '.promptci');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'config.json'),
      JSON.stringify({ severityThreshold: 'warning' }),
      'utf-8'
    );
    await fs.writeFile(path.join(tmpDir, '.gitignore'), '.promptci/\n', 'utf-8');
    process.env.PROMPTCI_API_URL = 'https://dashboard.promptci.test';

    // Mock global fetch to throw error
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('Connection refused');
    });

    await runDoctor({ scanPath: tmpDir });

    expect(stdoutOutput).toContain('Dashboard connection: Could not connect');
    expect(stdoutOutput).toContain('Diagnostics passed: Local setup is healthy!'); // Only warning, does not fail!
  });

  // BUG-17.1: doctor claimed logged-in users get server-side LLM features.
  // `fix --llm` and `explain` call the provider from this process; there is no
  // such code path, so the message must not promise one.
  it('does not claim the dashboard provides LLM features when logged in', async () => {
    Object.defineProperty(process, 'versions', {
      value: { node: '22.0.0' },
      configurable: true,
    });

    const configDir = path.join(tmpDir, '.promptci');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'config.json'),
      JSON.stringify({ severityThreshold: 'warning' }),
      'utf-8'
    );
    await fs.writeFile(path.join(tmpDir, '.gitignore'), '.promptci/\n', 'utf-8');
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    // Mock dashboard auth to be valid
    vi.mocked(authConfig.readAuthConfig).mockResolvedValue({
      access_token: 'valid-token',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
    vi.mocked(authConfig.getAuthToken).mockResolvedValue('valid-token');

    await runDoctor({ scanPath: tmpDir });

    expect(stdoutOutput).not.toContain('dashboard server-side API');
    expect(stdoutOutput).toContain('LLM API Keys: Neither OPENAI_API_KEY nor ANTHROPIC_API_KEY is configured');
    expect(stdoutOutput).toContain('run locally');
    expect(stdoutOutput).toContain('Dashboard Authentication: Authenticated');
    expect(stdoutOutput).toContain('Diagnostics passed: Local setup is healthy!');
  });

  // BUG-17.2: a directory with no .gitignore was a *critical* failure, so
  // `promptci doctor` exited 1 in any non-git directory.
  it('does not fail diagnostics in a directory with no .gitignore', async () => {
    Object.defineProperty(process, 'versions', {
      value: { node: '22.0.0' },
      configurable: true,
    });

    await runDoctor({ scanPath: tmpDir });

    expect(exitCode).toBeUndefined();
    expect(stdoutOutput).toContain('Not a git repository');
    expect(stdoutOutput).toContain('Diagnostics passed: Local setup is healthy!');
  });

  it('warns (but does not fail) in a git repo with no .gitignore', async () => {
    Object.defineProperty(process, 'versions', {
      value: { node: '22.0.0' },
      configurable: true,
    });
    await fs.mkdir(path.join(tmpDir, '.git'), { recursive: true });

    await runDoctor({ scanPath: tmpDir });

    expect(exitCode).toBeUndefined();
    expect(stdoutOutput).toContain('No .gitignore file found');
    expect(stdoutOutput).toContain('Diagnostics passed: Local setup is healthy!');
  });

  // BUG-17.4: doctor fetched {apiUrl}/api/health unconditionally, defaulting to
  // localhost:3000, for users who never touch the dashboard.
  it('does not contact any dashboard when no URL is configured', async () => {
    Object.defineProperty(process, 'versions', {
      value: { node: '22.0.0' },
      configurable: true,
    });
    await fs.writeFile(path.join(tmpDir, '.gitignore'), '.promptci/\n', 'utf-8');

    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await runDoctor({ scanPath: tmpDir });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stdoutOutput).toContain('No dashboard URL configured');
    expect(stdoutOutput).toContain('Diagnostics passed: Local setup is healthy!');
  });

  it('checks the dashboard named by .promptci/config.json', async () => {
    Object.defineProperty(process, 'versions', {
      value: { node: '22.0.0' },
      configurable: true,
    });

    const configDir = path.join(tmpDir, '.promptci');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'config.json'),
      JSON.stringify({ apiUrl: 'https://project.promptci.test' }),
      'utf-8'
    );
    await fs.writeFile(path.join(tmpDir, '.gitignore'), '.promptci/\n', 'utf-8');

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return { ok: true } as Response;
    });

    await runDoctor({ scanPath: tmpDir });

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://project.promptci.test/api/health',
      expect.anything(),
    );
    expect(stdoutOutput).toContain('Connected to dashboard at https://project.promptci.test');
  });

  // BUG-17.3: doctor green-lit Node 20/21 while every package declares >=22.
  it('keeps the Node floor in sync with package.json engines', async () => {
    const pkg = JSON.parse(
      await fs.readFile(new URL('../package.json', import.meta.url), 'utf-8'),
    ) as { engines?: { node?: string } };
    expect(pkg.engines?.node).toBe(`>=${MIN_NODE_MAJOR}`);
  });

  it('warns about missing LLM keys and not authenticated if auth token is expired', async () => {
    Object.defineProperty(process, 'versions', {
      value: { node: '22.0.0' },
      configurable: true,
    });

    const configDir = path.join(tmpDir, '.promptci');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'config.json'),
      JSON.stringify({ severityThreshold: 'warning' }),
      'utf-8'
    );
    await fs.writeFile(path.join(tmpDir, '.gitignore'), '.promptci/\n', 'utf-8');
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    // Mock dashboard auth to be expired
    vi.mocked(authConfig.readAuthConfig).mockResolvedValue({
      access_token: 'expired-token',
      expires_at: Math.floor(Date.now() / 1000) - 3600,
    });
    vi.mocked(authConfig.getAuthToken).mockResolvedValue('expired-token');

    // Mock global fetch
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return { ok: true } as Response;
    });

    await runDoctor({ scanPath: tmpDir });

    expect(stdoutOutput).toContain('LLM API Keys: Neither OPENAI_API_KEY nor ANTHROPIC_API_KEY is configured');
    expect(stdoutOutput).toContain('Dashboard Authentication: Not authenticated');
    expect(stdoutOutput).toContain('Diagnostics passed: Local setup is healthy!');
  });
});
