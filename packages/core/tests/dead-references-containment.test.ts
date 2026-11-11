/**
 * pcic-xhzb: hardening of the dead-reference resolver (follow-up to pcic-mh72).
 *
 * - Containment: a reference is only ever looked up inside the scan root. A
 *   `..` or absolute path, or a committed link out of the tree, must not cause
 *   a single filesystem call outside it. In the hosted product the root is a
 *   server temp directory, and an existence check outside it would tell the
 *   author of the scanned repository whether a server path exists.
 * - Exact case: a reference resolves only to a file of exactly that name, on
 *   every platform. A case-insensitive filesystem (Windows, macOS) must not
 *   hide a reference that is broken on Linux and on GitHub.
 * - Walk failures: when part of the tree cannot be listed, a name missing from
 *   the incomplete index is not reported as broken; the scan says what it
 *   could not read instead.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import fg from 'fast-glob';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { detectDeadReferences } from '../src/dead-references.js';
import type { InstructionFile, PromptCiIssue } from '../src/types.js';

/**
 * Every path argument handed to the filesystem while `recording` is on. Two
 * recorders feed it: the `node:fs` mock below sees the detector's own calls,
 * and the CommonJS `fs` patch here sees what dependencies (fast-glob,
 * @nodelib) call, which a `vi.mock` of the ES module never intercepts. The
 * patch runs before any import, so fast-glob captures the patched functions.
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
  // The CommonJS module object that `require('fs')` returns to dependencies.
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
let sentinel: string;

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-dead-ref-containment-'));
  repo = path.join(base, 'repo');
  outside = path.join(base, 'outside');
  sentinel = path.join(outside, 'sentinel.md');
  const write = (rel: string, content = ''): void => {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  write('README.md', '# repo\n');
  write('deploy_root.yml', 'name: deploy\n');
  write('.github/workflows/deploy_pr.yml', 'name: deploy\n');
  write('docs/guide.md', '# guide\n');
  write('docs/AGENTS.md', '');
  write('src/payments/index.ts', '');
  write('private/hidden.yml', '');
  write('private/also-hidden.md', '');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(sentinel, 'secret\n');
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

function detect(content: string, rel?: string): PromptCiIssue[] {
  state.recording = true;
  try {
    return detectDeadReferences([file(content, rel)], repo);
  } finally {
    state.recording = false;
  }
}

function brokenTitles(issues: PromptCiIssue[]): string[] {
  return issues.filter((i) => i.title.startsWith('Broken ')).map((i) => i.title).sort();
}

/** Paths the detector handed to node:fs that resolve outside the scan root. */
function outOfRootCalls(): string[] {
  const root = path.resolve(repo);
  return fsCalls.filter((p) => {
    const rel = path.relative(root, path.resolve(root, p));
    return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  });
}

/** `outside/sentinel.md` written the ways an instruction file could reach it. */
function escapingRefs(): string {
  const relFromRoot = path.relative(repo, sentinel).split(path.sep).join('/');
  const absolute = sentinel.split(path.sep).join('/');
  return [
    `See \`${relFromRoot}\` and [the notes](${relFromRoot}) and @${relFromRoot}.`,
    `Also \`${absolute}\` and [abs](${absolute}).`,
    'And `../../../../../../../../etc/hosts.md` and [up](../../../../../../../../etc/passwd.md).',
    'And `/etc/promptci-sentinel.md` and [root](/etc/promptci-sentinel.md).',
  ].join('\n');
}

describe('references that leave the scan root', () => {
  it('records in-root filesystem access (the spy is wired)', () => {
    detect('See `docs/missing.md`.');
    expect(fsCalls.length).toBeGreaterThan(0);
    expect(outOfRootCalls()).toEqual([]);
  });

  it('sees the filesystem calls fast-glob makes on its own (the CommonJS recorder is wired)', () => {
    state.recording = true;
    try {
      fg.sync('*', { cwd: path.join(repo, 'docs') });
    } finally {
      state.recording = false;
    }
    expect(fsCalls.some((p) => path.resolve(p) === path.join(repo, 'docs'))).toBe(true);
  });

  it('never touches the filesystem outside the root for `..` and absolute references', () => {
    const issues = detect(escapingRefs());
    expect(outOfRootCalls()).toEqual([]);
    expect(brokenTitles(issues)).toEqual([]);
  });

  it('never touches the filesystem outside the root from a nested instruction file', () => {
    detect(escapingRefs(), 'docs/AGENTS.md');
    expect(outOfRootCalls()).toEqual([]);
  });

  it('gives the same result whether or not the outside path exists', () => {
    const withSentinel = detect(escapingRefs());
    fs.rmSync(sentinel);
    try {
      const withoutSentinel = detect(escapingRefs());
      expect(withoutSentinel).toEqual(withSentinel);
    } finally {
      fs.writeFileSync(sentinel, 'secret\n');
    }
  });

  it('skips an absolute path even when it points into the root, so the checkout location does not matter', () => {
    const inside = path.join(repo, 'GONE.md').split(path.sep).join('/');
    expect(detect(`See \`${inside}\` and [x](${inside}).`)).toEqual([]);
    expect(outOfRootCalls()).toEqual([]);
  });

  it('skips Windows drive and UNC paths on every platform without touching them', () => {
    const issues = detect([
      'See `C:\\Windows\\win.ini.md` and `\\\\attacker.example\\share\\payload.md`.',
      'And [unc](//attacker.example/share/payload.md) and `D:/elsewhere/notes.md`.',
      'And the drive-relative `C:elsewhere-notes.md` and [d](D:elsewhere-guide.md).',
    ].join('\n'));
    expect(issues).toEqual([]);
    expect(outOfRootCalls()).toEqual([]);
    expect(fsCalls.filter((p) => /attacker\.example|win\.ini|elsewhere/.test(p))).toEqual([]);
  });

  it('still resolves a `..` reference that stays inside the root', () => {
    const issues = detect('See [the readme](../README.md) and [gone](../GONE.md).', 'docs/AGENTS.md');
    expect(brokenTitles(issues)).toEqual(['Broken file reference: GONE.md']);
    expect(outOfRootCalls()).toEqual([]);
  });

  it('does not follow a committed directory link out of the tree', () => {
    const link = path.join(repo, 'escape');
    fs.symlinkSync(outside, link, 'junction');
    try {
      const issues = detect('See `escape/sentinel.md`, `escape/nothing-here.md` and [x](escape/sentinel.md).');
      expect(brokenTitles(issues)).toEqual([]);
      const touched = fsCalls.filter((p) => path.resolve(repo, p).startsWith(`${link}${path.sep}`));
      expect(touched).toEqual([]);
    } finally {
      fs.rmSync(link, { recursive: true, force: true });
    }
  });

  it('gives up on a link cycle without reporting it as broken, and names the link', () => {
    const a = path.join(repo, 'loop-a');
    const b = path.join(repo, 'loop-b');
    fs.symlinkSync(b, a, 'junction');
    fs.symlinkSync(a, b, 'junction');
    try {
      const issues = detect('See `loop-a/notes.md`.');
      expect(brokenTitles(issues)).toEqual([]);
      const notice = issues.find((i) => i.title.startsWith('Dead-reference check incomplete'));
      expect(notice?.evidence).toEqual(expect.arrayContaining([
        expect.stringMatching(/^Could not read: loop-[ab] \(symlink loop\)$/),
        'Not checked: `loop-a/notes.md`',
      ]));
      expect(outOfRootCalls()).toEqual([]);
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });

  it('follows a committed directory link that stays inside the tree', () => {
    const link = path.join(repo, 'guides');
    fs.symlinkSync(path.join(repo, 'docs'), link, 'junction');
    try {
      expect(brokenTitles(detect('See `guides/guide.md` and `guides/gone.md`.'))).toEqual([
        'Broken file reference: gone.md',
      ]);
    } finally {
      fs.rmSync(link, { recursive: true, force: true });
    }
  });
});

describe('exact-case resolution on every platform', () => {
  it('reports a bare name whose only match differs in case, even next to the instruction file', () => {
    expect(brokenTitles(detect('`Deploy_Root.yml` deploys the site.'))).toEqual([
      'Broken file reference: Deploy_Root.yml',
    ]);
  });

  it('reports a bare name that matches a file elsewhere only case-insensitively', () => {
    expect(brokenTitles(detect('`Deploy_PR.yml` gates merges.'))).toEqual([
      'Broken file reference: Deploy_PR.yml',
    ]);
  });

  it('still resolves the exact name', () => {
    expect(brokenTitles(detect('`deploy_root.yml` and `deploy_pr.yml` deploy.'))).toEqual([]);
  });

  it('reports a full path whose case differs from the file on disk', () => {
    expect(brokenTitles(detect('See [the guide](docs/Guide.md).'))).toEqual(['Broken file reference: Guide.md']);
    expect(brokenTitles(detect('See `Docs/guide.md`.'))).toEqual(['Broken file reference: guide.md']);
    expect(brokenTitles(detect('See [the guide](docs/guide.md) and `docs/guide.md`.'))).toEqual([]);
  });

  it('does not anchor a directory path on a differently cased directory', () => {
    expect(brokenTitles(detect('See `SRC/billing/`.'))).toEqual([]);
    expect(brokenTitles(detect('See `src/billing/`.'))).toEqual(['Broken directory reference: billing/']);
  });
});

describe('a repository walk that fails', () => {
  it('does not report a name it could not look for, and says so', () => {
    unreadableDirs.add(path.resolve(repo, 'private'));
    const issues = detect('Run `hidden.yml` after `nowhere.yml`. See `docs/gone.md`.');
    expect(brokenTitles(issues)).toEqual(['Broken file reference: gone.md']);
    const notice = issues.find((i) => i.title.startsWith('Dead-reference check incomplete'));
    expect(notice).toBeDefined();
    // A warning, like the findings it stands in for: a `--fail-on warning` gate is not passed silently.
    expect(notice!.severity).toBe('warning');
    expect(notice!.evidence).toContain('Could not read: private/ (EACCES)');
    expect(notice!.evidence).toEqual(expect.arrayContaining([
      'Not checked: `hidden.yml`',
      'Not checked: `nowhere.yml`',
    ]));
    // The text never carries an absolute (server) path; filePaths are the scanned files, as for every issue.
    const text = [notice!.title, notice!.summary, notice!.recommendation, ...notice!.evidence].join('\n');
    expect(text).not.toContain(path.resolve(repo));
    expect(text).not.toContain(path.resolve(repo).split(path.sep).join('/'));
    expect(notice!.filePaths).toEqual([path.join(repo, 'AGENTS.md')]);
  });

  it('still resolves names it did find, with no notice when nothing was left unchecked', () => {
    unreadableDirs.add(path.resolve(repo, 'private'));
    const issues = detect('`deploy_pr.yml` gates merges.');
    expect(issues).toEqual([]);
  });

  it('does not report a path under a directory it could not list', () => {
    unreadableDirs.add(path.resolve(repo, 'private'));
    const issues = detect('See `private/also-hidden.md` and `private/gone.md`.');
    expect(brokenTitles(issues)).toEqual([]);
    const notice = issues.find((i) => i.title.startsWith('Dead-reference check incomplete'));
    expect(notice?.evidence).toEqual(expect.arrayContaining(['Not checked: `private/gone.md`']));
  });

  it('reports nothing about the walk when every directory can be listed', () => {
    const issues = detect('`nowhere.yml` is gone.');
    expect(issues.map((i) => i.title)).toEqual(['Broken file reference: nowhere.yml']);
  });
});
