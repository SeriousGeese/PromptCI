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

  // BUG-18: the volatile-section patterns matched prose that merely *mentions*
  // PromptCI (`/promptci\s+report/i`, `/scan\s+history/i`), so any repo
  // documenting the tool got those sections torn out into a generated doc.
  it.each([
    ['dashboard prose', '## Hosted dashboard\nA hosted dashboard (scan history, improvement metrics) exists.'],
    ['workflow prose', '## Reporting\nOpen the PromptCI report in your editor after each run.'],
    ['results prose', '## CI\nLatest scan results are posted as a PR comment.'],
  ])('leaves sections that only describe PromptCI alone (%s)', async (_label, section) => {
    const file = makeFile(`# Rules\n${section}\n`, 'agents', '/repo/AGENTS.md');
    const result = await optimizeContext([file], { repoRoot: '/repo' });
    expect(result.changes).toEqual([]);
  });

  it.each([
    ['health score', '## Status\nHealth Score: 87'],
    ['files scanned', '## Status\nFiles scanned: 12'],
    ['report title', '## Status\n# PromptCI Health Report'],
    ['report footer', '## Status\n*Generated by [PromptCI](https://example.com)*'],
  ])('still splits sections holding pasted scan output (%s)', async (_label, section) => {
    const file = makeFile(`# Rules\n${section}\n`, 'agents', '/repo/AGENTS.md');
    const result = await optimizeContext([file], { repoRoot: '/repo' });
    expect(result.changes.length).toBeGreaterThan(0);
  });

  it('never touches README.md', async () => {
    const content = '# Project\n## Tasks\nCurrent Branch: feat/caching\n';
    const file = makeFile(content, 'readme', '/repo/README.md');
    const result = await optimizeContext([file], { repoRoot: '/repo' });
    expect(result.changes).toEqual([]);
  });

  // The forked parser toggled `inCodeBlock` on any line starting with three
  // fence chars, so a ~~~ fence (or a longer ``` run) desynchronised it and
  // `#` comments inside code blocks were treated as section headings.
  it('does not treat headings inside ~~~ fences as sections', async () => {
    const content = [
      '# Rules',
      '## Setup',
      '~~~bash',
      '# Current Branch: main',
      'echo hi',
      '~~~',
      'Stable prose.',
    ].join('\n');

    const file = makeFile(content, 'agents', '/repo/AGENTS.md');
    const result = await optimizeContext([file], { repoRoot: '/repo' });

    // The volatile line lives inside the fence and belongs to "Setup"; the
    // extracted doc must carry the whole fenced block, not a phantom section.
    const newFile = result.changes.find((c) => c.originalContent === '');
    expect(newFile && path.basename(newFile.filePath)).toBe('setup.md');
    expect(newFile?.newContent).toContain('~~~bash');
    expect(newFile?.newContent).toContain('echo hi');
    expect(newFile?.newContent).toContain('~~~');
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
