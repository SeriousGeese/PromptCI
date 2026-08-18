import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { detectSkills } from '../src/skills-detector.js';
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

describe('detectSkills', () => {
  it('is silent when there are no skills', () => {
    expect(detectSkills(ctx(repo()))).toEqual([]);
  });

  it('accepts a well-formed skill with a bundled reference that exists', () => {
    const dir = repo();
    writeFile(dir, '.claude/skills/pdf/SKILL.md',
      ['---', 'name: pdf', 'description: Fill and read PDF forms when asked', '---', 'See [helper](scripts/fill.py).'].join('\n'));
    writeFile(dir, '.claude/skills/pdf/scripts/fill.py', 'print("hi")');
    expect(detectSkills(ctx(dir))).toEqual([]);
  });

  it('flags a skill with no frontmatter', () => {
    const dir = repo();
    writeFile(dir, '.claude/skills/pdf/SKILL.md', '# Just a body, no frontmatter');
    const issues = detectSkills(ctx(dir));
    expect(issues.some((i) => i.title.includes('missing YAML frontmatter'))).toBe(true);
    expect(issues.every((i) => i.category === 'ai_config')).toBe(true);
  });

  it('flags missing name and description', () => {
    const dir = repo();
    writeFile(dir, '.claude/skills/pdf/SKILL.md', ['---', 'foo: bar', '---', 'body'].join('\n'));
    const issues = detectSkills(ctx(dir));
    expect(issues.some((i) => i.title.includes('missing `name`'))).toBe(true);
    expect(issues.some((i) => i.title.includes('missing `description`'))).toBe(true);
  });

  it('flags a name that does not match the directory', () => {
    const dir = repo();
    writeFile(dir, '.claude/skills/pdf/SKILL.md',
      ['---', 'name: not-pdf', 'description: Do PDF things when the user asks', '---', 'body'].join('\n'));
    const issues = detectSkills(ctx(dir));
    expect(issues.some((i) => i.title.includes('does not match its directory'))).toBe(true);
  });

  it('flags a description that is too short', () => {
    const dir = repo();
    writeFile(dir, '.claude/skills/pdf/SKILL.md',
      ['---', 'name: pdf', 'description: pdf', '---', 'body'].join('\n'));
    const issues = detectSkills(ctx(dir));
    expect(issues.some((i) => i.title.includes('too short'))).toBe(true);
  });

  it('flags a dead bundled file reference', () => {
    const dir = repo();
    writeFile(dir, '.claude/skills/pdf/SKILL.md',
      ['---', 'name: pdf', 'description: Fill and read PDF forms when asked', '---', 'Run `scripts/missing.py` first.'].join('\n'));
    const issues = detectSkills(ctx(dir));
    const dead = issues.find((i) => i.title.includes('bundled file'));
    expect(dead).toBeDefined();
    expect(dead!.evidence.join(' ')).toContain('scripts/missing.py');
  });

  it('does not flag URLs or plain prose as file references', () => {
    const dir = repo();
    writeFile(dir, '.claude/skills/pdf/SKILL.md',
      ['---', 'name: pdf', 'description: Fill and read PDF forms when asked', '---', 'See [docs](https://example.com/a.html) and the pipeline.'].join('\n'));
    const issues = detectSkills(ctx(dir));
    expect(issues.some((i) => i.title.includes('bundled file'))).toBe(false);
  });

  it('flags two skills sharing the same trigger description', () => {
    const dir = repo();
    writeFile(dir, '.claude/skills/a/SKILL.md',
      ['---', 'name: a', 'description: Convert spreadsheets to reports on request', '---', 'body'].join('\n'));
    writeFile(dir, '.claude/skills/b/SKILL.md',
      ['---', 'name: b', 'description: Convert spreadsheets to reports on request', '---', 'body'].join('\n'));
    const issues = detectSkills(ctx(dir));
    const overlap = issues.find((i) => i.title.includes('share the same trigger'));
    expect(overlap).toBeDefined();
    expect(overlap!.filePaths.length).toBe(2);
  });

  it('produces deterministic output across runs', () => {
    const dir = repo();
    writeFile(dir, '.claude/skills/pdf/SKILL.md', '# no frontmatter');
    const a = detectSkills(ctx(dir));
    const b = detectSkills(ctx(dir));
    expect(a).toEqual(b);
  });
});
