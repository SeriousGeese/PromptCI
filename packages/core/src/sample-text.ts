/**
 * Text in an instruction file that is SAMPLE, not instruction, for the
 * mechanical fix recipes (pcic-1ik0.4 review).
 *
 * A recipe that rewrites the document must leave alone what the document only
 * shows or hides: an example inside a fenced block, an indented code block, a
 * line in an HTML comment. Reporting such a reference is still worthwhile (a
 * stale example is stale), rewriting it changes what the example says or edits
 * text no reader sees. Fenced blocks and inline code spans are handled where
 * the links are collected (markdown-fences.ts); this module covers the other
 * two shapes.
 *
 * Both checks lean toward "sample": a missed edit costs a human a minute, a
 * wrong automatic one lands in a stranger's repository.
 */

import { scanFencedLines } from './markdown-fences.js';

/**
 * `[start, end)` character ranges of every HTML comment; an unterminated one runs
 * to the end. A `<!--` inside a fenced block or an inline code span is text ABOUT
 * comments ("Comments start with `<!--`."), not a comment, and opens nothing.
 */
export function htmlCommentRanges(content: string): Array<[number, number]> {
  const fence = scanFencedLines(content);
  const ranges: Array<[number, number]> = [];
  let lineStart = 0;
  let resumeAt = 0;
  content.split('\n').forEach((line, i) => {
    if (fence[i]?.inFence !== true) {
      for (let at = line.indexOf('<!--'); at !== -1; at = line.indexOf('<!--', at + 4)) {
        const opener = lineStart + at;
        if (opener < resumeAt) continue; // inside the comment already open
        if ((line.slice(0, at).match(/`/g)?.length ?? 0) % 2 === 1) continue; // inside a code span
        const close = content.indexOf('-->', opener + 4);
        resumeAt = close === -1 ? content.length : close + 3;
        ranges.push([opener, resumeAt]);
      }
    }
    lineStart += line.length + 1;
  });
  return ranges;
}

export function inRanges(ranges: ReadonlyArray<[number, number]>, offset: number): boolean {
  return ranges.some(([start, end]) => offset >= start && offset < end);
}

/**
 * `result[n - 1]` is true when line `n` is non-blank and indented four or more
 * spaces or a tab. Markdown reads that as an indented code block, unless the line
 * continues a list item; telling those apart needs the whole block structure, so
 * every such line counts as code. Lines inside fenced blocks are not special-cased
 * (callers already treat those as code).
 */
export function indentedCodeLines(content: string): boolean[] {
  return content.split('\n').map((line) => /^(?: {4,}|\t)\S/.test(line));
}

/**
 * `result[n - 1]` is true when any part of line `n` lies in an HTML comment.
 * For a recipe that edits a whole line's text rather than a known offset.
 */
export function htmlCommentLines(content: string): boolean[] {
  const ranges = htmlCommentRanges(content);
  const flags: boolean[] = [];
  let start = 0;
  for (const line of content.split('\n')) {
    const end = start + line.length;
    flags.push(ranges.some(([a, b]) => a < end + 1 && b > start));
    start = end + 1;
  }
  return flags;
}
