import { describe, it, expect } from 'vitest';
import { detectNegativeInstructionOverload } from '../src/negative-instructions.js';
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
    sections: [],
    lineCount: content.split('\n').length,
    charCount: content.length,
    estimatedTokens: Math.round(content.length / 4),
  };
}

// 6 negatives + 4 positives = 60% negative (> 40%, >= 8 directives).
const NEGATIVE_HEAVY = [
  '# Rules',
  '- Never commit secrets to the repository.',
  '- Do not push directly to main.',
  '- Avoid using global mutable state.',
  "- Don't skip the test suite.",
  '- You must not delete migration files.',
  '- Refrain from editing generated code.',
  '- Always run the linter before committing.',
  '- Use const or let for variables.',
  '- Prefer composition over inheritance.',
  '- Keep functions small and focused.',
].join('\n');

// 2 negatives + 8 positives = 20% negative (<= 40%).
const POSITIVE_HEAVY = [
  '# Rules',
  '- Use const or let for variables.',
  '- Prefer composition over inheritance.',
  '- Keep functions small and focused.',
  '- Always run the linter before committing.',
  '- Write tests for new behavior.',
  '- Follow the existing code style.',
  '- Document public functions clearly.',
  '- Verify the build passes locally.',
  '- Never commit secrets to the repository.',
  '- Avoid premature optimization in hot paths.',
].join('\n');

describe('detectNegativeInstructionOverload', () => {
  it('flags a file whose directives are mostly prohibitions', () => {
    const issues = detectNegativeInstructionOverload([makeFile(NEGATIVE_HEAVY)]);
    expect(issues).toHaveLength(1);
    const issue = issues[0]!;
    expect(issue.severity).toBe('info');
    expect(issue.category).toBe('agent_practices');
    expect(issue.id).toMatch(/^negative-overload-/);
    // Evidence quotes offending instruction text, not regex source.
    expect(issue.evidence.join(' ')).toContain('Never commit secrets');
    expect(issue.recommendation.toLowerCase()).toContain('positive');
  });

  it('does not flag a mostly-positive file', () => {
    expect(detectNegativeInstructionOverload([makeFile(POSITIVE_HEAVY)])).toEqual([]);
  });

  it('does not flag when there are too few directives to be meaningful', () => {
    const content = [
      '# Rules',
      '- Never commit secrets.',
      '- Do not push to main.',
      '- Avoid global state.',
      '- Use const here.',
    ].join('\n');
    expect(detectNegativeInstructionOverload([makeFile(content)])).toEqual([]);
  });

  it('does not analyze non-instruction files (e.g. README)', () => {
    expect(
      detectNegativeInstructionOverload([makeFile(NEGATIVE_HEAVY, 'readme', '/repo/README.md')]),
    ).toEqual([]);
  });

  it('ignores prohibitions inside fenced code blocks', () => {
    const content = [
      '# Rules',
      '- Use const or let for variables.',
      '- Prefer composition over inheritance.',
      '- Keep functions small and focused.',
      '- Always run the linter before committing.',
      '- Write tests for new behavior.',
      '- Follow the existing code style.',
      '- Document public functions clearly.',
      '- Verify the build passes locally.',
      '',
      '```bash',
      '# never do this, do not run that, avoid the other thing, refrain from it',
      "echo don't && echo cannot && echo must not",
      '```',
    ].join('\n');
    // All prose directives are positive; the negatives live only in the fence.
    expect(detectNegativeInstructionOverload([makeFile(content)])).toEqual([]);
  });
});
