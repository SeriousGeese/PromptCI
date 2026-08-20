import { describe, it, expect } from 'vitest';
import { detectBuriedCriticalInstructions } from '../src/buried-critical.js';
import type { FileType, InstructionFile } from '../src/types.js';

/** Build a file of `total` lines, injecting keyword lines at given 1-based positions. */
function makeLongContent(total: number, keywordLines: Record<number, string>): string {
  const lines: string[] = [];
  for (let i = 1; i <= total; i++) {
    lines.push(keywordLines[i] ?? `Line ${i}: general project guidance and setup notes.`);
  }
  return lines.join('\n');
}

function makeFile(
  content: string,
  fileType: FileType = 'claude',
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

describe('detectBuriedCriticalInstructions', () => {
  it('flags a single critical instruction buried at the bottom of a long file', () => {
    const content = makeLongContent(120, { 115: 'NEVER push to production.' });
    const issues = detectBuriedCriticalInstructions([makeFile(content)]);
    expect(issues).toHaveLength(1);
    const issue = issues[0]!;
    expect(issue.severity).toBe('info');
    expect(issue.category).toBe('structure');
    expect(issue.id).toMatch(/^buried-critical-/);
    expect(issue.locations.some((l) => l.startLine === 115)).toBe(true);
  });

  it('does not flag the same instruction placed near the top', () => {
    const content = makeLongContent(120, { 5: 'NEVER push to production.' });
    expect(detectBuriedCriticalInstructions([makeFile(content)])).toEqual([]);
  });

  it('flags multiple critical instructions concentrated at the bottom', () => {
    const content = makeLongContent(120, {
      112: 'This is a critical safety rule.',
      115: 'NEVER push to production.',
      118: 'Handle the security tokens carefully.',
    });
    const issues = detectBuriedCriticalInstructions([makeFile(content)]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.summary).toContain('bottom half');
  });

  it('does not flag when critical keywords are spread across top and bottom', () => {
    const content = makeLongContent(120, {
      5: 'Never expose the admin panel.',
      115: 'Never log secrets.',
    });
    expect(detectBuriedCriticalInstructions([makeFile(content)])).toEqual([]);
  });

  it('does not flag short files under the line threshold', () => {
    const content = makeLongContent(30, { 25: 'NEVER push to production.' });
    expect(detectBuriedCriticalInstructions([makeFile(content)])).toEqual([]);
  });

  it('does not flag a long file with no high-severity keywords', () => {
    const content = makeLongContent(120, {});
    expect(detectBuriedCriticalInstructions([makeFile(content)])).toEqual([]);
  });

  it('does not analyze non-instruction files (e.g. README)', () => {
    const content = makeLongContent(120, { 115: 'NEVER push to production.' });
    expect(
      detectBuriedCriticalInstructions([makeFile(content, 'readme', '/repo/README.md')]),
    ).toEqual([]);
  });

  it('ignores keywords inside fenced code blocks', () => {
    const lines: string[] = [];
    for (let i = 1; i <= 120; i++) lines.push(`Line ${i}: general project guidance.`);
    lines[110] = '```';
    lines[111] = '# never run this dangerous critical security command';
    lines[112] = '```';
    expect(detectBuriedCriticalInstructions([makeFile(lines.join('\n'))])).toEqual([]);
  });
});
