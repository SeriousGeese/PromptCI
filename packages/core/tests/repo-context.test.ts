import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildRepoContext, parsePackageJsonFacts, analyzeContext } from '../src/index.js';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'promptci-context-test-'));
}

describe('parsePackageJsonFacts', () => {
  it('extracts package manager, scripts, engine, and dependency facts', () => {
    const facts = parsePackageJsonFacts(
      JSON.stringify({
        packageManager: 'pnpm@9.15.9',
        engines: { node: '>=22' },
        scripts: { test: 'vitest run' },
        dependencies: { react: '^19.0.0' },
        devDependencies: { typescript: '^5.5.0' },
      }),
      ['pnpm-lock.yaml'],
    );

    expect(facts.packageManagerName).toBe('pnpm');
    expect(facts.enginesNode).toBe('>=22');
    expect(facts.scripts.test).toBe('vitest run');
    expect(facts.dependencies.react).toBe('^19.0.0');
    expect(facts.devDependencies.typescript).toBe('^5.5.0');
  });

  it('falls back to lockfile package manager when package.json is absent or invalid', () => {
    expect(parsePackageJsonFacts(undefined, ['yarn.lock']).packageManagerName).toBe('yarn');
    expect(parsePackageJsonFacts('{bad json', ['package-lock.json']).packageManagerName).toBe('npm');
  });
});

describe('buildRepoContext', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('builds shared repo facts for scan and context commands', async () => {
    await fs.writeFile(path.join(tmpDir, 'AGENTS.md'), '# Rules\nRun pnpm test before pushing.', 'utf-8');
    await fs.writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({
        packageManager: 'pnpm@9.15.9',
        scripts: { test: 'vitest run', build: 'tsc -p tsconfig.json' },
      }),
      'utf-8',
    );
    await fs.mkdir(path.join(tmpDir, '.github', 'workflows'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, '.github', 'workflows', 'ci.yml'),
      ['name: ci', 'jobs:', '  test:', '    steps:', '      - run: pnpm test'].join('\n'),
      'utf-8',
    );

    const context = await buildRepoContext({ repoPath: tmpDir });

    expect(context.files).toHaveLength(1);
    expect(context.packageJson.packageManagerName).toBe('pnpm');
    expect(Object.keys(context.packageJson.scripts)).toEqual(['test', 'build']);
    expect(context.workflows.commands.map((cmd) => cmd.command)).toContain('pnpm test');
    expect(context.metrics.estimatedInstructionTokens).toBeGreaterThan(0);
  });

  it('extracts GitHub Actions run blocks with chomping indicators', async () => {
    await fs.writeFile(path.join(tmpDir, 'AGENTS.md'), '# Rules\nRun pnpm test before pushing.', 'utf-8');
    await fs.mkdir(path.join(tmpDir, '.github', 'workflows'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, '.github', 'workflows', 'ci.yml'),
      [
        'name: ci',
        'jobs:',
        '  test:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: |-',
        '          pnpm run lint',
        '          pnpm test',
        '      - run: >-',
        '          pnpm run build',
      ].join('\n'),
      'utf-8',
    );

    const context = await buildRepoContext({ repoPath: tmpDir });

    expect(context.workflows.commands.map((cmd) => cmd.command)).toEqual([
      'pnpm run lint\npnpm test',
      'pnpm run build',
    ]);
  });

  it('analyzeContext returns deterministic context issues without writing reports', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'AGENTS.md'),
      `# Rules\n${'Move this long historical example to docs. '.repeat(1200)}`,
      'utf-8',
    );

    const analysis = await analyzeContext({ repoPath: tmpDir });
    const promptciDirExists = await fs.access(path.join(tmpDir, '.promptci')).then(() => true).catch(() => false);

    expect(analysis.metrics.estimatedInstructionTokens).toBeGreaterThan(2_500);
    expect(analysis.issues.some((issue) => issue.tags?.includes('cost'))).toBe(true);
    expect(promptciDirExists).toBe(false);
  });
});
