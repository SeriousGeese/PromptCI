/**
 * #212 and #188: the unignored build-directory finding.
 *
 * - A reported directory that holds listed files under a complete inventory is tracked, so the finding
 *   is never auto-applicable and the recommendation says `git rm -r --cached`.
 * - Directories committed on purpose are not reported: an Action's runs.main/pre/post, a placeholder
 *   dotfile and a tool under bin/ that a build file names, anywhere; and, for a directory known to be
 *   tracked, a package.json main/module/bin/files/exports target and an image a markdown file embeds.
 * - A directory .cursorignore lists is not reported when Cursor is the only tool the instruction files
 *   evidence; otherwise it stays, with a note that Cursor already skips it.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { scan } from '../src/scan.js';

const EXAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../examples');
const ID = 'security-pack-unignored-dirs';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function listFiles(root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(root, child));
    else out.push(child);
  }
  return out;
}

function repo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-tracked-dirs-'));
  temps.push(root);
  for (const [rel, content] of Object.entries({ 'CLAUDE.md': '# Rules\n\nRun `npm test`.\n', ...files })) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

async function unignored(root: string, complete = false) {
  const knownPaths = complete ? listFiles(root) : undefined;
  const report = await scan({ repoPath: root, ...(knownPaths ? { knownPaths, knownPathsComplete: true } : {}) });
  return report.issues.find((i) => i.id === ID);
}

describe('tracked directories (#212)', () => {
  const FIXTURE = path.join(EXAMPLES, 'fixture-tracked-build-dir');

  it('a local scan still reports the directories and keeps the one-click fix', async () => {
    const issue = await unignored(FIXTURE);
    expect(issue?.evidence).toEqual([
      'Directory "coverage" exists but is not ignored in .gitignore.',
      'Directory "dist" exists but is not ignored in .gitignore.',
    ]);
    expect(issue?.autoApplySafe).toBe(true);
  });

  it('with a complete inventory the listed files are tracked: reported, never auto-applicable, with git rm --cached', async () => {
    const issue = await unignored(FIXTURE, true);
    expect(issue?.evidence).toEqual([
      'Directory "coverage" exists but is not ignored in .gitignore; it holds 1 tracked file(s), so ignoring it does not untrack them.',
      'Directory "dist" exists but is not ignored in .gitignore; it holds 1 tracked file(s), so ignoring it does not untrack them.',
    ]);
    expect(issue?.autoApplySafe).toBe(false);
    expect(issue?.recommendation).toContain('git rm -r --cached coverage dist');
  });

  it('an explicitly listed empty directory holds nothing tracked and stays auto-applicable', async () => {
    const root = repo({ 'package.json': '{"name":"x"}' });
    const report = await scan({ repoPath: root, knownPaths: ['CLAUDE.md', 'package.json', 'dist/'], knownPathsComplete: true });
    const issue = report.issues.find((i) => i.id === ID);
    expect(issue?.evidence).toEqual(['Directory "dist" exists but is not ignored in .gitignore.']);
    expect(issue?.autoApplySafe).toBe(true);
  });
});

describe('directories committed on purpose are not reported (#212)', () => {
  it('fixture-deliberate-dirs reports nothing once the inventory says the directories are tracked', async () => {
    expect(await unignored(path.join(EXAMPLES, 'fixture-deliberate-dirs'), true)).toBeUndefined();
  });

  it('fixture-deliberate-dirs: a local scan still reports what only package.json and a badge vouch for', async () => {
    const issue = await unignored(path.join(EXAMPLES, 'fixture-deliberate-dirs'));
    // dist (Action), logs and tmp (placeholders) and bin (a tool the build names) stay silent anywhere.
    expect(issue?.evidence).toEqual([
      'Directory "coverage" exists but is not ignored in .gitignore.',
      'Directory "build" exists but is not ignored in .gitignore.',
    ]);
  });

  // Exemptions that hold wherever the scan runs.
  it.each([
    ['an Action runs.main', { 'action.yml': 'runs:\n  using: node20\n  main: dist/index.js\n', 'dist/index.js': '1;' }],
    ['an Action runs.post', { 'action.yaml': "runs:\n  using: node20\n  main: src/main.js\n  post: 'dist/cleanup.js'\n", 'dist/cleanup.js': '1;' }],
    ['a placeholder dotfile', { 'logs/.gitkeep': '', 'tmp/.keep': '' }],
    ['a Gradle file dependency in bin/', { 'build.gradle': "dependencies { implementation files('bin/google-java-format.jar') }\n", 'bin/google-java-format.jar': 'PK' }],
    ['a Maven systemPath into bin/', { 'pom.xml': '<project><systemPath>${project.basedir}/bin/tool.jar</systemPath></project>', 'bin/tool.jar': 'PK' }],
    ['a .NET target running bin/nuget.exe', { 'App.sln': '', 'build.proj': '', 'Directory.Build.props': '<Project><Exec Command="$(MSBuildThisFileDirectory)bin\\nuget.exe restore"/></Project>', 'bin/nuget.exe': 'MZ' }],
  ])('%s', async (_label, files) => {
    expect(await unignored(repo(files), true)).toBeUndefined();
    expect(await unignored(repo(files), false)).toBeUndefined();
  });

  // Exemptions that need the directory to be known as tracked: a library that publishes dist/ and forgot to
  // ignore a locally built one names the same target.
  it.each([
    ['package.json main', { 'package.json': '{"main":"./dist/index.js"}', 'dist/index.js': '1;' }],
    ['package.json module', { 'package.json': '{"module":"dist/index.mjs"}', 'dist/index.mjs': '1;' }],
    ['package.json bin', { 'package.json': '{"bin":{"x":"build/cli.js"}}', 'build/cli.js': '1;' }],
    ['package.json files', { 'package.json': '{"files":["dist","README.md"]}', 'dist/index.js': '1;' }],
    ['package.json exports', { 'package.json': '{"exports":{".":{"import":"./dist/index.mjs","require":"./dist/index.cjs"}}}', 'dist/index.mjs': '1;' }],
    ['a markdown image', { 'README.md': '![cov](coverage/badge.svg)\n', 'coverage/badge.svg': '<svg/>' }],
    ['an HTML img in markdown', { 'README.md': '<img alt="c" src="./coverage/badge.svg">\n', 'coverage/badge.svg': '<svg/>' }],
  ])('%s is silent for a tracked directory and still reported by a local scan', async (_label, files) => {
    expect(await unignored(repo(files), true)).toBeUndefined();
    expect(await unignored(repo(files), false)).toBeDefined();
  });

  it.each([
    ['prose naming a file under the directory is not a link', { 'README.md': 'The build writes dist/index.js.\n', 'package.json': '{"name":"x"}', 'dist/index.js': '1;' }],
    ['a plain markdown link is not an image', { 'README.md': 'See [the report](coverage/lcov-report/index.html).\n', 'coverage/lcov-report/index.html': '<html/>' }],
    ['an image that does not exist', { 'README.md': '![x](coverage/missing.svg)\n', 'coverage/other.txt': 'x' }],
    ['an unrelated package.json main', { 'package.json': '{"main":"src/index.js"}', 'dist/index.js': '1;' }],
    ['a negated files entry', { 'package.json': '{"files":["!dist/**/*.map"]}', 'dist/index.js.map': '{}' }],
    ['a .NET OutputPath names no file', { 'App.csproj': '<Project><PropertyGroup><OutputPath>bin\\Debug\\</OutputPath></PropertyGroup></Project>', 'bin/Debug/App.dll': 'MZ' }],
    ['a Remove glob under bin', { 'App.csproj': '<Project><None Remove="bin\\**\\*.json" /></Project>', 'bin/Debug/App.pdb': 'x', 'bin/Debug/App.dll': 'MZ' }],
    ['a published executable is output', { 'App.csproj': '<Project><Exec Command="bin\\net8.0\\publish\\App.exe" /></Project>', 'bin/net8.0/publish/App.exe': 'MZ' }],
    ['a tool the build names but the repository lacks', { 'build.gradle': "files('bin/missing.jar')\n", 'bin/other.jar': 'PK' }],
  ])('still reports when %s', async (_label, files) => {
    expect(await unignored(repo(files), true)).toBeDefined();
    expect(await unignored(repo(files), false)).toBeDefined();
  });

  it.each([['dist/.env'], ['tmp/.eslintcache']])('a non-placeholder dotfile (%s) is content, not a placeholder', async (file) => {
    expect(await unignored(repo({ [file]: 'x' }), false)).toBeDefined();
  });

  it('says "at least" when the walk stops before the end of the directory', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 2002; i++) files[`dist/f${String(i).padStart(4, '0')}.js`] = '';
    const issue = await unignored(repo(files), true);
    expect(issue?.evidence[0]).toMatch(/it holds at least \d+ tracked file\(s\)/);
  }, 60_000);
});

describe('Cursor ignore handling (#188)', () => {
  it('fixture-cursorignore: a directory .cursorignore lists is not reported when Cursor is the only tool', async () => {
    expect(await unignored(path.join(EXAMPLES, 'fixture-cursorignore'))).toBeUndefined();
  });

  it('keeps it, with a note, when other tools read the repository too', async () => {
    const root = repo({ '.cursorignore': 'dist/\n', 'dist/bundle.js': '1;', 'package.json': '{"name":"x"}' });
    const issue = await unignored(root);
    expect(issue?.evidence).toEqual([
      'Directory "dist" exists but is not ignored in .gitignore; Cursor already skips it through .cursorignore, other tools may not.',
    ]);
    expect(issue?.summary).toContain('terminal and MCP tools');
  });

  it('a directory .cursorignore does not list is still reported for Cursor', async () => {
    const root = repo({ '.cursorignore': 'secrets/\n', 'dist/bundle.js': '1;', 'package.json': '{"name":"x"}', '.cursor/rules/a.mdc': '---\nalwaysApply: true\n---\nUse TypeScript.\n' });
    expect((await unignored(root))?.evidence).toEqual(['Directory "dist" exists but is not ignored in .gitignore.']);
  });
});
