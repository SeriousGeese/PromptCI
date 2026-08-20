import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { detectCopilotInstructions } from '../src/copilot-instructions-detector.js';
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

const INSTR = '.github/instructions/ts.instructions.md';

describe('detectCopilotInstructions', () => {
  it('is silent with no instruction files', () => {
    expect(detectCopilotInstructions(ctx(repo()))).toEqual([]);
  });

  it('accepts a file whose applyTo glob matches files', () => {
    const dir = repo();
    writeFile(dir, 'src/index.ts', 'export {};');
    writeFile(dir, INSTR,
      ['---', 'applyTo: "src/**/*.ts"', '---', 'Use strict mode.'].join('\n'));
    expect(detectCopilotInstructions(ctx(dir))).toEqual([]);
  });

  it('accepts applyTo: "**" (apply to everything) without a dead-glob finding', () => {
    const dir = repo();
    writeFile(dir, INSTR, ['---', 'applyTo: "**"', '---', 'body'].join('\n'));
    expect(detectCopilotInstructions(ctx(dir))).toEqual([]);
  });

  it('flags an applyTo glob that matches zero files, carrying the glob', () => {
    const dir = repo();
    writeFile(dir, INSTR, ['---', 'applyTo: "src/**/*.py"', '---', 'body'].join('\n'));
    const issues = detectCopilotInstructions(ctx(dir));
    const dead = issues.find((i) => i.title.includes('matches no files'));
    expect(dead).toBeDefined();
    expect(dead!.evidence.join(' ')).toContain('src/**/*.py');
    expect(dead!.summary).toContain('src/**/*.py');
  });

  it('flags an applyTo glob that matches only ignored/build-output files as info', () => {
    const dir = repo();
    writeFile(dir, 'dist/bundle.js', '/* built */');
    writeFile(dir, INSTR, ['---', 'applyTo: "dist/**/*.js"', '---', 'body'].join('\n'));
    const issues = detectCopilotInstructions(ctx(dir));
    const ignored = issues.find((i) => i.title.includes('only ignored files'));
    expect(ignored).toBeDefined();
    expect(ignored!.severity).toBe('info');
    expect(ignored!.evidence.join(' ')).toContain('dist/**/*.js');
  });

  it('flags a file with no applyTo key', () => {
    const dir = repo();
    writeFile(dir, INSTR, ['---', 'description: general rules', '---', 'body'].join('\n'));
    const issues = detectCopilotInstructions(ctx(dir));
    const noApply = issues.find((i) => i.title.includes('no applyTo glob'));
    expect(noApply).toBeDefined();
    expect(noApply!.severity).toBe('warning');
  });

  it('flags missing frontmatter', () => {
    const dir = repo();
    writeFile(dir, INSTR, 'just a body');
    const issues = detectCopilotInstructions(ctx(dir));
    expect(issues.some((i) => i.title.includes('missing frontmatter'))).toBe(true);
  });

  it('flags an unterminated frontmatter block', () => {
    const dir = repo();
    writeFile(dir, INSTR, ['---', 'applyTo: "**"', 'body with no close'].join('\n'));
    const issues = detectCopilotInstructions(ctx(dir));
    expect(issues.some((i) => i.title.includes('not closed'))).toBe(true);
  });

  it('does not flag a slashless extension glob that matches nested files', () => {
    const dir = repo();
    writeFile(dir, 'src/nested/app.tsx', 'export {};');
    writeFile(dir, INSTR, ['---', 'applyTo: "*.tsx"', '---', 'body'].join('\n'));
    const issues = detectCopilotInstructions(ctx(dir));
    expect(issues.some((i) => i.title.includes('matches no files'))).toBe(false);
  });

  it('handles a comma-separated applyTo list, flagging only the dead glob', () => {
    const dir = repo();
    writeFile(dir, 'src/a.ts', 'export {};');
    writeFile(dir, INSTR, ['---', 'applyTo: "src/**/*.ts,src/**/*.rb"', '---', 'body'].join('\n'));
    const issues = detectCopilotInstructions(ctx(dir));
    const dead = issues.filter((i) => i.title.includes('matches no files'));
    expect(dead).toHaveLength(1);
    expect(dead[0]!.evidence.join(' ')).toContain('src/**/*.rb');
  });

  it('does not scan the legacy single-file .github/copilot-instructions.md', () => {
    const dir = repo();
    // Legacy file has no applyTo support; discovery must scope it out.
    writeFile(dir, '.github/copilot-instructions.md', 'no frontmatter here');
    expect(detectCopilotInstructions(ctx(dir))).toEqual([]);
  });
});
