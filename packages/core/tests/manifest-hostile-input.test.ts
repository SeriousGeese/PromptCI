/**
 * Hostile-input timing for the manifest readers (pcic-1ik0.24) and the recipe planners
 * (pcic-k1t3.12). A scan runs on any repository, so a pyproject.toml, package.json or instruction
 * file built to make a regex backtrack must not hang it: core 0.4.9's TOML header regex took about
 * 15 s on one "[" followed by 4000 spaces, cubic in the line. Each reader and planner here must
 * answer a long hostile input in well under a tenth of a second, and keep answering ordinary input
 * as before.
 */

import * as fs from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import {
  MAX_VERSION_SPEC_LENGTH,
  parseVersionSpec,
  readJsLibraryVersion,
  readNodeEngineVersion,
  readPythonLibraryVersion,
  readPythonVersion,
  tomlTables,
} from '../src/manifest-versions.js';
import {
  MAX_EDIT_LINE_LENGTH,
  MAX_RECIPE_EDITS,
  packageManagerSwapEdits,
  versionMentionEdits,
} from '../src/manifest-fix-edits.js';
import type { PackageManagerHit } from '../src/manifest-fix-edits.js';
import { detectManifestConsistency } from '../src/manifest-consistency.js';
import type { RepoContext } from '../src/repo-context.js';
import type { InstructionFile } from '../src/types.js';
import { makeTempRepo } from './ai-config-helpers.js';

/** Budget for one call on a hostile input. Linear code answers in about a millisecond. */
const BUDGET_MS = 100;

function elapsed<T>(fn: () => T): { ms: number; value: T } {
  const start = performance.now();
  const value = fn();
  return { ms: performance.now() - start, value };
}

function quick<T>(fn: () => T, budget = BUDGET_MS): T {
  const { ms, value } = elapsed(fn);
  expect(ms).toBeLessThan(budget);
  return value;
}

const spaces = (n: number) => ' '.repeat(n);

describe('TOML table headers', () => {
  // The 0.4.9 header regex, kept as the oracle for short lines (it is only slow on long ones).
  function oracleTables(content: string): Array<{ name: string; start: number; end: number }> {
    const tables: Array<{ name: string; start: number; end: number }> = [];
    const header = /^[ \t]*\[\[?[ \t]*((?:[A-Za-z0-9_.\- \t]|"[^"\n]*"|'[^'\n]*')+?)[ \t]*\]\]?[ \t]*$/gm;
    let current = { name: '', start: 0, end: content.length };
    let m: RegExpExecArray | null;
    while ((m = header.exec(content)) !== null) {
      current.end = m.index;
      tables.push(current);
      current = { name: m[1]!.replace(/["'\s]/g, ''), start: m.index + m[0].length, end: content.length };
    }
    tables.push(current);
    return tables;
  }

  it.each([
    '[project]',
    '  [ project ]  ',
    '[[tool.uv.index]]',
    '[tool."poetry".dependencies]',
    "[ 'tool' . poetry ]",
    '["a]b"]',
    '[project]\r\nrequires-python = ">=3.9"\r\n',
    '[project',
    '[]',
    '[[]]',
    '[ ]',
    '[project] x',
    '[a]]]',
    '[a"b]',
    '[project]]',
    '[[project]',
    '[a#b]',
  ])('%j splits into the tables the old header regex found', (content) => {
    expect(tomlTables(content)).toEqual(oracleTables(content));
  });

  it('agrees with the old header regex on thousands of generated short files', () => {
    const alphabet = [' ', '\t', '[', ']', '"', "'", 'a', 'b', '.', '-', '_', '#', '=', '\n', '\r'];
    let seed = 0x2f6b1d;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let n = 0; n < 5000; n++) {
      const length = next() % 14;
      let content = '';
      for (let i = 0; i < length; i++) content += alphabet[next() % alphabet.length];
      expect(tomlTables(content), JSON.stringify(content)).toEqual(oracleTables(content));
    }
  });

  it.each([
    ['"[" and spaces with no "]"', '[' + spaces(50_000)],
    ['"[[" and spaces with no "]"', '[[' + spaces(50_000)],
    ['"[" and spaced words with no "]"', '[' + 'a '.repeat(25_000)],
    ['"[" and tabs and spaces', '[' + ' \t'.repeat(25_000) + 'x'],
    ['an unclosed quoted key', '["' + spaces(50_000)],
    ['quoted keys with no "]"', '[' + '"a" '.repeat(12_500)],
    ['many header-like lines', ('[' + spaces(100) + '\n').repeat(1_000)],
  ])('reads %s in linear time', (_label, content) => {
    expect(quick(() => readPythonVersion(content))).toBeNull();
    expect(quick(() => readPythonLibraryVersion(content, 'pandas'))).toBeNull();
  });

  it('still reads requires-python under a header with spaces, after a hostile line', () => {
    const content = '[' + spaces(50_000) + '\n[ project ]\nrequires-python = ">=3.11"\n';
    expect(quick(() => readPythonVersion(content))?.rewriteTo).toEqual([3, 11]);
  });
});

describe('version specs', () => {
  it.each([
    ['dotted digits', '>=' + '1.'.repeat(10_000) + '!'],
    ['a digit run', '>=' + '1'.repeat(20_000) + '!'],
    ['a prerelease tail', '^1' + '.1'.repeat(5_000) + '-' + 'a.'.repeat(5_000) + '!'],
    ['spaces after an operator', '>=' + spaces(20_000) + 'x'],
    ['alternatives', '>=1 ||'.repeat(5_000)],
  ])('a long spec (%s) is unreadable, in linear time', (_label, spec) => {
    expect(quick(() => parseVersionSpec(spec, 1, 'npm'))).toBeNull();
    expect(quick(() => readNodeEngineVersion(spec))).toBeNull();
    const pkg = JSON.stringify({ dependencies: { react: spec } });
    expect(quick(() => readJsLibraryVersion(pkg, 'react'))).toBeNull();
    expect(quick(() => readPythonVersion(`requires-python = "${spec}"`))).toBeNull();
  });

  it('a spec up to the length cap still reads; one character more does not', () => {
    const atCap = '>=18' + ' '.repeat(MAX_VERSION_SPEC_LENGTH - 8) + ' <99';
    expect(atCap).toHaveLength(MAX_VERSION_SPEC_LENGTH);
    expect(parseVersionSpec(atCap, 1, 'npm')?.floor.version).toEqual([18]);
    expect(parseVersionSpec(atCap.replace(' <99', '  <99'), 1, 'npm')).toBeNull();
  });
});

describe('pyproject.toml dependency strings', () => {
  it.each([
    ['spaces after the name', '[project]\ndependencies = ["pandas' + spaces(50_000) + '"]\n'],
    ['spaces after the name and an open paren', '[project]\ndependencies = ["pandas' + spaces(25_000) + '(' + spaces(25_000) + '"]\n'],
    ['many unfinished entries', '[project]\ndependencies = [' + '"pandas '.repeat(10_000) + ']\n'],
    ['an unclosed extras bracket', 'x = "pandas[' + 'a'.repeat(50_000)],
    ['spaces after a Poetry key', '[tool.poetry.dependencies]\npandas' + spaces(50_000) + 'x'],
  ])('%s: linear time', (_label, content) => {
    quick(() => readPythonLibraryVersion(content, 'pandas'));
  });

  it('thousands of tables each naming the library: linear time', () => {
    const content = '[a]\n"pandas>=1"\n'.repeat(20_000) + '[project]\ndependencies = ["pandas>=2"]\n';
    expect(quick(() => readPythonLibraryVersion(content, 'pandas'))?.rewriteTo).toEqual([2]);
  });

  it('still reads "pandas (>=2.1)" with spaces around the paren', () => {
    const content = '[project]\ndependencies = ["pandas  (  >=2.1,<3)"]\n';
    expect(readPythonLibraryVersion(content, 'pandas')?.rewriteTo).toEqual([2]);
  });
});

const fileOf = (content: string, path = 'CLAUDE.md'): InstructionFile => ({ path, content }) as unknown as InstructionFile;
const NODE_RE = /\bNode(?:\.js)?\s*(?:v)?(\d+)\b/gi;

function nodeEdits(content: string, index = content.indexOf('Node.js 18')) {
  return versionMentionEdits(
    fileOf(content),
    [{ index, text: 'Node.js 18', replacement: 'Node.js 22' }],
    NODE_RE,
    true,
    () => false,
  );
}

function pmEdits(content: string, indexes: number[]) {
  const file = fileOf(content);
  const hits: PackageManagerHit[] = indexes.map((index) => ({ file, index, text: content.slice(index, index + 11) }));
  return packageManagerSwapEdits([file], hits, 'pnpm', () => true, () => false);
}

describe('version-mention edits', () => {
  it('a declaration followed by a long run of spaces and punctuation: linear time', () => {
    const near = MAX_EDIT_LINE_LENGTH - 40;
    expect(quick(() => nodeEdits('Requires Node.js 18' + spaces(near) + 'x'))).toBeUndefined();
    expect(quick(() => nodeEdits('Requires Node.js 18+' + spaces(near / 2) + '.' + spaces(near / 2)))).toBeDefined();
  });

  it('a line longer than the cap keeps the finding advisory, quickly', () => {
    expect(nodeEdits('Requires Node.js 18+' + spaces(10))).toBeDefined();
    expect(quick(() => nodeEdits('Requires Node.js 18+' + spaces(MAX_EDIT_LINE_LENGTH)))).toBeUndefined();
    expect(quick(() => nodeEdits('Requires Node.js 18' + spaces(200_000) + 'x'))).toBeUndefined();
  });

  it('more mentions than an edit list holds refuse up front', () => {
    const content = 'Requires Node.js 18+\n'.repeat(20_000);
    const mentions = Array.from({ length: 20_000 }, (_, i) => ({
      index: i * 21 + 9,
      text: 'Node.js 18',
      replacement: 'Node.js 22',
    }));
    expect(quick(() => versionMentionEdits(fileOf(content), mentions, NODE_RE, true, () => false))).toBeUndefined();
    expect(versionMentionEdits(fileOf(content), mentions.slice(0, MAX_RECIPE_EDITS), NODE_RE, true, () => false)).toHaveLength(
      MAX_RECIPE_EDITS,
    );
  });
});

describe('package-manager swap edits', () => {
  it('thousands of hits refuse up front instead of rescanning the file per hit', () => {
    const content = 'npm install\n'.repeat(40_000);
    const indexes = Array.from({ length: 40_000 }, (_, i) => i * 12);
    expect(quick(() => pmEdits(content, indexes))).toBeUndefined();
    expect(pmEdits(content, indexes.slice(0, MAX_RECIPE_EDITS))).toHaveLength(MAX_RECIPE_EDITS);
  });

  it.each([
    ['"(cd" and spaces with no ")"', 'npm install (cd' + spaces(MAX_EDIT_LINE_LENGTH - 40) + 'x'],
    ['many "(cd" with no ")"', 'npm install ' + '(cd x'.repeat((MAX_EDIT_LINE_LENGTH - 40) / 5)],
    ['a lead of "(cd" lines', ('(cd' + spaces(MAX_EDIT_LINE_LENGTH - 10) + '\n').repeat(3) + 'npm install'],
  ])('%s: linear time', (_label, content) => {
    quick(() => pmEdits(content, [content.indexOf('npm install')]));
  });

  it('a subshell cd still refuses, an unclosed or empty one does not', () => {
    const at = (s: string) => [s.indexOf('npm install')];
    expect(pmEdits('Run (cd docs && npm install) first.', at('Run (cd docs && npm install) first.'))).toBeUndefined();
    expect(pmEdits('Run npm install (CD\tsite).', at('Run npm install (CD\tsite).'))).toBeUndefined();
    expect(pmEdits('Paren (cd docs, run npm install.', at('Paren (cd docs, run npm install.'))).toBeDefined();
    expect(pmEdits('Paren (cd ), run npm install.', at('Paren (cd ), run npm install.'))).toBeDefined();
  });
});

describe('detectManifestConsistency on hostile instruction files', () => {
  const repoRoot = makeTempRepo('promptci-hostile-');
  afterAll(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  function context(files: Record<string, string>, packageJson: Record<string, unknown>, pyproject?: string): RepoContext {
    const facts = {
      packageManagerName: (packageJson.packageManager as string | undefined)?.split('@')[0] ?? 'unknown',
      enginesNode: (packageJson.engines as { node?: string } | undefined)?.node,
      scripts: {},
      lockfiles: [],
    };
    return {
      repoRoot,
      files: Object.entries(files).map(([path, content]) => fileOf(content, path)),
      manifests: { packageJson: JSON.stringify(packageJson), ...(pyproject ? { pyproject } : {}) },
      packageJson: facts,
      workflows: { files: [], commands: [] },
    } as unknown as RepoContext;
  }

  /** Budget for one detector run over a 500 KB file (scanner.ts MAX_FILE_SIZE). Minutes before. */
  const DETECTOR_BUDGET_MS = 3000;

  it.each([
    ['one line of 40k negated npm commands', { 'CLAUDE.md': 'never npm i '.repeat(40_000) }, { packageManager: 'pnpm@9.0.0' }],
    ['40k lines of npm install', { 'CLAUDE.md': 'npm install\n'.repeat(40_000) }, { packageManager: 'pnpm@9.0.0' }],
    ['one line of 35k negated Node mentions', { 'CLAUDE.md': 'never Node 18 '.repeat(35_000) }, { engines: { node: '>=22' } }],
    [
      '25k distinct stale Node versions',
      { 'CLAUDE.md': Array.from({ length: 25_000 }, (_, i) => `Requires Node.js ${i}+`).join('\n') },
      { engines: { node: '>=99999' } },
    ],
    [
      '20k distinct stale React versions',
      { 'CLAUDE.md': Array.from({ length: 20_000 }, (_, i) => `Use React ${i}`).join('\n') },
      { dependencies: { react: '^99999.0.0' } },
    ],
  ] as const)('%s', (_label, files, pkg) => {
    const { ms, value } = elapsed(() => detectManifestConsistency(context(files, pkg)));
    expect(value.length).toBeGreaterThanOrEqual(0);
    expect(ms).toBeLessThan(DETECTOR_BUDGET_MS);
  });

  it('25k distinct stale Python versions', () => {
    const claude = Array.from({ length: 25_000 }, (_, i) => `Requires Python 3.${i}+`).join('\n');
    const pyproject = '[project]\nrequires-python = ">=3.99999"\n';
    const { ms } = elapsed(() => detectManifestConsistency(context({ 'CLAUDE.md': claude }, {}, pyproject)));
    expect(ms).toBeLessThan(DETECTOR_BUDGET_MS);
  });

  it('plans rewrites for at most ten version findings per file; the rest stay advisory', () => {
    const claude = Array.from({ length: 12 }, (_, i) => `- Requires Node.js ${i + 1}+`).join('\n\n') + '\n';
    const issues = detectManifestConsistency(context({ 'CLAUDE.md': claude }, { engines: { node: '>=22' } })).filter((i) =>
      i.id.startsWith('manifest-node-version-mismatch:'),
    );
    expect(issues).toHaveLength(12);
    expect(issues.filter((i) => i.fixEdits !== undefined)).toHaveLength(10);
    expect(issues.slice(10).every((i) => i.fixEdits === undefined && i.autoApplySafe === undefined)).toBe(true);
  });
});
