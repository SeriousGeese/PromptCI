/**
 * What the text around a documented command says about where and how it is run
 * (pcic-1ik0.2, issue #157).
 *
 * A script the root manifest lacks is often defined in the package the text
 * points at ("From `packages/docs/`:", a "Site (from `site/` directory)"
 * heading). The text that counts is narrow on purpose: the command's own line,
 * the sentence or list item that introduces its code block, and the nearest
 * heading. Anything wider (a whole section, 80 lines of context) silences real
 * findings, and a wrong silence or a wrong automatic edit costs more than a
 * note.
 *
 * Pure text work: nothing here touches the filesystem. The detector resolves
 * the directory tokens against the repository.
 */

import { fencedBlocks } from './markdown-fences.js';

/** Per-line structure of one document: where the fences are, so a `# comment` in a block is not a heading. */
export type LineStructure = {
  lines: readonly string[];
  /** `inFence[n - 1]`: line `n` is a fence marker or sits inside a fenced block (closed or not). */
  inFence: readonly boolean[];
  /** Content line number -> the line number of the opening fence of its block. */
  opener: ReadonlyMap<number, number>;
};

export function lineStructure(content: string): LineStructure {
  const lines = content.split(/\r?\n/);
  const inFence = new Array<boolean>(lines.length).fill(false);
  const opener = new Map<number, number>();
  for (const block of fencedBlocks(content)) {
    const last = block.closed ? block.contentStartLine + block.lines.length : lines.length;
    for (let n = block.openLine; n <= last && n <= lines.length; n++) inFence[n - 1] = true;
    for (let n = block.contentStartLine; n < block.contentStartLine + block.lines.length; n++) opener.set(n, block.openLine);
  }
  return { lines, inFence, opener };
}

const ATX_RE = /^ {0,3}#{1,6}(?:\s|$)/;
const SETEXT_UNDERLINE_RE = /^ {0,3}(?:=+|-{2,})\s*$/;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s/;

/** Whether line `n` (1-based) is a heading: ATX, or the text line above a setext underline. Never inside a fence. */
export function isHeadingLine(s: LineStructure, n: number): boolean {
  if (n < 1 || n > s.lines.length || s.inFence[n - 1]) return false;
  const text = s.lines[n - 1]!;
  if (ATX_RE.test(text)) return true;
  if (text.trim() === '' || LIST_ITEM_RE.test(text) || /^\s*>/.test(text)) return false;
  const next = s.lines[n];
  return next !== undefined && !s.inFence[n] && SETEXT_UNDERLINE_RE.test(next);
}

/** The nearest heading at or above line `n`, as a line number. */
export function nearestHeading(s: LineStructure, n: number): number | undefined {
  for (let i = Math.min(n, s.lines.length); i >= 1; i--) if (isHeadingLine(s, i)) return i;
  return undefined;
}

/** What introduces a command, split by how it can be used. */
export type CommandContext = {
  /** The pieces of text that may name the directory the command runs from. */
  text: string[];
  /** The text says the command runs at the repository root: no directory hint applies. */
  explicitRoot: boolean;
  /** The text presents the command as something not to do (a bad example, a warning). */
  cautionary: boolean;
};

const ROOT_RE =
  /\b(?:at|in|from|on|under)\s+(?:the\s+)?(?:(?:repo(?:sitory)?|project|workspace|monorepo)\s+)?root\b|\b(?:repo(?:sitory)?|project|workspace|monorepo)\s+root\b|\broot\s+(?:directory|folder|of\s+(?:the\s+)?(?:repo(?:sitory)?|project|monorepo))\b/i;
const CAUTION_RE =
  /\b(?:bad|wrong|incorrect|invalid|broken|outdated|deprecated|legacy|anti-?pattern|don'?t|do\s+not|never|avoid|not\s+to|instead\s+of|not\s+recommended|no\s+longer|old\s+way)\b/i;

/** Up to `max` contiguous non-blank, non-heading, non-fence lines ending at line `from` (1-based), nearest last. */
function paragraphEndingAt(s: LineStructure, from: number, max: number): string[] {
  const out: string[] = [];
  for (let n = from; n >= 1 && out.length < max; n--) {
    if (s.inFence[n - 1] || isHeadingLine(s, n) || s.lines[n - 1]!.trim() === '') break;
    out.unshift(s.lines[n - 1]!);
  }
  return out;
}

/**
 * The text that frames the command at `line` (1-based):
 *  - its own line (the whole line, so a trailing `# wrong` counts);
 *  - for a command in a fenced block, the `#` comment lines directly above it in
 *    the block, and the paragraph or list item that introduces the block;
 *  - for a prose command that is not a list item, the paragraph lines above it;
 *  - the nearest heading; and for a command written in a heading itself, the
 *    paragraph right under it.
 */
export function commandContext(s: LineStructure, line: number): CommandContext {
  const text: string[] = [];
  const own = s.lines[line - 1] ?? '';
  text.push(own);

  const open = s.opener.get(line);
  let anchor = line;
  if (open !== undefined) {
    anchor = open;
    for (let n = line - 1; n > open; n--) {
      const above = s.lines[n - 1]!.trim();
      if (!above.startsWith('#')) break;
      text.push(above);
    }
    // The blank lines between an introducing sentence and its block do not break the link.
    let intro = open - 1;
    while (intro >= 1 && s.lines[intro - 1]!.trim() === '') intro--;
    text.push(...paragraphEndingAt(s, intro, 4));
  } else if (!LIST_ITEM_RE.test(own) && !isHeadingLine(s, line)) {
    text.push(...paragraphEndingAt(s, line - 1, 3));
  }

  const heading = nearestHeading(s, anchor);
  if (heading !== undefined) text.push(s.lines[heading - 1]!);
  if (isHeadingLine(s, line)) {
    let started = false;
    for (let n = line + 1; n <= s.lines.length && n <= line + 8; n++) {
      if (s.inFence[n - 1] || isHeadingLine(s, n)) break;
      const below = s.lines[n - 1]!;
      if (below.trim() === '') {
        if (started) break;
        continue;
      }
      started = true;
      text.push(below);
    }
  }

  const joined = text.join('\n');
  return { text, explicitRoot: ROOT_RE.test(joined), cautionary: CAUTION_RE.test(joined) };
}

/**
 * A backticked token, a bare token ending in `/`, or the argument of `cd`: the
 * ways prose names a directory. A bare `dir/` that runs into a word (`site/index.html`)
 * or a glob (`packages/*`) is a path, not a directory name.
 */
const DIR_TOKEN_RE =
  /`([^`\s]+)`|(?<![\w./@-])((?:\.{1,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\/)(?![\w@.*?[{-])|\bcd\s+(?:\.\/)?([\w@.-]+(?:\/[\w@.-]+)*)/g;
const NOT_A_DIR_RE = /[*?<>{}[\]$~%\\]/;
const MAX_TOKENS = 24;

/** Candidate directory names in `texts`, in order, without duplicates. They are claims about the text, not yet checked against the repository. */
export function directoryTokens(texts: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const text of texts) {
    for (const m of text.matchAll(DIR_TOKEN_RE)) {
      const token = (m[1] ?? m[2] ?? m[3] ?? '').replace(/^\.\//, '').replace(/\/+$/, '');
      if (!token || token === '.' || NOT_A_DIR_RE.test(token)) continue;
      seen.add(token);
      if (seen.size >= MAX_TOKENS) return [...seen];
    }
  }
  return [...seen];
}
