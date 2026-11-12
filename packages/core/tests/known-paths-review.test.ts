/**
 * pcic-e6xa / pcic-csf review follow-ups (PR #152).
 *
 * Four holes a second-pass review found in the first cut of the file
 * inventory, and the exact-case consequence it asked be locked down:
 *
 *  1. An inventory entry could SHADOW a real on-disk symlink. An inventory
 *     entry is a plain file, so with a complete list no directory is listed and
 *     `lookup` never sees the link — the read then followed it out of the root.
 *     Every read through the tree is now containment-checked against the file
 *     it actually opens.
 *  2. A `.gitignore` the scan knew about but had not fetched read as "no
 *     rules", so a hosted scan reported every reference to a gitignored
 *     generated file as broken. The checker now says the answer is unavailable
 *     — `'unfetched'` when a caller listed the file without fetching it (and
 *     callers stay silent), `'unreadable'` when the scan genuinely failed to
 *     read it (and callers leave the reference unjudged and name it).
 *  3. A listed-but-unfetched `package.json` produced a "Command check
 *     incomplete" warning naming zero locations — nothing had failed, so there
 *     was nothing to name. That case is silent now; a genuinely unreadable
 *     on-disk file still warns.
 *  4. A Windows drive or UNC link target must be outside the root on every
 *     platform: on Linux `path.resolve('C:\\x')` is relative to the process's
 *     working directory, which could land inside the root.
 *
 * Plus: the fixed-name existence checks now match with exact case, like every
 * other lookup through the tree since pcic-xhzb. (Text-driven references were
 * already exact-case before this change — see dead-references-containment.)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RepoTree } from '../src/repo-tree.js';
import { createGitIgnoreChecker } from '../src/gitignore.js';
import { detectDeadReferences } from '../src/dead-references.js';
import { detectCommandValidity } from '../src/command-validity.js';
import { detectSecurityPack } from '../src/security-pack.js';
import { readMakefile } from '../src/makefile.js';
import { emptyAiConfigFiles } from '../src/ai-config.js';
import type { RepoContext } from '../src/repo-context.js';
import type { InstructionFile, PromptCiIssue } from '../src/types.js';
import { canSymlink, makeTempRepo, trySymlink, writeFile } from './ai-config-helpers.js';

function file(root: string, content: string, rel = 'AGENTS.md'): InstructionFile {
  return {
    path: path.join(root, rel),
    relativePath: rel,
    fileType: 'agents',
    content,
    sections: [],
    lineCount: content.split('\n').length,
    charCount: content.length,
    estimatedTokens: Math.round(content.length / 4),
  };
}

function context(root: string, content: string, extra: Partial<RepoContext> = {}): RepoContext {
  return {
    repoRoot: root,
    tree: new RepoTree(root),
    files: [file(root, content)],
    projectType: 'unknown',
    manifests: {},
    packageJson: {
      packageManagerName: 'pnpm',
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

/** A temp root plus a sibling directory outside it, with a sentinel file in each. */
function repoAndOutside(prefix: string): { root: string; outside: string } {
  const base = makeTempRepo(prefix);
  const root = path.join(base, 'repo');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.md'), 'SENTINEL-OUT-OF-ROOT\n');
  return { root, outside };
}

// ── 1. An inventory entry must not shadow a real on-disk symlink ─────────────

describe('a read through the tree is contained even when the inventory covers the path', () => {
  it.skipIf(!canSymlink)('does not read a listed path that is a link out of the root on disk', () => {
    const { root, outside } = repoAndOutside('promptci-inv-symlink-');
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    expect(trySymlink(path.join(outside, 'secret.md'), path.join(root, 'docs', 'a.md'))).toBe(true);
    // The link resolves on disk: a read by name alone would follow it.
    expect(fs.readFileSync(path.join(root, 'docs', 'a.md'), 'utf8')).toContain('SENTINEL-OUT-OF-ROOT');

    // Complete inventory: no directory is listed, so `lookup` never sees the link.
    const complete = new RepoTree(root, { knownPaths: ['docs/a.md'], knownPathsComplete: true });
    expect(complete.readText('docs/a.md')).toEqual({ state: 'outside' });

    // Partial inventory: the on-disk link wins the name clash, so the walk
    // itself judges it out of the root.
    const partial = new RepoTree(root, { knownPaths: ['docs/a.md'] });
    expect(partial.lookup('docs/a.md').state).toBe('outside');
    expect(partial.readText('docs/a.md')).toEqual({ state: 'outside' });
  });

  it.skipIf(!canSymlink)('does not read a Makefile that is a link out of the root on disk', () => {
    const { root, outside } = repoAndOutside('promptci-inv-makefile-');
    fs.writeFileSync(path.join(outside, 'Makefile'), 'sentinel-target:\n\techo hi\n');
    expect(trySymlink(path.join(outside, 'Makefile'), path.join(root, 'Makefile'))).toBe(true);
    const tree = new RepoTree(root, { knownPaths: ['Makefile'], knownPathsComplete: true });
    // Not read, and so not reported as defining `sentinel-target`.
    expect(readMakefile(root, '.', tree)).toBeUndefined();
  });

  it.skipIf(!canSymlink)('still reads an in-repo link, which is a normal way to share a file', () => {
    const { root } = repoAndOutside('promptci-inv-inlink-');
    writeFile(root, 'real.md', '# real\n');
    expect(trySymlink(path.join(root, 'real.md'), path.join(root, 'alias.md'))).toBe(true);
    const tree = new RepoTree(root, { knownPaths: ['real.md', 'alias.md'], knownPathsComplete: true });
    expect(tree.readText('alias.md')).toEqual({ state: 'found', content: '# real\n' });
  });
});

// ── 4. Drive-letter and UNC link targets are outside on every platform ───────

describe('link targets that are absolute only on Windows', () => {
  it.skipIf(!canSymlink)('treats a drive-letter or UNC target as outside the root', () => {
    const { root } = repoAndOutside('promptci-drive-link-');
    // On Linux these are ordinary relative names, and `path.resolve` would
    // join them to the process's working directory.
    expect(trySymlink('C:\\Windows\\win.ini', path.join(root, 'drive.md'))).toBe(true);
    expect(trySymlink('\\\\host\\share\\x.md', path.join(root, 'unc.md'))).toBe(true);
    const tree = new RepoTree(root);
    expect(tree.lookup('drive.md').state).toBe('outside');
    expect(tree.lookup('unc.md').state).toBe('outside');
  });
});

// ── 2. An unfetched .gitignore is "unknown", not "no rules" ──────────────────

describe('an ignore file the scan knows about but has not read', () => {
  it('says the answer is unavailable rather than not-ignored', () => {
    const root = makeTempRepo('promptci-gitignore-unknown-');
    const listedNotFetched = createGitIgnoreChecker(
      new RepoTree(root, { knownPaths: ['AGENTS.md', '.gitignore'], knownPathsComplete: true }),
    );
    // Nothing failed — the caller simply did not fetch the bytes — so callers
    // of the checker stay silent rather than raise a warning about it.
    expect(listedNotFetched('data/app.db')).toBe('unfetched');

    // A complete inventory with no `.gitignore` in it is a real statement that
    // the repository has none, so the rules are genuinely empty.
    const noneAtAll = createGitIgnoreChecker(
      new RepoTree(root, { knownPaths: ['AGENTS.md'], knownPathsComplete: true }),
    );
    expect(noneAtAll('data/app.db')).toBe(false);
  });

  it('does not report references as broken on the strength of rules nobody read', () => {
    const root = makeTempRepo('promptci-gitignore-unknown-');
    const content = [
      '# AGENTS.md',
      '',
      'Issue state lives in `.beads/issues.jsonl` — never commit it.',
      '',
      'The moved guide is [here](docs/gone.md).',
      '',
    ].join('\n');
    writeFile(root, 'AGENTS.md', content);
    const evidence = (issues: PromptCiIssue[]): string =>
      issues.flatMap((i) => [i.summary, ...i.evidence]).join('\n');

    // Baseline: the inventory does not mention `.gitignore`, so a complete list
    // says the repository has none and the rules really are empty. The moved
    // link is reported, as it should be.
    const noIgnoreFile = new RepoTree(root, {
      knownPaths: ['AGENTS.md', '.beads/issues.jsonl'],
      knownPathsComplete: true,
    });
    expect(evidence(detectDeadReferences([file(root, content)], root, noIgnoreFile))).toContain('docs/gone.md');

    // Listed but never fetched: an applicable `.gitignore` exists and its text
    // is unavailable, so every reference it could have covered goes unreported
    // rather than called broken. That is every reference in the file — the
    // conservative direction, and the reason a hosted scan should FETCH
    // `.gitignore` alongside the instruction files rather than only list it.
    const unfetched = new RepoTree(root, {
      knownPaths: ['AGENTS.md', '.gitignore', '.beads/issues.jsonl'],
      knownPathsComplete: true,
    });
    expect(detectDeadReferences([file(root, content)], root, unfetched)).toEqual([]);
  });
});

// ── 3. A listed-but-unfetched manifest is silent, not a 0-location warning ───

describe('a command whose manifest the inventory listed but did not fetch', () => {
  // `verify` deliberately: `npm test` is a package-manager builtin, which the
  // detector never judges against the manifest.
  const COMMANDS = ['```bash', 'cd packages/x && npm run verify', '```'].join('\n');

  it('reports nothing at all — no finding and no "check incomplete" warning', () => {
    const root = makeTempRepo('promptci-unfetched-manifest-');
    writeFile(root, 'AGENTS.md', COMMANDS);
    const tree = new RepoTree(root, {
      knownPaths: ['AGENTS.md', 'packages/x/package.json'],
      knownPathsComplete: true,
    });
    const issues = detectCommandValidity(context(root, COMMANDS, { tree }));
    expect(issues).toEqual([]);
  });

  it('still warns, with a location, when the manifest is genuinely unreadable', () => {
    const root = makeTempRepo('promptci-unreadable-manifest-');
    writeFile(root, 'AGENTS.md', COMMANDS);
    // No `packages/` on disk and no inventory: the directory is simply absent,
    // which is the "stay silent, there is no manifest to check" path.
    const absent = detectCommandValidity(context(root, COMMANDS));
    expect(absent).toEqual([]);

    // With the manifest really present and readable, a missing script IS reported.
    writeFile(root, 'packages/x/package.json', JSON.stringify({ name: 'x', scripts: { build: 'tsc' } }));
    const reported = detectCommandValidity(context(root, COMMANDS, { tree: new RepoTree(root) }));
    expect(reported.map((i) => i.title)).toEqual([
      'Possible reference to missing command or file: `npm run verify`',
    ]);
    expect(reported.flatMap((i) => i.evidence).join('\n')).toContain('npm run verify');
  });

  it('never emits a check-incomplete warning that names zero locations', () => {
    const root = makeTempRepo('promptci-no-empty-warning-');
    writeFile(root, 'AGENTS.md', COMMANDS);
    const tree = new RepoTree(root, {
      knownPaths: ['AGENTS.md', 'packages/x/package.json'],
      knownPathsComplete: true,
    });
    const issues = detectCommandValidity(context(root, COMMANDS, { tree }));
    for (const issue of issues) {
      expect(issue.summary).not.toContain('(0 locations)');
      expect(issue.summary).not.toContain('0 location');
    }
  });
});

// ── 5. Exact case for the fixed-name checks ──────────────────────────────────

describe('fixed-name existence checks match with exact case (pcic-e6xa)', () => {
  const SAFE = '# AGENTS.md\n\nUse TypeScript.\n';

  it('does not read a differently-cased directory as the one it looks for', () => {
    // A real repository directory named `Logs/`. `commonDirs` looks for `logs`,
    // and `fs.existsSync` matched it case-insensitively on Windows and macOS —
    // so those scans reported a finding a Linux scan of the same checkout did
    // not. The tree matches a directory entry of exactly that name, so every
    // platform now agrees with Linux and with GitHub.
    const root = makeTempRepo('promptci-exact-case-');
    writeFile(root, '.gitignore', 'node_modules/\n**/.promptci/*\n');
    fs.mkdirSync(path.join(root, 'Logs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Logs', 'app.log'), '');
    const issues = detectSecurityPack(context(root, SAFE));
    const unignored = issues.find((i) => i.id === 'security-pack-unignored-dirs');
    expect(unignored?.evidence.join('\n') ?? '').not.toContain('logs');
  });

  it('reports the directory when its name matches exactly', () => {
    const root = makeTempRepo('promptci-exact-case-');
    writeFile(root, '.gitignore', 'node_modules/\n**/.promptci/*\n');
    fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'logs', 'app.log'), '');
    const issues = detectSecurityPack(context(root, SAFE));
    const unignored = issues.find((i) => i.id === 'security-pack-unignored-dirs');
    expect(unignored?.evidence.join('\n') ?? '').toContain('"logs"');
  });
});
