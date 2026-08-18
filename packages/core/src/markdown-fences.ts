/**
 * The one CommonMark fenced-code-block scanner.
 *
 * This walk was independently reimplemented in eleven files (scanner.ts,
 * conflicts.ts, vague-guidance.ts, stale-instructions.ts, suppression.ts,
 * agent-practices.ts, missing-context.ts, command-validity.ts,
 * dead-references.ts, manifest-consistency.ts, product-boundary.ts). The
 * copies diverged: each carried its own bug-ID comment for a fix applied to
 * that copy alone, the same `~~~`-fence bug was found and fixed five separate
 * times, and dead-references.ts never got `~~~` support at all. Every future
 * fence bug should be fixable once, here.
 *
 * The rules all the copies were converging on, kept in one place:
 *
 * - A fence opens on ``` or ~~~ (3+ of the same character), indented at most
 *   3 spaces.
 * - A fence closes only on the SAME character, at least as long as the
 *   opener, with nothing but whitespace after it. ``` does not close ~~~, and
 *   a 3-backtick line does not close a 4-backtick block.
 * - An unclosed fence runs to the end of the text. Callers that only want
 *   confirmed blocks can check `closed`.
 *
 * Lines keep their exact original text, carriage returns included, so callers
 * that map offsets back to the source file stay aligned.
 */

/** Opening fence: up to 3 spaces of indent, then 3+ backticks or tildes. */
const OPEN_FENCE_RE = /^ {0,3}([`~]{3,})\s*([^\s`]*)/;

/** Closing fence: same shape, but nothing except whitespace may follow. */
const CLOSE_FENCE_RE = /^ {0,3}([`~]{3,})\s*$/;

/** Inline code span: a backtick run, content, then a matching run. */
const INLINE_CODE_RE = /(`+)([^`]+)\1/g;

export type FenceLineKind =
  /** Outside any fenced block. */
  | 'text'
  /** The opening fence line itself. */
  | 'open'
  /** A line of block content. */
  | 'content'
  /** The closing fence line itself. */
  | 'close';

export type FenceLine = {
  /** The line's exact original text, without its terminator. */
  text: string;
  /** 1-based physical line number in the source content. */
  lineNumber: number;
  kind: FenceLineKind;
  /** True for every line belonging to a fenced block, fence markers included. */
  inFence: boolean;
  /**
   * Lowercased info string of the enclosing block's opening fence — `'bash'`
   * for ```` ```bash ````, `''` for a bare fence or a line outside any block.
   */
  lang: string;
  /** False for the lines of a trailing block that is never closed. */
  closed: boolean;
};

export type FencedBlock = {
  /** Lowercased info string of the opening fence (`''` when bare). */
  lang: string;
  /** False when the block runs to the end of the text with no closing fence. */
  closed: boolean;
  /** 1-based line number of the opening fence. */
  openLine: number;
  /** 1-based line number of the block's first content line. */
  contentStartLine: number;
  /** The block's content lines, fence markers excluded. */
  lines: string[];
};

/**
 * Classify every line of `content` as inside or outside a fenced code block.
 *
 * The primitive the rest of this module — and every caller that needs a
 * per-line decision, like "is this `#` a heading or a bash comment?" — is
 * built on.
 */
export function scanFencedLines(content: string): FenceLine[] {
  const rawLines = content.split('\n');
  const result: FenceLine[] = [];

  let inBlock = false;
  let fenceChar: string | null = null;
  let fenceLen = 0;
  let lang = '';
  /** Index in `result` where the open block started, for the unclosed fixup. */
  let blockStart = -1;

  for (let i = 0; i < rawLines.length; i++) {
    const text = rawLines[i] ?? '';
    const lineNumber = i + 1;

    if (!inBlock) {
      const openMatch = OPEN_FENCE_RE.exec(text);
      if (openMatch) {
        inBlock = true;
        fenceChar = openMatch[1]![0] ?? null;
        fenceLen = openMatch[1]!.length;
        lang = (openMatch[2] ?? '').toLowerCase();
        blockStart = result.length;
        result.push({ text, lineNumber, kind: 'open', inFence: true, lang, closed: true });
        continue;
      }
      result.push({ text, lineNumber, kind: 'text', inFence: false, lang: '', closed: true });
      continue;
    }

    const closeMatch = CLOSE_FENCE_RE.exec(text);
    if (closeMatch && closeMatch[1]![0] === fenceChar && closeMatch[1]!.length >= fenceLen) {
      result.push({ text, lineNumber, kind: 'close', inFence: true, lang, closed: true });
      inBlock = false;
      fenceChar = null;
      fenceLen = 0;
      lang = '';
      blockStart = -1;
      continue;
    }

    result.push({ text, lineNumber, kind: 'content', inFence: true, lang, closed: true });
  }

  // A fence that never closes still swallows the rest of the text — but its
  // lines are marked unclosed so callers counting confirmed blocks can skip it.
  if (inBlock && blockStart >= 0) {
    for (let i = blockStart; i < result.length; i++) {
      result[i]!.closed = false;
    }
  }

  return result;
}

/** Group `content` into its fenced code blocks, in document order. */
export function fencedBlocks(content: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  let current: FencedBlock | null = null;

  for (const line of scanFencedLines(content)) {
    if (line.kind === 'open') {
      current = {
        lang: line.lang,
        closed: line.closed,
        openLine: line.lineNumber,
        contentStartLine: line.lineNumber + 1,
        lines: [],
      };
      blocks.push(current);
      continue;
    }
    if (line.kind === 'content' && current) {
      current.lines.push(line.text);
      continue;
    }
    if (line.kind === 'close') {
      current = null;
    }
  }

  return blocks;
}

export type StripOptions = {
  /**
   * Also remove inline `code spans`. Off by default: most callers strip
   * fences to avoid reading a quoted example as a live instruction, and an
   * inline span is usually still part of the sentence around it.
   */
  stripInlineCode?: boolean;
};

/**
 * Remove fenced code blocks — markers and content both — from `content`.
 *
 * Line numbers do NOT survive this; use `blankCodeBlockLines` when the caller
 * maps offsets back to the source file.
 */
export function stripCodeBlocks(content: string, options: StripOptions = {}): string {
  const kept = scanFencedLines(content)
    .filter((line) => !line.inFence)
    .map((line) => line.text)
    .join('\n');

  return options.stripInlineCode ? kept.replace(/`[^`\n]+`/g, '') : kept;
}

/**
 * Blank out fenced code block lines while keeping the line count identical, so
 * offsets computed against the result still map to the original file's lines.
 */
export function blankCodeBlockLines(content: string): string {
  return scanFencedLines(content)
    .map((line) => (line.inFence ? '' : line.text))
    .join('\n');
}

/**
 * The content of every fenced block, joined with newlines.
 *
 * `closedOnly` (the default) drops a trailing unclosed fence's partial
 * content — a caller asking "does this file document a setup command?" wants
 * confirmed blocks, not the tail of a malformed one.
 */
export function fencedBlockContents(
  content: string,
  options: { closedOnly?: boolean } = {},
): string {
  const closedOnly = options.closedOnly ?? true;
  return fencedBlocks(content)
    .filter((block) => (closedOnly ? block.closed : true))
    .map((block) => block.lines.join('\n'))
    .join('\n');
}

/**
 * Mark every character of `content` that sits inside a fenced block or an
 * inline `code span`.
 *
 * Callers use this to tell a command from a noun phrase: `pnpm 9+` in prose is
 * a version requirement, the same text in backticks is something a reader is
 * meant to run.
 */
export function buildCodeMask(content: string): boolean[] {
  const mask = new Array<boolean>(content.length).fill(false);
  let offset = 0;

  for (const line of scanFencedLines(content)) {
    if (line.inFence) {
      mask.fill(true, offset, offset + line.text.length);
    } else {
      let span: RegExpExecArray | null;
      const spanRe = new RegExp(INLINE_CODE_RE.source, INLINE_CODE_RE.flags);
      while ((span = spanRe.exec(line.text)) !== null) {
        mask.fill(true, offset + span.index, offset + span.index + span[0].length);
      }
    }
    offset += line.text.length + 1;
  }

  return mask;
}
