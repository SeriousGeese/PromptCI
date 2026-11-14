/**
 * The one "same text" rule for consolidation auto-fixes (pcic-1ik0.5), in its
 * own module so the detectors and the fix recipes share it without a cycle.
 */

import type { InstructionSection } from './types.js';

/**
 * The ONE definition of "the same text" for an UNATTENDED consolidation edit,
 * shared by per-section duplicate findings, mirrored-file findings and the
 * import recipe (pcic-1ik0.5, pcic-1ik0.10). Two sections are the same text
 * only when they are byte-identical after normalising exactly these, and
 * nothing else:
 *
 * - line endings (CRLF and CR become LF);
 * - trailing whitespace at the end of each line;
 * - a leading byte-order mark;
 * - leading and trailing blank lines of the section.
 *
 * No interior whitespace is collapsed, no indentation is trimmed, no reflow is
 * treated as equal and no Markdown is modelled: a nested list, `<pre>` or
 * inline-code spacing, a reflowed paragraph, tabs versus spaces, or a
 * different Unicode normalisation all count as different, and the finding is
 * then advisory. That costs a few auto-fixes and removes the whole class of
 * "equal after normalising, different in meaning" wrong edits.
 */
export function sameSectionText(section: Pick<InstructionSection, 'text'>): string {
  const lines = section.text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+$/, ''));
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}
