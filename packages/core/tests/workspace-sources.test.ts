/**
 * Where workspace packages come from, by package manager (#200).
 *
 * pnpm reads workspaces only from pnpm-workspace.yaml (https://pnpm.io/settings), so the
 * `workspaces` field of package.json declares nothing for it; npm, yarn and bun read only the
 * package.json field. With no package manager signal both sources are merged.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { scan } from '../src/scan.js';
import { buildRepoContext } from '../src/repo-context.js';
import { discoverWorkspaceManifests, workspaceGlobSources } from '../src/workspace-manifests.js';
import { makeTempRepo, writeFile } from './ai-config-helpers.js';

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../examples/fixture-workspace-sources');

const tempRepos: string[] = [];
afterEach(() => {
  for (const dir of tempRepos.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function repoWith(files: Record<string, string>): string {
  const repo = makeTempRepo('promptci-ws-sources-');
  tempRepos.push(repo);
  for (const [rel, content] of Object.entries(files)) writeFile(repo, rel, content);
  return repo;
}

const ROOT = JSON.stringify({ name: 'root', workspaces: ['pkgs-json/*'] });
const LAYOUT = {
  'pnpm-workspace.yaml': 'packages:\n  - "pkgs-yaml/*"\n',
  'pkgs-json/a/package.json': '{"name":"a","scripts":{"dev":"x"}}',
  'pkgs-yaml/b/package.json': '{"name":"b","scripts":{"dev":"x"}}',
};

async function dirs(packageManager: string | undefined): Promise<string[]> {
  const repo = repoWith({ 'package.json': ROOT, ...LAYOUT });
  const { manifests } = await discoverWorkspaceManifests(repo, ROOT, () => false, packageManager);
  return manifests.map((m) => m.dir).filter((d) => d !== '.').sort();
}

describe('workspaceGlobSources', () => {
  it('maps each package manager to the file it reads', () => {
    expect(workspaceGlobSources('pnpm')).toEqual({ packageJson: false, pnpmYaml: true });
    for (const pm of ['npm', 'yarn', 'bun']) expect(workspaceGlobSources(pm)).toEqual({ packageJson: true, pnpmYaml: false });
    expect(workspaceGlobSources('unknown')).toEqual({ packageJson: true, pnpmYaml: true });
    expect(workspaceGlobSources(undefined)).toEqual({ packageJson: true, pnpmYaml: true });
  });
});

describe('discoverWorkspaceManifests by package manager', () => {
  it('pnpm uses pnpm-workspace.yaml and ignores the package.json workspaces field', async () => {
    expect(await dirs('pnpm')).toEqual(['pkgs-yaml/b']);
  });

  it.each(['npm', 'yarn', 'bun'])('%s uses the package.json workspaces field and ignores pnpm-workspace.yaml', async (pm) => {
    expect(await dirs(pm)).toEqual(['pkgs-json/a']);
  });

  it('merges both sources when the package manager is unknown', async () => {
    expect(await dirs('unknown')).toEqual(['pkgs-json/a', 'pkgs-yaml/b']);
    expect(await dirs(undefined)).toEqual(['pkgs-json/a', 'pkgs-yaml/b']);
  });

  it('falls back to the conventional roots when the chosen source declares nothing', async () => {
    const repo = repoWith({
      'package.json': ROOT,
      'packages/c/package.json': '{"name":"c"}',
      'pkgs-json/a/package.json': '{"name":"a"}',
    });
    const { manifests } = await discoverWorkspaceManifests(repo, ROOT, () => false, 'pnpm');
    expect(manifests.map((m) => m.dir).filter((d) => d !== '.')).toEqual(['packages/c']);
  });
});

describe('script commands resolve against the package manager workspace source', () => {
  async function missing(files: Record<string, string>): Promise<string[]> {
    const repo = repoWith(files);
    const { issues } = await scan({ repoPath: repo, projectType: 'typescript' });
    return issues.filter((i) => i.category === 'command_validity').map((i) => i.evidence[0] ?? i.title);
  }

  const claude = (cmd: string): string => `# Project\n\n## Commands\n\n- Run it with \`${cmd}\`.\n`;

  it('pnpm --filter finds a package declared in pnpm-workspace.yaml', async () => {
    const found = await missing({
      'package.json': JSON.stringify({ name: 'root', packageManager: 'pnpm@9.15.9', scripts: { test: 'x' } }),
      ...LAYOUT,
      'CLAUDE.md': claude('pnpm --filter b dev'),
    });
    expect(found).toEqual([]);
  });

  it('pnpm --filter does not find a package only listed in package.json workspaces', async () => {
    const found = await missing({
      'package.json': JSON.stringify({ name: 'root', packageManager: 'pnpm@9.15.9', workspaces: ['pkgs-json/*'], scripts: { test: 'x' } }),
      ...LAYOUT,
      'CLAUDE.md': claude('pnpm --filter a dev'),
    });
    expect(found.join('\n')).toContain('pnpm --filter a dev');
  });

  it('npm -w finds a package declared in package.json workspaces', async () => {
    const found = await missing({
      'package.json': JSON.stringify({ name: 'root', workspaces: ['pkgs-json/*'], scripts: { test: 'x' } }),
      'package-lock.json': '{}',
      ...LAYOUT,
      'CLAUDE.md': claude('npm run dev -w a'),
    });
    expect(found).toEqual([]);
  });

  it('npm -w does not find a package only listed in pnpm-workspace.yaml', async () => {
    const found = await missing({
      'package.json': JSON.stringify({ name: 'root', workspaces: ['pkgs-json/*'], scripts: { test: 'x' } }),
      'package-lock.json': '{}',
      ...LAYOUT,
      'CLAUDE.md': claude('npm run dev -w b'),
    });
    expect(found.join('\n')).toContain('npm run dev -w b');
  });

  it('with no package manager signal, either source resolves', async () => {
    const found = await missing({
      'package.json': ROOT,
      ...LAYOUT,
      'CLAUDE.md': '# Project\n\n## Commands\n\n- `pnpm --filter a dev`\n- `pnpm --filter b dev`\n',
    });
    expect(found).toEqual([]);
  });
});

describe('lockfiles of several managers (#200)', () => {
  async function workspaceDirs(pkg: Record<string, unknown>, lockfiles: string[]): Promise<string[]> {
    const repo = repoWith({
      'package.json': JSON.stringify({ name: 'root', workspaces: ['pkgs-json/*'], ...pkg }),
      ...Object.fromEntries(lockfiles.map((f) => [f, '{}'])),
      ...LAYOUT,
    });
    const context = await buildRepoContext({ repoPath: repo, projectType: 'typescript' });
    return (context.workspaces ?? []).map((w) => w.dir).filter((d) => d !== '.').sort();
  }

  it('two managers\' lockfiles and no packageManager field read as unknown: both sources are read', async () => {
    expect(await workspaceDirs({}, ['pnpm-lock.yaml', 'package-lock.json'])).toEqual(['pkgs-json/a', 'pkgs-yaml/b']);
  });

  it('one lockfile decides', async () => {
    expect(await workspaceDirs({}, ['pnpm-lock.yaml'])).toEqual(['pkgs-yaml/b']);
    expect(await workspaceDirs({}, ['package-lock.json'])).toEqual(['pkgs-json/a']);
  });

  it('the packageManager field still wins over a second lockfile', async () => {
    expect(await workspaceDirs({ packageManager: 'pnpm@9.15.9' }, ['package-lock.json', 'yarn.lock'])).toEqual(['pkgs-yaml/b']);
  });
});

describe('fixture-workspace-sources', () => {
  it('accepts the package pnpm-workspace.yaml declares and flags the one only package.json lists', async () => {
    const { issues } = await scan({ repoPath: FIXTURE, projectType: 'typescript' });
    const found = issues.filter((i) => i.category === 'command_validity').map((i) => i.evidence[0] ?? i.title);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('pnpm --filter legacy dev');
  });
});
