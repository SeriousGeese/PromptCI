import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { detectCursorRules } from '../src/cursor-rules-detector.js';
import { makeTempRepo, writeFile, ctx } from './ai-config-helpers.js';

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function repo(): string {
  const dir = makeTempRepo();
  cleanups.push(dir);
  return dir;
}

describe('detectCursorRules', () => {
  it('is silent with no rules', () => {
    expect(detectCursorRules(ctx(repo()))).toEqual([]);
  });

  it('accepts a rule whose glob matches files', () => {
    const dir = repo();
    writeFile(dir, 'src/index.ts', 'export {};');
    writeFile(dir, '.cursor/rules/ts.mdc',
      ['---', 'description: TypeScript conventions', 'globs: src/**/*.ts', 'alwaysApply: false', '---', 'Use strict mode.'].join('\n'));
    expect(detectCursorRules(ctx(dir))).toEqual([]);
  });

  it('flags a glob that matches zero files', () => {
    const dir = repo();
    writeFile(dir, '.cursor/rules/py.mdc',
      ['---', 'description: Python rules', 'globs: src/**/*.py', '---', 'body'].join('\n'));
    const issues = detectCursorRules(ctx(dir));
    const dead = issues.find((i) => i.title.includes('glob matches no files'));
    expect(dead).toBeDefined();
    expect(dead!.evidence.join(' ')).toContain('src/**/*.py');
  });

  it('flags missing frontmatter', () => {
    const dir = repo();
    writeFile(dir, '.cursor/rules/x.mdc', 'just a body');
    const issues = detectCursorRules(ctx(dir));
    expect(issues.some((i) => i.title.includes('missing frontmatter'))).toBe(true);
  });

  it('flags an unterminated frontmatter block', () => {
    const dir = repo();
    writeFile(dir, '.cursor/rules/x.mdc', ['---', 'description: x', 'body with no close'].join('\n'));
    const issues = detectCursorRules(ctx(dir));
    expect(issues.some((i) => i.title.includes('not closed'))).toBe(true);
  });

  it('flags a rule with no trigger', () => {
    const dir = repo();
    writeFile(dir, '.cursor/rules/x.mdc', ['---', 'foo: bar', '---', 'body'].join('\n'));
    const issues = detectCursorRules(ctx(dir));
    expect(issues.some((i) => i.title.includes('no trigger'))).toBe(true);
  });

  it('does not run the glob check for alwaysApply rules', () => {
    const dir = repo();
    writeFile(dir, '.cursor/rules/always.mdc',
      ['---', 'description: global', 'alwaysApply: true', '---', 'body'].join('\n'));
    expect(detectCursorRules(ctx(dir))).toEqual([]);
  });
});
