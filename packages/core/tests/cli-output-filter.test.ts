import { describe, it, expect } from 'vitest';
import { detectCliOutputFilter } from '../src/cli-output-filter.js';
import type { RepoContext } from '../src/repo-context.js';
import type { InstructionFile } from '../src/types.js';

function makeFile(content: string, filePath = 'CLAUDE.md'): InstructionFile {
  return {
    path: filePath,
    fileType: 'claude',
    content,
    sections: [],
    lineCount: content.split('\n').length,
    charCount: content.length,
    estimatedTokens: Math.round(content.length / 4),
  };
}

function makeContext(files: InstructionFile[], totalTokens?: number): RepoContext {
  const estimated = totalTokens ?? files.reduce((sum, f) => sum + f.estimatedTokens, 0);
  return {
    repoRoot: '/repo',
    files,
    projectType: 'typescript',
    manifests: { packageJson: '', pyprojectToml: '', cargoToml: '' },
    packageJson: { scripts: {}, dependencies: {}, devDependencies: {}, engines: {} },
    workflows: { files: [], allCommands: [] },
    metrics: {
      estimatedInstructionTokens: estimated,
      instructionFileCount: files.length,
      largestInstructionFiles: [],
    },
  } as unknown as RepoContext;
}

const LARGE_CONTENT = 'A'.repeat(3000); // ~750 tokens

describe('detectCliOutputFilter', () => {
  it('returns no issues for empty files', () => {
    expect(detectCliOutputFilter(makeContext([]))).toHaveLength(0);
  });

  it('returns no issues for small instruction sets (<500 tokens)', () => {
    const file = makeFile('Run npm test before pushing.');
    const ctx = makeContext([file], 200);
    expect(detectCliOutputFilter(ctx)).toHaveLength(0);
  });

  it('returns no issues when rtk is already mentioned', () => {
    const file = makeFile(`${LARGE_CONTENT}\nUse rtk git status for compact output.`);
    expect(detectCliOutputFilter(makeContext([file]))).toHaveLength(0);
  });

  it('returns no issues when output filter guidance exists', () => {
    const file = makeFile(`${LARGE_CONTENT}\nUse a CLI proxy for output filtering.`);
    expect(detectCliOutputFilter(makeContext([file]))).toHaveLength(0);
  });

  it('returns no issues when compact output is mentioned', () => {
    const file = makeFile(`${LARGE_CONTENT}\nPrefer compact output from commands.`);
    expect(detectCliOutputFilter(makeContext([file]))).toHaveLength(0);
  });

  it('flags large projects with no output filter guidance', () => {
    const file = makeFile(`${LARGE_CONTENT}\nRun npm test and git diff before submitting.`);
    const issues = detectCliOutputFilter(makeContext([file]));
    expect(issues).toHaveLength(1);
    expect(issues[0].id).toBe('cli-output-filter-missing');
    expect(issues[0].severity).toBe('info');
    expect(issues[0].category).toBe('agent_practices');
  });

  it('includes referenced noisy commands in evidence', () => {
    const file = makeFile(`${LARGE_CONTENT}\nRun npm test and git diff before submitting.`);
    const issues = detectCliOutputFilter(makeContext([file]));
    expect(issues[0].evidence[0]).toMatch(/npm test|git diff/i);
  });

  it('includes a fixRecipe with install instructions', () => {
    const file = makeFile(LARGE_CONTENT);
    const issues = detectCliOutputFilter(makeContext([file]));
    expect(issues[0].fixRecipe).toMatch(/rtk init -g/);
    expect(issues[0].fixRecipe).toMatch(/brew install rtk/i);
  });

  it('detects RTK mention case-insensitively', () => {
    const file = makeFile(`${LARGE_CONTENT}\nWe use RTK for token savings.`);
    expect(detectCliOutputFilter(makeContext([file]))).toHaveLength(0);
  });

  it('detects Rust Token Killer mention', () => {
    const file = makeFile(`${LARGE_CONTENT}\nInstall Rust Token Killer for filtering.`);
    expect(detectCliOutputFilter(makeContext([file]))).toHaveLength(0);
  });
});
