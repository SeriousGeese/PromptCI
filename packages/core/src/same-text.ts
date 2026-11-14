/**
 * The one "same text" rule for consolidation auto-fixes (pcic-1ik0.5), in its
 * own module so the detectors and the fix recipes share it without a cycle.
 */

import type { InstructionSection } from './types.js';

/** A fence opener or closer: three or more backticks or tildes, up to three spaces in. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
/** A line that starts a new prose block: a list item, heading, blockquote or table row. */
const BLOCK_START_RE = /^(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>|\|)/;

/**
 * The ONE definition of "the same text" for the consolidation auto-fix,
 * shared by per-section duplicate findings and mirrored-file findings (and by
 * any recipe that drops a copy in favour of its canonical text). Two sections
 * count as the same text when their canonical forms below are equal; anything
 * else, a near-duplicate, is advisory only.
 *
 * - Line endings are normalised and trailing spaces and tabs dropped
 *   everywhere.
 * - Code is compared verbatim otherwise: lines inside a fenced block (``` or
 *   ~~~), and lines indented by four or more columns or a tab (indented code,
 *   and nested list items, where indentation also carries meaning). Their
 *   leading whitespace, tabs versus spaces included, must match.
 * - Prose is compared modulo reflow: runs of spaces collapse, and the lines
 *   of one paragraph or one list item join. A blank line, a list item, a
 *   heading, a blockquote or a table row starts a new block, so a reflowed
 *   list never equals a paragraph, and block order matters.
 * - Nothing else changes: case, punctuation, numbers, flags and link targets
 *   all count.
 */
export function sameSectionText(section: Pick<InstructionSection, 'text'>): string {
  const blocks: string[] = [];
  let prose: string[] = [];
  const flush = () => {
    if (prose.length > 0) blocks.push(`P:${prose.join(' ').replace(/[ \t]+/g, ' ')}`);
    prose = [];
  };
  let fence: { char: string; length: number } | undefined;
  for (const raw of section.text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/[ \t]+$/, '');
    if (fence) {
      blocks.push(`C:${line}`);
      const close = FENCE_RE.exec(line);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.length && line.trim() === close[1]) {
        fence = undefined;
      }
      continue;
    }
    const open = FENCE_RE.exec(line);
    if (open) {
      flush();
      fence = { char: open[1]![0]!, length: open[1]!.length };
      blocks.push(`C:${line.trimStart()}`);
      continue;
    }
    if (line === '') {
      flush();
      continue;
    }
    if (/^(?: {4}|\t)/.test(line) || /^ {0,3}\t/.test(line)) {
      flush();
      blocks.push(`C:${line}`);
      continue;
    }
    const text = line.trimStart();
    if (BLOCK_START_RE.test(text)) flush();
    prose.push(text);
  }
  flush();
  return blocks.join('\n');
}
