/**
 * Script-check precision (pcic-2b6.9).
 *
 * `pnpm vitest run`, `pnpm tsc --noEmit`, `pnpm eslint .` and `pnpm prettier`
 * invoke dependency binaries, not package scripts, and a monorepo command such
 * as `pnpm --filter web dev` or `cd apps/web && pnpm test:e2e` resolves its
 * script from a workspace manifest. None of them are missing scripts. And when a
 * script genuinely is missing, the one command must yield ONE finding — not one
 * from command-validity and another from manifest-consistency.
 *
 * These run the real scan pipeline over temp repos so the workspace discovery
 * in buildRepoContext is part of what is tested.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { scan } from '../src/scan.js';
import type { PromptCiIssue } from '../src/types.js';
import { makeTempRepo, writeFile } from './ai-config-helpers.js';
import * as fs from 'node:fs';

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../examples/fixture-monorepo-scripts',
);

/** Findings about a missing script, from either detector. */
function scriptFindings(issues: PromptCiIssue[]): PromptCiIssue[] {
  return issues.filter(
    (i) => i.category === 'command_validity' || i.id.startsWith('manifest-missing-script'),
  );
}

const tempRepos: string[] = [];
afterEach(() => {
  for (const dir of tempRepos.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function scanRepo(files: Record<string, string>): Promise<PromptCiIssue[]> {
  const repo = makeTempRepo('promptci-scripts-');
  tempRepos.push(repo);
  for (const [rel, content] of Object.entries(files)) writeFile(repo, rel, content);
  return scanIssues(repo);
}

async function scanIssues(repo: string): Promise<PromptCiIssue[]> {
  return (await scan({ repoPath: repo, projectType: 'typescript' })).issues;
}

const pkg = (value: Record<string, unknown>): string => JSON.stringify(value);

describe('dependency binaries are not missing scripts', () => {
  const manifest = pkg({
    name: 'app',
    scripts: { build: 'tsc -b' },
    devDependencies: { vitest: '^3.0.0', typescript: '^5.0.0', eslint: '^9.0.0', prettier: '^3.0.0' },
  });

  it('does not flag `pnpm vitest run`, `pnpm tsc --noEmit`, `pnpm eslint .`, `pnpm prettier`', async () => {
    const issues = await scanRepo({
      'package.json': manifest,
      'AGENTS.md': [
        '# Agents',
        '',
        '```bash',
        'pnpm vitest run',
        'pnpm tsc --noEmit',
        'pnpm eslint .',
        'pnpm prettier --check .',
        '```',
        '',
        'Also run `pnpm vitest run` and `pnpm tsc --noEmit` before pushing.',
      ].join('\n'),
    });
    expect(scriptFindings(issues)).toEqual([]);
  });

  it('does not flag `yarn tsc` / `yarn run tsc` (yarn falls through to binaries)', async () => {
    const issues = await scanRepo({
      'package.json': manifest,
      'AGENTS.md': '# Agents\n\nRun `yarn tsc --noEmit` or `yarn run eslint .`.\n',
    });
    expect(scriptFindings(issues)).toEqual([]);
  });

  it('accepts a well-known tool binary when a package providing it is declared', async () => {
    const issues = await scanRepo({
      'package.json': pkg({
        name: 'app',
        scripts: { build: 'tsc -b' },
        devDependencies: { '@playwright/test': '^1.50.0', turbo: '^2.0.0', '@biomejs/biome': '^1.9.0' },
      }),
      'AGENTS.md': '# Agents\n\nRun `pnpm playwright test`, `pnpm turbo run build` and `pnpm biome check .`.\n',
    });
    expect(scriptFindings(issues)).toEqual([]);
  });

  it('flags a well-known tool binary that nothing in the workspace installs', async () => {
    const issues = await scanRepo({
      'package.json': pkg({ name: 'app', scripts: { build: 'tsc -b' } }),
      'AGENTS.md': '# Agents\n\n```bash\npnpm prisma migrate deploy\npnpm next build\npnpm storybook\npnpm turbopack\n```\n',
    });
    const summaries = scriptFindings(issues).map((i) => i.summary).join('\n');
    for (const name of ['prisma', 'next', 'storybook', 'turbopack']) {
      expect(summaries).toContain(`pnpm script "${name}"`);
    }
  });

  it('does not treat @types/*, scoped basenames or sibling workspace packages as binaries', async () => {
    const issues = await scanRepo({
      'package.json': pkg({
        name: 'root',
        scripts: { build: 'turbo build' },
        devDependencies: { '@types/node': '1', '@trpc/server': '1' },
      }),
      'pnpm-workspace.yaml': 'packages:\n  - "apps/*"\n  - "packages/*"\n',
      'apps/web/package.json': pkg({
        name: '@acme/web',
        dependencies: { '@acme/db': 'workspace:*', '@acme/e2e': 'workspace:*' },
      }),
      'packages/db/package.json': pkg({ name: '@acme/db', scripts: { generate: 'x' } }),
      'packages/e2e/package.json': pkg({ name: '@acme/e2e', scripts: { test: 'x' } }),
      'AGENTS.md': '# Agents\n\n```bash\npnpm node\npnpm server\npnpm db\npnpm e2e\npnpm web\n```\n',
    });
    const summaries = scriptFindings(issues).map((i) => i.summary).join('\n');
    for (const name of ['node', 'server', 'db', 'e2e', 'web']) {
      expect(summaries).toContain(`pnpm script "${name}"`);
    }
  });

  it('still accepts a dependency literally named like the command, and workspace package bins', async () => {
    const issues = await scanRepo({
      'package.json': pkg({ name: 'root', scripts: { build: 'x' }, devDependencies: { 'my-cli': '1' } }),
      'pnpm-workspace.yaml': 'packages:\n  - "tools/*"\n',
      'tools/gen/package.json': pkg({ name: '@acme/gen', bin: { 'acme-gen': './bin.js' } }),
      'AGENTS.md': '# Agents\n\n```bash\npnpm my-cli --help\npnpm acme-gen\n```\n',
    });
    expect(scriptFindings(issues)).toEqual([]);
  });

  it('counts dependencies declared in a workspace package', async () => {
    const issues = await scanRepo({
      'package.json': pkg({ name: 'root', scripts: { build: 'pnpm -r build' } }),
      'pnpm-workspace.yaml': 'packages:\n  - "apps/*"\n',
      'apps/web/package.json': pkg({ name: 'web', devDependencies: { knex: '^3.0.0', 'drizzle-kit': '1.0.0' } }),
      'AGENTS.md': '# Agents\n\nRun `pnpm knex migrate:latest` then `pnpm drizzle-kit push`.\n',
    });
    expect(scriptFindings(issues)).toEqual([]);
  });

  it('still flags a bare name that is neither a script nor a dependency or known binary', async () => {
    const issues = await scanRepo({
      'package.json': manifest,
      'AGENTS.md': '# Agents\n\nRun `pnpm regenerate-fixtures` first.\n',
    });
    const findings = scriptFindings(issues);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.category).toBe('command_validity');
    expect(findings[0]!.summary).toContain('regenerate-fixtures');
  });

  it('still flags `npm run vitest` and `pnpm run tsc`: run accepts scripts only', async () => {
    const issues = await scanRepo({
      'package.json': manifest,
      'AGENTS.md': '# Agents\n\nRun `npm run vitest` or `pnpm run tsc`.\n',
    });
    const summaries = scriptFindings(issues).map((i) => i.summary).join('\n');
    expect(summaries).toContain('npm script "vitest"');
    expect(summaries).toContain('pnpm script "tsc"');
  });
});

describe('one command, one finding', () => {
  it('reports a missing script once, from command-validity', async () => {
    const issues = await scanRepo({
      'package.json': pkg({ name: 'app', scripts: { build: 'tsc -b' } }),
      'AGENTS.md': [
        '# Agents',
        '',
        '```bash',
        'pnpm run ship-it',
        '```',
        '',
        'Run `pnpm run ship-it` to release, or npm run ship-it if you prefer.',
      ].join('\n'),
    });
    const findings = scriptFindings(issues);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.category).toBe('command_validity');
  });

  it('keeps manifest-missing-script for prose that command-validity never parses', async () => {
    const issues = await scanRepo({
      'package.json': pkg({ name: 'app', scripts: { build: 'tsc -b' } }),
      'AGENTS.md': '# Agents\n\nAfterwards, npm run ship-it to release.\n',
    });
    const findings = scriptFindings(issues);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.id.startsWith('manifest-missing-script')).toBe(true);
  });
});

describe('monorepo scripts', () => {
  const files = {
    'package.json': pkg({ name: 'root', scripts: { build: 'pnpm -r build' } }),
    'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n  - 'packages/*'\n",
    'apps/web/package.json': pkg({ name: '@acme/web', scripts: { dev: 'next dev', 'test:e2e': 'playwright test' } }),
    'packages/ui/package.json': pkg({ name: '@acme/ui', scripts: { storybook: 'storybook dev' } }),
  };

  it('honors `cd <dir> &&`, `--filter`, `-r` and `--workspace` in any documented form', async () => {
    const issues = await scanRepo({
      ...files,
      'AGENTS.md': [
        '# Agents',
        '',
        '```bash',
        'cd apps/web && pnpm test:e2e',
        'pnpm --filter @acme/web dev',
        'pnpm --filter=web dev',
        'pnpm -r storybook',
        'pnpm --filter "./packages/*" storybook',
        'npm run dev --workspace=web',
        'npm run dev -w @acme/web',
        'yarn workspace @acme/web dev',
        'pnpm --dir apps/web dev',
        '```',
        '',
        'Prose: `cd apps/web && pnpm dev`, and in apps/web run `pnpm --filter web test:e2e`.',
        'Or: cd apps/web && npm run test:e2e',
      ].join('\n'),
    });
    expect(scriptFindings(issues)).toEqual([]);
  });

  it('does not report a workspace script as missing just because the root lacks it', async () => {
    const issues = await scanRepo({
      ...files,
      'AGENTS.md': '# Agents\n\nAfterwards, pnpm run test:e2e to verify the web app.\n',
    });
    expect(scriptFindings(issues)).toEqual([]);
  });

  it('still flags a script no workspace defines', async () => {
    const issues = await scanRepo({
      ...files,
      'AGENTS.md': '# Agents\n\n```bash\ncd apps/web && pnpm deploy-prod\npnpm --filter @acme/web nope\n```\n',
    });
    const summaries = scriptFindings(issues).map((i) => i.summary);
    expect(summaries.some((s) => s.includes('deploy-prod'))).toBe(true);
    expect(summaries.some((s) => s.includes('nope'))).toBe(true);
    expect(scriptFindings(issues)).toHaveLength(2);
  });

  it('reads workspace globs from package.json `workspaces`', async () => {
    const issues = await scanRepo({
      'package.json': pkg({ name: 'root', scripts: { build: 'echo' }, workspaces: ['services/*'] }),
      'services/api/package.json': pkg({ name: 'api', scripts: { 'db:migrate': 'knex migrate:latest' } }),
      'AGENTS.md': '# Agents\n\n```bash\npnpm --filter api db:migrate\npnpm -r db:migrate\n```\n',
    });
    expect(scriptFindings(issues)).toEqual([]);
  });
});

describe('npm run-script and bun run', () => {
  const manifest = pkg({ name: 'app', scripts: { build: 'tsc -b', lint: 'eslint .' }, devDependencies: { vitest: '3' } });

  it('validates `npm run-script <name>` like `npm run <name>`', async () => {
    const issues = await scanRepo({
      'package.json': manifest,
      'AGENTS.md': '# Agents\n\n```bash\nnpm run-script build\nnpm run-script nope\n```\n',
    });
    const findings = scriptFindings(issues);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.summary).toContain('npm script "nope"');
  });

  it('validates `bun run <name>` and bare `bun <name>`, but not bun built-ins or files', async () => {
    const issues = await scanRepo({
      'package.json': manifest,
      'scripts/seed.ts': 'export {};\n',
      'AGENTS.md': [
        '# Agents',
        '',
        '```bash',
        'bun run build',
        'bun lint',
        'bun install',
        'bun test',
        'bun x vitest',
        'bun run vitest',
        'bun run scripts/seed.ts',
        'bun run nope',
        'bun run scripts/missing.ts',
        '```',
      ].join('\n'),
    });
    const summaries = scriptFindings(issues).map((i) => i.summary);
    expect(summaries).toHaveLength(2);
    expect(summaries.some((s) => s.includes('bun script "nope"'))).toBe(true);
    expect(summaries.some((s) => s.includes('scripts/missing.ts'))).toBe(true);
  });
});

describe('workspace selectors resolve only against the selected workspaces', () => {
  const files = {
    'package.json': pkg({ name: 'root', scripts: { build: 'turbo build', lint: 'eslint .' } }),
    'pnpm-workspace.yaml': 'packages:\n  - "apps/*"\n',
    'apps/web/package.json': pkg({ name: '@acme/web', scripts: { dev: 'next dev' } }),
  };

  it('flags a selector that matches no workspace even when the root defines the script', async () => {
    const issues = await scanRepo({
      ...files,
      'AGENTS.md': [
        '# Agents',
        '',
        '```bash',
        'yarn workspace @acme/nope build',
        'pnpm --filter @acme/nope build',
        'npm run build -w nope',
        '```',
      ].join('\n'),
    });
    const summaries = scriptFindings(issues).map((i) => i.summary);
    expect(summaries).toHaveLength(3);
    expect(summaries.every((s) => s.includes('no workspace matches'))).toBe(true);
    expect(summaries.some((s) => s.includes('@acme/nope'))).toBe(true);
  });

  it('does not let a same-named root script stand in for the selected workspace, and names the workspace', async () => {
    const issues = await scanRepo({
      ...files,
      'AGENTS.md': '# Agents\n\n```bash\nyarn workspace @acme/web lint\npnpm --filter @acme/web lint\npnpm --filter @acme/web dev\n```\n',
    });
    const summaries = scriptFindings(issues).map((i) => i.summary);
    expect(summaries).toHaveLength(2);
    expect(summaries.every((s) => s.includes('@acme/web (apps/web/package.json)'))).toBe(true);
  });

  it('keeps matching by directory, glob and exclusion selectors', async () => {
    const issues = await scanRepo({
      ...files,
      'AGENTS.md': '# Agents\n\n```bash\npnpm --filter ./apps/web dev\npnpm --filter "@acme/*" dev\npnpm --filter "!@acme/other" dev\n```\n',
    });
    expect(scriptFindings(issues)).toEqual([]);
  });
});

describe('workspace discovery', () => {
  it('does not follow workspace globs out of the repository', async () => {
    const repo = makeTempRepo('promptci-scripts-');
    const sibling = `${repo}-outside`;
    tempRepos.push(repo, sibling);
    writeFile(sibling, 'pkgx/package.json', pkg({ name: 'outside', scripts: { 'secret-script': 'x' } }));
    writeFile(repo, 'package.json', pkg({
      name: 'root',
      scripts: { build: 'x' },
      workspaces: [`../${path.basename(sibling)}/*`, `/${path.basename(sibling)}/*`],
    }));
    writeFile(repo, 'AGENTS.md', '# Agents\n\n```bash\npnpm -r secret-script\n```\n');
    const findings = scriptFindings(await scanIssues(repo));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.summary).toContain('secret-script');
  });

  it.each([
    ['block list at column 0', 'packages:\n- "services/*"\n'],
    ['block list, single quotes, comment', "packages:\n  - 'services/*' # api\n"],
    ['flow list', "packages: ['services/*']\n"],
    ['multi-line flow list', 'packages: [\n  "services/*",\n  "tools/*"\n]\n'],
  ])('reads pnpm-workspace.yaml: %s', async (_label, yaml) => {
    const issues = await scanRepo({
      'package.json': pkg({ name: 'root', scripts: { build: 'x' } }),
      'pnpm-workspace.yaml': yaml,
      'services/api/package.json': pkg({ name: 'api', scripts: { migrate: 'x' } }),
      'AGENTS.md': '# Agents\n\n```bash\npnpm --filter api migrate\n```\n',
    });
    expect(scriptFindings(issues)).toEqual([]);
  });

  it('keeps a declared workspace package that lives under a directory named build', async () => {
    const issues = await scanRepo({
      'package.json': pkg({ name: 'root', scripts: { build: 'x' }, workspaces: ['tools/*'] }),
      'tools/build/package.json': pkg({ name: 'buildtool', scripts: { bundle: 'x' } }),
      'AGENTS.md': '# Agents\n\n```bash\npnpm --filter buildtool bundle\n```\n',
    });
    expect(scriptFindings(issues)).toEqual([]);
  });
});

describe('manifest-missing-script judges each occurrence on its own', () => {
  const manifest = pkg({ name: 'app', scripts: { build: 'tsc -b' } });

  it('still flags a prose mention when an uncheckable command elsewhere used the same script name', async () => {
    const issues = await scanRepo({
      'package.json': manifest,
      // `services/api` has no package.json, so command-validity cannot judge the first command.
      'AGENTS.md': '# Agents\n\n`cd services/api && pnpm run deploy-prod`\n\nLater, npm run deploy-prod again.\n',
    });
    const findings = scriptFindings(issues);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.id.startsWith('manifest-missing-script')).toBe(true);
  });

  it('does not let a -r or cd from an earlier command on the line excuse this one', async () => {
    const issues = await scanRepo({
      'package.json': manifest,
      'AGENTS.md': '# Agents\n\nFirst pnpm -r build, then afterwards npm run deploy-prod to ship.\n',
    });
    expect(scriptFindings(issues)).toHaveLength(1);
  });

  it('honors a scope that governs the command: a cd chained right before it, or a workspace flag after it', async () => {
    const issues = await scanRepo({
      'package.json': manifest,
      'AGENTS.md': '# Agents\n\nThen cd apps/web && npm run deploy-prod to ship.\n\nAlso npm run other-prod -w web works.\n',
    });
    expect(scriptFindings(issues)).toEqual([]);
  });
});

const SCOPE_FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../examples/fixture-command-scope',
);

describe('a script defined in a package the text points at (pcic-1ik0.2, #157)', () => {
  const root = pkg({ name: 'root', scripts: { check: 'echo' } });

  it('reports nothing when the nearest heading names the directory that defines the script', async () => {
    const issues = await scanRepo({
      'package.json': root,
      'site/package.json': pkg({ name: 'site', scripts: { dev: 'x', build: 'x', lint: 'x' } }),
      'CLAUDE.md': [
        '# Project',
        '',
        '### Site (from `site/` directory)',
        '',
        '- `npm run dev` -- Start dev server',
        '- `npm run build` -- Production build',
        '- `npm run lint` -- ESLint',
        '',
      ].join('\n'),
    });
    expect(scriptFindings(issues)).toEqual([]);
  });

  it('reports nothing when a sentence above a fenced block names the directory', async () => {
    const issues = await scanRepo({
      'package.json': root,
      'packages/trading-signals-docs/package.json': pkg({ scripts: { 'test:e2e': 'x' } }),
      '.claude/rules/docs-e2e.md': 'From `packages/trading-signals-docs/`:\n\n```sh\nnpm run test:e2e        # headless\n```\n',
    });
    expect(scriptFindings(issues)).toEqual([]);
  });

  it('reads a `cd <dir>` in an earlier step of the same section', async () => {
    const issues = await scanRepo({
      'package.json': root,
      'site/package.json': pkg({ scripts: { dev: 'x' } }),
      'CONTRIBUTING.md':
        '## Setup\n\n3. Install site dependencies:\n   ```bash\n   cd site\n   npm install\n   ```\n4. Start the dev server:\n   ```bash\n   npm run dev\n   ```\n',
    });
    expect(scriptFindings(issues)).toEqual([]);
  });

  it('reads the sentence under a heading that itself holds the command', async () => {
    const issues = await scanRepo({
      'package.json': root,
      'packages/docs/package.json': pkg({ scripts: { 'test:e2e': 'x' } }),
      'CLAUDE.md': '## Run via `npm run test:e2e`\n\nFrom `packages/docs/`:\n\n```sh\nnpm run test:e2e\n```\n\n## Other\n',
    });
    expect(scriptFindings(issues)).toEqual([]);
  });

  it('does not read a directory named under the NEXT heading', async () => {
    const issues = await scanRepo({
      'package.json': root,
      'site/package.json': pkg({ scripts: { dev: 'x' } }),
      'CLAUDE.md': '## Start\n\nRun `npm run dev`.\n\n## Site\n\nThe `site/` directory holds the website.\n',
    });
    const findings = scriptFindings(issues);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('info');
  });

  it('resolves a directory named relative to the instruction file', async () => {
    const issues = await scanRepo({
      'package.json': root,
      'app/web/package.json': pkg({ scripts: { dev: 'x' } }),
      'app/CLAUDE.md': 'Web (from `web/`):\n\n```sh\nnpm run dev\n```\n',
    });
    expect(scriptFindings(issues)).toEqual([]);
  });

  it('downgrades to an info note that says where the script is when no directory is named', async () => {
    const issues = await scanRepo({
      'package.json': root,
      'site/package.json': pkg({ scripts: { dev: 'x' } }),
      'CLAUDE.md': '# Project\n\nStart it with `npm run dev`.\n',
    });
    const findings = scriptFindings(issues);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('info');
    expect(findings[0]!.summary).toContain('site/package.json');
    expect(findings[0]!.fixEdits).toBeUndefined();
    expect(findings[0]!.autoApplySafe).toBeUndefined();
  });

  it('still notes it when the text names a directory that does not define the script', async () => {
    const issues = await scanRepo({
      'package.json': root,
      'site/package.json': pkg({ scripts: { lint: 'x' } }),
      'tools/package.json': pkg({ scripts: { seed: 'x' } }),
      'CLAUDE.md': '# Project\n\nFrom `site/`: run `npm run seed`.\n',
    });
    const findings = scriptFindings(issues);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('info');
    expect(findings[0]!.summary).toContain('tools/package.json');
  });

  it('keeps the warning for a script no package defines', async () => {
    const issues = await scanRepo({
      'package.json': root,
      'site/package.json': pkg({ scripts: { dev: 'x' } }),
      'CLAUDE.md': '### Site (from `site/` directory)\n\n- `npm run nonexistent`\n',
    });
    const findings = scriptFindings(issues);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('warning');
  });

  it('does not offer a typo rewrite for a name another package defines', async () => {
    const issues = await scanRepo({
      'package.json': pkg({ scripts: { build: 'x', test: 'x' } }),
      'tools/package.json': pkg({ scripts: { buidl: 'x' } }),
      'CLAUDE.md': '# Project\n\nUse `npm run buidl` for the toolchain.\n',
    });
    const findings = scriptFindings(issues);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.fixEdits).toBeUndefined();
  });

  it('ignores package.json files under node_modules and dot directories', async () => {
    const issues = await scanRepo({
      'package.json': root,
      'node_modules/dep/package.json': pkg({ scripts: { dev: 'x' } }),
      '.cache/pkg/package.json': pkg({ scripts: { dev: 'x' } }),
      'CLAUDE.md': '# Project\n\n- `npm run dev`\n',
    });
    const findings = scriptFindings(issues);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('warning');
  });
});

describe('a glob or placeholder in a script token is not a typo (pcic-qc33, #156)', () => {
  const manifest = pkg({
    scripts: { build: 'x', 'build:web': 'x', 'build:api': 'x', 'test:unit': 'x', lint: 'x' },
  });

  it('reports nothing and offers no rewrite for `pnpm build*`', async () => {
    const issues = await scanRepo({
      'package.json': manifest,
      'CLAUDE.md':
        '- **Validation**: run the smallest meaningful checks (`pnpm type-check`, `pnpm lint`, targeted scripts) before handing work back. Reserve `pnpm build*` for user requests or when architectural changes demand it.\n',
    });
    const findings = scriptFindings(issues).filter((i) => i.summary.includes('build'));
    expect(findings).toEqual([]);
    expect(issues.some((i) => i.fixEdits?.some((e) => e.find.includes('*')))).toBe(false);
  });

  it.each(['`npm run test:*`', '`pnpm run "build:?"`', '`yarn build:[a-z]`', '`bun run build:{web,api}`', '`npm run build:<target>`'])(
    'reports nothing for %s',
    async (snippet) => {
      const issues = await scanRepo({ 'package.json': manifest, 'CLAUDE.md': `# Project\n\nRun ${snippet} as needed.\n` });
      expect(scriptFindings(issues)).toEqual([]);
    },
  );

  it('still flags a plain missing script on the same line as a glob', async () => {
    const issues = await scanRepo({
      'package.json': manifest,
      'CLAUDE.md': '# Project\n\nRun `pnpm build*` or `pnpm deploy-prod`.\n',
    });
    const findings = scriptFindings(issues);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.summary).toContain('deploy-prod');
  });
});

describe('review follow-up to #163 (pcic-1ik0.2)', () => {
  const root = pkg({ scripts: { check: 'echo' } });

  it('counts a script with an empty command as defined, at the root, in a named directory and elsewhere', async () => {
    expect(
      scriptFindings(await scanRepo({ 'package.json': pkg({ scripts: { check: 'x', noop: '' } }), 'CLAUDE.md': '# P\n\nRun `npm run noop`.\n' })),
    ).toEqual([]);
    expect(
      scriptFindings(
        await scanRepo({
          'package.json': root,
          'site/package.json': pkg({ scripts: { noop: '' } }),
          'CLAUDE.md': '## Site (from `site/`)\n\n```sh\nnpm run noop\n```\n',
        }),
      ),
    ).toEqual([]);
    const elsewhere = scriptFindings(
      await scanRepo({ 'package.json': root, 'site/package.json': pkg({ scripts: { noop: '' } }), 'CLAUDE.md': '# P\n\nRun `npm run noop`.\n' }),
    );
    expect(elsewhere).toHaveLength(1);
    expect(elsewhere[0]!.severity).toBe('info');
  });

  it('does not take an inherited object key for a script', async () => {
    const findings = scriptFindings(
      await scanRepo({ 'package.json': root, 'site/package.json': pkg({ scripts: { dev: 'x' } }), 'CLAUDE.md': '# P\n\nRun `npm run constructor`.\n' }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('warning');
  });

  it('reads a directory named on the command\'s own line', async () => {
    const issues = await scanRepo({
      'package.json': root,
      'site/package.json': pkg({ scripts: { dev: 'x' } }),
      'CLAUDE.md': '# P\n\nFrom `site/`: run `npm run dev`.\n',
    });
    expect(scriptFindings(issues)).toEqual([]);
  });

  it('survives a malformed nested package.json without reporting from it', async () => {
    const issues = await scanRepo({
      'package.json': root,
      'broken/package.json': '{ not json',
      'site/package.json': pkg({ scripts: { dev: 'x' } }),
      'CLAUDE.md': '# P\n\nRun `npm run dev` and `npm run nothing-anywhere`.\n',
    });
    const findings = scriptFindings(issues);
    expect(findings.map((f) => `${f.severity}:${f.evidence[0]}`).sort()).toEqual([
      'info:Command: `npm run dev`',
      'warning:Command: `npm run nothing-anywhere`',
    ]);
  });
});

describe('fixture-command-scope', () => {
  it('flags only the note and the deliberately broken command', async () => {
    const findings = scriptFindings(await scanIssues(SCOPE_FIXTURE));
    const bySeverity = findings.map((f) => `${f.severity}:${f.evidence[0]}`).sort();
    expect(bySeverity).toEqual([
      'info:Command: `npm run seed`',
      'warning:Command: `npm run release:nightly`',
    ]);
    expect(findings.every((f) => f.fixEdits === undefined)).toBe(true);
  });
});

describe('fixture-monorepo-scripts', () => {
  it('flags only the deliberately broken command, exactly once', async () => {
    const findings = scriptFindings(await scanIssues(FIXTURE));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.category).toBe('command_validity');
    expect(findings[0]!.summary).toContain('release:nightly');
  });
});
