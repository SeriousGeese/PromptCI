import { describe, it, expect } from 'vitest';
import { detectWindsurfRules } from '../src/windsurf-detector.js';
import { parseSections } from '../src/scanner.js';
import { emptyAiConfigFiles } from '../src/ai-config.js';
import type { RepoContext } from '../src/repo-context.js';
import type { FileType, InstructionFile } from '../src/types.js';

function makeFile(path: string, fileType: FileType, content: string): InstructionFile {
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

function ctxWith(files: InstructionFile[]): RepoContext {
  return {
    repoRoot: '/repo',
    files,
    projectType: 'unknown',
    manifests: {},
    packageJson: {
      packageManagerName: 'unknown',
      scripts: {},
      dependencies: {},
      devDependencies: {},
      peerDependencies: {},
      lockfiles: [],
    },
    workflows: { files: [], commands: [] },
    aiConfig: emptyAiConfigFiles(),
    metrics: { estimatedInstructionTokens: 0, instructionFileCount: 0, largestInstructionFiles: [] },
    onDemandFiles: [],
  };
}

describe('detectWindsurfRules', () => {
  it('is silent when there is no .windsurfrules', () => {
    expect(detectWindsurfRules(ctxWith([]))).toEqual([]);
  });

  it('flags a .windsurfrules mixing multiple language-specific headings', () => {
    const content = [
      '# Rules',
      '## Python conventions',
      'Use type hints.',
      '## React components',
      'Prefer function components.',
    ].join('\n');
    const issues = detectWindsurfRules(ctxWith([makeFile('/repo/.windsurfrules', 'windsurf', content)]));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('info');
    expect(issues[0]!.category).toBe('ai_config');
    expect(issues[0]!.evidence.join(' ')).toContain('Python');
    expect(issues[0]!.evidence.join(' ')).toContain('React');
  });

  it('does not flag a single language-specific section', () => {
    const content = ['# Rules', '## Python conventions', 'Use type hints.'].join('\n');
    const issues = detectWindsurfRules(ctxWith([makeFile('/repo/.windsurfrules', 'windsurf', content)]));
    expect(issues).toEqual([]);
  });

  it('only matches language terms in headings, not in prose', () => {
    // "python" and "react" appear only in body prose, not headings.
    const content = [
      '# Rules',
      '## General',
      'We use python and react in this repo but keep rules generic.',
    ].join('\n');
    const issues = detectWindsurfRules(ctxWith([makeFile('/repo/.windsurfrules', 'windsurf', content)]));
    expect(issues).toEqual([]);
  });

  it('ignores non-windsurf files with multiple language headings', () => {
    const content = ['## Python', 'x', '## Rust', 'y'].join('\n');
    const issues = detectWindsurfRules(ctxWith([makeFile('/repo/CLAUDE.md', 'claude', content)]));
    expect(issues).toEqual([]);
  });
});
