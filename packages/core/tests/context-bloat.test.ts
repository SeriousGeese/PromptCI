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
    // A README-only file set is 100% README by definition, so the dominance
    // finding always fires here — this case is about the SIZE thresholds.
    const sizeIssues = (files: InstructionFile[]) =>
      detectContextBloat(files, { totalWarning: 999999, totalHigh: 999999 }).filter(
        (i) => !i.title.includes('dominates'),
      );

    expect(sizeIssues([makeFile('/repo/README.md', 'readme', 9000)])).toEqual([]);

    const warnIssues = sizeIssues([makeFile('/repo/README.md', 'readme', 16000)]); // readme warn = 15000
    expect(warnIssues.length).toBe(1);
    expect(warnIssues[0]?.severity).toBe('warning');

    const highIssues = sizeIssues([makeFile('/repo/README.md', 'readme', 31000)]); // readme high = 30000
    expect(highIssues.length).toBe(1);
    expect(highIssues[0]?.severity).toBe('high');
  });

  it('uses tighter thresholds and Windsurf-specific guidance for .windsurfrules', () => {
    // 6,500 chars is under the generic 8,000 file warning but over Windsurf's
    // ~6,000-char truncation limit — it should still warn, with Windsurf wording.
    const warn = detectContextBloat([makeFile('/repo/.windsurfrules', 'windsurf', 6500)]);
    const sizeWarn = warn.filter((i) => i.category === 'context_bloat');
    expect(sizeWarn).toHaveLength(1);
    expect(sizeWarn[0]?.severity).toBe('warning');
    expect(sizeWarn[0]?.title).toContain('.windsurfrules');
    expect(sizeWarn[0]?.recommendation).toContain('Windsurf');

    // Over the ~12,000-char combined budget → high.
    const high = detectContextBloat([makeFile('/repo/.windsurfrules', 'windsurf', 12500)]);
    const sizeHigh = high.filter((i) => i.category === 'context_bloat');
    expect(sizeHigh).toHaveLength(1);
    expect(sizeHigh[0]?.severity).toBe('high');
    expect(sizeHigh[0]?.title).toContain('.windsurfrules');
  });

  it('does not flag a small .windsurfrules under the Windsurf warning threshold', () => {
    expect(detectContextBloat([makeFile('/repo/.windsurfrules', 'windsurf', 5000)])).toEqual([]);
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

// ── Absorbed from the former context-cost detector ──────────────────────────

describe('detectContextBloat — context cost', () => {
  it('tags size findings as cost findings', () => {
    const issues = detectContextBloat([makeFile('/repo/CLAUDE.md', 'claude', 9000)]);
    expect(issues.every((i) => i.tags?.includes('cost'))).toBe(true);
  });

  it('flags a README that dominates the scanned context', () => {
    const files = [
      makeFile('/repo/README.md', 'readme', 6000), // ~1500 tokens, 75% of the total
      makeFile('/repo/CLAUDE.md', 'claude', 2000),
    ];
    const issues = detectContextBloat(files);
    const dominance = issues.find((i) => i.title.includes('README dominates'));
    expect(dominance).toBeDefined();
    expect(dominance!.severity).toBe('info');
    expect(dominance!.summary).toContain('75%');
  });

  it('does NOT flag README dominance below the absolute token floor', () => {
    // 60% of the context, but the whole context is ~250 tokens — a small repo,
    // not a finding.
    const files = [
      makeFile('/repo/README.md', 'readme', 600),
      makeFile('/repo/CLAUDE.md', 'claude', 400),
    ];
    const issues = detectContextBloat(files);
    expect(issues.some((i) => i.title.includes('README dominates'))).toBe(false);
  });

  it('does NOT flag README dominance below the ratio', () => {
    const files = [
      makeFile('/repo/README.md', 'readme', 5000), // ~1250 tokens, 25% of the total
      makeFile('/repo/CLAUDE.md', 'claude', 15000),
    ];
    const issues = detectContextBloat(files);
    expect(issues.some((i) => i.title.includes('README dominates'))).toBe(false);
  });

  it('states one fact once: a large file no longer produces a char AND a token finding', () => {
    // 12,000 chars is ~3,000 tokens — over the old context-bloat char warning
    // (8,000) and the old context-cost token warning (2,500) at the same time.
    const issues = detectContextBloat([makeFile('/repo/CLAUDE.md', 'claude', 12000)]);
    const perFile = issues.filter((i) => i.filePaths.includes('/repo/CLAUDE.md'));
    expect(perFile).toHaveLength(1);
  });
});
