/**
 * pcic-1ik0.22: bin/ and obj/ holding files are only guessed to be build output. A scan with no complete file
 * inventory (none given, or one declared incomplete) reports them but never marks the finding autoApplySafe,
 * matching a scan whose complete inventory lists the files as tracked.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scan } from '../src/scan.js';

const ID = 'security-pack-unignored-dirs';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function repo(files: Record<string, string>): { root: string; paths: string[] } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-unverified-bin-'));
  temps.push(root);
  const all = { 'CLAUDE.md': '# Rules\n\nRun `npm test`.\n', ...files };
  for (const [rel, content] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return { root, paths: Object.keys(all) };
}

const find = (r: Awaited<ReturnType<typeof scan>>) => r.issues.find((i) => i.id === ID);

const CASES: [string, Record<string, string>, string][] = [
  ['build.gradle + bin/*.jar', { 'build.gradle': 'apply plugin: "java"\n', 'bin/tool.jar': 'PK' }, 'bin'],
  ['App.sln + bin/nuget.exe', { 'App.sln': '', 'bin/nuget.exe': 'MZ' }, 'bin'],
  ['pom.xml + bin/*.jar + *.class', { 'pom.xml': '<project/>', 'bin/tool.jar': 'PK', 'bin/Main.class': 'CAFE' }, 'bin'],
  ['App.csproj + bin/libnative.so', { 'App.csproj': '<Project/>', 'bin/libnative.so': 'ELF' }, 'bin'],
];

describe('bin/ and obj/ without a complete inventory (pcic-1ik0.22)', () => {
  it.each(CASES)('%s: reported, not autoApplySafe, with no inventory', async (_l, files, dir) => {
    const { root } = repo(files);
    const issue = find(await scan({ repoPath: root }));
    expect(issue?.evidence?.[0]).toContain(`Directory "${dir}" exists`);
    expect(issue?.autoApplySafe).toBe(false);
  });

  // An incomplete inventory withholds bin/ outright (a partial listing may miss source); never safe either way.
  it.each(CASES)('%s: never autoApplySafe with an incomplete inventory', async (_l, files) => {
    const { root, paths } = repo(files);
    const issue = find(await scan({ repoPath: root, knownPaths: paths, knownPathsComplete: false }));
    expect(issue).toBeUndefined();
  });

  it('obj/ with an incomplete inventory is reported and not autoApplySafe', async () => {
    const { root, paths } = repo({ 'App.csproj': '<Project/>', 'obj/project.assets.json': '{}' });
    const issue = find(await scan({ repoPath: root, knownPaths: paths, knownPathsComplete: false }));
    expect(issue?.evidence?.[0]).toContain('Directory "obj" exists');
    expect(issue?.autoApplySafe).toBe(false);
  });

  it.each(CASES)('%s: control, a complete inventory lists them as tracked and stays unsafe', async (_l, files) => {
    const { root, paths } = repo(files);
    const issue = find(await scan({ repoPath: root, knownPaths: paths, knownPathsComplete: true }));
    expect(issue).toBeDefined();
    expect(issue?.autoApplySafe).toBe(false);
  });

  it('obj/ holding files beside a .NET project is not auto-applicable without an inventory', async () => {
    const { root } = repo({ 'App.csproj': '<Project/>', 'obj/project.assets.json': '{}' });
    const issue = find(await scan({ repoPath: root }));
    expect(issue?.evidence?.[0]).toContain('Directory "obj" exists');
    expect(issue?.autoApplySafe).toBe(false);
  });

  it('a dist/ beside an unverified bin/ makes the whole finding unsafe, and the summary says why', async () => {
    const { root } = repo({ 'build.gradle': 'apply plugin: "java"\n', 'bin/tool.jar': 'PK', 'dist/index.js': '1;' });
    const issue = find(await scan({ repoPath: root }));
    expect(issue?.evidence).toHaveLength(2);
    expect(issue?.autoApplySafe).toBe(false);
    expect(issue?.summary).toContain('bin could not be verified as build output without a file inventory');
  });

  it('control: dist/ and coverage/ keep the local one-click fix', async () => {
    const { root } = repo({ 'package.json': '{"name":"x"}', 'dist/index.js': '1;' });
    const issue = find(await scan({ repoPath: root }));
    expect(issue?.evidence?.[0]).toContain('Directory "dist" exists');
    expect(issue?.autoApplySafe).toBe(true);
  });
});
