/**
 * pcic-x1vl: the command-validity detector gets the dead-reference hardening
 * of pcic-xhzb (RepoTree).
 *
 * - Containment: a path a documented command names (`node ../x.js`, `./x.sh`,
 *   `docker compose -f`, `dotnet test`, `bun x.ts`, `--filter ../x`, `cd x`,
 *   `make -C x`) is only ever looked up inside the scan root. A `..` or
 *   absolute path, or a committed link out of the tree, must not cause a
 *   single filesystem call outside it, and the findings must not depend on
 *   whether the outside path exists. In the hosted product the root is a
 *   server temp directory, so either would tell the author of the scanned
 *   repository whether a server path exists.
 * - Exact case: a command's path resolves only to a file of exactly that name,
 *   on every platform, as on Linux and in CI.
 * - Unreadable directories: a command whose path lies under a directory that
 *   cannot be listed is not reported as missing; the scan says what it could
 *   not read instead.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import fg from 'fast-glob';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { detectCommandValidity } from '../src/command-validity.js';
import { emptyAiConfigFiles } from '../src/ai-config.js';
import type { RepoContext } from '../src/repo-context.js';
import type { InstructionFile, PromptCiIssue } from '../src/types.js';
import { canSymlink, trySymlink } from './ai-config-helpers.js';

/**
 * Every path argument handed to the filesystem while `recording` is on. Two
 * recorders feed it: the `node:fs` mock below sees the detector's own calls,
 * and the CommonJS `fs` patch here sees what dependencies (fast-glob,
 * @nodelib) call, which a `vi.mock` of the ES module never intercepts. The
 * patch runs before any import, so dependencies capture the patched functions.
 */
const { fsCalls, record, state } = vi.hoisted(() => {
  const calls: string[] = [];
  const flags = { recording: false };
  const rec = (args: unknown[]): void => {
    if (!flags.recording) return;
    for (const arg of args) {
      if (typeof arg === 'string') calls.push(arg);
      else if (arg instanceof URL) calls.push(arg.pathname);
      else if (Buffer.isBuffer(arg)) calls.push(arg.toString());
    }
  };
  const cjsFs = process.getBuiltinModule('node:fs') as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(cjsFs)) {
    if (typeof value !== 'function' || /^[A-Z]/.test(key) || key.startsWith('_')) continue;
    const original = value as ((...a: unknown[]) => unknown) & Record<string, unknown>;
    const patched = Object.assign(function (this: unknown, ...args: unknown[]) {
      rec(args);
      return original.apply(this, args);
    }, original);
    cjsFs[key] = patched;
  }
  return { fsCalls: calls, record: rec, state: flags };
});
/** Directories whose listing fails with EACCES, as an unreadable directory would. */
const unreadableDirs = new Set<string>();

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const wrapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(actual)) {
    if (typeof value !== 'function' || /^[A-Z]/.test(key)) {
      wrapped[key] = value;
      continue;
    }
    const fn = (...args: unknown[]): unknown => {
      record(args);
      if ((key === 'readdirSync' || key === 'opendirSync') && typeof args[0] === 'string' &&
        unreadableDirs.has(path.resolve(args[0]))) {
        throw Object.assign(new Error(`EACCES: permission denied, scandir '${args[0]}'`), { code: 'EACCES' });
      }
      return (value as (...a: unknown[]) => unknown)(...args);
    };
    if (key === 'realpathSync') {
      const native = (...args: unknown[]): unknown => {
        record(args);
        return (actual.realpathSync.native as (...a: unknown[]) => unknown)(...args);
      };
      Object.assign(fn, { native });
    }
    wrapped[key] = fn;
  }
  return { ...wrapped, default: wrapped };
});

let base: string;
let repo: string;
let outside: string;

/** Files outside the root that an instruction file could name. */
const OUTSIDE_FILES: Record<string, string> = {
  'sentinel.js': '',
  'sentinel.sh': '',
  'sentinel.ts': '',
  'sentinel.yml': '',
  'sentinel.csproj': '',
  'sentinel.txt': '',
  'package.json': JSON.stringify({ name: 'outside', scripts: { 'sentinel-only': 'echo' } }),
  'Makefile': 'build:\n\techo\n',
};

function writeOutside(): void {
  fs.mkdirSync(outside, { recursive: true });
  for (const [name, content] of Object.entries(OUTSIDE_FILES)) fs.writeFileSync(path.join(outside, name), content);
}

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-cmd-containment-'));
  repo = path.join(base, 'repo');
  outside = path.join(base, 'outside');
  const write = (rel: string, content = ''): void => {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  write('package.json', JSON.stringify({ name: 'repo', scripts: { build: 'tsc' } }));
  write('scripts/build.js');
  write('scripts/setup.sh');
  write('docs/tool.js');
  write('tools/Makefile', 'build:\n\techo\n');
  write('private/run.js');
  write('private/package.json', JSON.stringify({ name: 'private', scripts: { lint: 'eslint' } }));
  write('libs/ui/package.json', JSON.stringify({ name: 'ui', scripts: { storybook: 'storybook dev' } }));
  write('App.sln');
  writeOutside();
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

afterEach(() => {
  state.recording = false;
  fsCalls.length = 0;
  unreadableDirs.clear();
});

function file(content: string, rel = 'AGENTS.md'): InstructionFile {
  return {
    path: path.join(repo, rel),
    fileType: 'agents',
    content,
    sections: [],
    lineCount: content.split('\n').length,
    charCount: content.length,
    estimatedTokens: Math.round(content.length / 4),
  };
}

function context(content: string): RepoContext {
  return {
    repoRoot: repo,
    files: [file(content)],
    projectType: 'typescript',
    manifests: {},
    packageJson: {
      packageManagerName: 'pnpm',
      scripts: { build: 'tsc' },
      dependencies: {},
      devDependencies: {},
      peerDependencies: {},
      lockfiles: [],
    },
    workflows: { files: [], commands: [] },
    aiConfig: emptyAiConfigFiles(),
    metrics: { estimatedInstructionTokens: 0, instructionFileCount: 1, largestInstructionFiles: [] },
  };
}

/** Commands in a shell fence, one per line, as an instruction file documents them. */
function fence(...lines: string[]): string {
  return ['```bash', ...lines, '```'].join('\n');
}

function detect(content: string): PromptCiIssue[] {
  state.recording = true;
  try {
    return detectCommandValidity(context(content));
  } finally {
    state.recording = false;
  }
}

/** The commands reported as missing something (not the "check incomplete" notice). */
function reported(issues: PromptCiIssue[]): string[] {
  return issues
    .filter((i) => !i.title.startsWith('Command check incomplete'))
    .map((i) => i.evidence[0]!.replace(/^Command: `|`$/g, ''))
    .sort();
}

/** Paths the detector handed to the filesystem that resolve outside the scan root. */
function outOfRootCalls(): string[] {
  const root = path.resolve(repo);
  return fsCalls.filter((p) => {
    const rel = path.relative(root, path.resolve(root, p));
    return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  });
}

/** The outside files, named every way a documented command could reach them. */
function escapingCommands(): string {
  const rel = path.relative(repo, outside).split(path.sep).join('/');
  const abs = outside.split(path.sep).join('/');
  return fence(
    `node ${rel}/sentinel.js`,
    `bash ${rel}/sentinel.sh`,
    `node ${abs}/sentinel.js`,
    `python ${abs}/sentinel.py`,
    'python ../../../../../../../../etc/promptci-sentinel.py',
    'tsx /etc/promptci-sentinel.ts',
    `./${rel}/sentinel.sh`,
    `${rel}/sentinel.sh`,
    `docker compose -f ${rel}/sentinel.yml up`,
    `dotnet test ${rel}/sentinel.csproj`,
    `dotnet test ${rel}/sentinel.txt`,
    `dotnet test ${abs}/sentinel.txt`,
    `bun ${rel}/sentinel.ts`,
    `pnpm --filter ${rel} sentinel-only`,
    `cd .. && node outside/sentinel.js`,
    `make -C ${rel} build`,
  );
}

describe('commands that name a path outside the scan root', () => {
  it('records in-root filesystem access (the spy is wired)', () => {
    detect(fence('node scripts/missing.js'));
    expect(fsCalls.length).toBeGreaterThan(0);
    expect(outOfRootCalls()).toEqual([]);
  });

  it('sees the filesystem calls a dependency makes on its own (the CommonJS recorder is wired)', () => {
    state.recording = true;
    try {
      fg.sync('*', { cwd: path.join(repo, 'scripts') });
    } finally {
      state.recording = false;
    }
    expect(fsCalls.some((p) => path.resolve(p) === path.join(repo, 'scripts'))).toBe(true);
  });

  it('never touches the filesystem outside the root for `..` and absolute paths', () => {
    const issues = detect(escapingCommands());
    expect(outOfRootCalls()).toEqual([]);
    // Only the script check, which never looks outside, reports: the selector matched no manifest.
    expect(reported(issues)).toEqual(['pnpm --filter ../outside sentinel-only']);
  });

  it('gives the same result whether or not the outside paths exist', () => {
    const withSentinel = detect(escapingCommands());
    fs.rmSync(outside, { recursive: true, force: true });
    try {
      expect(detect(escapingCommands())).toEqual(withSentinel);
    } finally {
      writeOutside();
    }
  });

  it('skips an absolute path even when it points into the root, so the checkout location does not matter', () => {
    const inside = path.join(repo, 'scripts').split(path.sep).join('/');
    const issues = detect(fence(`node ${inside}/gone.js`, `node ${inside}/build.js`, `dotnet test ${inside}/x.txt`));
    expect(issues).toEqual([]);
    expect(outOfRootCalls()).toEqual([]);
  });

  it('skips Windows drive, drive-relative and UNC paths on every platform without touching them', () => {
    const issues = detect(fence(
      'node C:\\Windows\\win.ini.js',
      // (Not `.example`: the detector skips any command containing "example" as a placeholder.)
      'bash \\\\attacker.test\\share\\payload.sh',
      'node //attacker.test/share/payload.js',
      'docker compose -f D:/elsewhere/compose.yml up',
      'node C:elsewhere-notes.js',
      'dotnet test C:elsewhere.txt',
      'cd C:elsewhere && node scripts/gone.js',
      'cd \\\\attacker.test\\share && node scripts/gone.js',
      'make -C C:elsewhere no-such-target',
      // A control: the same fence is judged, so the lines above are skipped, not ignored.
      'node scripts/gone.js',
    ));
    expect(reported(issues)).toEqual(['node scripts/gone.js']);
    expect(outOfRootCalls()).toEqual([]);
    expect(fsCalls.filter((p) => /attacker\.test|win\.ini|elsewhere/.test(p))).toEqual([]);
  });

  it('does not resolve a `..` path that climbs out and re-enters the root by its name', () => {
    // Resolving it would report `gone.js` only when the guess at the root's
    // directory name is right, telling the author where the scan runs.
    const name = path.basename(repo);
    const parent = path.basename(base);
    const issues = detect(fence(
      `node ../${name}/scripts/gone.js`,
      `cd docs && node ../../${name}/scripts/gone.js`,
      `./../../${parent}/${name}/scripts/gone.sh`,
      `docker compose -f ../${name}/gone.yml up`,
    ));
    expect(issues).toEqual([]);
    expect(outOfRootCalls()).toEqual([]);
  });

  it('does not judge a path computed from the environment', () => {
    expect(detect(fence('node ~/gone.js', 'node $HOME/gone.js', 'python %APPDATA%\\gone.py', 'bash `pwd`/gone.sh')))
      .toEqual([]);
  });

  it('still resolves a `..` path that stays inside the root', () => {
    const issues = detect(fence('cd docs && node ../scripts/build.js', 'cd docs && node ../scripts/gone.js'));
    expect(reported(issues)).toEqual(['node ../scripts/gone.js']);
    expect(outOfRootCalls()).toEqual([]);
  });

  it('does not follow a committed directory link out of the tree', () => {
    const link = path.join(repo, 'escape');
    fs.symlinkSync(outside, link, 'junction');
    const commands = fence(
      'node escape/sentinel.js',
      'node escape/nothing.js',
      './escape/sentinel.sh',
      'docker compose -f escape/sentinel.yml up',
      'cd escape && pnpm sentinel-only',
      'make -C escape build',
      'cd escape && make other',
    );
    try {
      const withSentinel = detect(commands);
      expect(withSentinel).toEqual([]);
      const touched = fsCalls.filter((p) => path.resolve(repo, p).startsWith(`${link}${path.sep}`));
      expect(touched).toEqual([]);
      fs.rmSync(outside, { recursive: true, force: true });
      try {
        expect(detect(commands)).toEqual(withSentinel);
      } finally {
        writeOutside();
      }
    } finally {
      fs.rmSync(link, { recursive: true, force: true });
    }
  });

  it('does not read a workspace directory linked out of the tree', () => {
    const link = path.join(repo, 'packages');
    fs.symlinkSync(base, link, 'junction');
    try {
      const issues = detect(fence('pnpm --filter outside sentinel-only'));
      expect(reported(issues)).toEqual(['pnpm --filter outside sentinel-only']);
      const touched = fsCalls.filter((p) => path.resolve(repo, p).startsWith(`${link}${path.sep}`));
      expect(touched).toEqual([]);
    } finally {
      fs.rmSync(link, { recursive: true, force: true });
    }
  });

  it.skipIf(!canSymlink)('does not read or follow a committed file link out of the tree', () => {
    const links = [path.join(repo, 'linked.js'), path.join(repo, 'pkg/package.json'), path.join(repo, 'mk/Makefile')];
    expect(trySymlink(path.join(outside, 'sentinel.js'), links[0]!)).toBe(true);
    expect(trySymlink(path.join(outside, 'package.json'), links[1]!)).toBe(true);
    expect(trySymlink(path.join(outside, 'Makefile'), links[2]!)).toBe(true);
    const commands = fence(
      'node linked.js',
      './linked.js',
      'cd pkg && pnpm sentinel-only',
      'make -C mk build',
      'make -C mk other',
    );
    try {
      const withSentinel = detect(commands);
      expect(withSentinel).toEqual([]);
      expect(outOfRootCalls()).toEqual([]);
      fs.rmSync(outside, { recursive: true, force: true });
      try {
        expect(detect(commands)).toEqual(withSentinel);
      } finally {
        writeOutside();
      }
    } finally {
      for (const link of links) fs.rmSync(link, { force: true });
      fs.rmSync(path.join(repo, 'pkg'), { recursive: true, force: true });
      fs.rmSync(path.join(repo, 'mk'), { recursive: true, force: true });
    }
  });

  it('follows a committed directory link that stays inside the tree', () => {
    const link = path.join(repo, 'guides');
    fs.symlinkSync(path.join(repo, 'docs'), link, 'junction');
    try {
      expect(reported(detect(fence('node guides/tool.js', 'node guides/gone.js')))).toEqual(['node guides/gone.js']);
    } finally {
      fs.rmSync(link, { recursive: true, force: true });
    }
  });

  it('gives up on a link cycle without reporting it as missing, and names the link', () => {
    const a = path.join(repo, 'loop-a');
    const b = path.join(repo, 'loop-b');
    fs.symlinkSync(b, a, 'junction');
    fs.symlinkSync(a, b, 'junction');
    try {
      const issues = detect(fence('node loop-a/x.js'));
      expect(reported(issues)).toEqual([]);
      const notice = issues.find((i) => i.title.startsWith('Command check incomplete'));
      expect(notice?.evidence).toEqual(expect.arrayContaining([
        expect.stringMatching(/^Could not read: loop-[ab] \(symlink loop\)$/),
        'Not checked: `node loop-a/x.js`',
      ]));
      expect(outOfRootCalls()).toEqual([]);
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });
});

describe('exact-case resolution on every platform', () => {
  it('reports a path whose case differs from the file on disk', () => {
    const issues = detect(fence(
      'node scripts/Build.js',
      'node Scripts/build.js',
      './scripts/Setup.sh',
      'dotnet test app.sln',
    ));
    expect(reported(issues)).toEqual([
      './scripts/Setup.sh',
      'dotnet test app.sln',
      'node Scripts/build.js',
      'node scripts/Build.js',
    ]);
  });

  it('still resolves the exact name', () => {
    expect(detect(fence('node scripts/build.js', './scripts/setup.sh', 'dotnet test App.sln'))).toEqual([]);
  });

  it('reads a Makefile only under its exact directory name', () => {
    expect(reported(detect(fence('make -C tools missing-target')))).toEqual(['make -C tools missing-target']);
    expect(detect(fence('make -C Tools missing-target'))).toEqual([]);
  });
});

describe('a directory that cannot be listed', () => {
  it('does not report a command whose path it could not look for, and says so', () => {
    unreadableDirs.add(path.resolve(repo, 'private'));
    const issues = detect(fence('node private/run.js', 'node private/gone.js', 'node scripts/gone.js'));
    expect(reported(issues)).toEqual(['node scripts/gone.js']);
    const notice = issues.find((i) => i.title.startsWith('Command check incomplete'));
    expect(notice).toBeDefined();
    // A warning, like the findings it stands in for: a `--fail-on warning` gate is not passed silently.
    expect(notice!.severity).toBe('warning');
    expect(notice!.category).toBe('command_validity');
    expect(notice!.evidence).toEqual([
      'Could not read: private/ (EACCES)',
      'Not checked: `node private/run.js`',
      'Not checked: `node private/gone.js`',
    ]);
    expect(notice!.locations).toEqual([{ filePath: path.join(repo, 'AGENTS.md'), startLine: 2 }]);
    // The text never carries an absolute (server) path; filePaths are the scanned files, as for every issue.
    const text = [notice!.title, notice!.summary, notice!.recommendation, ...notice!.evidence].join('\n');
    expect(text).not.toContain(path.resolve(repo));
    expect(text).not.toContain(path.resolve(repo).split(path.sep).join('/'));
    expect(notice!.filePaths).toEqual([path.join(repo, 'AGENTS.md')]);
  });

  it('does not report a script it could not look for in an unreadable package directory', () => {
    unreadableDirs.add(path.resolve(repo, 'libs'));
    unreadableDirs.add(path.resolve(repo, 'private'));
    const issues = detect(fence('pnpm --filter ui run storybook', 'cd private && pnpm lint'));
    expect(reported(issues)).toEqual([]);
    const notice = issues.find((i) => i.title.startsWith('Command check incomplete'));
    expect(notice?.evidence).toEqual([
      'Could not read: libs/ (EACCES)',
      'Could not read: private/ (EACCES)',
      'Not checked: `pnpm --filter ui run storybook`',
      'Not checked: `pnpm lint`',
    ]);
  });

  it('still judges a workspace script when the package directory can be read', () => {
    expect(reported(detect(fence('pnpm --filter ui run storybook', 'pnpm --filter ui run nope')))).toEqual([
      'pnpm --filter ui run nope',
    ]);
  });

  it('reports nothing about the tree when every directory can be listed', () => {
    const issues = detect(fence('node scripts/gone.js'));
    expect(issues.map((i) => i.title)).toEqual(['Possible reference to missing command or file: `node scripts/gone.js`']);
  });
});
