/**
 * What the text around a documented command says about where and how it is run
 * (pcic-1ik0.2, issue #157).
 *
 * A script the root manifest lacks is often defined in the package the text
 * points at ("From `packages/docs/`:", a "Site (from `site/` directory)"
 * heading). The text that counts is narrow on purpose: the command's own line,
 * the sentence or list lead-in that introduces it, the `#` comment lines above
 * it in its block, and the nearest heading. Anything wider silences real
 * findings.
 *
 * Whether a script rewrite may be applied unseen is a different question and is
 * default-deny: see `cautionary` and the single-package rule in command-validity.ts.
 *
 * Pure text work: nothing here touches the filesystem. The detector resolves the
 * directory tokens against the repository.
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

const ATX_RE = /^ {0,3}(#{1,6})(?:\s|$)/;
const SETEXT_UNDERLINE_RE = /^ {0,3}(=+|-{2,})\s*$/;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s/;

/** The level (1-6) of the heading at line `n`: ATX, or the text line above a setext underline. Never inside a fence. */
function headingLevel(s: LineStructure, n: number): number | undefined {
  if (n < 1 || n > s.lines.length || s.inFence[n - 1]) return undefined;
  const text = s.lines[n - 1]!;
  const atx = ATX_RE.exec(text);
  if (atx) return atx[1]!.length;
  if (text.trim() === '' || LIST_ITEM_RE.test(text) || /^\s*>/.test(text)) return undefined;
  const next = s.lines[n];
  if (next === undefined || s.inFence[n]) return undefined;
  const underline = SETEXT_UNDERLINE_RE.exec(next);
  return underline ? (underline[1]!.startsWith('=') ? 1 : 2) : undefined;
}

/** Whether line `n` (1-based) is a heading. */
export function isHeadingLine(s: LineStructure, n: number): boolean {
  return headingLevel(s, n) !== undefined;
}

/** The nearest heading at or above line `n`, as a line number. */
export function nearestHeading(s: LineStructure, n: number): number | undefined {
  for (let i = Math.min(n, s.lines.length); i >= 1; i--) if (isHeadingLine(s, i)) return i;
  return undefined;
}

/** The nearest heading at or above line `n` and every heading above it of a lower level (its parents), nearest first. */
export function headingChain(s: LineStructure, n: number): number[] {
  const chain: number[] = [];
  let level = 7;
  for (let i = Math.min(n, s.lines.length); i >= 1 && level > 1; i--) {
    const l = headingLevel(s, i);
    if (l !== undefined && l < level) {
      chain.push(i);
      level = l;
    }
  }
  return chain;
}

/** Straight quotes in place of the curly ones, so a marker is found whichever apostrophe the author typed. */
export function normalizeQuotes(text: string): string {
  return text.replace(/[‘’ʼ′]/g, "'").replace(/[“”]/g, '"');
}

export type CommandContext = {
  /**
   * Text that may name the directory the command runs from: its own line, the
   * paragraph or list lead-in that introduces it, the comment lines above it in
   * its block, the nearest heading (for a command written in a heading, the
   * paragraph under it), the list items that enclose it, a `<details>` summary and
   * a table's header row.
   */
  text: string[];
  /**
   * A cautionary or negating marker anywhere that frames the command: its whole heading chain, whole block
   * or paragraph, every enclosing list item, its table row and header, an enclosing blockquote or
   * `<details>` summary, or a trailing comment on its own line. Wide on purpose (non-English cautions
   * are a known gap).
   */
  cautionary: boolean;
  /**
   * The command's own sentence, or the sentence that introduces its block, says
   * un-negated that it runs at the repository root and names no directory itself.
   * A directory named in the same sentence wins over a root phrase.
   */
  explicitRoot: boolean;
};

const ROOT_RE =
  /\b(?:at|in|from|on|under)\s+(?:the\s+)?(?:(?:repo(?:sitory)?|project|workspace|monorepo)\s+)?root\b|\b(?:repo(?:sitory)?|project|workspace|monorepo)\s+root\b|\broot\s+(?:directory|folder|of\s+(?:the\s+)?(?:repo(?:sitory)?|project|monorepo))\b/i;
const NEGATION_RE = /\b(?:not|never|without|instead\s+of|rather\s+than|other\s+than|except|unlike)\b|n't\b/i;
/** Words and marks that say a command is shown as something not to do. Applied to text with straight quotes. */
const CAUTION_RE =
  /\b(?:don'?t|do\s+not|doesn'?t|never|avoid|wrong|bad|incorrect|invalid|broken|deprecated|outdated|obsolete|legacy|old|removed|renamed|anti-?pattern|typo|mistakes?|warning|should\s+not|shouldn'?t|must\s+not|can'?t|cannot|fails?|failing|instead\s+of|no\s+longer|not\s+(?:this|that|like\s+this|recommended|to))\b|[❌✗✘✖⚠\u{1f6ab}⛔]|~~|<\/?(?:del|s|strike)>|\bbefore\s*:/iu;

/** Up to `max` contiguous non-blank, non-heading, non-fence lines ending at line `from` (1-based). */
function paragraphEndingAt(s: LineStructure, from: number, max: number): string[] {
  const out: string[] = [];
  for (let n = from; n >= 1 && out.length < max; n--) {
    if (s.inFence[n - 1] || isHeadingLine(s, n) || s.lines[n - 1]!.trim() === '') break;
    out.unshift(s.lines[n - 1]!);
  }
  return out;
}

/** The sentence that introduces the list a list item belongs to: the paragraph above the list, past its other items. */
function listLeadIn(s: LineStructure, line: number): string[] {
  for (let n = line - 1; n >= 1 && line - n <= 40; n--) {
    if (s.inFence[n - 1] || isHeadingLine(s, n)) return [];
    const text = s.lines[n - 1]!;
    if (text.trim() === '' || LIST_ITEM_RE.test(text) || /^\s{2,}\S/.test(text)) continue;
    return paragraphEndingAt(s, n, 3);
  }
  return [];
}

function indentOf(text: string): number {
  return /^\s*/.exec(text)![0].replace(/\t/g, '    ').length;
}

/** The list items that enclose line `from` (a list item, or a line or block nested under one), nearest first. */
function ancestorListItems(s: LineStructure, from: number): string[] {
  const out: string[] = [];
  let indent = indentOf(s.lines[from - 1] ?? '');
  for (let n = from - 1; n >= 1 && from - n <= 200 && indent > 0; n--) {
    if (s.inFence[n - 1] || isHeadingLine(s, n)) continue;
    const text = s.lines[n - 1]!;
    if (LIST_ITEM_RE.test(text) && indentOf(text) < indent) {
      out.push(text);
      indent = indentOf(text);
    }
  }
  return out;
}

/** Contiguous lines around `line` that satisfy `keep`, up to 60 each way (a table, a blockquote). */
function runOfLines(s: LineStructure, line: number, keep: (text: string) => boolean): string[] {
  let first = line;
  while (first > 1 && line - first < 60 && keep(s.lines[first - 2]!)) first--;
  let last = line;
  while (last < s.lines.length && last - line < 60 && keep(s.lines[last]!)) last++;
  return s.lines.slice(first - 1, last);
}

/** The `<summary>` text of the `<details>` element that encloses line `from`, if any. */
function enclosingSummary(s: LineStructure, from: number): string[] {
  let depth = 0;
  for (let n = from - 1; n >= 1 && from - n <= 300; n--) {
    const text = s.lines[n - 1]!;
    if (/<\/details>/i.test(text)) depth++;
    if (/<details\b/i.test(text)) {
      if (depth > 0) {
        depth--;
        continue;
      }
      const block = s.lines.slice(n - 1, Math.min(s.lines.length, n + 6)).join('\n');
      return /<summary[\s\S]*?<\/summary>/i.exec(block)?.slice(0, 1) ?? [text];
    }
  }
  return [];
}

/** Splits text into sentences (and colon clauses); a terminator counts only before whitespace or the end. */
export function sentencesOf(text: string): string[] {
  return (text.match(/[^.!?;:]+(?:[.!?;:]+(?=\s|$)|$)/g) ?? [text]).map((x) => x.trim()).filter(Boolean);
}

/** The sentence of `lineText` that holds `command` (the whole line when it is not found in it). */
function sentenceHolding(lineText: string, command: string): string {
  const at = lineText.indexOf(command);
  if (at === -1) return lineText;
  let cursor = 0;
  for (const raw of lineText.match(/[^.!?;:]+(?:[.!?;:]+(?=\s|$)|$)/g) ?? [lineText]) {
    const end = cursor + raw.length;
    if (at < end) return raw.trim();
    cursor = end;
  }
  return lineText;
}

/**
 * The text that frames the command at `line` (1-based; `command` is its text).
 * `namesDirectory` says whether a piece of text names an existing directory.
 */
export function commandContext(
  s: LineStructure,
  line: number,
  command: string,
  namesDirectory: (text: string) => boolean,
): CommandContext {
  const own = s.lines[line - 1] ?? '';
  const text: string[] = [own];
  const open = s.opener.get(line);
  const rootCandidates: string[] = [];
  let anchor = line;
  let introduction: string[] = [];

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
    introduction = paragraphEndingAt(s, intro, 4);
  } else if (LIST_ITEM_RE.test(own)) {
    introduction = listLeadIn(s, line);
    rootCandidates.push(sentenceHolding(own, command));
  } else if (!isHeadingLine(s, line)) {
    introduction = paragraphEndingAt(s, line - 1, 3);
    rootCandidates.push(sentenceHolding(own, command));
  }
  text.push(...introduction);
  // What encloses the command: the list items it sits under, a <details> summary, a table's header row.
  const around: string[] = [...ancestorListItems(s, anchor), ...enclosingSummary(s, anchor)];
  if (own.includes('|') && open === undefined) {
    const table = runOfLines(s, line, (t) => t.includes('|'));
    around.push(...table.slice(0, 2));
  }
  text.push(...around);
  const lastIntroSentence = sentencesOf(introduction.join(' ')).pop();
  if (lastIntroSentence) rootCandidates.push(lastIntroSentence);

  const headingLines = headingChain(s, anchor);
  const nearest = headingLines[0];
  if (nearest !== undefined) {
    text.push(s.lines[nearest - 1]!);
    rootCandidates.push(s.lines[nearest - 1]!);
  }
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
      const first = sentencesOf(below)[0];
      if (first) rootCandidates.push(first);
    }
  }

  // Caution is wide on purpose (RULE 2): the whole block, paragraph, table, blockquote and every ancestor heading.
  const scope: string[] = [...text, ...headingLines.map((n) => s.lines[n - 1]!)];
  if (open !== undefined) {
    scope.push(s.lines[open - 1]!);
    let n = open + 1;
    while (n <= s.lines.length && s.opener.get(n) === open) scope.push(s.lines[n++ - 1]!);
    if (n <= s.lines.length && s.inFence[n - 1]) scope.push(s.lines[n - 1]!);
  } else if (!isHeadingLine(s, line)) {
    scope.push(...paragraphEndingAt(s, line, 30));
    for (let n = line + 1; n <= s.lines.length && n <= line + 30; n++) {
      if (s.inFence[n - 1] || isHeadingLine(s, n) || s.lines[n - 1]!.trim() === '') break;
      scope.push(s.lines[n - 1]!);
    }
  }
  if (/^\s*>/.test(own)) scope.push(...runOfLines(s, line, (t) => /^\s*>/.test(t)));
  if (own.includes('|') && open === undefined) scope.push(...runOfLines(s, line, (t) => t.includes('|')));
  const cautionary = CAUTION_RE.test(normalizeQuotes(scope.join('\n')));
  const explicitRoot = rootCandidates.some((sentence) => {
    const plain = normalizeQuotes(sentence);
    return ROOT_RE.test(plain) && !NEGATION_RE.test(plain) && !namesDirectory(sentence);
  });
  return { text, cautionary, explicitRoot };
}

/**
 * A backticked token, a bare token ending in `/`, or the argument of `cd`: the
 * ways prose names a directory. A bare `dir/` that runs into a word (`site/index.html`)
 * or a glob (`packages/*`) is a path, not a directory name.
 */
const DIR_TOKEN_RE =
  /`([^`\s]+)`|(?<![\w./@-])((?:\.{1,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\/)(?![\w@.*?[{-])|\bcd\s+(?:\.\/)?([\w@.-]+(?:\/[\w@.-]+)*)|\b(?:from|in|inside|under|within|into)\s+(?:the\s+)?([\w@.-]+(?:\/[\w@.-]+)*)/gi;
const NOT_A_DIR_RE = /[*?<>{}[\]$~%\\]/;
const MAX_TOKENS = 24;

/** Candidate directory names in `texts`, in order, without duplicates. They are claims about the text, not yet checked against the repository. */
export function directoryTokens(texts: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const text of texts) {
    for (const m of text.matchAll(DIR_TOKEN_RE)) {
      const token = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').replace(/^\.\//, '').replace(/\/+$/, '');
      if (!token || token === '.' || NOT_A_DIR_RE.test(token)) continue;
      seen.add(token);
      if (seen.size >= MAX_TOKENS) return [...seen];
    }
  }
  return [...seen];
}
