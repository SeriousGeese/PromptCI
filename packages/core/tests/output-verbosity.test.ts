import { describe, it, expect } from 'vitest';
import { detectOutputVerbosity } from '../src/output-verbosity.js';
import type { InstructionFile } from '../src/types.js';

function makeFile(
  content: string,
  fileType: InstructionFile['fileType'] = 'claude',
  path = '/repo/CLAUDE.md',
): InstructionFile {
  return {
    path,
    fileType,
    content,
    sections: [],
    lineCount: content.split('\n').length,
    charCount: content.length,
    estimatedTokens: Math.round(content.length / 4),
  };
}

describe('detectOutputVerbosity', () => {
  it('flags missing verbosity discipline by default', () => {
    const file = makeFile('# Stable Rules\nAvoid using complex logic. Always keep functions small.');
    const issues = detectOutputVerbosity([file]);
    expect(issues.some(i => i.id === 'cost-missing-verbosity-discipline')).toBe(true);
  });

  it('does not flag missing discipline if conciseness guidelines exist', () => {
    const file = makeFile('# Stable Rules\nBe concise and summarize test outcomes.');
    const issues = detectOutputVerbosity([file]);
    expect(issues.some(i => i.id === 'cost-missing-verbosity-discipline')).toBe(false);
  });

  it('flags unconditional verbosity demands', () => {
    const file = makeFile('# Stable Rules\nBe concise.\nAlways include all logs in your output.');
    const issues = detectOutputVerbosity([file]);
    expect(issues.some(i => i.id.startsWith('cost-verbosity-encouraged'))).toBe(true);
  });

  it('does not flag debugging-specific conditional log instructions', () => {
    const file = makeFile('# Stable Rules\nBe concise.\nIf tests fail, include all logs.');
    const issues = detectOutputVerbosity([file]);
    expect(issues.some(i => i.id.startsWith('cost-verbosity-encouraged'))).toBe(false);
  });

  it('does not flag noun-phrase references to a detailed explanation', () => {
    const file = makeFile(
      '# Architecture\nBe concise. A detailed explanation of the architecture lives in ARCHITECTURE.md.',
    );
    const issues = detectOutputVerbosity([file]);
    expect(issues.some(i => i.id.startsWith('cost-verbosity-encouraged'))).toBe(false);
  });

  // ── B4: id must not collide across two files of the same fileType ─────────

  it('B4: emits a distinct id for two different "claude"-fileType files with the same verbosity issue', () => {
    const fileA = makeFile(
      '# Rules\nAlways include all logs in your output.',
      'claude',
      '/repo/CLAUDE.md',
    );
    const fileB = makeFile(
      '# Notes\nAlways include all logs in your output.',
      'claude',
      '/repo/.claude/notes.md',
    );
    const issues = detectOutputVerbosity([fileA, fileB]);
    const matches = issues.filter((i) => i.id.startsWith('cost-verbosity-encouraged'));
    expect(matches).toHaveLength(2);
    expect(matches[0]!.id).not.toBe(matches[1]!.id);
  });
});
