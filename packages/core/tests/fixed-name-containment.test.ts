/**
 * pcic-e6xa: the containment of pcic-xhzb / pcic-x1vl, extended to the checks
 * that read a FIXED name.
 *
 * The name is not user input, but the tree around it is: a committed symlink
 * can point `.env`, `.promptci`, `coverage/`, `go.mod`, `Cargo.toml`,
 * `Assets/`, `requirements.txt`, `.clinerules` or a skill's `.git` at anything
 * on the scanning machine. Before this, the verdict — and so the findings —
 * changed with whether that outside path existed, which in the hosted product
 * (where the scan root is a server temp directory) tells whoever wrote the
 * scanned repository whether a server path exists.
 *
 * Every such check now goes through {@link RepoTree}, so:
 *  - nothing outside the scan root is listed, stat'ed or opened;
 *  - the findings are identical whether the outside target exists or not;
 *  - a link whose target climbs above the root is refused even when a later
 *    segment names the root's own directory again (`x -> ../<root name>/y`),
 *    which otherwise made the verdict depend on the root directory's name.
 *
 * Windows cannot create file symlinks without the privilege, so the symlink
 * cases are skipped there and run on Linux CI; directory junctions work
 * everywhere and cover the absolute-target cases.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { detectSecurityPack } from '../src/security-pack.js';
import { runFrameworkPacks } from '../src/framework-packs.js';
import { detectManifestConsistency } from '../src/manifest-consistency.js';
import { detectProjectType } from '../src/project-type.js';
import { scanFiles } from '../src/scanner.js';
import { RepoTree } from '../src/repo-tree.js';
import { discoverAiConfigFiles, emptyAiConfigFiles } from '../src/ai-config.js';
import { detectSkillSupplyChain } from '../src/skill-supply-chain.js';
import type { RepoContext } from '../src/repo-context.js';
import type { InstructionFile, PromptCiIssue } from '../src/types.js';
import { canSymlink, trySymlink } from './ai-config-helpers.js';

/**
 * Every path handed to the filesystem while `recording` is on — the detector's
 * own calls and those of its dependencies. The CommonJS patch runs before any
 * import, so a dependency that does `require('fs')` captures it too.
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

/** The markers a fixed-name check looks for, placed OUTSIDE the scan root. */
const OUTSIDE_FILES: Record<string, string> = {
  '.env': 'SECRET=1\n',
  'go.mod': 'module example.com/x\n',
  'Cargo.toml': '[package]\nrust-version = "1.75"\n',
  'requirements.txt': 'requests\n',
  'Pipfile': '[packages]\n',
  'ProjectVersion.txt': 'm_EditorVersion: 6000.0.0f1\n',
};

/** Directories of markers, outside the root. */
const OUTSIDE_DIRS = ['.promptci', 'coverage', 'Assets', 'supabase/migrations', '.clinerules'];

function writeOutside(): void {
  fs.mkdirSync(outside, { recursive: true });
  for (const [name, content] of Object.entries(OUTSIDE_FILES)) {
    fs.writeFileSync(path.join(outside, name), content);
  }
  for (const dir of OUTSIDE_DIRS) {
    fs.mkdirSync(path.join(outside, dir), { recursive: true });
    fs.writeFileSync(path.join(outside, dir, 'marker.md'), '# marker\n');
  }
  // What the .promptci and Assets links would make visible.
  fs.writeFileSync(path.join(outside, '.promptci', 'report.json'), '{}');
}

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-fixedname-'));
  repo = path.join(base, 'repo');
  outside = path.join(base, 'outside');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n**/.promptci/*\n');
  writeOutside();
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

afterEach(() => {
  state.recording = false;
  fsCalls.length = 0;
});

/** Paths handed to the filesystem that resolve outside the scan root. */
function outOfRootCalls(): string[] {
  const root = path.resolve(repo);
  return fsCalls.filter((p) => {
    const rel = path.relative(root, path.resolve(root, p));
    return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  });
}

function file(content: string, rel = 'AGENTS.md'): InstructionFile {
  return {
    path: path.join(repo, rel),
    relativePath: rel,
    fileType: 'agents',
    content,
    sections: [],
    lineCount: content.split('\n').length,
    charCount: content.length,
    estimatedTokens: Math.round(content.length / 4),
  };
}

function context(content: string, extra: Partial<RepoContext> = {}): RepoContext {
  return {
    repoRoot: repo,
    tree: new RepoTree(repo),
    files: [file(content)],
    projectType: 'unknown',
    manifests: {},
    packageJson: {
      packageManagerName: 'unknown',
      scripts: {},
      dependencies: {},
      devDependencies: {},
      peerDependencies: {},
      lockfiles: [],
    },
    workflows: { files: [], commands: [] },
    aiConfig: emptyAiConfigFiles(),
    metrics: { estimatedInstructionTokens: 0, instructionFileCount: 1, largestInstructionFiles: [] },
    onDemandFiles: [],
    customRules: [],
    ...extra,
  };
}

/** Run `detect` with recording on, then again with the outside tree deleted. */
function sameWithoutOutside(detect: () => PromptCiIssue[]): { issues: PromptCiIssue[]; outOfRoot: string[] } {
  state.recording = true;
  let issues: PromptCiIssue[];
  try {
    issues = detect();
  } finally {
    state.recording = false;
  }
  const outOfRoot = outOfRootCalls();
  fs.rmSync(outside, { recursive: true, force: true });
  try {
    // The verdict must not depend on whether the outside path exists.
    expect(detect().map((i) => i.id).sort()).toEqual(issues.map((i) => i.id).sort());
  } finally {
    writeOutside();
  }
  return { issues, outOfRoot };
}

/** Link `rel` inside the repo to `target` outside it; returns false where the OS refuses. */
function linkOut(rel: string, target: string, type: 'file' | 'junction'): boolean {
  const link = path.join(repo, rel);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  if (type === 'junction') {
    fs.symlinkSync(target, link, 'junction');
    return true;
  }
  return trySymlink(target, link);
}

function unlink(rel: string): void {
  fs.rmSync(path.join(repo, rel), { recursive: true, force: true });
}

const SAFEGUARDS = [
  '# AGENTS.md',
  '',
  'Use TypeScript.',
].join('\n');

describe('security pack existence signals (pcic-e6xa)', () => {
  it.skipIf(!canSymlink)('does not see a .env committed as a link out of the tree', () => {
    expect(linkOut('.env', path.join(outside, '.env'), 'file')).toBe(true);
    try {
      const { issues, outOfRoot } = sameWithoutOutside(() => detectSecurityPack(context(SAFEGUARDS)));
      expect(issues.map((i) => i.title)).not.toContain('Missing secret safeguard instruction');
      expect(outOfRoot).toEqual([]);
    } finally {
      unlink('.env');
    }
  });

  it('does not see a .promptci directory linked out of the tree', () => {
    linkOut('.promptci', path.join(outside, '.promptci'), 'junction');
    try {
      const { issues, outOfRoot } = sameWithoutOutside(() => detectSecurityPack(context(SAFEGUARDS)));
      expect(issues.map((i) => i.title)).not.toContain('Missing safeguard for .promptci/ reports');
      expect(outOfRoot).toEqual([]);
    } finally {
      unlink('.promptci');
    }
  });

  it('does not see supabase/migrations behind a linked directory', () => {
    linkOut('supabase', path.join(outside, 'supabase'), 'junction');
    try {
      const { issues, outOfRoot } = sameWithoutOutside(() => detectSecurityPack(context(SAFEGUARDS)));
      expect(issues.map((i) => i.title)).not.toContain('Missing Supabase service role safeguard');
      expect(outOfRoot).toEqual([]);
    } finally {
      unlink('supabase');
    }
  });

  it('does not report a coverage directory that is only a link out of the tree', () => {
    linkOut('coverage', path.join(outside, 'coverage'), 'junction');
    try {
      const { issues, outOfRoot } = sameWithoutOutside(() => detectSecurityPack(context(SAFEGUARDS)));
      const unignored = issues.find((i) => i.id === 'security-pack-unignored-dirs');
      expect(unignored?.evidence.join('\n') ?? '').not.toContain('coverage');
      expect(outOfRoot).toEqual([]);
    } finally {
      unlink('coverage');
    }
  });
});

describe('framework packs (pcic-e6xa)', () => {
  it.skipIf(!canSymlink)('does not enable the Go pack for a go.mod linked out of the tree', () => {
    expect(linkOut('go.mod', path.join(outside, 'go.mod'), 'file')).toBe(true);
    try {
      const { issues, outOfRoot } = sameWithoutOutside(() => runFrameworkPacks(context('# Rules\nWrite code.')));
      expect(issues.map((i) => i.id).filter((id) => id.startsWith('go-'))).toEqual([]);
      expect(outOfRoot).toEqual([]);
    } finally {
      unlink('go.mod');
    }
  });

  it.skipIf(!canSymlink)('does not enable the Rust pack for a Cargo.toml linked out of the tree', () => {
    expect(linkOut('Cargo.toml', path.join(outside, 'Cargo.toml'), 'file')).toBe(true);
    try {
      const { issues, outOfRoot } = sameWithoutOutside(() => runFrameworkPacks(context('# Rules\nWrite code.')));
      expect(issues.map((i) => i.id).filter((id) => id.startsWith('rust-'))).toEqual([]);
      expect(outOfRoot).toEqual([]);
    } finally {
      unlink('Cargo.toml');
    }
  });

  it.skipIf(!canSymlink)('does not enable the Unity pack for Assets/ and ProjectVersion.txt linked out of the tree', () => {
    linkOut('Assets', path.join(outside, 'Assets'), 'junction');
    expect(linkOut('ProjectSettings/ProjectVersion.txt', path.join(outside, 'ProjectVersion.txt'), 'file')).toBe(true);
    try {
      const { issues, outOfRoot } = sameWithoutOutside(() => runFrameworkPacks(context('# Rules\nWrite C#.')));
      expect(issues.map((i) => i.id).filter((id) => id.startsWith('unity-'))).toEqual([]);
      expect(outOfRoot).toEqual([]);
    } finally {
      unlink('Assets');
      unlink('ProjectSettings');
    }
  });

  it.skipIf(!canSymlink)('does not enable the Python pack for a Pipfile linked out of the tree', () => {
    expect(linkOut('Pipfile', path.join(outside, 'Pipfile'), 'file')).toBe(true);
    try {
      const { issues, outOfRoot } = sameWithoutOutside(() => runFrameworkPacks(context('# Rules\nWrite code.')));
      expect(issues.map((i) => i.id).filter((id) => id.startsWith('python-'))).toEqual([]);
      expect(outOfRoot).toEqual([]);
    } finally {
      unlink('Pipfile');
    }
  });
});

describe('manifest consistency (pcic-e6xa)', () => {
  const POETRY = '[tool.poetry]\nname = "x"\n';
  const PIP = '# AGENTS.md\n\nInstall with `pip install -r requirements.txt`.\n';

  it.skipIf(!canSymlink)('does not accept a requirements.txt linked out of the tree as present', () => {
    expect(linkOut('requirements.txt', path.join(outside, 'requirements.txt'), 'file')).toBe(true);
    try {
      const { issues, outOfRoot } = sameWithoutOutside(() =>
        detectManifestConsistency(context(PIP, { manifests: { pyproject: POETRY } })));
      // The repository itself has no requirements.txt, so the pip instruction
      // would fail: the finding fires, and no longer depends on an outside path.
      expect(issues.map((i) => i.title)).toContain('Tooling mismatch: instruction uses pip but project uses Poetry');
      expect(outOfRoot).toEqual([]);
    } finally {
      unlink('requirements.txt');
    }
  });

  it('accepts a real in-root requirements.txt as present', () => {
    fs.writeFileSync(path.join(repo, 'requirements.txt'), 'requests\n');
    try {
      const issues = detectManifestConsistency(context(PIP, { manifests: { pyproject: POETRY } }));
      expect(issues.map((i) => i.title)).not.toContain('Tooling mismatch: instruction uses pip but project uses Poetry');
    } finally {
      fs.rmSync(path.join(repo, 'requirements.txt'), { force: true });
    }
  });
});

describe('scanner discovery and project type (pcic-e6xa)', () => {
  it('does not treat a .clinerules linked out of the tree as a rules directory', async () => {
    linkOut('.clinerules', path.join(outside, '.clinerules'), 'junction');
    try {
      expect(new RepoTree(repo).isDir('.clinerules')).toBe(false);
      const files = await scanFiles({ repoPath: repo });
      expect(files.map((f) => f.relativePath)).not.toContain('.clinerules/marker.md');
    } finally {
      unlink('.clinerules');
    }
  });

  it.skipIf(!canSymlink)('does not decide the project type from a marker linked out of the tree', async () => {
    expect(linkOut('go.mod', path.join(outside, 'go.mod'), 'file')).toBe(true);
    try {
      expect(await detectProjectType(repo)).toBe('unknown');
    } finally {
      unlink('go.mod');
    }
  });
});

describe('skill supply chain .git/hooks (pcic-e6xa)', () => {
  const SKILL_DIR = '.claude/skills/demo';

  it.skipIf(!canSymlink)('does not read a skill\'s .git/hooks linked out of the tree', () => {
    // `.git` itself is a real directory, so bundle discovery files it as a
    // skipped dependency directory; only `hooks` is the link out of the tree.
    // The old check resolved it lexically and read through, so whether the
    // skip was reported as `warning` or `info` depended on an outside path.
    fs.mkdirSync(path.join(outside, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'hooks', 'pre-commit'), '#!/bin/sh\necho hi\n');
    fs.mkdirSync(path.join(repo, SKILL_DIR, '.git'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, SKILL_DIR, 'SKILL.md'),
      ['---', 'name: demo', 'description: A demo skill used by the containment test.', '---', '', 'Body.', ''].join('\n'),
    );
    expect(linkOut(`${SKILL_DIR}/.git/hooks`, path.join(outside, 'hooks'), 'file')).toBe(true);
    try {
      const aiConfig = discoverAiConfigFiles(repo);
      const { issues, outOfRoot } = sameWithoutOutside(() =>
        detectSkillSupplyChain(context('# AGENTS.md\n\nUse TypeScript.\n', { aiConfig })));
      const evidence = issues.flatMap((i) => i.evidence).join('\n');
      expect(evidence).not.toContain('git directory with hooks');
      expect(outOfRoot).toEqual([]);
    } finally {
      fs.rmSync(path.join(repo, '.claude'), { recursive: true, force: true });
    }
  });
});

describe('RepoTree link containment (pcic-e6xa)', () => {
  it.skipIf(!canSymlink)('refuses a link that climbs above the root and re-enters by the root directory name', () => {
    // `../repo/real.md` lands back inside the root lexically, so the old
    // containment check passed it — and the verdict then depended on the name
    // of the directory the scan runs in, which a hosted scan must not reveal.
    fs.writeFileSync(path.join(repo, 'real.md'), '# real\n');
    const rootName = path.basename(repo);
    expect(trySymlink(path.join('..', rootName, 'real.md'), path.join(repo, 'reentry.md'))).toBe(true);
    try {
      const tree = new RepoTree(repo);
      expect(tree.lookup('reentry.md').state).toBe('outside');
      expect(tree.exists('reentry.md')).toBe(false);
      // The file it names IS reachable under its own name.
      expect(tree.isFile('real.md')).toBe(true);
    } finally {
      fs.rmSync(path.join(repo, 'reentry.md'), { force: true });
      fs.rmSync(path.join(repo, 'real.md'), { force: true });
    }
  });

  it.skipIf(!canSymlink)('still follows a relative link that stays inside the root', () => {
    fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'docs', 'guide.md'), '# guide\n');
    expect(trySymlink(path.join('docs', 'guide.md'), path.join(repo, 'inside.md'))).toBe(true);
    try {
      expect(new RepoTree(repo).isFile('inside.md')).toBe(true);
    } finally {
      fs.rmSync(path.join(repo, 'inside.md'), { force: true });
      fs.rmSync(path.join(repo, 'docs'), { recursive: true, force: true });
    }
  });
});
