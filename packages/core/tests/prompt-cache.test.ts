import { describe, it, expect } from 'vitest';
import { detectPromptCacheFriendliness } from '../src/prompt-cache.js';
import type { InstructionFile } from '../src/types.js';

function makeFile(content: string, fileType: InstructionFile['fileType'] = 'claude', path = '/repo/CLAUDE.md'): InstructionFile {
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

describe('detectPromptCacheFriendliness', () => {
  it('returns no issues for clean/stable instruction files', () => {
    const file = makeFile('# Stable Rules\nAvoid using complex logic. Always keep functions small.');
    expect(detectPromptCacheFriendliness([file])).toEqual([]);
  });

  it('flags volatile timestamps in canonical instruction files', () => {
    const file = makeFile('# Instructions\nLast Updated: 2026-06-05\nAvoid using global states.');
    const issues = detectPromptCacheFriendliness([file]);
    expect(issues.some(i => i.id.startsWith('prompt-cache-volatile-timestamp'))).toBe(true);
  });

  it('does not flag dates/timestamps in README files', () => {
    const file = makeFile('# Project changelog\nLast updated: 2026-06-05\n- Added new API features.', 'readme', '/repo/README.md');
    const issues = detectPromptCacheFriendliness([file]);
    expect(issues.length).toBe(0);
  });

  it('flags pasted PromptCI scan summaries', () => {
    const file = makeFile('# Rules\nPromptCI Scan Report\nHealth Score: 85\nFiles Scanned: 4\nIssues: 2');
    const issues = detectPromptCacheFriendliness([file]);
    expect(issues.some(i => i.id.startsWith('prompt-cache-pasted-report'))).toBe(true);
  });

  it('flags branch and task notes', () => {
    const file = makeFile('# Tasks\nCurrent Branch: feat/caching\nActive Task: implement cache checks');
    const issues = detectPromptCacheFriendliness([file]);
    expect(issues.some(i => i.id.startsWith('prompt-cache-volatile-branch-task'))).toBe(true);
  });

  it('flags absolute local machine paths', () => {
    const file = makeFile('# Configuration\nSave backup outputs in C:\\Users\\zachm\\AppData\\Local\\Temp.');
    const issues = detectPromptCacheFriendliness([file]);
    expect(issues.some(i => i.id.startsWith('prompt-cache-local-paths'))).toBe(true);
  });

  it('flags exceptionally large tables', () => {
    let tableContent = '# Data Reference\n| Key | Value |\n|---|---|\n';
    for (let i = 0; i < 20; i++) {
      tableContent += `| k${i} | v${i} |\n`;
    }
    const file = makeFile(tableContent);
    const issues = detectPromptCacheFriendliness([file]);
    expect(issues.some(i => i.id.startsWith('prompt-cache-large-table'))).toBe(true);
  });

  it('counts word-only markdown table rows as content rows', () => {
    let tableContent = '# Data Reference\n| Use | Avoid |\n|---|---|\n';
    for (let i = 0; i < 20; i++) {
      tableContent += '| Use | Avoid |\n';
    }
    const file = makeFile(tableContent);
    const issues = detectPromptCacheFriendliness([file]);
    expect(issues.some(i => i.id.startsWith('prompt-cache-large-table'))).toBe(true);
  });

  it('does not flag small tables', () => {
    const tableContent = '# Reference\n| Key | Value |\n|---|---|\n| k1 | v1 |\n| k2 | v2 |\n';
    const file = makeFile(tableContent);
    const issues = detectPromptCacheFriendliness([file]);
    expect(issues.length).toBe(0);
  });

  // ── B4: id must not collide across two files of the same fileType ─────────

  it('B4: emits a distinct id for two different "claude"-fileType files with the same volatile-timestamp issue', () => {
    const fileA = makeFile('# Instructions\nLast Updated: 2026-06-05', 'claude', '/repo/CLAUDE.md');
    const fileB = makeFile('# Notes\nLast Updated: 2026-06-06', 'claude', '/repo/.claude/notes.md');
    const issues = detectPromptCacheFriendliness([fileA, fileB]);
    const matches = issues.filter((i) => i.id.startsWith('prompt-cache-volatile-timestamp'));
    expect(matches).toHaveLength(2);
    expect(matches[0]!.id).not.toBe(matches[1]!.id);
  });
});
