import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
  cleanAbsolutePaths,
  cleanVolatileDates,
  optimizeContext,
} from '../src/context-optimizer.js';
import type { InstructionFile } from '../src/types.js';

function makeFile(
  content: string,
  fileType: InstructionFile['fileType'] = 'claude',
  filePath = '/repo/CLAUDE.md'
): InstructionFile {
  return {
    path: path.resolve(filePath),
    fileType,
    content,
    sections: [],
    lineCount: content.split('\n').length,
    charCount: content.length,
    estimatedTokens: Math.round(content.length / 4),
  };
}

describe('cleanAbsolutePaths', () => {
  it('converts absolute repo paths to relative ones using forward slashes', () => {
    const repoRoot = 'C:/git/project';
    const content = 'Refer to C:\\git\\project\\packages\\core or C:/git/project/apps/web.';
    const cleaned = cleanAbsolutePaths(content, repoRoot);
    expect(cleaned).toBe('Refer to ./packages/core or ./apps/web.');
  });
});

describe('cleanVolatileDates', () => {
  it('strips volatile updated/modified date lines', () => {
    const content = [
      '# Rules',
      'Last updated: 2026-06-08',
      '- Do not write global state',
      '* Updated at: 2026-06-05',
      'This is standard prose.',
    ].join('\n');

    const cleaned = cleanVolatileDates(content);
    expect(cleaned).toBe('# Rules\n- Do not write global state\nThis is standard prose.');
  });
});

describe('optimizeContext', () => {
  it('returns no changes if files are small and stable', async () => {
    const file = makeFile('# Guidelines\nAlways use strict typing.', 'agents', '/repo/AGENTS.md');
    const result = await optimizeContext([file], { repoRoot: '/repo' });
    expect(result.changes.length).toBe(0);
  });

  it('splits sections that exceed the size threshold', async () => {
    // Section "Heavy Reference" will be ~2100 chars, exceeding characterLimit of 2000
    const heading = '## Heavy Reference';
    const body = 'A'.repeat(2050);
    const content = `# Rules\n\n${heading}\n${body}\n\n## Another Section\nSome short text.`;

    const file = makeFile(content, 'agents', '/repo/AGENTS.md');
    const result = await optimizeContext([file], { repoRoot: '/repo', characterLimit: 2000 });

    // Expect 2 changes: 
    // 1. New file created for the split section: Docs/heavy-reference.md (contains '# Heavy Reference\nAAAA...')
    // 2. Original file updated to replace body with a link
    expect(result.changes.length).toBe(2);

    const newFileChange = result.changes.find(c => c.filePath.endsWith('heavy-reference.md'));
    const origFileChange = result.changes.find(c => c.filePath.endsWith('AGENTS.md'));

    expect(newFileChange).toBeDefined();
    expect(newFileChange?.originalContent).toBe('');
    expect(newFileChange?.newContent).toContain('# Heavy Reference');
    expect(newFileChange?.newContent).toContain('AAAA');

    expect(origFileChange).toBeDefined();
    expect(origFileChange?.newContent).toContain('## Heavy Reference');
    expect(origFileChange?.newContent).toContain('For details, see [Docs/heavy-reference.md](Docs/heavy-reference.md).');
    expect(origFileChange?.newContent).not.toContain(body);
  });

  it('splits sections containing volatile information even if under size threshold', async () => {
    const content = [
      '# Rules',
      '## Current Tasks',
      'Current Branch: feat/caching',
      'Active Task: implement cache checks',
      '## Stable Section',
      'This section contains no volatile info.',
    ].join('\n');

    const file = makeFile(content, 'agents', '/repo/AGENTS.md');
    const result = await optimizeContext([file], { repoRoot: '/repo' });

    expect(result.changes.length).toBe(2);
    const newFileChange = result.changes.find(c => c.filePath.endsWith('current-tasks.md'));
    expect(newFileChange?.newContent).toContain('# Current Tasks');
    expect(newFileChange?.newContent).toContain('Current Branch: feat/caching');
  });

  it('prevents collisions by appending counter suffix to filenames', async () => {
    const content = [
      '# Rules',
      '## Reference',
      'A'.repeat(2100),
      '## Reference',
      'B'.repeat(2100),
    ].join('\n');

    const file = makeFile(content, 'agents', '/repo/AGENTS.md');
    const result = await optimizeContext([file], { repoRoot: '/repo', characterLimit: 2000 });

    const newFiles = result.changes.filter(c => c.originalContent === '');
    expect(newFiles.length).toBe(2);
    
    const paths = newFiles.map(f => path.basename(f.filePath));
    expect(paths).toContain('reference.md');
    expect(paths).toContain('reference-2.md');
  });
});
