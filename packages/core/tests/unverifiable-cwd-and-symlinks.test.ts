/**
 * pcic-2b6.13 and the command-validity half of pcic-2b6.8.
 *
 *  - A `cd` to a directory the scanner cannot resolve (absolute, home,
 *    out-of-repo, variable) makes the rest of the line unverifiable. It used to
 *    fall back to the repo root (`cmd.cwd ?? '.'`) and validate against the
 *    root manifest.
 *  - A bare `./dir` in a code span is a directory mention, not a missing script.
 *  - Files committed as symlinks to a location outside the repository are never
 *    read (instruction files, package manifests, Makefiles); in-repo symlinks are.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRepoContext } from '../src/repo-context.js';
import { realPathWithinRoot, resolveReadableWithinRoot } from '../src/path-containment.js';
import { scan } from '../src/scan.js';
import { makeTempRepo, writeFile } from './ai-config-helpers.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempRepo(files: Record<string, string>): string {
  const repo = makeTempRepo('promptci-cwd-');
  tempDirs.push(repo);
  for (const [rel, content] of Object.entries(files)) writeFile(repo, rel, content);
  return repo;
}

async function commandSummaries(repo: string): Promise<string[]> {
  const report = await scan({ repoPath: repo, projectType: 'typescript' });
  return report.issues
    .filter((i) => i.category === 'command_validity' || i.id.startsWith('manifest-missing-script'))
    .map((i) => i.summary);
}

const ROOT_PKG = JSON.stringify({ name: 'root', scripts: { build: 'tsc' } });

describe('unknown working directory is unverifiable (pcic-2b6.13)', () => {
  it.each([
    ['an absolute path', 'cd /srv/app && pnpm deploy-prod'],
    ['a home path', 'cd ~/work/app && pnpm deploy-prod'],
    ['a path escaping the repo', 'cd ../../elsewhere && pnpm deploy-prod'],
    ['a variable', 'cd $APP_DIR && pnpm deploy-prod'],
    ['a command substitution', 'cd "$(git rev-parse --show-toplevel)/app" && node scripts/gone.js'],
    ['cd -', 'cd - && ./scripts/gone.sh'],
  ])('does not validate after `cd` to %s', async (_label, command) => {
    const repo = tempRepo({
      'package.json': ROOT_PKG,
      'AGENTS.md': `# Agents\n\n\`\`\`bash\n${command}\n\`\`\`\n\nAlso \`${command}\`.\n`,
    });
    expect(await commandSummaries(repo)).toEqual([]);
  });

  it('still validates after a resolvable `cd` (control)', async () => {
    const repo = tempRepo({
      'package.json': ROOT_PKG,
      'apps/web/package.json': JSON.stringify({ name: 'web', scripts: { dev: 'next dev' } }),
      'AGENTS.md': '# Agents\n\n```bash\ncd apps/web && pnpm deploy-prod\n```\n',
    });
    expect(await commandSummaries(repo)).toEqual([
      'pnpm script "deploy-prod" does not appear in apps/web/package.json scripts',
    ]);
  });
});

describe('bare ./dir is not a missing script (pcic-2b6.8)', () => {
  it('ignores `./dir` mentions in code spans, existing or not', async () => {
    const repo = tempRepo({
      'package.json': ROOT_PKG,
      'src/index.ts': '',
      'AGENTS.md': '# Agents\n\nSources are under `./src`; old code was in `./legacy` and `./old-docs/`.\n',
    });
    expect(await commandSummaries(repo)).toEqual([]);
  });

  it('never reports an existing directory, even on a shell-fence line', async () => {
    const repo = tempRepo({
      'package.json': ROOT_PKG,
      'src/index.ts': '',
      'AGENTS.md': '# Agents\n\n```bash\n./src\n```\n',
    });
    expect(await commandSummaries(repo)).toEqual([]);
  });

  it('still reports a missing extension-less executable run from a shell fence', async () => {
    const repo = tempRepo({
      'package.json': ROOT_PKG,
      'AGENTS.md': '# Agents\n\n```bash\n./gradlew\n```\n',
    });
    expect(await commandSummaries(repo)).toEqual(['Script "./gradlew" does not appear to exist in the repository']);
  });

  it('still reports a missing script with arguments or an extension', async () => {
    const repo = tempRepo({
      'package.json': ROOT_PKG,
      'AGENTS.md': '# Agents\n\nRun `./scripts/setup.sh` or `./tools/gen --all`.\n',
    });
    expect(await commandSummaries(repo)).toEqual([
      'Script "./scripts/setup.sh" does not appear to exist in the repository',
      'Script "./tools/gen" does not appear to exist in the repository',
    ]);
  });
});

// ── Symlinks ──────────────────────────────────────────────────────────────────

/** Create a file symlink, or return false where the OS refuses (Windows without the privilege). */
function trySymlink(target: string, linkPath: string): boolean {
  try {
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.symlinkSync(target, linkPath, 'file');
    return true;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') return false;
    throw err;
  }
}

function symlinksSupported(): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-symlink-probe-'));
  try {
    fs.writeFileSync(path.join(dir, 'target'), '');
    return trySymlink(path.join(dir, 'target'), path.join(dir, 'link'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const canSymlink = symlinksSupported();

/**
 * A linked DIRECTORY (a junction on Windows, which needs no privilege; a plain
 * directory symlink elsewhere), so this part runs on every platform.
 */
describe('files under a directory linked outside the repo are not read (pcic-2b6.13)', () => {
  function setup(): string {
    const outside = makeTempRepo('promptci-outside-dir-');
    tempDirs.push(outside);
    writeFile(outside, 'package.json', JSON.stringify({ name: 'outside', scripts: { other: 'x' } }));
    writeFile(outside, 'Makefile', 'other:\n\t@echo x\n');
    const repo = tempRepo({
      'package.json': ROOT_PKG,
      'AGENTS.md': '# Agents\n\n```bash\ncd linked && pnpm deploy-prod\nmake -C linked deploy\n```\n',
    });
    fs.symlinkSync(outside, path.join(repo, 'linked'), 'junction');
    return repo;
  }

  it('resolveReadableWithinRoot refuses a path through the link', () => {
    const repo = setup();
    expect(resolveReadableWithinRoot(repo, 'linked/package.json')).toBeNull();
    expect(realPathWithinRoot(repo, path.join(repo, 'linked', 'Makefile'))).toBe(false);
  });

  it('does not validate commands against manifests or Makefiles read through the link', async () => {
    const repo = setup();
    // Read through the link, both would be reported (neither defines the name);
    // unread, the directory's manifests are unknown and nothing is claimed.
    expect(await commandSummaries(repo)).toEqual([]);
  });

  it('does not scan instruction files under a rules directory linked outside the repo', async () => {
    const outside = makeTempRepo('promptci-outside-rules-');
    tempDirs.push(outside);
    writeFile(outside, 'house-style.md', '# Outside rules\n\nOUTSIDE-RULES-MARKER\n');
    const repo = tempRepo({ 'AGENTS.md': '# Agents\n\nIN-REPO-MARKER\n' });
    fs.mkdirSync(path.join(repo, '.cursor'), { recursive: true });
    // fast-glob starts its walk AT a pattern's base directory (`.cursor/rules`),
    // following a link there even with followSymbolicLinks: false.
    fs.symlinkSync(outside, path.join(repo, '.cursor', 'rules'), 'junction');
    const context = await buildRepoContext({ repoPath: repo });
    const contents = context.files.map((f) => f.content).join('\n');
    expect(contents).toContain('IN-REPO-MARKER');
    expect(contents).not.toContain('OUTSIDE-RULES-MARKER');
  });
});

/**
 * File symlinks need a privilege on Windows, so this part runs where the OS
 * allows them (CI on Linux). fast-glob never lists a symlinked FILE while
 * walking (followSymbolicLinks: false leaves its dirent a symlink, not a file),
 * but manifests and Makefiles are opened by name and used to be read through.
 */
describe.skipIf(!canSymlink)('symlinked files escaping the repo are not read (pcic-2b6.13)', () => {
  function setup(): string {
    const outside = makeTempRepo('promptci-outside-');
    tempDirs.push(outside);
    writeFile(outside, 'secret.md', '# Outside\n\nSECRET-MARKER\n');
    writeFile(outside, 'package.json', JSON.stringify({ name: 'outside', scripts: { 'outside-only': 'x' } }));
    writeFile(outside, 'Makefile', 'outside-target:\n\t@echo x\n');

    const repo = tempRepo({
      'AGENTS.md': '# Agents\n\n```bash\nmake deploy\ncd apps/web && pnpm deploy-prod\n```\n',
      'config/package.json': JSON.stringify({ name: 'root', scripts: { 'in-repo-only': 'x' } }),
      'apps/web/README.md': '',
    });
    trySymlink(path.join(outside, 'secret.md'), path.join(repo, 'CLAUDE.md'));
    // In-repo link: still read.
    trySymlink(path.join(repo, 'config', 'package.json'), path.join(repo, 'package.json'));
    // Escaping links: not read.
    trySymlink(path.join(outside, 'package.json'), path.join(repo, 'apps', 'web', 'package.json'));
    trySymlink(path.join(outside, 'Makefile'), path.join(repo, 'Makefile'));
    return repo;
  }

  it('reads an in-repo manifest link but not a Makefile or instruction file linked outside', async () => {
    const repo = setup();
    const context = await buildRepoContext({ repoPath: repo });
    expect(context.packageJson.scripts).toEqual({ 'in-repo-only': 'x' });
    expect(context.makefile).toBeUndefined();
    expect(context.files.map((f) => f.content).join('\n')).not.toContain('SECRET-MARKER');
    expect((context.workspaces ?? []).some((ws) => ws.scripts['outside-only'])).toBe(false);
  });

  it('does not validate commands against a Makefile or manifest linked outside the repo', async () => {
    const repo = setup();
    // Read through the links, both commands would be reported.
    expect(await commandSummaries(repo)).toEqual([]);
  });

  it('path-containment helpers reject the escaping link and accept the in-repo one', () => {
    const repo = setup();
    expect(realPathWithinRoot(repo, path.join(repo, 'Makefile'))).toBe(false);
    expect(resolveReadableWithinRoot(repo, 'CLAUDE.md')).toBeNull();
    expect(realPathWithinRoot(repo, path.join(repo, 'package.json'))).toBe(true);
    expect(resolveReadableWithinRoot(repo, 'package.json')).toBe(path.join(repo, 'package.json'));
    // A path that does not exist has nothing to read through.
    expect(realPathWithinRoot(repo, path.join(repo, 'absent.md'))).toBe(true);
  });
});
