import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runInit, resolveSafePath } from '../src/commands/init.js';
import { loadConfig } from '../src/config.js';

// The interactive menu omits 'auto' — it is reached by accepting the detected type.
const PROJECT_TYPES = ['typescript', 'nextjs', 'unity', 'dotnet', 'python', 'go', 'rust', 'unknown'] as const;

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'promptci-init-test-'));
}

describe('runInit', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates .promptci/config.json with default values in non-interactive mode', async () => {
    await runInit(tmpDir, { interactive: false });

    const configPath = path.join(tmpDir, '.promptci', 'config.json');
    const raw = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(raw) as Record<string, unknown>;

    expect(config.severityThreshold).toBe('high');
    expect(config.projectType).toBe('auto');
    expect(config.include).toBeUndefined();
    expect(config.exclude).toBeUndefined();
  });

  it('does not overwrite an existing config file in non-interactive mode', async () => {
    const dir = path.join(tmpDir, '.promptci');
    await fs.mkdir(dir, { recursive: true });
    const configPath = path.join(dir, 'config.json');
    await fs.writeFile(configPath, JSON.stringify({ severityThreshold: 'critical' }), 'utf-8');

    await runInit(tmpDir, { interactive: false });

    const raw = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(raw) as Record<string, unknown>;
    expect(config.severityThreshold).toBe('critical');
  });

  it('detects Rust project and confirms in interactive mode', async () => {
    // Write Rust indicator file
    await fs.writeFile(path.join(tmpDir, 'Cargo.toml'), '[package]\nname = "test"', 'utf-8');

    // answers:
    // 1. Confirm detected 'rust'? 'y'
    // 2. Generate starter template? 'n'
    await runInit(tmpDir, {
      interactive: true,
      answers: ['y', 'n'],
    });

    const configPath = path.join(tmpDir, '.promptci', 'config.json');
    const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    expect(config.projectType).toBe('rust');

    // should not create any instruction files
    const hasAgents = await fs.access(path.join(tmpDir, 'AGENTS.md')).then(() => true).catch(() => false);
    expect(hasAgents).toBe(false);
  });

  it('detects Python, overrides to Go, and generates .cursorrules', async () => {
    // Write Python indicator file
    await fs.writeFile(path.join(tmpDir, 'requirements.txt'), 'pytest', 'utf-8');

    // answers:
    // 1. Confirm detected 'python'? 'n' (override)
    // 2. Select project type: '6' (for go)
    // 3. Generate starter template? 'y'
    // 4. Select template choice: '2' (for .cursorrules)
    await runInit(tmpDir, {
      interactive: true,
      answers: ['n', '6', 'y', '2'],
    });

    const configPath = path.join(tmpDir, '.promptci', 'config.json');
    const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    expect(config.projectType).toBe('go');

    const cursorrulesPath = path.join(tmpDir, '.cursorrules');
    const templateContent = await fs.readFile(cursorrulesPath, 'utf-8');
    expect(templateContent).toContain('Go (Golang)');
    expect(templateContent).toContain('go test');
  });

  // BUG-15: init offered python/go/rust but the CLI's config validator did not
  // know them, so the config init wrote was rejected by the very next scan.
  // Menu index N must select PROJECT_TYPES[N-1] and survive a loadConfig round trip.
  it.each(PROJECT_TYPES.map((t, i) => [String(i + 1), t] as const))(
    'writes a config loadConfig accepts when menu choice %s (%s) is selected',
    async (choice, expectedType) => {
      await runInit(tmpDir, {
        interactive: true,
        // 1. Confirm detected type? 'n' (override)  2. menu choice  3. template? 'n'
        answers: ['n', choice, 'n'],
      });

      const config = JSON.parse(
        await fs.readFile(path.join(tmpDir, '.promptci', 'config.json'), 'utf-8'),
      );
      expect(config.projectType).toBe(expectedType);
      await expect(loadConfig(tmpDir)).resolves.toMatchObject({ projectType: expectedType });
    },
  );

  it('does not overwrite existing instruction files', async () => {
    // Write existing AGENTS.md
    const agentsPath = path.join(tmpDir, 'AGENTS.md');
    await fs.writeFile(agentsPath, 'Existing instructions', 'utf-8');

    // answers:
    // 1. Confirm detected 'unknown'? 'y'
    // 2. Generate starter template? 'y'
    // 3. Which file? '1' (AGENTS.md)
    await runInit(tmpDir, {
      interactive: true,
      answers: ['y', 'y', '1'],
    });

    const content = await fs.readFile(agentsPath, 'utf-8');
    expect(content).toBe('Existing instructions');
  });

  it('honors path traversal security when resolving directories', async () => {
    // Target paths are resolved cleanly. We verify runInit finishes successfully.
    await expect(runInit(tmpDir, { interactive: false })).resolves.not.toThrow();

    // Verify resolveSafePath throws when relative path escapes the root directory
    expect(() => resolveSafePath(tmpDir, '../outside.md')).toThrow('Path escapes target directory');
    expect(() => resolveSafePath(tmpDir, '/absolute/path/outside')).toThrow('Path escapes target directory');
  });

  it('gracefully handles loop fallbacks when invalid inputs are provided', async () => {
    // answers:
    // 1. Confirm detected 'unknown'? 'n'
    // 2. Provide 5 invalid answers for project type: ['bad', 'invalid', '9', 'foo', 'bar']
    // 3. Generate starter template? 'y'
    // 4. Provide 5 invalid answers for template type: ['bad', 'invalid', '4', 'foo', 'bar']
    await runInit(tmpDir, {
      interactive: true,
      answers: [
        'n',
        'bad', 'invalid', '9', 'foo', 'bar',
        'y',
        'bad', 'invalid', '4', 'foo', 'bar'
      ],
    });

    const configPath = path.join(tmpDir, '.promptci', 'config.json');
    const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    // Should fallback to 'auto'
    expect(config.projectType).toBe('auto');

    // Should skip template generation
    const hasAgents = await fs.access(path.join(tmpDir, 'AGENTS.md')).then(() => true).catch(() => false);
    expect(hasAgents).toBe(false);
  });

  // BUG-7: the appended rule must ignore generated reports WITHOUT ignoring
  // baseline.json — `scan --baseline` / `--fail-on-new` read it from the CI
  // checkout, so a wholesale `.promptci/` defeats the ratchet.
  const EXPECTED_IGNORE =
    '# PromptCI: ignore generated reports, keep the shared baseline and config\n' +
    '**/.promptci/*\n' +
    '!**/.promptci/baseline.json\n' +
    '!**/.promptci/config.json\n';

  it('appends the baseline-preserving .promptci rules to .gitignore in non-interactive mode', async () => {
    const gitignorePath = path.join(tmpDir, '.gitignore');
    await fs.writeFile(gitignorePath, 'node_modules/\n', 'utf-8');

    await runInit(tmpDir, { interactive: false });

    const content = await fs.readFile(gitignorePath, 'utf-8');
    expect(content).toBe(`node_modules/\n${EXPECTED_IGNORE}`);
    // `.promptci/*` (contents), not `.promptci/` (directory) — git skips
    // ignored directories entirely, which would make the negations dead.
    expect(content).not.toMatch(/^\.promptci\/$/m);
  });

  it('prompts and appends .promptci/ to .gitignore in interactive mode if confirmed', async () => {
    const gitignorePath = path.join(tmpDir, '.gitignore');
    await fs.writeFile(gitignorePath, 'node_modules/\n', 'utf-8');

    // answers:
    // 1. Confirm detected 'unknown'? 'y'
    // 2. Generate starter template? 'n'
    // 3. Add to gitignore? 'y'
    await runInit(tmpDir, {
      interactive: true,
      answers: ['y', 'n', 'y'],
    });

    const content = await fs.readFile(gitignorePath, 'utf-8');
    expect(content).toBe(`node_modules/\n${EXPECTED_IGNORE}`);
  });

  it('prompts and does not append .promptci/ to .gitignore in interactive mode if rejected', async () => {
    const gitignorePath = path.join(tmpDir, '.gitignore');
    await fs.writeFile(gitignorePath, 'node_modules/\n', 'utf-8');

    // answers:
    // 1. Confirm detected 'unknown'? 'y'
    // 2. Generate starter template? 'n'
    // 3. Add to gitignore? 'n'
    await runInit(tmpDir, {
      interactive: true,
      answers: ['y', 'n', 'n'],
    });

    const content = await fs.readFile(gitignorePath, 'utf-8');
    expect(content).toBe('node_modules/\n');
  });

  it('does not modify .gitignore if .promptci/ is already ignored', async () => {
    const gitignorePath = path.join(tmpDir, '.gitignore');
    await fs.writeFile(gitignorePath, 'node_modules/\n.promptci/\n', 'utf-8');

    await runInit(tmpDir, { interactive: false });

    const content = await fs.readFile(gitignorePath, 'utf-8');
    expect(content).toBe('node_modules/\n.promptci/\n');
  });

  it('is idempotent — re-running init does not append the rules twice', async () => {
    const gitignorePath = path.join(tmpDir, '.gitignore');
    await fs.writeFile(gitignorePath, 'node_modules/\n', 'utf-8');

    await runInit(tmpDir, { interactive: false });
    await runInit(tmpDir, { interactive: false });

    const content = await fs.readFile(gitignorePath, 'utf-8');
    expect(content).toBe(`node_modules/\n${EXPECTED_IGNORE}`);
  });
});
