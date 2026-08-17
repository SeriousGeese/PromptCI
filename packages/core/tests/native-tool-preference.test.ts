import { describe, it, expect } from 'vitest';
import { detectNativeToolPreference } from '../src/native-tool-preference.js';
import type { InstructionFile } from '../src/types.js';

function makeFile(
  content: string,
  filePath = 'CLAUDE.md',
  fileType: InstructionFile['fileType'] = 'claude',
): InstructionFile {
  return {
    path: filePath,
    fileType,
    content,
    sections: [],
    lineCount: content.split('\n').length,
    charCount: content.length,
    estimatedTokens: Math.round(content.length / 4),
  };
}

describe('detectNativeToolPreference', () => {
  it('returns no issues for empty files', () => {
    expect(detectNativeToolPreference([])).toHaveLength(0);
  });

  it('returns no issues when no Claude-targeted file exists', () => {
    const agentsFile = makeFile('Use grep for search.', 'AGENTS.md', 'agents');
    expect(detectNativeToolPreference([agentsFile])).toHaveLength(0);
  });

  it('flags Claude file with no native tool preference guidance', () => {
    const file = makeFile('Run tests with npm test. Use grep for searching.');
    const issues = detectNativeToolPreference([file]);
    expect(issues).toHaveLength(1);
    expect(issues[0].id).toBe('native-tool-preference-missing');
    expect(issues[0].severity).toBe('info');
    expect(issues[0].category).toBe('agent_practices');
  });

  it('returns no issues when "Read tool" is mentioned', () => {
    const file = makeFile('Use the Read tool instead of cat.');
    expect(detectNativeToolPreference([file])).toHaveLength(0);
  });

  it('returns no issues when "use Grep" is mentioned', () => {
    const file = makeFile('Use Grep for content search instead of running grep.');
    expect(detectNativeToolPreference([file])).toHaveLength(0);
  });

  it('returns no issues when "use Glob" is mentioned', () => {
    const file = makeFile('Use Glob (not find or ls) for file search.');
    expect(detectNativeToolPreference([file])).toHaveLength(0);
  });

  it('returns no issues when "prefer Read" is mentioned', () => {
    const file = makeFile('Prefer Read over cat/head/tail for reading files.');
    expect(detectNativeToolPreference([file])).toHaveLength(0);
  });

  it('returns no issues when guidance exists in any instruction file', () => {
    const claude = makeFile('Run npm test before pushing.', 'CLAUDE.md', 'claude');
    const agents = makeFile('Use Read not cat. Use Glob not find.', 'AGENTS.md', 'agents');
    expect(detectNativeToolPreference([claude, agents])).toHaveLength(0);
  });

  it('includes the Claude file path in the issue', () => {
    const file = makeFile('Run tests. Search with grep.', 'CLAUDE.md');
    const issues = detectNativeToolPreference([file]);
    expect(issues[0].filePaths).toContain('CLAUDE.md');
  });

  it('includes a fixRecipe describing the three tool mappings', () => {
    const file = makeFile('Some instructions without tool guidance.');
    const issues = detectNativeToolPreference([file]);
    expect(issues[0].fixRecipe).toMatch(/Glob/);
    expect(issues[0].fixRecipe).toMatch(/Grep/);
    expect(issues[0].fixRecipe).toMatch(/Read/);
  });

  it('detects claude.md by path basename regardless of fileType', () => {
    const file = makeFile('No tool guidance here.', 'CLAUDE.md', 'unknown');
    expect(detectNativeToolPreference([file])).toHaveLength(1);
  });

  it('returns no issues when built-in tools mentioned via "dedicated tools" pattern', () => {
    const file = makeFile('Use dedicated tools instead of cat and find for file ops.');
    expect(detectNativeToolPreference([file])).toHaveLength(0);
  });
});
