import { describe, it, expect } from 'vitest';
import { detectCheapModelRouting } from '../src/cheap-model-routing.js';
import type { InstructionFile } from '../src/types.js';
import type { RepoContext } from '../src/repo-context.js';

function makeFile(content: string): InstructionFile {
  return {
    path: '/repo/CLAUDE.md',
    fileType: 'claude',
    content,
    sections: [],
    lineCount: content.split('\n').length,
    charCount: content.length,
    estimatedTokens: Math.round(content.length / 4),
  };
}

const mockContext: RepoContext = {
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
    estimatedInstructionTokens: 600,
    instructionFileCount: 1,
    largestInstructionFiles: [],
  },
};

describe('detectCheapModelRouting', () => {
  it('flags missing model routing guidance when repo is large enough', () => {
    const context: RepoContext = {
      ...mockContext,
      files: [makeFile('# Rules\nWe write TypeScript code. Always compile code before testing.')],
    };
    const issues = detectCheapModelRouting(context);
    expect(issues.some(i => i.id === 'cheap-model-routing-missing')).toBe(true);
  });

  it('does not flag missing guidance when repo is small', () => {
    const context: RepoContext = {
      ...mockContext,
      metrics: {
        ...mockContext.metrics,
        estimatedInstructionTokens: 200,
      },
      files: [makeFile('# Rules\nWe write TS.')],
    };
    const issues = detectCheapModelRouting(context);
    expect(issues.length).toBe(0);
  });

  it('does not flag when cost-routing guidance is present', () => {
    const context: RepoContext = {
      ...mockContext,
      files: [makeFile('# Rules\nUse gpt-4o-mini for simple tests and formatting. Escalate to Claude 3.5 Sonnet for design changes.')],
    };
    const issues = detectCheapModelRouting(context);
    expect(issues.length).toBe(0);
  });

  it('does not treat unrelated flash-message prose as model routing guidance', () => {
    const context: RepoContext = {
      ...mockContext,
      files: [makeFile('# UI\nUse flash messages for successful form submissions.')],
    };
    const issues = detectCheapModelRouting(context);
    expect(issues.some(i => i.id === 'cheap-model-routing-missing')).toBe(true);
  });
});
