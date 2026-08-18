import { describe, it, expect } from 'vitest';
import {
  scanFencedLines,
  fencedBlocks,
  fencedBlockContents,
  stripCodeBlocks,
  blankCodeBlockLines,
  buildCodeMask,
} from '../src/markdown-fences.js';

/**
 * The suite that replaces eleven copies' worth of one-off fence tests. Each
 * case below is a bug that was found — and fixed — independently in several
 * of those copies before they were consolidated here.
 */

describe('scanFencedLines', () => {
  it('marks fence markers and content as in-fence, prose as out', () => {
    const lines = scanFencedLines(['before', '```', 'inside', '```', 'after'].join('\n'));

    expect(lines.map(l => l.kind)).toEqual(['text', 'open', 'content', 'close', 'text']);
    expect(lines.map(l => l.inFence)).toEqual([false, true, true, true, false]);
    expect(lines.map(l => l.lineNumber)).toEqual([1, 2, 3, 4, 5]);
  });

  it('does not let ``` close a ~~~ block', () => {
    const lines = scanFencedLines(['~~~', 'inside', '```', 'still inside', '~~~', 'out'].join('\n'));

    expect(lines.map(l => l.inFence)).toEqual([true, true, true, true, true, false]);
  });

  it('does not let a shorter run close a longer fence', () => {
    const lines = scanFencedLines(['````', 'inside', '```', 'still inside', '````', 'out'].join('\n'));

    expect(lines.map(l => l.inFence)).toEqual([true, true, true, true, true, false]);
  });

  it('treats an unclosed fence as running to the end, marked unclosed', () => {
    const lines = scanFencedLines(['prose', '```', 'dangling'].join('\n'));

    expect(lines.map(l => l.inFence)).toEqual([false, true, true]);
    expect(lines.map(l => l.closed)).toEqual([true, false, false]);
  });

  it('allows up to three spaces of indent on either fence', () => {
    const lines = scanFencedLines(['   ```bash', '   npm test', '   ```', 'out'].join('\n'));

    expect(lines.map(l => l.inFence)).toEqual([true, true, true, false]);
    expect(lines[1]!.lang).toBe('bash');
  });

  it('does not open a fence indented four or more spaces', () => {
    const lines = scanFencedLines(['    ```', 'text'].join('\n'));

    expect(lines.every(l => !l.inFence)).toBe(true);
  });

  it('rejects a closing fence with trailing content', () => {
    const lines = scanFencedLines(['```', 'inside', '``` not a close', '```', 'out'].join('\n'));

    expect(lines.map(l => l.kind)).toEqual(['open', 'content', 'content', 'close', 'text']);
  });

  it('lowercases the info string and carries it across the block', () => {
    const lines = scanFencedLines(['```BASH', 'npm test', '```'].join('\n'));

    expect(lines.map(l => l.lang)).toEqual(['bash', 'bash', 'bash']);
  });

  it('keeps line text byte-identical, carriage returns included', () => {
    const lines = scanFencedLines('a\r\n```\r\nb\r\n```\r\n');

    expect(lines[0]!.text).toBe('a\r');
    expect(lines[2]!.text).toBe('b\r');
    // A trailing CR must not stop a fence line from being recognised.
    expect(lines[1]!.kind).toBe('open');
    expect(lines[3]!.kind).toBe('close');
  });
});

describe('fencedBlocks', () => {
  it('groups content per block with 1-based line anchors', () => {
    const blocks = fencedBlocks(
      ['intro', '```bash', 'npm ci', 'npm test', '```', 'outro'].join('\n'),
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      lang: 'bash',
      closed: true,
      openLine: 2,
      contentStartLine: 3,
      lines: ['npm ci', 'npm test'],
    });
  });

  it('reports a trailing unclosed block as unclosed', () => {
    const blocks = fencedBlocks(['```', 'half a block'].join('\n'));

    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.closed).toBe(false);
    expect(blocks[0]!.lines).toEqual(['half a block']);
  });

  it('handles several blocks, including an even number of fences', () => {
    const blocks = fencedBlocks(
      ['```json', '{}', '```', 'prose', '```sh', 'ls', '```'].join('\n'),
    );

    expect(blocks.map(b => b.lang)).toEqual(['json', 'sh']);
    expect(blocks.map(b => b.lines)).toEqual([['{}'], ['ls']]);
  });
});

describe('fencedBlockContents', () => {
  it('returns only confirmed closed blocks by default', () => {
    const content = ['```', 'closed body', '```', '```', 'dangling body'].join('\n');

    expect(fencedBlockContents(content)).toBe('closed body');
    expect(fencedBlockContents(content, { closedOnly: false })).toBe('closed body\ndangling body');
  });
});

describe('stripCodeBlocks', () => {
  it('removes fence markers and their content', () => {
    const out = stripCodeBlocks(['keep', '```', 'drop', '```', 'keep too'].join('\n'));

    expect(out).toBe('keep\nkeep too');
  });

  it('leaves inline code spans alone unless asked', () => {
    expect(stripCodeBlocks('run `npm test` now')).toBe('run `npm test` now');
    expect(stripCodeBlocks('run `npm test` now', { stripInlineCode: true })).toBe('run  now');
  });

  it('swallows everything after an unclosed fence', () => {
    expect(stripCodeBlocks(['keep', '~~~', 'drop', 'drop too'].join('\n'))).toBe('keep');
  });
});

describe('blankCodeBlockLines', () => {
  it('preserves the line count so offsets still map to the original file', () => {
    const content = ['one', '```', 'two', '```', 'five'].join('\n');
    const out = blankCodeBlockLines(content);

    expect(out.split('\n')).toEqual(['one', '', '', '', 'five']);
    expect(out.split('\n')).toHaveLength(content.split('\n').length);
  });
});

describe('buildCodeMask', () => {
  const maskedText = (content: string): string =>
    [...content].filter((_, i) => buildCodeMask(content)[i]).join('');

  it('marks fenced block characters', () => {
    const content = 'prose\n```\ncode\n```\n';

    expect(maskedText(content)).toBe('```code```');
  });

  it('marks inline code spans but not the prose around them', () => {
    const content = 'run `npm test` now';

    expect(maskedText(content)).toBe('`npm test`');
  });

  it('returns a mask the same length as the content', () => {
    const content = 'a\n```\nb\n```\nc';

    expect(buildCodeMask(content)).toHaveLength(content.length);
  });
});
