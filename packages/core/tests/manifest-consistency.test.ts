/**
 * Tests for the manifest-consistency detector (BUG-001, BUG-002, BUG-003).
 */

import { describe, it, expect } from 'vitest';
import { detectManifestConsistency, type ManifestData } from '../src/manifest-consistency.js';
import type { InstructionFile } from '../src/types.js';
import { parsePackageJsonFacts, type RepoContext } from '../src/repo-context.js';

const MOCK_METRICS = { estimatedInstructionTokens: 0, instructionFileCount: 0, largestInstructionFiles: [] };
const MOCK_WORKFLOWS = { files: [], commands: [] };

function makeFile(content: string, filePath = '/repo/CLAUDE.md'): InstructionFile {
  return {
    path: filePath,
    fileType: 'claude',
    content,
    sections: [],
    lineCount: content.split('\n').length,
    charCount: content.length,
    estimatedTokens: Math.round(content.length / 4),
  };
}

function makeContext(
  files: InstructionFile[],
  manifests: ManifestData,
  repoRoot = '/repo',
): RepoContext {
  const packageJsonFacts = parsePackageJsonFacts(
    manifests.packageJson,
    manifests.packageJson ? ['package-lock.json'] : [],
  );
  return {
    repoRoot,
    files,
    projectType: 'unknown',
    manifests,
    packageJson: packageJsonFacts,
    workflows: MOCK_WORKFLOWS,
    metrics: MOCK_METRICS,
  };
}

// ── BUG-001: pip vs Poetry ────────────────────────────────────────────────────

describe('detectManifestConsistency — BUG-001 pip vs Poetry', () => {
  const POETRY_PYPROJECT = `
[tool.poetry]
name = "flowpipe"
version = "0.1.0"

[tool.poetry.dependencies]
python = "^3.11"
pandas = "^2.1"

[build-system]
requires = ["poetry-core"]
build-backend = "poetry.core.masonry.api"
`.trim();

  it('flags pip install -r requirements.txt when project uses Poetry and no requirements.txt exists', () => {
    const file = makeFile([
      '## Environment Setup',
      'To set up the project, run:',
      '```',
      'pip install -r requirements.txt',
      '```',
    ].join('\n'));

    // Pass a non-existent repoRoot so requirements.txt check fails
    const context = makeContext(
      [file],
      { pyproject: POETRY_PYPROJECT },
      '/nonexistent/repo',
    );
    const issues = detectManifestConsistency(context);
    const toolingIssue = issues.find((i) => i.title.toLowerCase().includes('pip') || i.title.toLowerCase().includes('poetry'));
    expect(toolingIssue).toBeDefined();
    expect(toolingIssue!.severity).toBe('high');
  });

  it('does NOT flag pip install when pyproject.toml does not use Poetry', () => {
    const setupCfgPyproject = `
[build-system]
requires = ["setuptools", "wheel"]
build-backend = "setuptools.build_meta"

[project]
requires-python = ">=3.11"
`.trim();

    const file = makeFile('Run: pip install -r requirements.txt');
    const context = makeContext(
      [file],
      { pyproject: setupCfgPyproject },
      '/nonexistent/repo',
    );
    const issues = detectManifestConsistency(context);
    const toolingIssue = issues.find((i) => i.title.toLowerCase().includes('pip'));
    expect(toolingIssue).toBeUndefined();
  });

  it('returns empty when no manifests were loaded', () => {
    const file = makeFile('Run: pip install -r requirements.txt');
    const context = makeContext([file], {});
    const issues = detectManifestConsistency(context);
    expect(issues).toHaveLength(0);
  });
});

// ── BUG-002: Python version mismatch ─────────────────────────────────────────

describe('detectManifestConsistency — BUG-002 Python version mismatch', () => {
  const PYPROJECT_311 = `
[tool.poetry]
name = "flowpipe"

[tool.poetry.dependencies]
python = "^3.11"
`.trim();

  it('flags instruction saying Python 3.9 when pyproject.toml requires ^3.11', () => {
    const file = makeFile(
      '## Overview\nWe target Python 3.9 for maximum compatibility across our environments.',
    );
    const context = makeContext(
      [file],
      { pyproject: PYPROJECT_311 },
      '/repo',
    );
    const issues = detectManifestConsistency(context);
    const versionIssue = issues.find((i) => i.title.includes('3.9'));
    expect(versionIssue).toBeDefined();
    expect(versionIssue!.severity).toBe('high');
  });

  it('flags instruction saying Python 3.8 when PEP 621 requires-python requires >=3.11', () => {
    const pyproject = `
[project]
name = "flowpipe"
requires-python = ">=3.11"
`.trim();
    const file = makeFile('## Overview\nWe target Python 3.8 for compatibility.');
    const context = makeContext(
      [file],
      { pyproject },
      '/repo',
    );
    const issues = detectManifestConsistency(context);
    const versionIssue = issues.find((i) => i.title.includes('3.8'));
    expect(versionIssue).toBeDefined();
    expect(versionIssue!.severity).toBe('high');
  });

  it('does NOT flag instruction saying Python 3.11 when pyproject.toml requires ^3.11', () => {
    const file = makeFile('We target Python 3.11 and above.');
    const context = makeContext(
      [file],
      { pyproject: PYPROJECT_311 },
      '/repo',
    );
    const issues = detectManifestConsistency(context);
    const versionIssue = issues.find((i) => i.category === 'stale_instruction');
    expect(versionIssue).toBeUndefined();
  });

  it('does NOT flag negated old Python syntax guidance as a version mismatch', () => {
    const file = makeFile('Do not use Python 2.7 syntax in this project.');
    const context = makeContext(
      [file],
      { pyproject: PYPROJECT_311 },
      '/repo',
    );
    const issues = detectManifestConsistency(context);
    const versionIssue = issues.find((i) => i.title.includes('Python version mismatch'));
    expect(versionIssue).toBeUndefined();
  });

  it('does NOT flag instruction saying Python 3.12 (newer than manifest requirement)', () => {
    const file = makeFile('We use Python 3.12 with all the new features.');
    const context = makeContext(
      [file],
      { pyproject: PYPROJECT_311 },
      '/repo',
    );
    const issues = detectManifestConsistency(context);
    expect(issues.filter((i) => i.category === 'stale_instruction')).toHaveLength(0);
  });
});

// ── BUG-003: Library version mismatch ───────────────────────────────────────

describe('detectManifestConsistency — BUG-003 library version mismatch', () => {
  const PYPROJECT_PANDAS_2 = `
[tool.poetry]
name = "flowpipe"

[tool.poetry.dependencies]
python = "^3.11"
pandas = "^2.1"
numpy = "^1.26"
`.trim();

  it('flags instruction targeting Pandas 1.5 when pyproject.toml pins pandas ^2.1', () => {
    const file = makeFile(
      '## Data Processing\nTarget Pandas 1.5 compatibility — avoid 2.x-only APIs.',
    );
    const context = makeContext(
      [file],
      { pyproject: PYPROJECT_PANDAS_2 },
      '/repo',
    );
    const issues = detectManifestConsistency(context);
    const pandasIssue = issues.find((i) => i.title.includes('Pandas'));
    expect(pandasIssue).toBeDefined();
    expect(pandasIssue!.severity).toBe('high');
    expect(pandasIssue!.category).toBe('stale_instruction');
  });

  it('does NOT flag guidance matching the manifest library major version', () => {
    const file = makeFile('Target Pandas 2.x compatibility for dataframe APIs.');
    const context = makeContext(
      [file],
      { pyproject: PYPROJECT_PANDAS_2 },
      '/repo',
    );
    const issues = detectManifestConsistency(context);
    expect(issues.find((i) => i.title.includes('Pandas'))).toBeUndefined();
  });

  it('does NOT flag future-looking library version mentions as stale', () => {
    const file = makeFile('Prepare for Pandas 3.0 compatibility after the next migration.');
    const context = makeContext(
      [file],
      { pyproject: PYPROJECT_PANDAS_2 },
      '/repo',
    );
    const issues = detectManifestConsistency(context);
    expect(issues.find((i) => i.title.includes('Pandas'))).toBeUndefined();
  });

  it('detects common project.dependencies entries such as FastAPI', () => {
    const pyproject = `
[project]
dependencies = [
  "fastapi>=1.0",
]
`.trim();
    const file = makeFile('Keep FastAPI 0.95 compatibility for the service layer.');
    const context = makeContext([file], { pyproject });
    const issues = detectManifestConsistency(context);
    const fastApiIssue = issues.find((i) => i.title.includes('FastAPI'));
    expect(fastApiIssue).toBeDefined();
    expect(fastApiIssue!.severity).toBe('high');
  });

  it('does NOT treat upper-bound-only constraints as pinned newer majors', () => {
    const file = makeFile('Target Pandas 1.5 compatibility for legacy deployments.');
    const poetryContext = makeContext(
      [file],
      { pyproject: '[tool.poetry.dependencies]\npandas = "<2"' },
      '/repo',
    );
    const projectContext = makeContext(
      [file],
      { pyproject: '[project]\ndependencies = ["pandas<2"]' },
      '/repo',
    );

    const poetryIssues = detectManifestConsistency(poetryContext);
    const projectIssues = detectManifestConsistency(projectContext);

    expect(poetryIssues.find((i) => i.title.includes('Pandas'))).toBeUndefined();
    expect(projectIssues.find((i) => i.title.includes('Pandas'))).toBeUndefined();
  });

  it('does NOT confuse similarly named packages with tracked libraries', () => {
    const file = makeFile('Target Pandas 1.5 compatibility and maintain NumPy 1.x support.');
    const pyproject = `
[project]
dependencies = [
  "pandas-stubs==2.1",
  "numpy-financial>=2",
]
`.trim();

    const context = makeContext([file], { pyproject });
    const issues = detectManifestConsistency(context);
    expect(issues.find((i) => i.title.includes('Pandas'))).toBeUndefined();
    expect(issues.find((i) => i.title.toLowerCase().includes('numpy'))).toBeUndefined();
  });

  it('does NOT flag historical migration prose without compatibility intent', () => {
    const file = makeFile('Migrated from Pandas 1.5 to Pandas 2.x during the dataframe cleanup.');
    const context = makeContext(
      [file],
      { pyproject: PYPROJECT_PANDAS_2 },
      '/repo',
    );
    const issues = detectManifestConsistency(context);

    expect(issues.find((i) => i.title.includes('Pandas'))).toBeUndefined();
  });
});

// ── BUG-004: package.json library version mismatch ──────────────────────────

describe('detectManifestConsistency — BUG-004 package.json library version mismatch', () => {
  it('flags React 18 instruction guidance when package.json uses React 19', () => {
    const file = makeFile(
      '## React Guidance\nUse React 18 concurrent features and useTransition for responsive UI.',
    );
    const packageJson = JSON.stringify({
      dependencies: {
        react: '^19.2.0',
      },
    });

    const context = makeContext([file], { packageJson });
    const issues = detectManifestConsistency(context);
    const reactIssue = issues.find((i) => i.title.includes('React'));
    expect(reactIssue).toBeDefined();
    expect(reactIssue!.severity).toBe('high');
    expect(reactIssue!.category).toBe('stale_instruction');
  });

  it('does NOT flag React guidance matching package.json major version', () => {
    const file = makeFile('Use React 19 features for transitions and optimistic updates.');
    const packageJson = JSON.stringify({
      dependencies: {
        react: '^19.2.0',
      },
    });

    const context = makeContext([file], { packageJson });
    const issues = detectManifestConsistency(context);
    expect(issues.find((i) => i.title.includes('React'))).toBeUndefined();
  });

  it('does NOT flag invalid package.json content', () => {
    const file = makeFile('Use React 18 features.');
    const context = makeContext([file], { packageJson: '{bad json' });
    const issues = detectManifestConsistency(context);
    expect(issues).toHaveLength(0);
  });
});

describe('detectManifestConsistency — JS/TS specific detectors', () => {
  it('flags package manager mismatch (npm instructions in pnpm project)', () => {
    const file = makeFile('Run `npm install` to set up.');
    const packageJson = JSON.stringify({ name: 'test' });
    const context = makeContext([file], { packageJson });
    // Override packageManagerName for testing
    context.packageJson.packageManagerName = 'pnpm';
    context.packageJson.lockfiles = ['pnpm-lock.yaml'];

    const issues = detectManifestConsistency(context);
    const issue = issues.find(i => i.id === 'manifest-package-manager-mismatch');
    expect(issue).toBeDefined();
    expect(issue!.title).toContain('pnpm');
    expect(issue!.severity).toBe('warning');
  });

  it('does NOT flag npm install -g pnpm as a package-manager mismatch in a pnpm project', () => {
    const file = makeFile('Install pnpm with `npm install -g pnpm`, then run `pnpm install`.');
    const packageJson = JSON.stringify({ name: 'test' });
    const context = makeContext([file], { packageJson });
    context.packageJson.packageManagerName = 'pnpm';
    context.packageJson.lockfiles = ['pnpm-lock.yaml'];

    const issues = detectManifestConsistency(context);
    const issue = issues.find(i => i.id === 'manifest-package-manager-mismatch');
    expect(issue).toBeUndefined();
  });

  it('flags missing scripts', () => {
    const file = makeFile('Run `npm run build:prod` to build.');
    const packageJson = JSON.stringify({
      scripts: {
        build: 'vite build',
      },
    });
    const context = makeContext([file], { packageJson });

    const issues = detectManifestConsistency(context);
    const issue = issues.find(i => i.id.startsWith('manifest-missing-script') && i.title.includes('build:prod'));
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('warning');
  });

  it('does NOT flag missing scripts when package.json has no scripts key', () => {
    const file = makeFile('Run `pnpm build:prod` to build.');
    const packageJson = JSON.stringify({ name: 'scripts-less' });
    const context = makeContext([file], { packageJson });

    const issues = detectManifestConsistency(context);
    const missingScripts = issues.filter(i => i.id.startsWith('manifest-missing-script'));
    expect(missingScripts).toHaveLength(0);
  });

  it('does NOT flag standard npm commands as missing scripts', () => {
    const file = makeFile('Run `npm test` and `npm start`.');
    const packageJson = JSON.stringify({
      scripts: {
        test: 'vitest',
      },
    });
    const context = makeContext([file], { packageJson });

    const issues = detectManifestConsistency(context);
    const missingScripts = issues.filter(i => i.id.startsWith('manifest-missing-script'));
    // 'test' is present, 'start' is standard
    expect(missingScripts).toHaveLength(0);
  });

  it('flags Node.js version mismatch', () => {
    const file = makeFile('This project requires Node 18.');
    const packageJson = JSON.stringify({
      engines: {
        node: '>=20.0.0',
      },
    });
    const context = makeContext([file], { packageJson });

    const issues = detectManifestConsistency(context);
    const issue = issues.find(i => i.id.startsWith('manifest-node-version-mismatch'));
    expect(issue).toBeDefined();
    expect(issue!.summary).toContain('20');
  });

  // ── MF1: skip-list gaps (npm ci, bare "pnpm run") ──────────────────────────

  it('MF1: does NOT flag "npm ci" as a missing script named "ci"', () => {
    const file = makeFile('Run `npm ci` to install dependencies.');
    const packageJson = JSON.stringify({ scripts: { build: 'vite build' } });
    const context = makeContext([file], { packageJson });

    const issues = detectManifestConsistency(context);
    expect(issues.some(i => i.id.startsWith('manifest-missing-script') && i.title.includes('"ci"'))).toBe(false);
  });

  it('MF1: does NOT flag bare "pnpm run" prose as a missing script named "run"', () => {
    const file = makeFile('You can pnpm run any of the scripts defined below.');
    const packageJson = JSON.stringify({ scripts: { build: 'vite build' } });
    const context = makeContext([file], { packageJson });

    const issues = detectManifestConsistency(context);
    expect(issues.some(i => i.id.startsWith('manifest-missing-script') && i.title.includes('"run"'))).toBe(false);
  });

  it('MF1: does NOT flag pnpm flags or workspace subcommands as missing scripts', () => {
    const file = makeFile([
      'Run `pnpm --filter web build` when validating the web app.',
      'Use `pnpm workspace web build` only when targeting that workspace.',
    ].join('\n'));
    const packageJson = JSON.stringify({ scripts: { build: 'vite build' } });
    const context = makeContext([file], { packageJson });

    const issues = detectManifestConsistency(context);
    const missingScripts = issues.filter(i => i.id.startsWith('manifest-missing-script'));
    expect(missingScripts).toHaveLength(0);
  });

  // ── MF2: underscore in script names ─────────────────────────────────────────

  it('MF2: flags a missing script containing an underscore ("build_all")', () => {
    const file = makeFile('Run `pnpm build_all` before releasing.');
    const packageJson = JSON.stringify({ scripts: { build: 'vite build' } });
    const context = makeContext([file], { packageJson });

    const issues = detectManifestConsistency(context);
    expect(issues.some(i => i.id.startsWith('manifest-missing-script') && i.title.includes('build_all'))).toBe(true);
  });

  it('MF2: does NOT flag an existing underscore-named script', () => {
    const file = makeFile('Run `pnpm build_all` before releasing.');
    const packageJson = JSON.stringify({ scripts: { build_all: 'vite build --all' } });
    const context = makeContext([file], { packageJson });

    const issues = detectManifestConsistency(context);
    expect(issues.some(i => i.id.startsWith('manifest-missing-script') && i.title.includes('build_all'))).toBe(false);
  });

  // ── MF3: Node version negation + duplicate-id dedupe ───────────────────────

  it('MF-A: does NOT treat package-manager flags as script names', () => {
    const file = makeFile('Run `pnpm --filter @promptci/core test` before releasing.');
    const packageJson = JSON.stringify({ scripts: { test: 'vitest' } });
    const context = makeContext([file], { packageJson });

    const issues = detectManifestConsistency(context);
    expect(issues.some(i => i.id.startsWith('manifest-missing-script') && i.title.includes('--filter'))).toBe(false);
  });

  it('MF-A: does NOT treat prose nouns after npm as script names', () => {
    const file = makeFile('This repo is an npm package used by the CLI.');
    const packageJson = JSON.stringify({ scripts: { build: 'tsc' } });
    const context = makeContext([file], { packageJson });

    const issues = detectManifestConsistency(context);
    expect(issues.some(i => i.id.startsWith('manifest-missing-script') && i.title.includes('package'))).toBe(false);
  });

  it('MF-A: does NOT treat prose continuation words after pnpm as script names', () => {
    const file = makeFile('Use pnpm instead of npm. npm scripts are defined in package.json.');
    const packageJson = JSON.stringify({ scripts: { build: 'tsc' } });
    const context = makeContext([file], { packageJson });

    const issues = detectManifestConsistency(context);
    const missingScripts = issues.filter(i => i.id.startsWith('manifest-missing-script'));
    expect(missingScripts).toHaveLength(0);
  });

  it('MF-A: does NOT flag pnpm store prune as a missing script', () => {
    const file = makeFile('Run `pnpm store prune` when the package cache gets large.');
    const packageJson = JSON.stringify({ scripts: { build: 'tsc' } });
    const context = makeContext([file], { packageJson });

    const issues = detectManifestConsistency(context);
    expect(issues.some(i => i.id.startsWith('manifest-missing-script') && i.title.includes('store'))).toBe(false);
  });

  // ── MF4: prose after npm/pnpm is not a script name (issue #3) ──────────────

  it('MF4: does NOT flag version requirements after a package manager ("pnpm 9+")', () => {
    const file = makeFile([
      '# Instructions',
      '',
      'Requirements: Node.js 22+, pnpm 9+.',
      'Dependencies are consumed from the npm registry.',
    ].join('\n'));
    const packageJson = JSON.stringify({ scripts: { build: 'echo hi' } });
    const context = makeContext([file], { packageJson });

    const issues = detectManifestConsistency(context);
    const missingScripts = issues.filter(i => i.id.startsWith('manifest-missing-script'));
    expect(missingScripts).toHaveLength(0);
  });

  it('MF4: does NOT flag a numeric token even inside a code span ("`pnpm 9`")', () => {
    const file = makeFile('This repo needs `pnpm 9` or newer.');
    const packageJson = JSON.stringify({ scripts: { build: 'tsc' } });
    const context = makeContext([file], { packageJson });

    const issues = detectManifestConsistency(context);
    expect(issues.filter(i => i.id.startsWith('manifest-missing-script'))).toHaveLength(0);
  });

  it('MF4: does NOT flag prose nouns after a package manager ("npm registry")', () => {
    const file = makeFile('Published to the npm registry; pnpm workspaces link the pnpm packages.');
    const packageJson = JSON.stringify({ scripts: { build: 'tsc' } });
    const context = makeContext([file], { packageJson });

    const issues = detectManifestConsistency(context);
    expect(issues.filter(i => i.id.startsWith('manifest-missing-script'))).toHaveLength(0);
  });

  it('MF4: still flags a bare invocation inside a fenced code block', () => {
    const file = makeFile([
      'Build the app:',
      '',
      '```bash',
      'pnpm build:prod',
      '```',
    ].join('\n'));
    const packageJson = JSON.stringify({ scripts: { build: 'vite build' } });
    const context = makeContext([file], { packageJson });

    const issues = detectManifestConsistency(context);
    expect(issues.some(i => i.id.startsWith('manifest-missing-script') && i.title.includes('build:prod'))).toBe(true);
  });

  it('MF4: still flags an explicit "npm run <name>" written in prose', () => {
    const file = makeFile('Before pushing, run npm run typecheck to verify the build.');
    const packageJson = JSON.stringify({ scripts: { build: 'tsc' } });
    const context = makeContext([file], { packageJson });

    const issues = detectManifestConsistency(context);
    expect(issues.some(i => i.id.startsWith('manifest-missing-script') && i.title.includes('typecheck'))).toBe(true);
  });

  it('MF4: does NOT flag "pnpm run any of the scripts" prose as a script named "any"', () => {
    const file = makeFile('You can pnpm run any of the scripts defined below.');
    const packageJson = JSON.stringify({ scripts: { build: 'vite build' } });
    const context = makeContext([file], { packageJson });

    const issues = detectManifestConsistency(context);
    expect(issues.filter(i => i.id.startsWith('manifest-missing-script'))).toHaveLength(0);
  });

  it('MF3: does NOT flag "Do not use Node 14" as a version mismatch', () => {
    const file = makeFile('Do not use Node 14 for this project.');
    const packageJson = JSON.stringify({ engines: { node: '>=20.0.0' } });
    const context = makeContext([file], { packageJson });

    const issues = detectManifestConsistency(context);
    expect(issues.some(i => i.id.startsWith('manifest-node-version-mismatch'))).toBe(false);
  });

  it('MF3/B2: emits only ONE issue when the same old Node version is mentioned twice in one file', () => {
    const file = makeFile('This project requires Node 12. We still support Node 12 in CI.');
    const packageJson = JSON.stringify({ engines: { node: '>=20.0.0' } });
    const context = makeContext([file], { packageJson });

    const issues = detectManifestConsistency(context);
    const matches = issues.filter(i => i.id.startsWith('manifest-node-version-mismatch'));
    expect(matches).toHaveLength(1);
  });

  it('flags tooling mismatch (Jest vs Vitest)', () => {
    const file = makeFile('We use Jest for testing.');
    const packageJson = JSON.stringify({
      devDependencies: {
        vitest: '^1.0.0',
      },
    });
    const context = makeContext([file], { packageJson });

    const issues = detectManifestConsistency(context);
    const issue = issues.find(i => i.id === 'manifest-js-tooling-mismatch:jest');
    expect(issue).toBeDefined();
    expect(issue!.summary).toContain('vitest');
  });

  it('flags tooling mismatch (Cypress vs Playwright)', () => {
    const file = makeFile('Run Cypress tests with `npm run cy:open`.');
    const packageJson = JSON.stringify({
      devDependencies: {
        '@playwright/test': '^1.40.0',
      },
      scripts: {
        'test:e2e': 'playwright test',
      },
    });
    const context = makeContext([file], { packageJson });

    const issues = detectManifestConsistency(context);
    const issue = issues.find(i => i.id === 'manifest-js-tooling-mismatch:cypress');
    expect(issue).toBeDefined();
    expect(issue!.summary).toContain('@playwright/test');
  });

  it('does NOT flag when BOTH tools are present (e.g. migration period)', () => {
    const file = makeFile('We use Jest for unit tests.');
    const packageJson = JSON.stringify({
      devDependencies: {
        jest: '^29.0.0',
        vitest: '^1.0.0',
      },
    });
    const context = makeContext([file], { packageJson });

    const issues = detectManifestConsistency(context);
    expect(issues.find(i => i.id.includes('js-tooling-mismatch'))).toBeUndefined();
  });
});

// ── False-positive avoidance: negation and migration-history prose ─────────────

describe('detectManifestConsistency — false-positive avoidance', () => {
  it('does NOT flag "do not use npm" instruction in a pnpm project as a mismatch', () => {
    // The instruction is correct advisory guidance; it should not be flagged.
    const file = makeFile(
      'This project uses pnpm. Do not use npm install or npm run to avoid lockfile drift.',
    );
    const packageJson = JSON.stringify({ name: 'my-pnpm-project' });
    const context = makeContext([file], { packageJson });
    context.packageJson.packageManagerName = 'pnpm';
    context.packageJson.lockfiles = ['pnpm-lock.yaml'];

    const issues = detectManifestConsistency(context);
    const pmIssue = issues.find((i) => i.id === 'manifest-package-manager-mismatch');
    expect(pmIssue).toBeUndefined();
  });

  it('DOES flag "npm install" (positive command) in a pnpm project', () => {
    const file = makeFile('Set up the project by running npm install in the root.');
    const packageJson = JSON.stringify({ name: 'my-pnpm-project' });
    const context = makeContext([file], { packageJson });
    context.packageJson.packageManagerName = 'pnpm';
    context.packageJson.lockfiles = ['pnpm-lock.yaml'];

    const issues = detectManifestConsistency(context);
    const pmIssue = issues.find((i) => i.id === 'manifest-package-manager-mismatch');
    expect(pmIssue).toBeDefined();
  });

  it('does NOT flag "do not use Jest" instruction in a Vitest project', () => {
    // Instructions explicitly say to avoid Jest — that is correct, not a mismatch.
    const file = makeFile(
      'Do not use Jest for testing. This project uses Vitest; run `pnpm test`.',
    );
    const packageJson = JSON.stringify({
      devDependencies: {
        vitest: '^1.6.0',
      },
    });
    const context = makeContext([file], { packageJson });

    const issues = detectManifestConsistency(context);
    const toolIssue = issues.find((i) => i.id === 'manifest-js-tooling-mismatch:jest');
    expect(toolIssue).toBeUndefined();
  });

  it('does NOT flag migration-history prose ("migrated from Jest to Vitest")', () => {
    // Historical context should not be treated as an active instruction to use Jest.
    const file = makeFile(
      'We migrated from Jest to Vitest in Q3 2024. All tests now use Vitest.',
    );
    const packageJson = JSON.stringify({
      devDependencies: {
        vitest: '^1.6.0',
      },
    });
    const context = makeContext([file], { packageJson });

    const issues = detectManifestConsistency(context);
    const toolIssue = issues.find((i) => i.id === 'manifest-js-tooling-mismatch:jest');
    expect(toolIssue).toBeUndefined();
  });

  it('does NOT flag "switched from Cypress to Playwright" migration note', () => {
    const file = makeFile(
      'We switched from Cypress to Playwright for end-to-end tests. Use `pnpm test:e2e`.',
    );
    const packageJson = JSON.stringify({
      devDependencies: {
        '@playwright/test': '^1.45.0',
      },
    });
    const context = makeContext([file], { packageJson });

    const issues = detectManifestConsistency(context);
    const toolIssue = issues.find((i) => i.id === 'manifest-js-tooling-mismatch:cypress');
    expect(toolIssue).toBeUndefined();
  });

  it('DOES flag positive Cypress reference in a Playwright-only project', () => {
    const file = makeFile('Run Cypress to execute end-to-end tests before merging.');
    const packageJson = JSON.stringify({
      devDependencies: {
        '@playwright/test': '^1.45.0',
      },
    });
    const context = makeContext([file], { packageJson });

    const issues = detectManifestConsistency(context);
    const toolIssue = issues.find((i) => i.id === 'manifest-js-tooling-mismatch:cypress');
    expect(toolIssue).toBeDefined();
  });

  it('does NOT flag "avoid npm" (negation) even when followed by a command word', () => {
    const file = makeFile(
      "Avoid npm install; prefer pnpm install. Don't use npm run either.",
    );
    const packageJson = JSON.stringify({ name: 'pnpm-repo' });
    const context = makeContext([file], { packageJson });
    context.packageJson.packageManagerName = 'pnpm';
    context.packageJson.lockfiles = ['pnpm-lock.yaml'];

    const issues = detectManifestConsistency(context);
    const pmIssue = issues.find((i) => i.id === 'manifest-package-manager-mismatch');
    expect(pmIssue).toBeUndefined();
  });
});
