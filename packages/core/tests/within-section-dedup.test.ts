import { describe, it, expect } from 'vitest';
import { detectWithinSectionDedup } from '../src/within-section-dedup.js';
import { parseSections } from '../src/scanner.js';
import type { FileType, InstructionFile } from '../src/types.js';

function makeFile(
  content: string,
  fileType: FileType = 'claude',
  path = '/repo/CLAUDE.md',
): InstructionFile {
  return {
    path,
    fileType,
    content,
    sections: parseSections(content, path),
    lineCount: content.split('\n').length,
    charCount: content.length,
    estimatedTokens: Math.round(content.length / 4),
  };
}

const DIVERSE = [
  'The build pipeline runs on every pull request and must pass before merge.',
  'Use TypeScript strict mode across all packages in this monorepo project.',
  'Prefer small, focused commits with clear descriptive messages for reviewers.',
  'Document any new environment variables in the configuration reference guide.',
];

// One section, 6 qualifying paragraphs, two of them ~72% similar.
const WITH_DUP = [
  '# Project',
  '',
  '## Guidelines',
  '',
  'You should always validate all user input before processing it to prevent injection attacks and data corruption.',
  '',
  DIVERSE[0],
  '',
  DIVERSE[1],
  '',
  'Always validate user input before processing to prevent injection attacks and data corruption issues.',
  '',
  DIVERSE[2],
  '',
  DIVERSE[3],
].join('\n');

// Same shape, six paragraphs, all diverse — nothing to flag.
const NO_DUP = [
  '# Project',
  '',
  '## Guidelines',
  '',
  'You should always validate all user input before processing to prevent injection and corruption.',
  '',
  DIVERSE[0],
  '',
  DIVERSE[1],
  '',
  'Rotate deployment credentials on a quarterly schedule and record the change in the audit log.',
  '',
  DIVERSE[2],
  '',
  DIVERSE[3],
].join('\n');

// Similar pair but only 4 paragraphs (<= 5) — below the paragraph-count gate.
const SMALL_SECTION = [
  '## Guidelines',
  '',
  'You should always validate all user input before processing it to prevent injection attacks and data corruption.',
  '',
  DIVERSE[0],
  '',
  'Always validate user input before processing to prevent injection attacks and data corruption issues.',
  '',
  DIVERSE[1],
].join('\n');

describe('detectWithinSectionDedup', () => {
  it('flags two near-duplicate paragraphs within a large section', () => {
    const issues = detectWithinSectionDedup([makeFile(WITH_DUP)]);
    expect(issues).toHaveLength(1);
    const issue = issues[0]!;
    expect(issue.severity).toBe('info');
    expect(issue.category).toBe('duplicate');
    expect(issue.id).toMatch(/^within-section-dup-/);
    expect(issue.title).toContain('Guidelines');
    expect(issue.summary).toMatch(/paragraphs \d+ and \d+/);
    expect(issue.evidence.length).toBe(2);
  });

  it('does not flag a section whose paragraphs are all diverse', () => {
    expect(detectWithinSectionDedup([makeFile(NO_DUP)])).toEqual([]);
  });

  it('does not flag sections with five or fewer paragraphs', () => {
    expect(detectWithinSectionDedup([makeFile(SMALL_SECTION)])).toEqual([]);
  });

  it('does not analyze non-instruction files (e.g. README)', () => {
    expect(detectWithinSectionDedup([makeFile(WITH_DUP, 'readme', '/repo/README.md')])).toEqual([]);
  });
});
