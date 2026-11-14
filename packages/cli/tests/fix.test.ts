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
    expect(content).toContain('node_modules/');
    // BUG-7: report files are ignored, but the shared baseline stays committed
    // so `scan --baseline` / `--fail-on-new` work in CI.
    expect(content).toContain('**/.promptci/*');
    expect(content).toContain('!**/.promptci/baseline.json');
    expect(content).toContain('!**/.promptci/config.json');
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

  // pcic-1ik0.10: the CLAUDE.md import is opt-in only. A plain `fix` leaves a
  // mirrored CLAUDE.md alone (an import does not load in a session started in
  // a subdirectory without approval); naming the finding with --issue applies it.
  it('leaves a mirrored CLAUDE.md alone by default and imports AGENTS.md when the finding is named', async () => {
    const agentsPath = path.join(tmpDir, 'AGENTS.md');
    const claudePath = path.join(tmpDir, 'CLAUDE.md');
    const duplicateBody =
      '## Testing Conventions\n' +
      'Run all tests before saying work is done. Ensure coverage matches or exceeds 80%.\n' +
      'Always document design constraints in the codebase.\n';
    await fs.writeFile(agentsPath, duplicateBody, 'utf-8');
    await fs.writeFile(claudePath, duplicateBody, 'utf-8');

    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...m) => { logs.push(m.join(' ')); });
    try {
      await runFix({ scanPath: tmpDir, interactive: false });
      expect(await fs.readFile(claudePath, 'utf-8')).toBe(duplicateBody);
      const hint = logs.find((l) => l.startsWith('Opt-in fix available'));
      expect(hint).toMatch(/promptci fix --issue (duplicate-[0-9a-f]{12})/);
      const id = /--issue (duplicate-[0-9a-f]{12})/.exec(hint!)![1]!;

      await runFix({ scanPath: tmpDir, issueId: id, interactive: false });
    } finally {
      spy.mockRestore();
    }
    expect(await fs.readFile(agentsPath, 'utf-8')).toBe(duplicateBody);
    expect(await fs.readFile(claudePath, 'utf-8')).toBe('@AGENTS.md\n');
  });

  it('prints why the opt-in import is refused and edits nothing', async () => {
    const agentsPath = path.join(tmpDir, 'AGENTS.md');
    const claudePath = path.join(tmpDir, 'CLAUDE.md');
    const body =
      '## Testing Conventions\n' +
      'Run all tests before saying work is done. Ensure coverage matches or exceeds 80%.\n' +
      'Always document design constraints in the codebase.\n' +
      '\n## Style Conventions\n' +
      'Format with Prettier defaults and keep imports sorted; never reformat files you did not change.\n' +
      'Prefer named exports, and keep each module focused on one responsibility.\n';
    const claude = `## Binding\nEverything below binds Claude.\n\n${body}`;
    await fs.writeFile(agentsPath, body, 'utf-8');
    await fs.writeFile(claudePath, claude, 'utf-8');
    const { scan } = await import('@promptci/core');
    const mirror = (await scan({ repoPath: tmpDir })).issues.find((i) => (i.tags ?? []).includes('mirrored-files'));
    expect(mirror).toBeDefined();

    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...m) => { logs.push(m.join(' ')); });
    try {
      await runFix({ scanPath: tmpDir, issueId: mirror!.id, interactive: false });
    } finally {
      spy.mockRestore();
    }
    expect(await fs.readFile(claudePath, 'utf-8')).toBe(claude);
    expect(logs).toContain(`No edit for ${mirror!.id}:`);
    expect(logs.some((l) => l.includes('comes before "Testing Conventions"; it would move'))).toBe(true);
  });

  // pcic-1ik0.5 (PromptCI#160): a near-duplicate is two copies that have
  // drifted apart. Consolidating it unattended would replace the text that
  // differs with a pointer, deleting the conflict along with its evidence.
  it('leaves near-duplicate (drifted) sections in both files untouched', async () => {
    const agentsPath = path.join(tmpDir, 'AGENTS.md');
    const claudePath = path.join(tmpDir, 'CLAUDE.md');
    const body = (word: string) =>
      '## Database Rules\n' +
      `Every schema change ships as a new migration under drizzle/ and is ${word} edited after merge.\n` +
      'Queries go through the repository modules in src/repos so transactions stay in one place.\n' +
      'Route handlers must not import the database client directly; tests stub the repositories.\n';
    await fs.writeFile(agentsPath, body('never'), 'utf-8');
    await fs.writeFile(claudePath, body('always'), 'utf-8');

    await runFix({ scanPath: tmpDir, interactive: false });

    expect(await fs.readFile(agentsPath, 'utf-8')).toBe(body('never'));
    expect(await fs.readFile(claudePath, 'utf-8')).toBe(body('always'));
  });

  it('leaves a copy whose nested list was flattened untouched', async () => {
    const agentsPath = path.join(tmpDir, 'AGENTS.md');
    const claudePath = path.join(tmpDir, 'CLAUDE.md');
    const body = (indent: string) =>
      '## Release Steps\n' +
      'Follow these steps in order for every release and never skip one of them, even for hotfixes.\n' +
      `- Build the packages\n${indent}- run pnpm build in the repository root\n${indent}- check that dist/ holds the bundles\n` +
      `- Publish the packages\n${indent}- run pnpm publish from each package directory\n`;
    await fs.writeFile(agentsPath, body('  '), 'utf-8');
    await fs.writeFile(claudePath, body(''), 'utf-8');

    await runFix({ scanPath: tmpDir, interactive: false });

    expect(await fs.readFile(agentsPath, 'utf-8')).toBe(body('  '));
    expect(await fs.readFile(claudePath, 'utf-8')).toBe(body(''));
  });

  it('leaves a copy whose fenced code lost its indentation untouched', async () => {
    const agentsPath = path.join(tmpDir, 'AGENTS.md');
    const claudePath = path.join(tmpDir, 'CLAUDE.md');
    const body = (indent: string) =>
      '## Database Rules\n' +
      'Every schema change ships as a new migration under drizzle/ and is never edited after merge.\n' +
      'Queries go through the repository modules in src/repos so transactions stay in one place.\n' +
      '\n```python\nif x:\n' + `${indent}run()\nelse:\n${indent}stop()\n` + '```\n';
    await fs.writeFile(agentsPath, body('    '), 'utf-8');
    await fs.writeFile(claudePath, body(''), 'utf-8');

    await runFix({ scanPath: tmpDir, interactive: false });

    expect(await fs.readFile(agentsPath, 'utf-8')).toBe(body('    '));
    expect(await fs.readFile(claudePath, 'utf-8')).toBe(body(''));
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
});
