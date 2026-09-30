/**
 * Workspace package.json facts shared by the script-validity checks
 * (command-validity and manifest-consistency).
 *
 * A package-manager command is only a "missing script" when nothing the repo
 * can run under that name exists. Two kinds of names are never scripts and must
 * not be reported as missing:
 *
 *  - Dependencies and their binaries: `pnpm vitest run` and `yarn tsc --noEmit`
 *    fall through to the installed binary when no script of that name exists.
 *  - Scripts defined by a workspace package rather than the root manifest:
 *    `pnpm --filter web dev` or `pnpm -r build` in a monorepo.
 *
 * `node_modules/.bin` is not available when scanning a checkout, so binaries are
 * derived from the dependency blocks of every workspace manifest plus a list of
 * well-known tool binaries. Everything here is deterministic and offline.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { listFiles } from './ai-config.js';
import { MAX_FILE_SIZE } from './scanner.js';
import type { RepoContext } from './repo-context.js';

export type WorkspaceManifest = {
  /** Repo-relative POSIX directory of the package ('.' = repo root). */
  dir: string;
  name?: string;
  scripts: Record<string, string>;
  /** Names from dependencies, devDependencies, peerDependencies and optionalDependencies. */
  dependencies: string[];
  /** Binary names the package itself exposes (`bin`). */
  bins: string[];
};

/** Upper bound on workspace manifests read, so a huge repo cannot stall a scan. */
const MAX_WORKSPACE_MANIFESTS = 200;

/** Conventional workspace roots, used when no `workspaces` globs are declared. */
const CONVENTIONAL_WORKSPACE_GLOBS = ['apps/*', 'packages/*', 'libs/*'];

const DEPENDENCY_BLOCKS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;

// ── Well-known binaries ───────────────────────────────────────────────────────

/**
 * Binaries of common JS/TS tooling. A bare `pnpm <bin>` / `yarn <bin>` runs the
 * installed binary, so these are valid invocations whether or not the package is
 * listed in a manifest this scan could read (hoisted workspace installs).
 */
export const KNOWN_BINS: ReadonlySet<string> = new Set([
  // compilers / bundlers / transpilers
  'tsc', 'tsx', 'ts-node', 'tsup', 'tsc-alias', 'vue-tsc', 'esbuild', 'rollup', 'webpack', 'vite',
  'swc', 'babel', 'parcel', 'turbopack', 'rspack', 'unbuild', 'bunchee',
  // lint / format / type tools
  'eslint', 'prettier', 'biome', 'oxlint', 'stylelint', 'knip', 'depcheck', 'madge', 'commitlint',
  'svelte-check', 'typedoc', 'size-limit',
  // test runners
  'vitest', 'jest', 'mocha', 'ava', 'playwright', 'cypress', 'storybook', 'msw',
  // monorepo / release
  'turbo', 'nx', 'lerna', 'changeset', 'changesets', 'semantic-release', 'husky', 'lint-staged',
  // frameworks
  'next', 'nuxt', 'nuxi', 'astro', 'remix', 'expo', 'eas', 'react-native', 'ng', 'nest', 'gatsby',
  'docusaurus', 'vitepress', 'tauri', 'electron', 'electron-builder', 'sanity', 'strapi',
  // data / infra / deploy
  'prisma', 'drizzle-kit', 'knex', 'typeorm', 'sequelize', 'supabase', 'wrangler', 'vercel', 'netlify',
  'firebase', 'sst', 'cdk', 'serverless',
  // process / shell helpers
  'nodemon', 'concurrently', 'cross-env', 'rimraf', 'dotenv', 'npm-run-all', 'run-s', 'run-p',
  // css / codegen
  'tailwindcss', 'postcss', 'graphql-codegen', 'openapi-typescript',
]);

/**
 * Dependencies whose binary name differs from the package name. The unscoped
 * package name is always accepted as well (`@biomejs/biome` -> `biome`).
 */
const DEP_BIN_ALIASES: Readonly<Record<string, readonly string[]>> = {
  typescript: ['tsc', 'tsserver'],
  '@playwright/test': ['playwright'],
  '@changesets/cli': ['changeset'],
  '@angular/cli': ['ng'],
  '@nestjs/cli': ['nest'],
  '@tailwindcss/cli': ['tailwindcss'],
  '@graphql-codegen/cli': ['graphql-codegen'],
  '@storybook/cli': ['storybook'],
  '@commitlint/cli': ['commitlint'],
  '@sanity/cli': ['sanity'],
  '@tauri-apps/cli': ['tauri'],
  '@redwoodjs/cli': ['rw'],
  '@swc/cli': ['swc'],
  '@babel/cli': ['babel'],
  'npm-run-all2': ['npm-run-all', 'run-s', 'run-p'],
};

// ── Discovery (async; called once while building the RepoContext) ─────────────

function stringKeys(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  return Object.keys(value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(value)) {
    if (typeof v === 'string') out[key] = v;
  }
  return out;
}

/** Bin names a manifest exposes: a string `bin` is named after the (unscoped) package. */
function binNames(parsed: Record<string, unknown>): string[] {
  const { bin, name } = parsed;
  if (typeof bin === 'string' && typeof name === 'string') return [name.split('/').pop()!];
  return stringKeys(bin);
}

export function parseWorkspaceManifest(dir: string, raw: string): WorkspaceManifest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  const dependencies = new Set<string>();
  for (const block of DEPENDENCY_BLOCKS) {
    for (const dep of stringKeys(obj[block])) dependencies.add(dep);
  }
  return {
    dir,
    name: typeof obj.name === 'string' ? obj.name : undefined,
    scripts: stringRecord(obj.scripts),
    dependencies: [...dependencies].sort(),
    bins: binNames(obj),
  };
}

/** `workspaces` globs from package.json (array form, or yarn's `{ packages: [...] }`). */
function packageJsonWorkspaceGlobs(rawPackageJson: string | undefined): string[] {
  if (!rawPackageJson) return [];
  try {
    const parsed = JSON.parse(rawPackageJson) as { workspaces?: unknown };
    const ws = parsed.workspaces;
    const list = Array.isArray(ws)
      ? ws
      : typeof ws === 'object' && ws !== null && Array.isArray((ws as { packages?: unknown }).packages)
        ? (ws as { packages: unknown[] }).packages
        : [];
    return list.filter((g): g is string => typeof g === 'string');
  } catch {
    return [];
  }
}

/** `packages:` entries of pnpm-workspace.yaml — the tiny subset of YAML it uses. */
function pnpmWorkspaceGlobs(rawYaml: string | undefined): string[] {
  if (!rawYaml) return [];
  const globs: string[] = [];
  let inPackages = false;
  for (const line of rawYaml.split(/\r?\n/)) {
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    if (/^\S/.test(line) && line.trim() !== '' && !line.startsWith('#')) break; // next top-level key
    const item = /^\s*-\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))/.exec(line);
    const glob = item?.[1] ?? item?.[2] ?? item?.[3];
    if (glob) globs.push(glob);
  }
  return globs;
}

function toManifestGlob(workspaceGlob: string): string {
  const trimmed = workspaceGlob.replace(/^\.\//, '').replace(/\/+$/, '');
  return `${trimmed}/package.json`;
}

/**
 * Read the root manifest and every workspace package manifest. Workspace
 * directories come from the declared `workspaces` globs (package.json or
 * pnpm-workspace.yaml) or, when none are declared, the conventional
 * `apps/`, `packages/` and `libs/` roots. Dot-directories, dependency trees and
 * paths the scan's `exclude` patterns cover (`isExcluded`) are never read.
 */
export async function discoverWorkspaceManifests(
  repoRoot: string,
  rawRootPackageJson: string | undefined,
  isExcluded: (posixPath: string) => boolean = () => false,
): Promise<WorkspaceManifest[]> {
  let pnpmYaml: string | undefined;
  try {
    pnpmYaml = await fs.readFile(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf-8');
  } catch {
    pnpmYaml = undefined;
  }
  const declared = [...packageJsonWorkspaceGlobs(rawRootPackageJson), ...pnpmWorkspaceGlobs(pnpmYaml)];
  const positive = declared.filter((g) => !g.startsWith('!'));
  const negative = declared.filter((g) => g.startsWith('!')).map((g) => g.slice(1));
  const globs = positive.length > 0 ? positive : CONVENTIONAL_WORKSPACE_GLOBS;

  const ignore = [
    '**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/worktrees/**', '**/.worktrees/**',
    '**/.*/**',
    ...negative.map((g) => `${g.replace(/\/+$/, '')}/**`),
  ];
  const manifestPaths = listFiles(repoRoot, globs.map(toManifestGlob), ignore)
    .filter((rel) => !isExcluded(rel))
    .slice(0, MAX_WORKSPACE_MANIFESTS);

  const manifests: WorkspaceManifest[] = [];
  const rootManifest = rawRootPackageJson ? parseWorkspaceManifest('.', rawRootPackageJson) : undefined;
  if (rootManifest) manifests.push(rootManifest);

  for (const rel of manifestPaths) {
    if (rel === 'package.json') continue;
    try {
      const abs = path.join(repoRoot, rel);
      const stat = await fs.stat(abs);
      if (!stat.isFile() || stat.size > MAX_FILE_SIZE) continue;
      const manifest = parseWorkspaceManifest(path.posix.dirname(rel), await fs.readFile(abs, 'utf-8'));
      if (manifest) manifests.push(manifest);
    } catch {
      // unreadable — skip
    }
  }
  return manifests;
}

// ── Queries (pure; used by the detectors) ─────────────────────────────────────

/** Package names and binaries that resolve as an installed command, across the whole workspace. */
export function isKnownBinary(context: RepoContext, name: string): boolean {
  if (KNOWN_BINS.has(name)) return true;
  const { dependencies, devDependencies, peerDependencies } = context.packageJson;
  const isDep = (dep: string): boolean =>
    dep === name || dep.split('/').pop() === name || (DEP_BIN_ALIASES[dep]?.includes(name) ?? false);
  if ([dependencies, devDependencies, peerDependencies].some((block) => Object.keys(block).some(isDep))) {
    return true;
  }
  return (context.workspaces ?? []).some(
    (ws) => ws.bins.includes(name) || ws.dependencies.some(isDep),
  );
}

/** True when the root manifest or any workspace package defines the script. */
export function anyWorkspaceHasScript(context: RepoContext, name: string): boolean {
  if (context.packageJson.scripts[name]) return true;
  return (context.workspaces ?? []).some((ws) => !!ws.scripts[name]);
}

/** Find workspace manifests a pnpm/npm/yarn selector (name, path, or glob) refers to. */
export function selectWorkspaces(context: RepoContext, selector: string): WorkspaceManifest[] {
  const workspaces = context.workspaces ?? [];
  // `*` / `[since]` / `...dependents` style selectors span many packages; be permissive.
  if (/[*[]/.test(selector)) return workspaces;
  const posix = selector.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return workspaces.filter(
    (ws) => ws.name === selector || ws.dir === posix || ws.dir.endsWith(`/${posix}`),
  );
}
