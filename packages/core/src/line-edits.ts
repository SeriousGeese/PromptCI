/**
 * The text half of the line-anchored fix recipes (pcic-oonz): how a list of
 * {@link FixEdit}s rewrites one file's content. Shared by the fix engine, which
 * applies the edits, and by the detectors that emit them, which run the same
 * function first so a finding never carries an edit the engine would refuse
 * (pcic-k1t3.12).
 */

import type { FixEdit } from './types.js';

/** Occurrences of `needle` (a plain string, never a pattern) in `haystack`. */
export function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
    count++;
  }
  return count;
}

/**
 * `content` with `edits` applied in order, or `undefined` when any edit cannot
 * be applied cleanly: every edit must land on an existing line whose text (at
 * that point, after the edits before it) contains its `find` exactly once, and
 * `find` must be non-empty and hold no newline. All or nothing: one refusal
 * means no rewrite at all.
 *
 * Lines are split with their terminators attached and rejoined verbatim, so a
 * one-token substitution leaves every other byte of the file (mixed or CRLF line
 * endings, a missing trailing newline) exactly as it was.
 */
export function applyLineEditsToText(
  content: string,
  edits: ReadonlyArray<Pick<FixEdit, 'line' | 'find' | 'replace'>>,
): string | undefined {
  const lines = content.split(/(?<=\n)/);
  for (const { line, find, replace } of edits) {
    const text = lines[line - 1];
    if (text === undefined || !find || find.includes('\n')) return undefined;
    if (countOccurrences(text, find) !== 1) return undefined;
    // Spliced by index, not via String.replace: a `$&`, `$1` or `$$` in the
    // replacement is replacement-pattern syntax there, and a path or script
    // name containing `$` would be silently corrupted.
    const at = text.indexOf(find);
    lines[line - 1] = text.slice(0, at) + replace + text.slice(at + find.length);
  }
  return lines.join('');
}

/** 1-based line number of character `offset` in `content`. */
export function lineNumberAt(content: string, offset: number): number {
  let line = 1;
  for (let at = content.indexOf('\n'); at !== -1 && at < offset; at = content.indexOf('\n', at + 1)) line++;
  return line;
}
