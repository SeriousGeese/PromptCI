import { describe, it, expect } from 'vitest';
import { detectContextCost } from '../src/context-cost.js';
import type { RepoContext, InstructionFile, FileType } from '../src/types.js';

function makeFile(path: string, fileType: string, estimatedTokens: number): InstructionFile {
  return {
    path,
    fileType: fileType as unknown as FileType,
    content: '',
    sections: [],
    lineCount: 0,
    charCount: estimatedTokens * 4,
    estimatedTokens,
  };
}

const mockBaseContext = {
  repoRoot: '/repo',
  files: [],
  projectType: 'typescript',
  manifests: {},
  packageJson: {
    packageManagerName: 'pnpm',
    scripts: {},
    dependencies: {},
    devDependencies: {},
    peerDependencies: {},
    lockfiles: [],
  },
  workflows: { files: [], commands: [] },
  metrics: {
    estimatedInstructionTokens: 0,
    instructionFileCount: 0,
    largestInstructionFiles: [],
  },
} as unknown as RepoContext;

describe('detectContextCost', () => {
  it('returns no issues when within budgets', () => {
    const context: RepoContext = {
      ...mockBaseContext,
      files: [makeFile('/repo/CLAUDE.md', 'claude', 500)],
      metrics: {
        estimatedInstructionTokens: 500,
        instructionFileCount: 1,
        largestInstructionFiles: [{ path: '/repo/CLAUDE.md', estimatedTokens: 500 }],
      },
    };
    const issues = detectContextCost(context);
    expect(issues).toEqual([]);
  });

  it('flags total token budget warnings when exceeding limits', () => {
    const context: RepoContext = {
      ...mockBaseContext,
      files: [makeFile('/repo/CLAUDE.md', 'claude', 9000)],
      metrics: {
        estimatedInstructionTokens: 9000, // exceeds 8000
        instructionFileCount: 1,
        largestInstructionFiles: [{ path: '/repo/CLAUDE.md', estimatedTokens: 9000 }],
      },
    };
    const issues = detectContextCost(context);
    expect(issues.some(i => i.id === 'context-cost-total-token-budget')).toBe(true);
  });

  it('flags large always-scanned instruction files', () => {
    const context: RepoContext = {
      ...mockBaseContext,
      files: [makeFile('/repo/CLAUDE.md', 'claude', 3000)], // exceeds 2500
      metrics: {
        estimatedInstructionTokens: 3000,
        instructionFileCount: 1,
        largestInstructionFiles: [{ path: '/repo/CLAUDE.md', estimatedTokens: 3000 }],
      },
    };
    const issues = detectContextCost(context);
    expect(issues.some(i => i.title.includes('Large always-scanned'))).toBe(true);
  });

  it('flags README dominance when README dominates context tokens', () => {
    const context: RepoContext = {
      ...mockBaseContext,
      files: [
        makeFile('/repo/README.md', 'readme', 1500), // >= 1000 tokens, ratio >= 0.5
        makeFile('/repo/CLAUDE.md', 'claude', 500),
      ],
      metrics: {
        estimatedInstructionTokens: 2000,
        instructionFileCount: 2,
        largestInstructionFiles: [],
      },
    };
    const issues = detectContextCost(context);
    expect(issues.some(i => i.title.includes('README dominates'))).toBe(true);
  });
});
