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
 * `node_modules/.bin` is not available when scanning a checkout, so a binary is
 * accepted only when a package that provides it is declared in some workspace
 * manifest (or, for a dependency whose name IS the command, the dependency
 * itself). Everything here is deterministic and offline.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import micromatch from 'micromatch';
import { listFiles, resolveReadableWithinRoot, resolveWithinRoot } from './ai-config.js';
import { MAX_FILE_SIZE } from './scanner.js';
import type { RepoContext } from './repo-context.js';

export type WorkspaceManifest = {
  /** Repo-relative POSIX directory of the package ('.' = repo root). */
  dir: string;
  name?: string;
  scripts: Record<string, string>;
  /**
   * Names from dependencies, devDependencies, peerDependencies and
   * optionalDependencies, minus `workspace:` links to sibling packages (those
   * are packages of this repo, not installed tools).
   */
  dependencies: string[];
  /** Binary names the package itself exposes (`bin`). */
  bins: string[];
};

export type WorkspaceDiscovery = {
  manifests: WorkspaceManifest[];
  /** More manifests matched than were read: the list is a sample, not the whole workspace. */
  truncated: boolean;
};

/** Upper bound on workspace manifests read, so a huge repo cannot stall a scan. */
const MAX_WORKSPACE_MANIFESTS = 200;

/** Conventional workspace roots, used when no `workspaces` globs are declared. */
const CONVENTIONAL_WORKSPACE_GLOBS = ['apps/*', 'packages/*', 'libs/*'];

const DEPENDENCY_BLOCKS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;

// ── Well-known binaries ───────────────────────────────────────────────────────

/**
 * Common JS/TS tool binaries and the packages that install them. A bare
 * `pnpm <bin>` / `yarn <bin>` runs the installed binary, so `pnpm prisma
 * migrate` is valid when `prisma` is a dependency somewhere in the workspace —
 * and a missing script when nothing installs it.
 */
const BIN_PROVIDERS: Readonly<Record<string, readonly string[]>> = {
  // compilers / bundlers / transpilers
  tsc: ['typescript'], tsserver: ['typescript'], tsx: ['tsx'], 'ts-node': ['ts-node'],
  tsup: ['tsup'], 'tsc-alias': ['tsc-alias'], 'vue-tsc': ['vue-tsc'], esbuild: ['esbuild'],
  rollup: ['rollup'], webpack: ['webpack-cli', 'webpack'], vite: ['vite'], swc: ['@swc/cli'],
  babel: ['@babel/cli'], parcel: ['parcel'], rspack: ['@rspack/cli'], unbuild: ['unbuild'],
  bunchee: ['bunchee'],
  // lint / format / type tools
  eslint: ['eslint'], prettier: ['prettier'], biome: ['@biomejs/biome'], oxlint: ['oxlint'],
  stylelint: ['stylelint'], knip: ['knip'], depcheck: ['depcheck'], madge: ['madge'],
  commitlint: ['@commitlint/cli'], 'svelte-check': ['svelte-check'], typedoc: ['typedoc'],
  'size-limit': ['size-limit'],
  // test runners
  vitest: ['vitest'], jest: ['jest'], mocha: ['mocha'], ava: ['ava'],
  playwright: ['@playwright/test', 'playwright'], cypress: ['cypress'],
  storybook: ['storybook', '@storybook/cli'], msw: ['msw'],
  // monorepo / release
  turbo: ['turbo'], nx: ['nx'], lerna: ['lerna'], changeset: ['@changesets/cli'],
  'semantic-release': ['semantic-release'], husky: ['husky'], 'lint-staged': ['lint-staged'],
  // frameworks
  next: ['next'], nuxt: ['nuxt'], nuxi: ['nuxt', 'nuxi'], astro: ['astro'], remix: ['@remix-run/dev'],
  expo: ['expo'], eas: ['eas-cli'], 'react-native': ['react-native'], ng: ['@angular/cli'],
  nest: ['@nestjs/cli'], gatsby: ['gatsby'], docusaurus: ['@docusaurus/core'], vitepress: ['vitepress'],
  tauri: ['@tauri-apps/cli'], electron: ['electron'], 'electron-builder': ['electron-builder'],
  sanity: ['sanity', '@sanity/cli'], strapi: ['@strapi/strapi'],
  // data / infra / deploy
  prisma: ['prisma'], 'drizzle-kit': ['drizzle-kit'], knex: ['knex'], typeorm: ['typeorm'],
  sequelize: ['sequelize-cli'], supabase: ['supabase'], wrangler: ['wrangler'], vercel: ['vercel'],
  netlify: ['netlify-cli'], firebase: ['firebase-tools'], sst: ['sst'], cdk: ['aws-cdk'],
  serverless: ['serverless'],
  // process / shell helpers
  nodemon: ['nodemon'], concurrently: ['concurrently'], 'cross-env': ['cross-env'], rimraf: ['rimraf'],
  dotenv: ['dotenv-cli', 'dotenv'], 'npm-run-all': ['npm-run-all', 'npm-run-all2'],
  'run-s': ['npm-run-all', 'npm-run-all2'], 'run-p': ['npm-run-all', 'npm-run-all2'],
  // css / codegen
  tailwindcss: ['tailwindcss', '@tailwindcss/cli'], postcss: ['postcss-cli'],
  'graphql-codegen': ['@graphql-codegen/cli'], 'openapi-typescript': ['openapi-typescript'],
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
    const specs = stringRecord(obj[block]);
    for (const dep of Object.keys(specs)) {
      if (!specs[dep]!.startsWith('workspace:')) dependencies.add(dep);
    }
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

function unquoteYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  const quoted = /^(?:"([^"]*)"|'([^']*)')/.exec(trimmed);
  if (quoted) return quoted[1] ?? quoted[2] ?? '';
  return trimmed.replace(/\s+#.*$/, '');
}

/**
 * `packages:` entries of pnpm-workspace.yaml — the small subset of YAML it
 * uses: a block list (indented or not) or a flow list (`['a/*', "b/*"]`,
 * possibly across lines).
 */
export function pnpmWorkspaceGlobs(rawYaml: string | undefined): string[] {
  if (!rawYaml) return [];
  const lines = rawYaml.split(/\r?\n/);
  const globs: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const header = /^packages\s*:\s*(.*)$/.exec(lines[i]!);
    if (!header) continue;
    const rest = header[1]!.trim();
    if (rest.startsWith('[')) {
      let flow = rest;
      for (let j = i + 1; !flow.includes(']') && j < lines.length; j++) flow += ` ${lines[j]!.trim()}`;
      const inner = flow.slice(1, flow.includes(']') ? flow.indexOf(']') : undefined);
      for (const item of inner.split(',')) {
        const glob = unquoteYamlScalar(item);
        if (glob) globs.push(glob);
      }
      break;
    }
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!;
      const item = /^\s*-\s+(.*)$/.exec(line); // `- x` at any indent, including column 0
      if (item) {
        const glob = unquoteYamlScalar(item[1]!);
        if (glob) globs.push(glob);
        continue;
      }
      // Blank lines and comments continue the list; the next top-level key ends it.
      if (line.trim() === '' || /^\s*#/.test(line) || /^\s/.test(line)) continue;
      break;
    }
    break;
  }
  return globs;
}

/**
 * A workspace glob is only followed when it stays inside the repository: an
 * absolute path or a `..` segment would let a hostile `workspaces` entry read
 * package.json files of sibling directories.
 */
function isContainedGlob(glob: string): boolean {
  const posix = glob.replace(/\\/g, '/');
  if (posix.startsWith('/') || /^[a-zA-Z]:/.test(posix)) return false;
  return !posix.split('/').includes('..');
}

function toManifestGlob(workspaceGlob: string): string {
  const trimmed = workspaceGlob.replace(/^\.\//, '').replace(/\/+$/, '');
  return `${trimmed}/package.json`;
}

/**
 * Read the root manifest and every workspace package manifest. Workspace
 * directories come from the declared `workspaces` globs (package.json or
 * pnpm-workspace.yaml) or, when none are declared, the conventional
 * `apps/`, `packages/` and `libs/` roots. Only dependency trees and VCS
 * directories are ignored — a declared glob may legitimately reach
 * `tools/build/`. Paths the scan's `exclude` patterns cover (`isExcluded`) are
 * never read.
 */
export async function discoverWorkspaceManifests(
  repoRoot: string,
  rawRootPackageJson: string | undefined,
  isExcluded: (posixPath: string) => boolean = () => false,
): Promise<WorkspaceDiscovery> {
  let pnpmYaml: string | undefined;
  try {
    const abs = resolveReadableWithinRoot(repoRoot, 'pnpm-workspace.yaml');
    pnpmYaml = abs ? await fs.readFile(abs, 'utf-8') : undefined;
  } catch {
    pnpmYaml = undefined;
  }
  const declared = [...packageJsonWorkspaceGlobs(rawRootPackageJson), ...pnpmWorkspaceGlobs(pnpmYaml)];
  const positive = declared.filter((g) => !g.startsWith('!') && isContainedGlob(g));
  const negative = declared.filter((g) => g.startsWith('!')).map((g) => g.slice(1));
  const globs = positive.length > 0 ? positive : CONVENTIONAL_WORKSPACE_GLOBS;

  const ignore = [
    '**/node_modules/**', '**/.git/**',
    ...negative.filter(isContainedGlob).map((g) => `${g.replace(/\/+$/, '')}/**`),
  ];
  const matched = listFiles(repoRoot, globs.map(toManifestGlob), ignore)
    .filter((rel) => resolveWithinRoot(repoRoot, rel) !== null && !isExcluded(rel));
  const truncated = matched.length > MAX_WORKSPACE_MANIFESTS;

  const manifests: WorkspaceManifest[] = [];
  const rootManifest = rawRootPackageJson ? parseWorkspaceManifest('.', rawRootPackageJson) : undefined;
  if (rootManifest) manifests.push(rootManifest);

  for (const rel of matched.slice(0, MAX_WORKSPACE_MANIFESTS)) {
    if (rel === 'package.json') continue;
    try {
      const abs = resolveReadableWithinRoot(repoRoot, rel);
      if (!abs) continue;
      const stat = await fs.stat(abs);
      if (!stat.isFile() || stat.size > MAX_FILE_SIZE) continue;
      const manifest = parseWorkspaceManifest(path.posix.dirname(rel), await fs.readFile(abs, 'utf-8'));
      if (manifest) manifests.push(manifest);
    } catch {
      // unreadable — skip
    }
  }
  return { manifests, truncated };
}

// ── Queries (pure; used by the detectors) ─────────────────────────────────────

/** Dependency names declared anywhere in the workspace, without @types and sibling-package links. */
function installedPackages(context: RepoContext): Set<string> {
  const localNames = new Set((context.workspaces ?? []).map((ws) => ws.name).filter((n): n is string => !!n));
  const names = new Set<string>();
  const add = (dep: string): void => {
    if (!dep.startsWith('@types/') && !localNames.has(dep)) names.add(dep);
  };
  const { dependencies, devDependencies, peerDependencies } = context.packageJson;
  for (const block of [dependencies, devDependencies, peerDependencies]) {
    for (const [dep, spec] of Object.entries(block)) if (!spec.startsWith('workspace:')) add(dep);
  }
  for (const ws of context.workspaces ?? []) ws.dependencies.forEach(add);
  return names;
}

/**
 * True when `pnpm|yarn|bun <name>` would run an installed binary:
 *  - a workspace package exposes it (`bin`);
 *  - a dependency is literally named `<name>`; or
 *  - `<name>` is a well-known tool binary AND a package providing it is declared.
 *
 * When workspace discovery is absent or was truncated the declared packages are
 * not the whole picture, so a well-known tool binary is accepted unconditionally.
 */
export function isKnownBinary(context: RepoContext, name: string): boolean {
  if ((context.workspaces ?? []).some((ws) => ws.bins.includes(name))) return true;
  const installed = installedPackages(context);
  if (installed.has(name)) return true;
  const providers = BIN_PROVIDERS[name];
  if (!providers) return false;
  if (context.workspaces === undefined || context.workspacesTruncated) return true;
  return providers.some((provider) => installed.has(provider));
}

/** True when the root manifest or any workspace package defines the script. */
export function anyWorkspaceHasScript(context: RepoContext, name: string): boolean {
  if (context.packageJson.scripts[name]) return true;
  return (context.workspaces ?? []).some((ws) => !!ws.scripts[name]);
}

/**
 * Workspaces a pnpm/npm/yarn selector (package name, path, or glob) refers to.
 * `*`, `**` and exclusion/dependents selectors (`!web`, `[origin/main]`) select
 * every workspace — they cannot be evaluated statically, so stay permissive.
 */
export function selectWorkspaces(context: RepoContext, selector: string): WorkspaceManifest[] {
  const workspaces = context.workspaces ?? [];
  if (selector === '*' || selector === '**' || selector.startsWith('!') || selector.startsWith('[')) {
    return workspaces;
  }
  const posix = selector.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  const options = { dot: true };
  return workspaces.filter(
    (ws) =>
      ws.name === selector ||
      ws.dir === posix ||
      ws.dir.endsWith(`/${posix}`) ||
      (/[*?[{]/.test(selector) &&
        ((ws.name !== undefined && micromatch.isMatch(ws.name, selector, options)) ||
          micromatch.isMatch(ws.dir, posix, options))),
  );
}
