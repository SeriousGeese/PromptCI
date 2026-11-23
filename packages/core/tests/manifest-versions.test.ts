/**
 * pcic-1ik0.24: how core reads a version out of package.json and pyproject.toml for the
 * version-mismatch checks and their rewrites. A floor decides whether a mention is stale; a
 * rewrite target exists only when the manifest settles one version.
 */

import { describe, expect, it } from 'vitest';
import {
  isBelowFloor,
  parseVersionSpec,
  readJsLibraryVersion,
  readNodeEngineVersion,
  readPythonLibraryVersion,
  readPythonVersion,
} from '../src/manifest-versions.js';

describe('parseVersionSpec', () => {
  it.each([
    // spec, precision, floor, exclusive, rewritable
    ['>=22', 1, [22], false, true],
    ['^19.2.0', 1, [19], false, true],
    ['~18.2.0', 1, [18], false, true],
    ['18.x', 1, [18], false, true],
    ['>= 20.0.0', 1, [20], false, true],
    ['18 - 20', 1, [18], false, true],
    ['>18', 1, [18], true, false],
    ['>18.2', 1, [18], false, false],
    ['^18.18.0 || ^20.9.0 || >=21.1.0', 1, [18], false, false],
    ['^19 || ^19.1', 1, [19], false, true],
    ['>=3.11', 2, [3, 11], false, true],
    ['>3.8', 2, [3, 8], true, false],
    ['<4,>=3.10', 2, [3, 10], false, true],
    ['>=3.9, !=3.9.1, <4', 2, [3, 9], false, true],
    ['~=3.10', 2, [3, 10], false, true],
    ['==3.12.*', 2, [3, 12], false, true],
    ['^3', 2, [3, 0], false, false],
    ['>=1.5,<3', 1, [1], false, true],
    ['>=2.0rc1', 1, [2], false, true],
  ] as const)('%s at precision %d floors at %j', (spec, precision, version, exclusive, rewritable) => {
    expect(parseVersionSpec(spec, precision)).toEqual({ floor: { version, exclusive }, rewritable });
  });

  it.each(['*', '<2', '<=3.0', 'latest', 'catalog:', 'workspace:*', 'npm:react@19', 'github:facebook/react', '', '>=18 || <16'])(
    'has no floor for %j',
    (spec) => {
      expect(parseVersionSpec(spec, 1)).toBeNull();
    },
  );
});

describe('isBelowFloor', () => {
  it('excludes the bound itself only when it is exclusive', () => {
    expect(isBelowFloor([3, 8], { version: [3, 8], exclusive: false })).toBe(false);
    expect(isBelowFloor([3, 8], { version: [3, 8], exclusive: true })).toBe(true);
    expect(isBelowFloor([3, 9], { version: [3, 8], exclusive: true })).toBe(false);
    expect(isBelowFloor([3, 7], { version: [3, 8], exclusive: false })).toBe(true);
  });
});

describe('readJsLibraryVersion', () => {
  const pkg = (blocks: Record<string, Record<string, string>>) => JSON.stringify({ name: 'x', ...blocks });

  it('reads what the project installs over a peer range, and refuses the rewrite when they disagree', () => {
    const reading = readJsLibraryVersion(
      pkg({ devDependencies: { react: '^19.2.0' }, peerDependencies: { react: '^18.0.0 || ^19.0.0' } }),
      'react',
    );
    expect(reading).toEqual({ floor: { version: [18], exclusive: false }, label: '≥18', declared: [19] });
  });

  it('rewrites when dependencies and the peer range agree', () => {
    const reading = readJsLibraryVersion(pkg({ devDependencies: { react: '^19.0.0' }, peerDependencies: { react: '^19.0.0' } }), 'react');
    expect(reading?.rewriteTo).toEqual([19]);
  });

  it('reads a peer-only declaration for the floor, never as a rewrite', () => {
    const reading = readJsLibraryVersion(pkg({ peerDependencies: { react: '>=18' } }), 'react');
    expect(reading?.floor).toEqual({ version: [18], exclusive: false });
    expect(reading?.rewriteTo).toBeUndefined();
  });

  it('refuses the rewrite when dependencies and devDependencies disagree, or one is unreadable', () => {
    expect(readJsLibraryVersion(pkg({ dependencies: { vite: '^7.0.0' }, devDependencies: { vite: '^8.1.0' } }), 'vite')?.rewriteTo).toBeUndefined();
    const catalog = readJsLibraryVersion(pkg({ devDependencies: { vite: 'catalog:' }, peerDependencies: { vite: '^8.0.0' } }), 'vite');
    expect(catalog?.floor.version).toEqual([8]);
    expect(catalog?.rewriteTo).toBeUndefined();
  });

  it('has no reading for a package it does not declare, or for malformed JSON', () => {
    expect(readJsLibraryVersion(pkg({ dependencies: { vue: '^3.5.0' } }), 'react')).toBeNull();
    expect(readJsLibraryVersion('{bad json', 'react')).toBeNull();
  });
});

describe('readNodeEngineVersion', () => {
  it('floors alternatives at the lowest and offers no rewrite for them', () => {
    expect(readNodeEngineVersion('^18.18.0 || ^20.9.0 || >=21.1.0')).toEqual({
      floor: { version: [18], exclusive: false },
      label: '≥18',
      declared: [18],
    });
  });

  it('reads ">18" as excluding 18', () => {
    expect(readNodeEngineVersion('>18')).toEqual({ floor: { version: [18], exclusive: true }, label: '>18', declared: [18] });
  });
});

describe('readPythonVersion', () => {
  it('reads requires-python with an exclusive bound as excluding that version, with no rewrite', () => {
    expect(readPythonVersion('[project]\nname = "x"\nrequires-python = ">3.8"\n')).toEqual({
      floor: { version: [3, 8], exclusive: true },
      label: '>3.8',
      declared: [3, 8],
    });
  });

  it('reads an upper bound written first', () => {
    expect(readPythonVersion('[project]\nname = "x"\nrequires-python = "<4,>=3.10"\n')?.rewriteTo).toEqual([3, 10]);
  });

  it('refuses the rewrite when requires-python and Poetry\'s python constraint disagree', () => {
    const pyproject = [
      '[project]',
      'name = "x"',
      'requires-python = ">=3.9"',
      '',
      '[tool.poetry.dependencies]',
      'python = "^3.10"',
      '',
    ].join('\n');
    expect(readPythonVersion(pyproject)).toEqual({ floor: { version: [3, 9], exclusive: false }, label: '≥3.9', declared: [3, 9] });
  });

  it('ignores a python key outside the Poetry dependency table', () => {
    expect(readPythonVersion('[tool.other]\npython = "^3.6"\n\n[project]\nrequires-python = ">=3.11"\n')?.rewriteTo).toEqual([3, 11]);
  });
});

describe('readPythonLibraryVersion', () => {
  it('reads the main dependency over an earlier Poetry group pin', () => {
    const pyproject = [
      '[project]',
      'name = "x"',
      'requires-python = ">=3.11"',
      'dependencies = [',
      '    "django>=5.0",',
      '    "psycopg[binary]>=3.1",',
      ']',
      '',
      '[tool.poetry.group.lts.dependencies]',
      'django = "^4.2"',
      '',
    ].join('\n');
    expect(readPythonLibraryVersion(pyproject, 'django')).toEqual({
      floor: { version: [4], exclusive: false },
      label: '≥4',
      declared: [5],
    });
  });

  it('reads an optional-dependencies entry for the floor only', () => {
    const pyproject = ['[project]', 'name = "x"', 'dependencies = ["httpx>=0.27"]', '', '[project.optional-dependencies]', 'django = ["django>=4.2"]', ''].join('\n');
    const reading = readPythonLibraryVersion(pyproject, 'django');
    expect(reading?.floor.version).toEqual([4]);
    expect(reading?.rewriteTo).toBeUndefined();
  });

  it('treats a Poetry entry marked optional as an extra', () => {
    const pyproject = ['[tool.poetry.dependencies]', 'python = "^3.11"', 'pandas = { version = "^2.1", optional = true }', ''].join('\n');
    expect(readPythonLibraryVersion(pyproject, 'pandas')?.rewriteTo).toBeUndefined();
    expect(readPythonLibraryVersion(pyproject.replace(', optional = true', ''), 'pandas')?.rewriteTo).toEqual([2]);
  });

  it('rewrites when the main dependency and the extras agree on one major', () => {
    const pyproject = ['[project]', 'name = "x"', 'dependencies = [', '  "pandas>=2.1,<3",', ']', '', '[dependency-groups]', 'test = ["pandas>=2.2"]', ''].join('\n');
    expect(readPythonLibraryVersion(pyproject, 'pandas')?.rewriteTo).toEqual([2]);
  });

  it('does not read a similarly named package', () => {
    expect(readPythonLibraryVersion('[project]\ndependencies = ["pandas-stubs==2.1", "numpy-financial>=2"]\n', 'pandas')).toBeNull();
  });
});
