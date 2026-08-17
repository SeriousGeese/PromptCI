import { describe, it, expect } from 'vitest';
import { applyFixRecipe } from '../src/fix-engine.js';
import type { PromptCiIssue } from '../src/types.js';

function staleIssue(overrides: Partial<PromptCiIssue> = {}): PromptCiIssue {
  return {
    id: 'stale-abc123def456',
    severity: 'warning',
    category: 'stale_instruction',
    title: 'Instruction may reference outdated content',
    summary: 'This instruction may reference outdated content.',
    filePaths: ['CLAUDE.md'],
    locations: [{ filePath: 'CLAUDE.md', startLine: 1, endLine: 5 }],
    evidence: ['Year reference(s) that may be outdated: 2021, 2022'],
    recommendation: 'Review this section for accuracy.',
    confidence: 0.6,
    ...overrides,
  };
}

/**
 * BUG-14: this recipe used to rewrite every year in the flagged section to a
 * hardcoded '2026'. It could not distinguish a stale instruction from a
 * copyright line, a release date, or a version pin, and its source range
 * (2019–2023) did not even match the detector's (2019–2025).
 */
describe('applyFixRecipe — stale years are advisory, never auto-rewritten', () => {
  it('produces no file changes for a stale_instruction issue', async () => {
    const changes = await applyFixRecipe(staleIssue(), process.cwd());
    expect(changes).toEqual([]);
  });

  it('produces no file changes even when year evidence is present', async () => {
    const changes = await applyFixRecipe(
      staleIssue({ evidence: ['Year reference(s) that may be outdated: 2020'] }),
      process.cwd(),
    );
    expect(changes).toEqual([]);
  });
});
