/**
 * Text helpers that stay linear on hostile input (pcic-1ik0.25).
 *
 * A scan runs on any repository, so an instruction file can be built to make a pattern backtrack:
 * one 300 KB line, or 20,000 short ones. These helpers answer the questions detectors used to ask
 * with a regex or a slice per match, in time proportional to the text.
 */

/** What a practice or rule pattern needs: a RegExp satisfies it. */
export type TextMatcher = { test(text: string): boolean };

/** A matcher that can also say where its first match starts (-1 when there is none). */
export type LocatingMatcher = TextMatcher & {
  firstIndex(text: string): number;
  /** The last part, for evidence that has to know whether a match runs on past a window. */
  lastPart: RegExp;
};

/**
 * A part written after `\s+` in the original pattern (`/report.*\s+before/`): it must follow at least
 * one whitespace character, and that whitespace may cross a line break, which the `.*` gap before it
 * cannot. Searched as `(?<=\s)before`, so a long run of spaces is not re-read from each of its
 * positions (`/\s+before/` was quadratic on one).
 */
export type AfterSpace = { afterSpace: RegExp };

const LINE_BREAK_RE = /[\n\r\u2028\u2029]/g;

/**
 * The matcher `/A.*B.*C/` describes, without its backtracking: `parts` match in order and the
 * gaps between them hold no line terminator (what `.` refuses), while a part itself may span lines
 * as before. A part must not end in a quantifier that could give back text the next part needs;
 * the tests hold each use to its regex on generated input.
 *
 * `/read.*before.*edit/i` tried every "read" against the rest of its line, and every "before"
 * after it against the rest again: minutes on one long line. This walks each part once.
 */
export function inOrderOnOneLine(...parts: Array<RegExp | AfterSpace>): LocatingMatcher {
  const sources = parts.map((p) => {
    const re = p instanceof RegExp ? p : p.afterSpace;
    const source = p instanceof RegExp ? re.source : `(?<=\\s)(?:${re.source})`;
    return { source, flags: re.flags.replace(/[gy]/g, '') + 'g', afterSpace: !(p instanceof RegExp) };
  });
  const isSpace = (char: string | undefined) => char !== undefined && /\s/.test(char);
  const firstIndex = (text: string): number => {
    const res = sources.map((s) => new RegExp(s.source, s.flags));
    const breaks: number[] = [];
    for (const m of text.matchAll(LINE_BREAK_RE)) breaks.push(m.index);
    const nextBreak = (from: number): number => {
      let lo = 0;
      let hi = breaks.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (breaks[mid]! < from) lo = mid + 1;
        else hi = mid;
      }
      return lo < breaks.length ? breaks[lo]! : text.length;
    };
    // Where the run of spaces ending at `index` starts, worked out once per run.
    const runStarts = new Map<number, number>();
    const spaceRunStart = (index: number): number => {
      let at = runStarts.get(index);
      if (at === undefined) {
        at = index;
        while (at > 0 && isSpace(text[at - 1])) at--;
        runStarts.set(index, at);
      }
      return at;
    };
    // The leftmost match of part k at or after `pos`, kept while later questions it answers come.
    const cache: Array<{ from: number; match: RegExpExecArray | null } | undefined> = res.map(() => undefined);
    const find = (k: number, pos: number): RegExpExecArray | null => {
      const known = cache[k];
      if (known && pos >= known.from && (known.match === null || pos <= known.match.index)) return known.match;
      const re = res[k]!;
      re.lastIndex = pos;
      const match = re.exec(text);
      cache[k] = { from: pos, match };
      return match;
    };
    for (let start = 0; ; ) {
      const first = find(0, start);
      if (!first) return -1;
      let end = first.index + first[0].length;
      let k = 1;
      for (; k < res.length; k++) {
        const afterSpace = sources[k]!.afterSpace;
        let next = find(k, end);
        // At least one of an after-space part's spaces must lie past the previous part.
        if (next && afterSpace && next.index <= end) next = find(k, end + 1);
        if (!next) return -1;
        // The gap may not cross a line break; an after-space part owns the spaces before it.
        const gapEnd = afterSpace ? Math.max(end, spaceRunStart(next.index)) : next.index;
        if (nextBreak(end) < gapEnd) break;
        end = next.index + next[0].length;
      }
      if (k === res.length) return first.index;
      start = first.index + 1;
    }
  };
  const last = parts[parts.length - 1]!;
  return { test: (text: string) => firstIndex(text) !== -1, firstIndex, lastPart: last instanceof RegExp ? last : last.afterSpace };
}

/** The offsets at which the lines of `content` start (after each `\n`), ascending. */
export function lineStartsOf(content: string): number[] {
  const starts = [0];
  for (let i = content.indexOf('\n'); i !== -1; i = content.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

/** How many of the ascending `values` are at most `value`. */
function countAtMost(values: readonly number[], value: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid]! <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Line number (1-based, counting `\n`) of a character offset, by binary search over the line starts. */
export function lineNumberIndex(content: string): (offset: number) => number {
  const starts = lineStartsOf(content);
  return (offset: number): number => Math.max(1, countAtMost(starts, offset));
}

/** The start of the line holding `offset` (what `content.lastIndexOf('\n', offset - 1) + 1` gives). */
export function lineStartIndex(content: string): (offset: number) => number {
  const starts = lineStartsOf(content);
  return (offset: number): number => starts[Math.max(1, countAtMost(starts, offset)) - 1]!;
}

/**
 * `text.indexOf(needle, from)`, remembered: while the questions move forward through the text, each
 * part of it is searched once instead of once per question.
 */
export function forwardIndexOf(text: string, needle: string): (from: number) => number {
  let askedFrom = -1;
  let found = -1;
  return (from: number): number => {
    if (askedFrom !== -1 && from >= askedFrom && (found === -1 || from <= found)) return found;
    askedFrom = from;
    found = text.indexOf(needle, from);
    return found;
  };
}

/** The leftmost match of `pattern` at or after `from`, remembered like `forwardIndexOf`. */
export function forwardExec(text: string, pattern: RegExp): (from: number) => RegExpExecArray | null {
  const re = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '') + 'g');
  let askedFrom = -1;
  let found: RegExpExecArray | null = null;
  return (from: number): RegExpExecArray | null => {
    if (askedFrom !== -1 && from >= askedFrom && (found === null || from <= found.index)) return found;
    askedFrom = from;
    re.lastIndex = from;
    found = re.exec(text);
    return found;
  };
}
