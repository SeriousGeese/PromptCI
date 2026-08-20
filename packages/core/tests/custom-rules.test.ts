import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseCustomRules,
  runCustomRules,
  loadCustomRules,
  CustomRulesError,
  scan,
  createBaseline,
} from '../src/index.js';
import type { CustomRule, FileType, InstructionFile } from '../src/index.js';
import { parseSections } from '../src/scanner.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, '../../../examples/fixture-custom-rules');

function makeFile(
  content: string,
  filePath = '/repo/CLAUDE.md',
  fileType: FileType = 'claude',
): InstructionFile {
  return {
    path: filePath,
    fileType,
    content,
    sections: parseSections(content, filePath),
    lineCount: content.split('\n').length,
    charCount: content.length,
    estimatedTokens: Math.round(content.length / 4),
  };
}

function rule(overrides: Partial<CustomRule> & Pick<CustomRule, 'id' | 'type' | 'message'>): CustomRule {
  return { severity: 'warning', ...overrides } as CustomRule;
}

// ── Schema validation ─────────────────────────────────────────────────────────

describe('parseCustomRules — schema validation', () => {
  it('parses a valid rule set (object form and bare-array form)', () => {
    const objForm = parseCustomRules({
      rules: [{ id: 'no-todo', type: 'forbiddenPattern', pattern: 'TODO', message: 'no todos' }],
    });
    expect(objForm).toHaveLength(1);
    expect(objForm[0]!.severity).toBe('warning'); // default

    const arrForm = parseCustomRules([
      { id: 'x', type: 'requiredSection', heading: 'Setup', message: 'need setup', severity: 'high' },
    ]);
    expect(arrForm[0]!.severity).toBe('high');
  });

  it('rejects a top level that is not an object/array with rules', () => {
    expect(() => parseCustomRules(42)).toThrow(CustomRulesError);
    expect(() => parseCustomRules({})).toThrow(/rules/);
  });

  it('names the offending key: missing id', () => {
    expect(() => parseCustomRules({ rules: [{ type: 'forbiddenPattern', pattern: 'x', message: 'm' }] }))
      .toThrow(/"id"/);
  });

  it('names the offending key: unknown type', () => {
    expect(() =>
      parseCustomRules({ rules: [{ id: 'r', type: 'banPattern', pattern: 'x', message: 'm' }] }),
    ).toThrow(/"type"/);
  });

  it('names the offending key: invalid regex pattern', () => {
    expect(() =>
      parseCustomRules({ rules: [{ id: 'r', type: 'forbiddenPattern', pattern: '(', message: 'm' }] }),
    ).toThrow(/pattern.*regular expression/);
  });

  it('names the offending key: invalid severity', () => {
    expect(() =>
      parseCustomRules({
        rules: [{ id: 'r', type: 'forbiddenPattern', pattern: 'x', message: 'm', severity: 'extreme' }],
      }),
    ).toThrow(/severity/);
  });

  it('rejects duplicate rule ids', () => {
    expect(() =>
      parseCustomRules({
        rules: [
          { id: 'dup', type: 'forbiddenPattern', pattern: 'a', message: 'm' },
          { id: 'dup', type: 'forbiddenPattern', pattern: 'b', message: 'm' },
        ],
      }),
    ).toThrow(/duplicate/);
  });

  it('requires heading for requiredSection and pattern for pattern types', () => {
    expect(() => parseCustomRules({ rules: [{ id: 'r', type: 'requiredSection', message: 'm' }] }))
      .toThrow(/"heading"/);
    expect(() => parseCustomRules({ rules: [{ id: 'r', type: 'absentPattern', message: 'm' }] }))
      .toThrow(/"pattern"/);
  });
});

// ── Interpreter ────────────────────────────────────────────────────────────────

describe('runCustomRules — rule types', () => {
  const repo = '/repo';

  it('forbiddenPattern fires per matching file with a line location, ignores clean files', () => {
    const dirty = makeFile('# A\nTODO fix this\n', '/repo/CLAUDE.md');
    const clean = makeFile('# B\nAll good here.\n', '/repo/AGENTS.md', 'agents');
    const issues = runCustomRules(
      [dirty, clean],
      [rule({ id: 'no-todo', type: 'forbiddenPattern', pattern: 'TODO', message: 'no todo', severity: 'info' })],
      repo,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.id.startsWith('custom:no-todo:')).toBe(true);
    expect(issues[0]!.category).toBe('custom');
    expect(issues[0]!.severity).toBe('info');
    expect(issues[0]!.locations[0]).toMatchObject({ filePath: '/repo/CLAUDE.md', startLine: 2 });
  });

  it('absentPattern fires only when the pattern is absent from all files', () => {
    const files = [makeFile('# A\nno license here\n', '/repo/CLAUDE.md')];
    const r = rule({ id: 'lic', type: 'absentPattern', pattern: 'SPDX-License-Identifier', message: 'need license' });
    expect(runCustomRules(files, [r], repo)).toHaveLength(1);

    const withLicense = [makeFile('# A\nSPDX-License-Identifier: MIT\n', '/repo/CLAUDE.md')];
    expect(runCustomRules(withLicense, [r], repo)).toHaveLength(0);
  });

  it('requiredSection fires when the heading is missing anywhere', () => {
    const r = rule({ id: 'setup', type: 'requiredSection', heading: 'Setup', message: 'need setup' });
    expect(runCustomRules([makeFile('# Project\n## Guidelines\ntext', '/repo/CLAUDE.md')], [r], repo)).toHaveLength(1);
    expect(runCustomRules([makeFile('# Project\n## Setup\ntext', '/repo/CLAUDE.md')], [r], repo)).toHaveLength(0);
  });

  it('crossFileConflict fires when a captured value differs across files', () => {
    const a = makeFile('# A\nUse node 20 for builds.\n', '/repo/CLAUDE.md');
    const b = makeFile('# B\nUse node 22 for builds.\n', '/repo/AGENTS.md', 'agents');
    const r = rule({ id: 'node', type: 'crossFileConflict', pattern: 'node (\\d+)', message: 'node version conflict' });
    const issues = runCustomRules([a, b], [r], repo);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.id).toBe('custom:node');
    expect(issues[0]!.filePaths.sort()).toEqual(['/repo/AGENTS.md', '/repo/CLAUDE.md']);

    // Same value in both → no conflict.
    const c = makeFile('# B\nUse node 20 everywhere.\n', '/repo/AGENTS.md', 'agents');
    expect(runCustomRules([a, c], [r], repo)).toHaveLength(0);
  });

  it('respects the files glob filter', () => {
    const claude = makeFile('# A\nTODO here\n', '/repo/CLAUDE.md');
    const agents = makeFile('# B\nTODO here too\n', '/repo/AGENTS.md', 'agents');
    const r = rule({
      id: 'no-todo',
      type: 'forbiddenPattern',
      pattern: 'TODO',
      message: 'no todo',
      files: ['AGENTS.md'],
    });
    const issues = runCustomRules([claude, agents], [r], repo);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.filePaths).toEqual(['/repo/AGENTS.md']);
  });
});

// ── Loading from disk + fixture repo ────────────────────────────────────────────

describe('loadCustomRules + fixture repo', () => {
  it('returns [] when no custom-rules file exists', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'promptci-cr-'));
    try {
      expect(await loadCustomRules(tmp)).toEqual([]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('the absentPattern rule fires on the fixture repo (AC)', async () => {
    const report = await scan({ repoPath: FIXTURE });
    const custom = report.issues.filter((i) => i.category === 'custom');
    // require-license (absent), no-todo (present), require-setup-section (missing).
    expect(custom.some((i) => i.id === 'custom:require-license')).toBe(true);
    expect(custom.some((i) => i.id.startsWith('custom:no-todo:'))).toBe(true);
    expect(custom.some((i) => i.id === 'custom:require-setup-section')).toBe(true);
  });
});

// ── Suppression + baseline parity ───────────────────────────────────────────────

describe('custom findings integrate with suppression and the baseline ratchet', () => {
  async function tmpRepoWith(claude: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'promptci-cr-scan-'));
    await fs.mkdir(path.join(dir, '.promptci'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.promptci', 'custom-rules.json'),
      JSON.stringify({
        rules: [{ id: 'no-todo', type: 'forbiddenPattern', pattern: 'TODO', message: 'no todo', severity: 'warning' }],
      }),
      'utf-8',
    );
    await fs.writeFile(path.join(dir, 'CLAUDE.md'), claude, 'utf-8');
    return dir;
  }

  it('a promptci-ignore annotation suppresses a custom finding', async () => {
    const dir = await tmpRepoWith(
      '# Guidelines\n<!-- promptci-ignore: custom reason: tracked separately -->\nTODO wire this up.\n',
    );
    try {
      const report = await scan({ repoPath: dir });
      expect(report.issues.some((i) => i.id.startsWith('custom:no-todo'))).toBe(false);
      expect((report.suppressedIssues ?? []).some((i) => i.id.startsWith('custom:no-todo'))).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('a baselined custom finding is not reported as new (--fail-on-new parity)', async () => {
    const dir = await tmpRepoWith('# Guidelines\nTODO wire this up.\n');
    try {
      const first = await scan({ repoPath: dir });
      const baseline = createBaseline(first.issues, dir);
      const second = await scan({ repoPath: dir, baseline });
      expect((second.newIssues ?? []).some((i) => i.id.startsWith('custom:no-todo'))).toBe(false);
      expect((second.baselinedIssues ?? []).some((i) => i.id.startsWith('custom:no-todo'))).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('an invalid custom-rules.json fails the scan with an actionable error (never a crash)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'promptci-cr-bad-'));
    await fs.mkdir(path.join(dir, '.promptci'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.promptci', 'custom-rules.json'),
      JSON.stringify({ rules: [{ id: 'r', type: 'nope', pattern: 'x', message: 'm' }] }),
      'utf-8',
    );
    await fs.writeFile(path.join(dir, 'CLAUDE.md'), '# X\ntext', 'utf-8');
    try {
      await expect(scan({ repoPath: dir })).rejects.toThrow(/custom-rules\.json.*"type"/s);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
