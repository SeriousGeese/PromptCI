/**
 * pcic-2b6.11: dependency and framework-API staleness against the manifests.
 *
 * (a) packages named in instructions that no package.json declares,
 * (b) a short list of deprecated packages recommended by the instructions,
 * (c) version-gated APIs (ReactDOM.render, getInitialProps, NgModule).
 *
 * Every rule has negatives: the point of this detector is to stay quiet unless
 * the instruction text is plainly pointing at something the repo disagrees with.
 */

import * as fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { detectDependencyStaleness } from '../src/dependency-staleness.js';
import { buildRepoContext } from '../src/repo-context.js';
import { scan } from '../src/scan.js';
import type { PromptCiIssue } from '../src/types.js';
import { makeTempRepo, writeFile } from './ai-config-helpers.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const FENCE = '```';
function fence(lang: string, body: string): string {
  return [`${FENCE}${lang}`, body, FENCE].join('\n');
}

function pkg(deps: Record<string, string> = {}, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ name: 'app', version: '1.0.0', dependencies: deps, ...extra });
}

function repoWith(files: Record<string, string>): string {
  const repo = makeTempRepo('promptci-depstale-');
  tempDirs.push(repo);
  for (const [rel, content] of Object.entries(files)) writeFile(repo, rel, content);
  return repo;
}

async function detect(files: Record<string, string>): Promise<PromptCiIssue[]> {
  const context = await buildRepoContext({ repoPath: repoWith(files) });
  return detectDependencyStaleness(context);
}

/** Instructions body in CLAUDE.md with a root manifest. */
async function detectIn(instructions: string, deps: Record<string, string> = {}, extra: Record<string, string> = {}) {
  return detect({ 'package.json': pkg(deps), 'CLAUDE.md': `# Project\n\n${instructions}\n`, ...extra });
}

function titles(issues: PromptCiIssue[]): string[] {
  return issues.map((i) => i.title);
}

// ── (a) packages absent from every manifest ───────────────────────────────────

describe('missing package (a)', () => {
  it('flags a package named by an install command', async () => {
    const issues = await detectIn(fence('bash', 'npm install zod'), { react: '^18.0.0' });
    expect(titles(issues)).toEqual(['Package named in instructions is not in any package.json: zod']);
    const [issue] = issues;
    expect(issue!.severity).toBe('warning');
    expect(issue!.confidence).toBe(0.5);
    expect(issue!.category).toBe('stale_instruction');
    expect(issue!.locations[0]).toMatchObject({ startLine: 4 });
    expect(issue!.filePaths[0]).toMatch(/CLAUDE\.md$/);
  });

  it.each([
    ['npm i zod', 'zod'],
    ['npm add zod@^3.22.0', 'zod'],
    ['pnpm add -D zustand', 'zustand'],
    ['yarn add --dev zustand', 'zustand'],
    ['bun add zustand', 'zustand'],
    ['pnpm --filter web add zustand', 'zustand'],
    ['yarn workspace web add zustand', 'zustand'],
    ['$ npm install --save-exact zustand', 'zustand'],
    ['npm install @tanstack/react-query', '@tanstack/react-query'],
    ['pnpm add @tanstack/react-query@latest', '@tanstack/react-query'],
  ])('reads the package out of `%s`', async (command, name) => {
    const issues = await detectIn(fence('bash', command));
    expect(titles(issues)).toEqual([`Package named in instructions is not in any package.json: ${name}`]);
  });

  it('flags only the undeclared packages of a multi-package install', async () => {
    const issues = await detectIn(fence('sh', 'pnpm add -D vitest zustand && pnpm build'), { vitest: '^2.0.0' });
    expect(titles(issues)).toEqual(['Package named in instructions is not in any package.json: zustand']);
  });

  it('flags a package named by an import or require line', async () => {
    const issues = await detectIn(
      fence('ts', "import { create } from 'zustand';\nconst x = require('left-pad');\nimport('dayjs');"),
    );
    expect(titles(issues).sort()).toEqual([
      'Package named in instructions is not in any package.json: dayjs',
      'Package named in instructions is not in any package.json: left-pad',
      'Package named in instructions is not in any package.json: zustand',
    ]);
  });

  it('takes the package name out of a sub-path import', async () => {
    const issues = await detectIn(fence('ts', "import { x } from 'zustand/middleware';"));
    expect(titles(issues)).toEqual(['Package named in instructions is not in any package.json: zustand']);
  });

  it('does not treat prose that calls a code span a package as an install or import', async () => {
    // Real examples: a transitive dependency described in passing, and a system tool.
    expect(
      await detectIn(
        'Keep one file per `playwright-core` package root. After installing `bd`, verify hooks. Install `cloudflared` on the router.\n' +
          'State lives in the `zustand` library; validation uses the package `valibot`.',
      ),
    ).toEqual([]);
  });

  it('lists every file that mentions the package, once each', async () => {
    const issues = await detect({
      'package.json': pkg(),
      'CLAUDE.md': `# A\n\n${fence('bash', 'npm i zod\nnpm i zod')}\n`,
      'AGENTS.md': `# B\n\nInstall it with \`pnpm add zod\`.\n`,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.filePaths).toHaveLength(2);
  });

  it('has a stable id that does not depend on where the repo is checked out', async () => {
    const files = { 'package.json': pkg(), 'CLAUDE.md': `# A\n\n${fence('bash', 'npm i zod')}\n` };
    const [a] = await detect(files);
    const [b] = await detect(files);
    expect(a!.id).toBe(b!.id);
    expect(a!.id).toMatch(/^dep-staleness-missing-package-[0-9a-f]{12}$/);
  });

  describe('stays quiet when', () => {
    it.each([
      ['dependencies', { zod: '^3.0.0' }, {}],
      ['devDependencies', {}, { devDependencies: { zod: '^3.0.0' } }],
      ['peerDependencies', {}, { peerDependencies: { zod: '^3.0.0' } }],
      ['optionalDependencies', {}, { optionalDependencies: { zod: '^3.0.0' } }],
    ])('the package is in %s', async (_label, deps, extra) => {
      const issues = await detect({
        'package.json': pkg(deps, extra),
        'CLAUDE.md': `# A\n\n${fence('bash', 'npm install zod')}\n`,
      });
      expect(issues).toEqual([]);
    });

    it('a workspace package declares it', async () => {
      const issues = await detect({
        'package.json': pkg({}, { workspaces: ['apps/*'] }),
        'apps/web/package.json': pkg({ zod: '^3.0.0' }),
        'CLAUDE.md': `# A\n\n${fence('bash', 'pnpm --filter web add zod')}\n`,
      });
      expect(issues).toEqual([]);
    });

    it('a manifest outside the conventional workspace directories declares it', async () => {
      const issues = await detect({
        'package.json': pkg(),
        'services/api/package.json': pkg({ zod: '^3.0.0' }),
        'CLAUDE.md': `# A\n\n${fence('bash', 'npm install zod')}\n`,
      });
      expect(issues).toEqual([]);
    });

    it('it is a sibling workspace package of this repo', async () => {
      const issues = await detect({
        'package.json': pkg({}, { workspaces: ['packages/*'] }),
        'packages/ui/package.json': JSON.stringify({ name: '@acme/ui', version: '1.0.0' }),
        'CLAUDE.md': `# A\n\n${fence('bash', 'pnpm add @acme/ui')}\n`,
      });
      expect(issues).toEqual([]);
    });

    it('it is a Node.js built-in', async () => {
      const issues = await detectIn(
        fence('js', "import fs from 'node:fs';\nimport path from 'path';\nconst c = require('crypto');\nimport { x } from 'fs/promises';"),
      );
      expect(issues).toEqual([]);
    });

    it('it is a global install', async () => {
      expect(await detectIn(fence('bash', 'npm install -g typescript\nnpm i --global zx\npnpm add -g turbo'))).toEqual([]);
    });

    it('it is a package manager or runtime', async () => {
      expect(await detectIn(fence('bash', 'npm install pnpm\nnpm i yarn'))).toEqual([]);
    });

    it('it is run one-off rather than installed', async () => {
      expect(await detectIn(fence('bash', 'npx create-next-app@latest\npnpm dlx shadcn@latest init\nnpm exec cowsay'))).toEqual([]);
    });

    it.each([
      'npm install <package>',
      'npm install package-name',
      'npm i my-package',
      'pnpm add your-package',
      'npm install @scope/pkg',
      'npm i @your-org/utils',
      'npm i @myorg/shared',
      'npm install foo bar',
      'npm install some-package',
    ])('it is a placeholder (%s)', async (command) => {
      expect(await detectIn(fence('bash', command))).toEqual([]);
    });

    it('it is not a registry name', async () => {
      const commands = [
        'npm install ./local-lib',
        'npm install ../sibling',
        'npm install github:user/repo',
        'npm install git+https://github.com/user/repo.git',
        'npm install https://example.com/pkg.tgz',
        'npm install $PACKAGE',
        'npm install npm:other-name@1',
        'npm install file:../x',
        'npm install Zod',
      ];
      expect(await detectIn(fence('bash', commands.join('\n')))).toEqual([]);
    });

    it('the command has a flag it cannot read', async () => {
      // Without knowing `--registry` takes a value, `https://...` would be misread as a package.
      expect(await detectIn(fence('bash', 'npm install --registry https://registry.example.com zod'))).toEqual([]);
    });

    it('the install has no package arguments', async () => {
      expect(await detectIn(fence('bash', 'pnpm install\nnpm ci\nyarn install\nbun install --frozen-lockfile'))).toEqual([]);
    });

    it.each([
      'Do not install `left-pad`; write the three lines yourself.',
      'Never run `npm install lodash` here.',
      'Use `pnpm add zod` instead of `npm install joi`.',
      'We migrated off the `request` package last year.',
      'Avoid the `moment-timezone` dependency.',
      'The `left-pad` package is deprecated and was removed.',
    ])('the line says not to (%s)', async (line) => {
      expect(await detectIn(line, { zod: '^3.0.0' })).toEqual([]);
    });

    it('a negated line sits inside a code fence', async () => {
      expect(await detectIn(fence('bash', '# never do this\nnpm install left-pad  # do not'))).toEqual([]);
    });

    it('an import is relative, aliased or uses a protocol', async () => {
      const lines = [
        "import a from './a';",
        "import b from '../b';",
        "import c from '/abs/c';",
        "import d from '@/lib/d';",
        "import e from '~/e';",
        "import f from '#internal/f';",
        "import g from 'node:test';",
        "import h from 'npm:hono';",
        "import i from 'https://deno.land/x/i.ts';",
      ];
      expect(await detectIn(fence('ts', lines.join('\n')))).toEqual([]);
    });

    it('an import names a path alias or a local directory', async () => {
      const issues = await detect({
        'package.json': pkg(),
        'src/widgets/index.ts': '',
        'CLAUDE.md': `# A\n\n${fence('ts', "import { Button } from 'components/Button';\nimport { w } from 'widgets';\nimport { x } from 'utils';")}\n`,
      });
      expect(issues).toEqual([]);
    });

    it('a scoped import comes from a scope the repo does not use (a path alias)', async () => {
      const issues = await detectIn(fence('ts', "import { x } from '@lib/utils';\nimport { y } from '@components/Button';"), {
        react: '^18.0.0',
      });
      expect(issues).toEqual([]);
    });

    it('is a code span with no package wording around it', async () => {
      expect(await detectIn('Call `zustand` and `valibot` and `request` as needed. A `foo-bar` class.')).toEqual([]);
    });

    it("an import names one of this monorepo's own packages by its short or directory name", async () => {
      const issues = await detect({
        'package.json': pkg({}, { workspaces: ['apps/*', 'packages/*'] }),
        'apps/web/package.json': JSON.stringify({ name: '@acme/web', version: '1.0.0' }),
        'packages/billing/package.json': JSON.stringify({ name: '@acme/billing-core', version: '1.0.0' }),
        'CLAUDE.md': `# A\n\n${fence('ts', "import { page } from 'web';\nimport { invoice } from 'billing';\nimport { core } from 'billing-core';")}\n`,
      });
      expect(issues).toEqual([]);
    });

    it('the install runs after a cd, so the target manifest is not the root one', async () => {
      const lines = [
        'cd tools && npm install zod',
        'pushd scripts; npm i zod',
        '(cd .ds-sync && npm i esbuild ts-morph && npx playwright install chromium)',
      ];
      for (const line of lines) expect(await detectIn(fence('bash', line))).toEqual([]);
      // an earlier line of the same block changed directory
      expect(await detectIn(fence('bash', 'cd .ds-sync\nnpm i esbuild ts-morph'))).toEqual([]);
      // ...but a later block starts over from the repo root
      expect(
        titles(await detectIn(`${fence('bash', 'cd tools')}\n\n${fence('bash', 'npm i zod')}`)),
      ).toEqual(['Package named in instructions is not in any package.json: zod']);
    });

    it.each(['npm install --prefix tools zod', 'npm i zod --prefix=tools', 'pnpm -C tools add zod', 'pnpm add zod --dir tools', 'yarn --cwd tools add zod'])(
      'the install is pointed at another directory (%s)',
      async (command) => {
        expect(await detectIn(fence('bash', command))).toEqual([]);
      },
    );

    it.each([
      'Put it in the `dev` dependency group.',
      'The `optional` dependency list is empty.',
      'Run it with the `root` package.',
    ])('a generic word is called a package (%s)', async (line) => {
      expect(await detectIn(line)).toEqual([]);
    });

    it('is in a fence of another language', async () => {
      const python = fence('python', 'import requests\nfrom flask import Flask\npip install flask');
      const yaml = fence('yaml', 'run: npm install zod');
      expect(await detectIn(`${python}\n\n${yaml}`)).toEqual([]);
    });

    it('the instruction file is a README or other human-facing doc', async () => {
      const issues = await detect({
        'package.json': pkg(),
        'README.md': `# App\n\n${fence('bash', 'npm install zod')}\n`,
        'CONTRIBUTING.md': `# Contributing\n\n${fence('bash', 'npm install zod')}\n`,
        'AGENTS.md': '# Agents\n\nBe careful.\n',
      });
      expect(issues).toEqual([]);
    });

    it('the repo is not a JavaScript project (no package.json)', async () => {
      const issues = await detect({
        'pyproject.toml': '[project]\nname = "x"\n',
        'CLAUDE.md': `# A\n\n${fence('bash', 'npm install zod')}\n`,
      });
      expect(issues).toEqual([]);
    });

    it('workspace discovery was cut short, so the manifests are only a sample', async () => {
      const context = await buildRepoContext({
        repoPath: repoWith({ 'package.json': pkg(), 'CLAUDE.md': `# A\n\n${fence('bash', 'npm install zod')}\n` }),
      });
      expect(detectDependencyStaleness(context)).toHaveLength(1);
      expect(detectDependencyStaleness({ ...context, workspacesTruncated: true })).toEqual([]);
    });

    it('a binary of an installed tool is named (pnpm vitest)', async () => {
      expect(await detectIn(fence('bash', 'pnpm add -D vitest'), { vitest: '^2.0.0' })).toEqual([]);
    });
  });

  describe('scoped names from non-install mentions', () => {
    it('are believed when the repo already uses the scope', async () => {
      const issues = await detectIn(fence('ts', "import { useQuery } from '@tanstack/react-query';"), {
        '@tanstack/react-table': '^8.0.0',
      });
      expect(titles(issues)).toEqual(['Package named in instructions is not in any package.json: @tanstack/react-query']);
    });
  });
});

// ── (b) deprecated packages ───────────────────────────────────────────────────

describe('deprecated package (b)', () => {
  it('warns when instructions recommend a deprecated package no manifest declares', async () => {
    const issues = await detectIn(fence('bash', 'npm install moment'));
    // One finding, not also a "missing package" one.
    expect(titles(issues)).toEqual(['Instructions point at a deprecated package: moment']);
    expect(issues[0]!.severity).toBe('warning');
    expect(issues[0]!.summary).toContain('date-fns');
    expect(issues[0]!.summary).toContain('No package.json in this repo declares it');
    expect(issues[0]!.id).toMatch(/^dep-staleness-deprecated-/);
  });

  it('is info when a manifest declares it', async () => {
    const issues = await detectIn('Format dates with the `moment` package.', { moment: '^2.29.0' });
    expect(titles(issues)).toEqual(['Instructions point at a deprecated package: moment']);
    expect(issues[0]!.severity).toBe('info');
    expect(issues[0]!.summary).toContain('still declares it');
  });

  it.each([
    ['moment', "import moment from 'moment';", 'date-fns'],
    ['request', "const request = require('request');", 'fetch'],
    ['request', 'npm install request', 'fetch'],
    ['request', 'Make calls with the `request` library.', 'fetch'],
    ['enzyme', "import { shallow } from 'enzyme';", '@testing-library/react'],
    ['node-sass', 'npm install -D node-sass', 'sass (Dart Sass)'],
    ['tslint', 'npx tslint -p tsconfig.json', 'typescript-eslint'],
    ['tslint', 'Lint with `tslint`.', 'typescript-eslint'],
    ['react-scripts', 'react-scripts start', 'Vite'],
    ['react-scripts', 'yarn react-scripts test', 'Vite'],
    ['react-scripts', 'The app is built with `react-scripts`.', 'Vite'],
  ])('finds %s via %j', async (name, text, replacement) => {
    const body = /^(?:import|const|npm|npx|react-scripts|yarn)/.test(text) ? fence('bash', text) : text;
    const issues = await detectIn(/^(?:import|const)/.test(text) ? fence('js', text) : body);
    expect(titles(issues)).toEqual([`Instructions point at a deprecated package: ${name}`]);
    expect(issues[0]!.summary).toContain(replacement);
  });

  describe('stays quiet when', () => {
    it.each([
      "Don't use `moment`; use date-fns.",
      'Avoid `enzyme` in new tests.',
      'We migrated from enzyme to Testing Library. Never use `enzyme`.',
      'Replaced `tslint` with ESLint.',
      '`react-scripts` is deprecated, do not add it.',
    ])('the line says not to (%s)', async (line) => {
      expect(await detectIn(line, { moment: '^2.0.0', enzyme: '^3.0.0' })).toEqual([]);
    });

    it('"request" is only an ordinary word or identifier', async () => {
      expect(
        await detectIn('Handle each `request` in the route. The request object has a `body`.\n\n' + fence('ts', 'const request = new Request(url);')),
      ).toEqual([]);
    });

    it('a manifest declares the deprecated package but the instructions never mention it', async () => {
      expect(await detectIn('Run the tests.', { moment: '^2.29.0', enzyme: '^3.11.0' })).toEqual([]);
    });

    it('moment is only prose', async () => {
      expect(await detectIn('At the moment we are mid-migration; this is a key moment.')).toEqual([]);
    });
  });
});

// ── (c) version-gated APIs ────────────────────────────────────────────────────

describe('ReactDOM.render (c)', () => {
  const RENDER = fence('tsx', 'ReactDOM.render(<App />, document.getElementById("root"));');

  it('is a warning on React 18', async () => {
    const issues = await detectIn(RENDER, { react: '^18.2.0', 'react-dom': '^18.2.0' });
    expect(titles(issues)).toEqual(['Instructions use ReactDOM.render, which is the legacy React 17 root API']);
    expect(issues[0]!.severity).toBe('warning');
    expect(issues[0]!.summary).toContain('createRoot');
  });

  it('is high on React 19, where it was removed', async () => {
    const issues = await detectIn(RENDER, { react: '^19.0.0', 'react-dom': '^19.0.0' });
    expect(titles(issues)).toEqual(['Instructions use ReactDOM.render, which React 19 removed']);
    expect(issues[0]!.severity).toBe('high');
  });

  it('reads plain prose too', async () => {
    const issues = await detectIn('Mount the app with ReactDOM.render in index.tsx.', { react: '~19.0.0' });
    expect(issues).toHaveLength(1);
  });

  it.each([
    ['React 17', { react: '^17.0.2', 'react-dom': '^17.0.2' }],
    ['React 16', { react: '16.14.0' }],
    ['no React', { vue: '^3.0.0' }],
    ['an unreadable range', { react: 'latest', 'react-dom': 'latest' }],
    ['a catalog reference', { react: 'catalog:', 'react-dom': 'catalog:' }],
    ['an upper bound only', { react: '<19' }],
  ])('stays quiet with %s', async (_label, deps) => {
    expect(await detectIn(RENDER, deps)).toEqual([]);
  });

  it('stays quiet when a workspace still runs React 17', async () => {
    const issues = await detect({
      'package.json': pkg({ react: '^19.0.0' }, { workspaces: ['apps/*'] }),
      'apps/legacy/package.json': pkg({ react: '^17.0.2' }),
      'CLAUDE.md': `# A\n\n${RENDER}\n`,
    });
    expect(issues).toEqual([]);
  });

  it.each([
    'Use createRoot; ReactDOM.render is gone.',
    'Do not use ReactDOM.render.',
    'Replace ReactDOM.render with createRoot(container).render().',
    'For React 17 projects keep ReactDOM.render.',
    'The legacy ReactDOM.render entry point is only for tests.',
  ])('stays quiet for guidance that already moves off it (%s)', async (line) => {
    expect(await detectIn(line, { react: '^19.0.0' })).toEqual([]);
  });
});

describe('getInitialProps (c)', () => {
  const NEXT = { next: '^15.0.0', react: '^19.0.0' };
  const GUIDE = 'Fetch data with `getInitialProps` on each page.';

  it('is flagged in an app-router project', async () => {
    const issues = await detect({
      'package.json': pkg(NEXT),
      'app/layout.tsx': 'export default function L() { return null; }',
      'CLAUDE.md': `# A\n\n${GUIDE}\n`,
    });
    expect(titles(issues)).toEqual(['Instructions use getInitialProps in a Next.js app-router project']);
    expect(issues[0]!.severity).toBe('warning');
  });

  it('finds the router under src/app and in a workspace app', async () => {
    const issues = await detect({
      'package.json': pkg({}, { workspaces: ['apps/*'] }),
      'apps/web/package.json': pkg(NEXT),
      'apps/web/src/app/page.tsx': 'export default function P() { return null; }',
      'CLAUDE.md': `# A\n\n${GUIDE}\n`,
    });
    expect(issues).toHaveLength(1);
  });

  it('stays quiet when the project also has a pages/ router', async () => {
    const issues = await detect({
      'package.json': pkg(NEXT),
      'app/layout.tsx': '',
      'pages/legacy.tsx': '',
      'CLAUDE.md': `# A\n\n${GUIDE}\n`,
    });
    expect(issues).toEqual([]);
  });

  it('stays quiet when there is no app/ router', async () => {
    const issues = await detect({
      'package.json': pkg(NEXT),
      'pages/index.tsx': '',
      'CLAUDE.md': `# A\n\n${GUIDE}\n`,
    });
    expect(issues).toEqual([]);
  });

  it('stays quiet when an app/ directory has no layout or page (it is not the router)', async () => {
    const issues = await detect({
      'package.json': pkg(NEXT),
      'app/README.txt': 'not a router',
      'CLAUDE.md': `# A\n\n${GUIDE}\n`,
    });
    expect(issues).toEqual([]);
  });

  it('stays quiet when the project does not use Next.js', async () => {
    const issues = await detect({
      'package.json': pkg({ react: '^19.0.0' }),
      'app/layout.tsx': '',
      'CLAUDE.md': `# A\n\n${GUIDE}\n`,
    });
    expect(issues).toEqual([]);
  });

  it.each([
    'In the pages router, use getInitialProps.',
    'pages/_app.tsx may still use getInitialProps.',
    'Do not use getInitialProps; use Server Components.',
    'getInitialProps is legacy.',
  ])('stays quiet for a note scoped to the pages router or against it (%s)', async (line) => {
    const issues = await detect({
      'package.json': pkg(NEXT),
      'app/layout.tsx': '',
      'CLAUDE.md': `# A\n\n${line}\n`,
    });
    expect(issues).toEqual([]);
  });
});

describe('NgModule (c)', () => {
  const GUIDE = 'Declare every component in an `NgModule`, and import the module in `AppModule`.';
  const ANGULAR_17 = { '@angular/core': '^17.3.0' };

  it('is info on Angular 17+ with no module files', async () => {
    const issues = await detect({
      'package.json': pkg(ANGULAR_17),
      'src/app/app.component.ts': '',
      'CLAUDE.md': `# A\n\n${GUIDE}\n`,
    });
    expect(titles(issues)).toEqual(['Instructions are NgModule-centric in an Angular 17+ project with no modules']);
    expect(issues[0]!.severity).toBe('info');
    expect(issues[0]!.summary).toContain('standalone');
  });

  it('stays quiet when the project still has *.module.ts files', async () => {
    const issues = await detect({
      'package.json': pkg(ANGULAR_17),
      'src/app/app.module.ts': '',
      'CLAUDE.md': `# A\n\n${GUIDE}\n`,
    });
    expect(issues).toEqual([]);
  });

  it('stays quiet on Angular 16 and older', async () => {
    const issues = await detect({
      'package.json': pkg({ '@angular/core': '^16.2.0' }),
      'CLAUDE.md': `# A\n\n${GUIDE}\n`,
    });
    expect(issues).toEqual([]);
  });

  it('stays quiet without Angular', async () => {
    expect(await detectIn(GUIDE, { react: '^19.0.0' })).toEqual([]);
  });

  it.each([
    'Prefer standalone components over NgModules.',
    'Do not create an NgModule.',
    'Avoid NgModules in new code.',
  ])('stays quiet for guidance that steers away from it (%s)', async (line) => {
    const issues = await detect({
      'package.json': pkg(ANGULAR_17),
      'CLAUDE.md': `# A\n\n${line}\n`,
    });
    expect(issues).toEqual([]);
  });
});

// ── Review round: non-JS imports, migration examples, manifest discovery ──────

describe('imports from other languages are not npm packages', () => {
  it.each([
    ['Go, unlabeled fence', fence('', 'import "fmt"\nimport "github.com/spf13/cobra"\nimport "log/slog"')],
    ['Go, labeled fence', fence('go', 'import "fmt"\nimport "github.com/spf13/cobra"')],
    ['Go, inline span', 'Log with `import "log/slog"` and wire commands with `import "github.com/spf13/cobra"`.'],
    ['Dart, unlabeled fence', fence('', "import 'foo_bar.dart';\nimport 'package:flutter/material.dart';")],
    ['Dart, inline span', "Use `import 'foo_bar.dart';` in lib/."],
    ['a CSS virtual module', fence('ts', "import 'uno.css';\nimport './theme.scss';\nimport logo from 'logo.svg';")],
    ['a module path with a domain', fence('ts', "import { x } from 'github.com/spf13/cobra';\nimport y from 'golang.org/x/net/http2';")],
    ['Python', fence('python', 'import os\nfrom flask import Flask')],
    ['Rust', fence('rust', 'use serde::Serialize;')],
  ])('%s', async (_label, body) => {
    expect(await detectIn(body, { react: '^19.0.0' })).toEqual([]);
  });

  it('still reads JavaScript-only import forms in an unlabeled fence or a span', async () => {
    const issues = await detectIn(
      `${fence('', "import { create } from 'zustand';")}\n\nOr call \`require('left-pad')\` and \`import('dayjs')\`.`,
    );
    expect(titles(issues).sort()).toEqual([
      'Package named in instructions is not in any package.json: dayjs',
      'Package named in instructions is not in any package.json: left-pad',
      'Package named in instructions is not in any package.json: zustand',
    ]);
  });

  it('still reads a bare side-effect import in a JS-labeled fence', async () => {
    const issues = await detectIn(fence('ts', "import 'reflect-metadata';"));
    expect(titles(issues)).toEqual(['Package named in instructions is not in any package.json: reflect-metadata']);
  });

  it('keeps real package names that end in .js', async () => {
    const issues = await detectIn(fence('ts', "import Chart from 'chart.js/auto';"));
    expect(titles(issues)).toEqual(['Package named in instructions is not in any package.json: chart.js']);
  });
});

describe('severity by evidence', () => {
  it('is info for an import line alone and warning for an install command', async () => {
    const imp = await detectIn(fence('ts', "import { create } from 'zustand';"));
    const inst = await detectIn(fence('bash', 'npm i zustand'));
    expect(imp[0]!.severity).toBe('info');
    expect(inst[0]!.severity).toBe('warning');
  });

  it('is warning when both appear', async () => {
    const issues = await detectIn(`${fence('bash', 'npm i zustand')}\n\n${fence('ts', "import { create } from 'zustand';")}`);
    expect(issues[0]!.severity).toBe('warning');
  });
});

describe('negation reads comments in code, not identifiers', () => {
  it('does not treat an imported identifier as a negation', async () => {
    const issues = await detectIn(fence('ts', "import { without } from 'lodash';"));
    expect(titles(issues)).toEqual(['Package named in instructions is not in any package.json: lodash']);
  });

  it('still honors a negating trailing comment', async () => {
    expect(await detectIn(fence('ts', "import x from 'left-pad'; // never use this"))).toEqual([]);
  });

  it('treats "phased out" prose as a migration note', async () => {
    expect(await detectIn('Dates use `moment` for now; it is being phased out for date-fns.', { moment: '^2.0.0' })).toEqual([]);
  });
});

describe('before/after migration examples are not instructions', () => {
  const REACT_19 = { react: '^19.0.0', 'react-dom': '^19.0.0' };

  it('skips a diff fence', async () => {
    const diff = fence('diff', '- ReactDOM.render(<App />, el)\n+ createRoot(el).render(<App />)');
    expect(await detectIn(diff, REACT_19)).toEqual([]);
    // even a diff that only shows the removed line
    expect(await detectIn(fence('diff', '- ReactDOM.render(<App />, el)'), REACT_19)).toEqual([]);
    expect(await detectIn(fence('patch', '-ReactDOM.render(<App />, el)'), REACT_19)).toEqual([]);
  });

  it.each([
    'Before: `ReactDOM.render(<App/>, el)`. After: use the new root API.',
    'Old tests call ReactDOM.render through enzyme; new tests use RTL.',
    'Anti-pattern: ReactDOM.render(<App />, el)',
  ])('skips a line labeled as the old way (%s)', async (line) => {
    expect(await detectIn(line, REACT_19)).toEqual([]);
  });

  it('skips a fence introduced by a Before label', async () => {
    const body = `Before:\n\n${fence('tsx', 'ReactDOM.render(<App />, el);')}`;
    expect(await detectIn(body, REACT_19)).toEqual([]);
  });

  it('skips a section that also shows the replacement', async () => {
    const body = `## Mounting\n\n${fence('tsx', 'ReactDOM.render(<App />, el);')}\n\n${fence('tsx', 'createRoot(el).render(<App />);')}`;
    expect(await detectIn(body, REACT_19)).toEqual([]);
  });

  it('still flags a section that shows only the old API', async () => {
    const body = `## Mounting\n\n${fence('tsx', 'ReactDOM.render(<App />, el);')}\n\n## Other\n\nUse createRoot elsewhere.`;
    expect(titles(await detectIn(body, REACT_19))).toEqual(['Instructions use ReactDOM.render, which React 19 removed']);
  });

  it('skips getInitialProps in a section that names the app-router way', async () => {
    const issues = await detect({
      'package.json': pkg({ next: '^15.0.0' }),
      'app/layout.tsx': '',
      'CLAUDE.md': '# A\n\n## Data\n\nThe old getInitialProps hook was replaced by Server Components here.\n',
    });
    expect(issues).toEqual([]);
  });
});

describe('manifest discovery', () => {
  const ZOD = fence('bash', 'npm install zod');

  it('treats a manifest deeper than six levels as a declaration', async () => {
    expect(
      await detect({ 'package.json': pkg(), 'a/b/c/d/e/f/g/package.json': pkg({ zod: '^3.0.0' }), 'CLAUDE.md': `# A\n\n${ZOD}\n` }),
    ).toEqual([]);
  });

  it('reads manifests in dot directories', async () => {
    const issues = await detect({
      'package.json': pkg(),
      '.github/actions/x/package.json': pkg({ zod: '^3.0.0' }),
      'CLAUDE.md': `# A\n\n${fence('ts', "import { z } from 'zod';")}\n`,
    });
    expect(issues).toEqual([]);
  });

  it('does not guess when more manifests exist than were read', async () => {
    const files: Record<string, string> = { 'package.json': pkg(), 'CLAUDE.md': `# A\n\n${ZOD}\n` };
    for (let i = 0; i < 201; i++) files[`aa${String(i).padStart(3, '0')}/package.json`] = pkg();
    files['zz-service/package.json'] = pkg({ zod: '^3.0.0' });
    expect(await detect(files)).toEqual([]);
  });

  it("respects the scan's exclude patterns when looking for other manifests", async () => {
    const files = { 'package.json': pkg(), 'fixtures/x/package.json': pkg({ zod: '^3.0.0' }), 'CLAUDE.md': `# A\n\n${ZOD}\n` };
    const repo = repoWith(files);
    expect(detectDependencyStaleness(await buildRepoContext({ repoPath: repo }))).toEqual([]);
    const excluded = await buildRepoContext({ repoPath: repo, exclude: ['fixtures/**'] });
    expect(titles(detectDependencyStaleness(excluded))).toEqual([
      'Package named in instructions is not in any package.json: zod',
    ]);
  });

  it('counts @types/x as declaring x', async () => {
    const issues = await detect({
      'package.json': pkg({}, { devDependencies: { '@types/json-schema': '^7.0.0', '@types/babel__core': '^7.0.0' } }),
      'CLAUDE.md': `# A\n\n${fence('ts', "import type { JSONSchema7 } from 'json-schema';\nimport type { x } from '@babel/core';")}\n`,
    });
    expect(issues).toEqual([]);
  });

  it.each([
    ["import * as vscode from 'vscode';"],
    ["import http from 'k6/http';\nimport { check } from 'k6';"],
  ])('skips modules the host provides (%s)', async (code) => {
    expect(await detectIn(fence('ts', code))).toEqual([]);
  });

  it('reads a Deno import map as declarations', async () => {
    const issues = await detect({
      'package.json': pkg(),
      'deno.json': JSON.stringify({ imports: { hono: 'jsr:@hono/hono@^4', '@std/assert/': 'jsr:@std/assert@1/' } }),
      'CLAUDE.md': `# A\n\n${fence('ts', "import { Hono } from 'hono';\nimport { assert } from '@std/assert';")}\n`,
    });
    expect(issues).toEqual([]);
  });

  it('treats tsconfig paths (JSONC, root and workspace) as local aliases', async () => {
    const issues = await detect({
      'package.json': pkg({}, { workspaces: ['apps/*'] }),
      'tsconfig.json': '{\n  // comment\n  "compilerOptions": { "paths": { "@app/*": ["./src/app/*"], "~/*": ["./src/*"], }, },\n}\n',
      'apps/web/package.json': pkg({ next: '^15.0.0' }),
      'apps/web/tsconfig.json': JSON.stringify({ compilerOptions: { paths: { 'trpc/*': ['./src/trpc/*'], '@lib/format': ['./src/format.ts'] } } }),
      'CLAUDE.md': `# A\n\n${fence('ts', "import { api } from 'trpc/react';\nimport { s } from '@app/session';\nimport { f } from '@lib/format';")}\n`,
    });
    expect(issues).toEqual([]);
  });

  it("finds a local directory in a workspace's src/", async () => {
    const issues = await detect({
      'package.json': pkg({}, { workspaces: ['apps/*'] }),
      'apps/web/package.json': pkg({ next: '^15.0.0' }),
      'apps/web/src/trpc/react.ts': '',
      'CLAUDE.md': `# A\n\n${fence('ts', "import { api } from 'trpc/react';")}\n`,
    });
    expect(issues).toEqual([]);
  });

  it('does not double-report a Jest/Vitest mix-up manifest-consistency already reports', async () => {
    const issues = await detect({
      'package.json': pkg({}, { devDependencies: { vitest: '^2.0.0' } }),
      'CLAUDE.md': `# A\n\n${fence('bash', 'npm install -D jest')}\n`,
    });
    expect(issues).toEqual([]);
    // ...but a jest mention with neither tool installed is not that mismatch
    expect(titles(await detectIn(fence('bash', 'npm install -D jest')))).toEqual([
      'Package named in instructions is not in any package.json: jest',
    ]);
  });
});

describe('version specs from pnpm catalogs', () => {
  const RENDER = 'Mount with ReactDOM.render(<App />, el).';

  it('resolves the default catalog', async () => {
    const issues = await detect({
      'package.json': pkg({ react: 'catalog:', 'react-dom': 'catalog:' }),
      'pnpm-workspace.yaml': 'packages:\n  - apps/*\ncatalog:\n  react: ^19.0.0\n  react-dom: "^19.0.0"\n',
      'CLAUDE.md': `# A\n\n${RENDER}\n`,
    });
    expect(titles(issues)).toEqual(['Instructions use ReactDOM.render, which React 19 removed']);
  });

  it('resolves a named catalog', async () => {
    const issues = await detect({
      'package.json': pkg({ react: 'catalog:legacy', 'react-dom': 'catalog:legacy' }),
      'pnpm-workspace.yaml':
        'packages:\n  - apps/*\ncatalogs:\n  legacy:\n    react: ^17.0.2\n    react-dom: ^17.0.2\n  modern:\n    react: ^19.0.0\n',
      'CLAUDE.md': `# A\n\n${RENDER}\n`,
    });
    expect(issues).toEqual([]);
    const modern = await detect({
      'package.json': pkg({ react: 'catalog:modern', 'react-dom': 'catalog:modern' }),
      'pnpm-workspace.yaml':
        'packages:\n  - apps/*\ncatalogs:\n  legacy:\n    react: ^17.0.2\n  modern:\n    react: ^18.3.0\n    react-dom: ^18.3.0\n',
      'CLAUDE.md': `# A\n\n${RENDER}\n`,
    });
    expect(titles(modern)).toEqual(['Instructions use ReactDOM.render, which is the legacy React 17 root API']);
  });

  it('stays quiet when the catalog entry cannot be found', async () => {
    const issues = await detect({
      'package.json': pkg({ react: 'catalog:', 'react-dom': 'catalog:' }),
      'CLAUDE.md': `# A\n\n${RENDER}\n`,
    });
    expect(issues).toEqual([]);
  });
});

describe('repo reads stay inside the repo', () => {
  it('ignores an app/ router that is a link leaving the repo', async () => {
    const outside = repoWith({ 'layout.tsx': 'export default function L() { return null; }' });
    const repo = repoWith({
      'package.json': pkg({ next: '^15.0.0' }),
      'CLAUDE.md': '# A\n\nFetch with getInitialProps.\n',
    });
    fs.symlinkSync(outside, `${repo}/app`, 'junction');
    expect(detectDependencyStaleness(await buildRepoContext({ repoPath: repo }))).toEqual([]);
  });
});

// ── Pipeline ──────────────────────────────────────────────────────────────────

describe('in a scan', () => {
  it('reports through scan() as a stale_instruction finding', async () => {
    const repo = repoWith({
      'package.json': pkg({ react: '^19.0.0' }),
      'CLAUDE.md': `# A\n\nRun the tests before you push.\n\n${fence('bash', 'npm install zod')}\n\nUse ReactDOM.render.\n`,
    });
    const report = await scan({ repoPath: repo });
    const found = report.issues.filter((i) => i.id.startsWith('dep-staleness-'));
    expect(found.map((i) => i.severity).sort()).toEqual(['high', 'warning']);
    expect(found.every((i) => i.category === 'stale_instruction')).toBe(true);
  });

  it('can be silenced with an inline promptci-ignore annotation like any other finding', async () => {
    const repo = repoWith({
      'package.json': pkg(),
      'CLAUDE.md':
        '# A\n\nRun the tests before you push.\n\n' +
        '<!-- promptci-ignore: stale_instruction reason: zod is installed in CI only -->\n' +
        `${fence('bash', 'npm install zod')}\n`,
    });
    const report = await scan({ repoPath: repo });
    expect(report.issues.some((i) => i.id.startsWith('dep-staleness-'))).toBe(false);
  });
});
