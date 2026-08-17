import { describe, it, expect } from 'vitest';
import { detectContextBloat } from '../src/context-bloat.js';
import type { InstructionFile, FileType } from '../src/types.js';

function makeFile(path: string, fileType: string, charCount: number, lineCount = 100): InstructionFile {
  return {
    path,
    fileType: fileType as unknown as FileType,
    content: 'x'.repeat(charCount),
    sections: [],
    lineCount,
    charCount,
    estimatedTokens: Math.round(charCount / 4),
  };
}

describe('detectContextBloat', () => {
  it('returns no issues for small files', () => {
    const files = [makeFile('/repo/CLAUDE.md', 'claude', 500)];
    const issues = detectContextBloat(files);
    expect(issues).toEqual([]);
  });

  it('flags standard files exceeding warning threshold', () => {
    const files = [makeFile('/repo/CLAUDE.md', 'claude', 9000)]; // defaults warn = 8000
    const issues = detectContextBloat(files);
    expect(issues.length).toBe(1);
    expect(issues[0]?.severity).toBe('warning');
    expect(issues[0]?.title).toBe('Instruction file may be too large');
  });

  it('flags standard files exceeding high threshold', () => {
    const files = [makeFile('/repo/CLAUDE.md', 'claude', 21000)]; // defaults high = 20000
    const issues = detectContextBloat(files);
    expect(issues.length).toBe(1);
    expect(issues[0]?.severity).toBe('high');
    expect(issues[0]?.title).toBe('Instruction file is very large');
  });

  it('uses relaxed thresholds for readme files', () => {
    const standardFiles = [makeFile('/repo/README.md', 'readme', 9000)];
    expect(detectContextBloat(standardFiles, { totalWarning: 999999, totalHigh: 999999 })).toEqual([]);

    const warnFiles = [makeFile('/repo/README.md', 'readme', 16000)]; // defaults readme warn = 15000
    const warnIssues = detectContextBloat(warnFiles, { totalWarning: 999999, totalHigh: 999999 });
    expect(warnIssues.length).toBe(1);
    expect(warnIssues[0]?.severity).toBe('warning');

    const highFiles = [makeFile('/repo/README.md', 'readme', 31000)]; // defaults readme high = 30000
    const highIssues = detectContextBloat(highFiles, { totalWarning: 999999, totalHigh: 999999 });
    expect(highIssues.length).toBe(1);
    expect(highIssues[0]?.severity).toBe('high');
  });

  it('flags copilot files exceeding line warning threshold', () => {
    const files = [makeFile('/repo/copilot-instructions.md', 'copilot', 1000, 1005)]; // defaults copilot lines warn = 1000
    const issues = detectContextBloat(files);
    expect(issues.some(i => i.title.includes('Copilot'))).toBe(true);
  });

  it('flags total context warning threshold', () => {
    const files = [
      makeFile('/repo/CLAUDE.md', 'claude', 16000),
      makeFile('/repo/AGENTS.md', 'agents', 15000),
    ]; // total = 31000 (defaults warn = 30000)
    const issues = detectContextBloat(files);
    expect(issues.some(i => i.id === 'context-bloat-total' && i.severity === 'warning')).toBe(true);
  });

  it('flags total context high threshold', () => {
    const files = [
      makeFile('/repo/CLAUDE.md', 'claude', 31000),
      makeFile('/repo/AGENTS.md', 'agents', 30000),
    ]; // total = 61000 (defaults high = 60000)
    const issues = detectContextBloat(files);
    expect(issues.some(i => i.id === 'context-bloat-total' && i.severity === 'high')).toBe(true);
  });

  it('respects custom threshold overrides', () => {
    const files = [makeFile('/repo/CLAUDE.md', 'claude', 2500)];
    const issues = detectContextBloat(files, { fileWarning: 2000 });
    expect(issues.length).toBe(1);
    expect(issues[0]?.severity).toBe('warning');
  });
});

// ── BUG-A: explicit `undefined` overrides must not blank out real defaults ───

describe('detectContextBloat — BUG-A undefined-override regression', () => {
  it('still flags a file above the default warning threshold when thresholds carries explicit undefined keys', () => {
    // Mirrors detectors.ts's call site: `{ totalWarning: context.contextBudget, ... }`
    // where context.contextBudget/fileContextBudget are `undefined` when no
    // .promptci config is present — all four keys are PRESENT but undefined,
    // not absent. `{ ...DEFAULTS, ...thresholds }` would silently replace
    // every real default with undefined, disabling every comparison.
    const files = [makeFile('/repo/CLAUDE.md', 'claude', 9000)]; // default file warn = 8000
    const issues = detectContextBloat(files, {
      totalWarning: undefined,
      totalHigh: undefined,
      fileWarning: undefined,
      fileHigh: undefined,
    });
    expect(issues.length).toBe(1);
    expect(issues[0]?.severity).toBe('warning');
    expect(issues[0]?.title).toBe('Instruction file may be too large');
  });

  it('still flags total context above the default threshold with undefined total overrides', () => {
    const files = [
      makeFile('/repo/CLAUDE.md', 'claude', 16000),
      makeFile('/repo/AGENTS.md', 'agents', 15000),
    ]; // total = 31000, default total warn = 30000
    const issues = detectContextBloat(files, {
      totalWarning: undefined,
      totalHigh: undefined,
      fileWarning: undefined,
      fileHigh: undefined,
    });
    expect(issues.some((i) => i.id === 'context-bloat-total' && i.severity === 'warning')).toBe(true);
  });

  it('a defined override still wins over the default even when sibling keys are undefined', () => {
    // Only fileWarning is a real number; the other three keys mirror the
    // detectors.ts "no budget configured" shape (present but undefined).
    const files = [makeFile('/repo/CLAUDE.md', 'claude', 2500)];
    const issues = detectContextBloat(files, {
      fileWarning: 2000,
      fileHigh: undefined,
      totalWarning: undefined,
      totalHigh: undefined,
    });
    expect(issues.length).toBe(1);
    expect(issues[0]?.severity).toBe('warning');
  });
});
