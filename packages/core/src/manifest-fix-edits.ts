/**
 * Line-anchored fix edits (pcic-oonz `fixEdits`) for the manifest-consistency
 * findings whose repair the manifest itself dictates (pcic-k1t3.12):
 *
 * - a package-manager mismatch: `npm run build` in a pnpm repository becomes
 *   `pnpm run build`, a bare `npm install` becomes `pnpm install`;
 * - a stale runtime or library version: "Requires Node.js 18+" becomes
 *   "Requires Node.js 22+" when `engines.node` says `>=22`.
 *
 * Every planner here is all-or-nothing and leans toward "no edit": a finding
 * gets edits only when EVERY mention behind it can be rewritten without a
 * judgement call, the edits apply cleanly (the fix engine's own
 * {@link applyLineEditsToText}), and the rewritten text no longer raises the
 * finding. Anything else keeps the finding advisory, as before. A missed edit
 * costs a human a minute; a wrong automatic one lands in a stranger's
 * repository.
 */

import type { FixEdit, InstructionFile } from './types.js';
import { applyLineEditsToText } from './line-edits.js';
import { scanFencedLines } from './markdown-fences.js';
import { htmlCommentRanges, inRanges, indentedCodeLines } from './sample-text.js';

/**
 * Most edits one finding may carry. The hosted service drops a longer list
 * whole (`MAX_FIX_EDITS_PER_ISSUE` there), so a longer one would only be a
 * finding advertised as fixable that nothing fixes.
 */
export const MAX_RECIPE_EDITS = 50;

/**
 * Longest line a recipe edits. A longer one (a minified blob, a hostile file) keeps its finding
 * advisory, and every regex below only ever sees a line this long, or a frame of a few of them
 * ({@link MAX_FRAME_LENGTH}).
 */
export const MAX_EDIT_LINE_LENGTH = 2000;

/** Longest heading chain or lead (see {@link LineIndex.framing}) a recipe reads before it refuses. */
const MAX_FRAME_LENGTH = 4 * MAX_EDIT_LINE_LENGTH;

/**
 * Line facts the planners read for every hit or mention in one file, computed once per file: a
 * line number by binary search, and each line's frame (see {@link LineIndex.framing}) by following
 * precomputed links. Walking back through the file for every hit, as this used to, was quadratic
 * in a hostile file of a few hundred mentions spread over hundreds of thousands of lines.
 */
export interface LineIndex {
  /** 1-based line number of character `offset`, as `lineNumberAt` (line-edits.ts) counts it. */
  lineOf(offset: number): number;
  /**
   * The lines that frame line `lineNo` (1-based): every ancestor heading above
   * it (outside fenced blocks: the nearest one, then each shallower one up to the
   * top), and up to three non-blank lines before it (or before the opening fence
   * when it is inside a fenced block), back to the nearest heading. "If pnpm is
   * not available, use npm:" above a fence, or a "## Legacy npm workflow" heading
   * over a "### Build" section, changes what the line below says.
   */
  framing(lineNo: number): { heading: string; lead: string };
}

const FRAME_HEADING_RE = /^\s{0,3}(#{1,6})\s/;

/** Exported for tests. */
export function indexLines(content: string, fence: ReturnType<typeof scanFencedLines>): LineIndex {
  const lines = content.split('\n').map((l) => l.replace(/\r$/, ''));
  const starts = [0];
  for (let at = content.indexOf('\n'); at !== -1; at = content.indexOf('\n', at + 1)) starts.push(at + 1);
  const count = lines.length;
  /** For a fenced line, the line its fence opened on (0 when no opener precedes it). */
  const openOf = new Int32Array(count);
  /** A fenced line or a heading: where the walk for lead lines stops. */
  const stopsLead = new Uint8Array(count);
  /** The nearest earlier line that is non-blank or stops the lead walk, or -1. */
  const prevLead = new Int32Array(count);
  /** The nearest earlier heading outside a fence, or -1. */
  const nearestHeading = new Int32Array(count);
  /** For a heading, the nearest earlier heading of a shallower level, or -1. */
  const parentHeading = new Int32Array(count).fill(-1);
  const stack: Array<{ level: number; line: number }> = [];
  let lastOpen = 0;
  let lastLead = -1;
  for (let i = 0; i < count; i++) {
    if (fence[i]?.kind === 'open') lastOpen = i;
    openOf[i] = lastOpen;
    prevLead[i] = lastLead;
    nearestHeading[i] = stack.length > 0 ? stack[stack.length - 1]!.line : -1;
    const inFence = fence[i]?.inFence === true;
    const heading = inFence ? null : FRAME_HEADING_RE.exec(lines[i]!);
    if (inFence || heading) stopsLead[i] = 1;
    if (stopsLead[i] || lines[i]!.trim() !== '') lastLead = i;
    if (heading) {
      const level = heading[1]!.length;
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
      parentHeading[i] = stack.length > 0 ? stack[stack.length - 1]!.line : -1;
      stack.push({ level, line: i });
    }
  }
  return {
    lineOf(offset) {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid]! <= offset) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    },
    framing(lineNo) {
      let anchor = lineNo - 1;
      if (fence[anchor]?.inFence) anchor = openOf[anchor]!;
      // Up to three non-blank lines back, stopping at a heading or a fenced block: a lead such as
      // "Then:" carries no meaning of its own, the paragraph above it may ("build with npm").
      const leads: string[] = [];
      for (let i = prevLead[anchor]!; i >= 0 && leads.length < 3 && !stopsLead[i]; i = prevLead[i]!) leads.push(lines[i]!);
      const headings: string[] = [];
      for (let i = nearestHeading[anchor]!; i >= 0; i = parentHeading[i]!) headings.push(lines[i]!);
      return { heading: headings.join('\n'), lead: leads.join('\n') };
    },
  };
}

/**
 * What the planners read about one file (its fences, indented code lines, HTML comments and line
 * index), each computed on first use and kept while the file's content is unchanged. A file can
 * carry a finding per stale version and per check; recomputing these for every one of them was
 * most of what a long hostile file cost.
 */
class FileFacts {
  private fenceLines: ReturnType<typeof scanFencedLines> | undefined;
  private indentedLines: boolean[] | undefined;
  private commentRanges: Array<[number, number]> | undefined;
  private lineIndex: LineIndex | undefined;

  constructor(readonly content: string) {}

  get fence(): ReturnType<typeof scanFencedLines> {
    if (this.fenceLines === undefined) this.fenceLines = scanFencedLines(this.content);
    return this.fenceLines;
  }

  get indented(): boolean[] {
    if (this.indentedLines === undefined) this.indentedLines = indentedCodeLines(this.content);
    return this.indentedLines;
  }

  get comments(): Array<[number, number]> {
    if (this.commentRanges === undefined) this.commentRanges = htmlCommentRanges(this.content);
    return this.commentRanges;
  }

  get index(): LineIndex {
    if (this.lineIndex === undefined) this.lineIndex = indexLines(this.content, this.fence);
    return this.lineIndex;
  }
}

const FILE_FACTS = new WeakMap<InstructionFile, FileFacts>();

function factsOf(file: InstructionFile): FileFacts {
  let facts = FILE_FACTS.get(file);
  if (facts === undefined || facts.content !== file.content) FILE_FACTS.set(file, (facts = new FileFacts(file.content)));
  return facts;
}

/** The text of the line holding `offset`, without its terminator, and where it starts. */
function lineAround(content: string, offset: number): { start: number; text: string } {
  const start = content.lastIndexOf('\n', offset - 1) + 1;
  const end = content.indexOf('\n', offset);
  return { start, text: content.slice(start, end === -1 ? undefined : end).replace(/\r$/, '') };
}

/**
 * `edits` when, for every file they touch, they apply cleanly to its content
 * exactly as the fix engine applies them, change it, and leave text that
 * `resolved` accepts; otherwise undefined.
 */
function checkedEdits(
  files: readonly InstructionFile[],
  edits: FixEdit[],
  resolved: (file: InstructionFile, newContent: string) => boolean,
): FixEdit[] | undefined {
  if (edits.length === 0 || edits.length > MAX_RECIPE_EDITS) return undefined;
  const touched = new Set(edits.map((e) => e.filePath));
  for (const filePath of touched) {
    const file = files.find((f) => f.path === filePath);
    if (!file) return undefined;
    const next = applyLineEditsToText(
      file.content,
      edits.filter((e) => e.filePath === filePath),
    );
    if (next === undefined || next === file.content || !resolved(file, next)) return undefined;
  }
  return edits;
}

// ── Package-manager mismatch ────────────────────────────────────────────────

/** One command-like mention of another package manager that the mismatch check counted. */
export type PackageManagerHit = {
  file: InstructionFile;
  /** Offset of the match in `file.content`. */
  index: number;
  /** The matched text, such as `npm run` or `yarn install`. */
  text: string;
};

/** After a bare install: the end of the line, of the code span, or of the command. */
const BARE_INSTALL_END = /^\s*(?:$|[`'")&;|#,]|\.(?:\s|$))/;

/**
 * Fenced blocks whose commands are shell commands a reader types. A command in
 * any other block is part of a file the example shows (a Dockerfile, a CI
 * workflow, a package.json), where the image or runner may not have the other
 * manager; rewriting it changes that file, not an instruction.
 */
const SHELL_FENCE_LANGS: ReadonlySet<string> = new Set([
  '', 'sh', 'bash', 'shell', 'zsh', 'fish', 'console', 'terminal', 'shellsession', 'shell-session', 'sh-session',
  'powershell', 'ps1', 'pwsh', 'cmd', 'bat', 'batch', 'text', 'txt', 'plaintext',
]);

/**
 * A line that contrasts managers or offers this command as a fallback ("if pnpm
 * is unavailable, fall back to `npm run build`", "Windows users can run ..."):
 * the other manager is deliberate there.
 */
const LEGACY_WORDING = /\b(?:legacy|old(?:er)?|deprecated|migrat\w*|previous(?:ly)?|without)\b/i;

/**
 * Wording that addresses someone installing or using the package in THEIR
 * project ("To use this library in your own project, run `npm install`"): the
 * manager there is the reader's, not this repository's.
 */
const CONSUMER_WORDING =
  /\b(?:your\s+(?:own\s+)?(?:project|app(?:lication)?|repo(?:sitory)?|codebase|package)|in\s+your\b|consumers?|end\s+users?|to\s+use\s+this\s+(?:library|package|plugin|module|sdk)|install\s+(?:this|the)\s+(?:package|library|plugin|module|sdk))/i;

/**
 * A command run from another directory: `cd site && npm run build`, `(cd docs)`,
 * "Inside `website/`, run ...", `npm --prefix site run build`.
 */
const OTHER_DIRECTORY =
  /\bcd\s+\S+\s*(?:&&|;)|\b(?:inside|in)\s+`?[\w./-]+\/`?|(?:^|\s)(?:--prefix|--cwd|-C|--dir|--filter|--workspace|-w)(?=[\s=]|$)/i;

/** Where a subshell `(cd <dir> ...)` can start: the rest is checked by {@link runsInOtherDirectory}. */
const SUBSHELL_CD_START = /\(cd\s[^)]/i;

/**
 * {@link OTHER_DIRECTORY}, or a subshell `(cd docs && npm run build)`. The subshell is found by hand
 * (an opener, then any `)` after it), not with `\(cd\s+[^)]+\)`: that regex rescans to the end of
 * the text from every `(cd` and backtracks between its two runs, quadratic on a hostile line.
 */
function runsInOtherDirectory(text: string): boolean {
  if (OTHER_DIRECTORY.test(text)) return true;
  const open = SUBSHELL_CD_START.exec(text);
  return open !== null && text.lastIndexOf(')') > open.index + 4;
}

const ALTERNATIVE_WORDING =
  /\b(?:fall(?:\s*|-)back|alternative(?:ly)?|otherwise|instead|unavailable|not\s+installed|if\s+you\s+(?:use|prefer|have|don'?t)|windows|users?\s+(?:can|may|of|on|who))\b/i;

/**
 * The edits that switch every counted mention to `preferred`, or undefined
 * when any one of them is not a plain swap:
 *
 * - `<pm> run <script>` becomes `<preferred> run <script>` when the repository
 *   defines `<script>` (root or workspace manifest) and the command passes no
 *   flag after it: package managers differ on which flags reach the script.
 * - a bare `<pm> install` or `<pm> i` becomes `<preferred> install`. An install
 *   that names a package (`npm install eslint-plugin-x`) is the README telling
 *   a CONSUMER how to install the package, with whatever manager they use, and
 *   is never rewritten; neither is one with a flag.
 * - `add`, `exec` and `dlx` are never rewritten: their arguments and
 *   semantics differ between managers.
 *
 * A mention inside an HTML comment (text no reader sees), in a fenced block
 * that is not a shell session ({@link SHELL_FENCE_LANGS}), on a line holding a
 * link, run from another directory ({@link OTHER_DIRECTORY}), or that would
 * still name the old manager after the swap, or where the line, its lead lines
 * or an ancestor heading names another manager or reads as an alternative or
 * consumer instruction ({@link ALTERNATIVE_WORDING}, {@link CONSUMER_WORDING})
 * refuses too. `stillOffends` re-runs the check on the rewritten text: the
 * edits must leave nothing behind for the finding to report.
 */
export function packageManagerSwapEdits(
  files: readonly InstructionFile[],
  hits: readonly PackageManagerHit[],
  preferred: string,
  scriptDefined: (name: string) => boolean,
  stillOffends: (file: InstructionFile, newContent: string) => boolean,
): FixEdit[] | undefined {
  // Every hit becomes exactly one edit or refuses them all, so more hits than an edit list may hold
  // refuse up front, before the per-hit work below (quadratic in the hit count) runs.
  if (hits.length > MAX_RECIPE_EDITS) return undefined;
  const edits: FixEdit[] = [];
  const managers = /\b(?:npm|pnpm|yarn|bun)\b/gi;
  const ordered = [...hits].sort((a, b) =>
    a.file.path === b.file.path ? a.index - b.index : a.file.path < b.file.path ? -1 : 1,
  );
  const lineOf = new Map(ordered.map((h) => [h, factsOf(h.file).index.lineOf(h.index)] as const));
  for (const hit of ordered) {
    const { file, index, text } = hit;
    const m = /^(npm|yarn|pnpm|bun) (install|i|run)$/.exec(text);
    if (!m || m[1] === preferred) return undefined;
    const facts = factsOf(file);
    if (inRanges(facts.comments, index)) return undefined;
    const lineNo = lineOf.get(hit)!;
    const fenceLine = facts.fence[lineNo - 1];
    if (fenceLine?.inFence && !SHELL_FENCE_LANGS.has(fenceLine.lang)) return undefined;

    const { start, text: lineText } = lineAround(file.content, index);
    if (lineText.length > MAX_EDIT_LINE_LENGTH) return undefined;
    if (ALTERNATIVE_WORDING.test(lineText) || CONSUMER_WORDING.test(lineText)) return undefined;
    if (runsInOtherDirectory(lineText) || LINK_OR_URL.test(lineText)) return undefined;
    // After the swap the line must not still name the old manager (`npm install && npm test`
    // would read `pnpm install && npm test`): every mention of it on the line must be a hit.
    const onLine = ordered.filter((h) => h.file === file && lineOf.get(h) === lineNo).length;
    if ((lineText.match(new RegExp(`\\b${m[1]}\\b`, 'gi')) ?? []).length !== onLine) return undefined;
    // Every manager named on the line must be this one: `pnpm` beside `npm run` is a contrast.
    if ((lineText.match(managers) ?? []).some((name) => name.toLowerCase() !== m[1])) return undefined;
    // The same holds for the line that introduces it and the section it sits in.
    const { heading, lead } = facts.index.framing(lineNo);
    for (const frame of [heading, lead]) {
      if (frame.length > MAX_FRAME_LENGTH) return undefined;
      if (ALTERNATIVE_WORDING.test(frame) || LEGACY_WORDING.test(frame) || CONSUMER_WORDING.test(frame)) return undefined;
      if (runsInOtherDirectory(frame)) return undefined;
      // A frame that names the old manager itself ("## Using npm", "Install with npm:") means it on
      // purpose. Commands on it (a previous step, `npm install`) are not that: they are hits too.
      const words = frame.replace(/\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|run|exec|dlx|i)\b/gi, '');
      if ((words.match(managers) ?? []).some((name) => name.toLowerCase() !== preferred)) return undefined;
    }
    const rest = lineText.slice(index - start + text.length);
    let find: string;
    let replace: string;
    if (m[2] === 'run') {
      const s = /^ ([A-Za-z0-9][A-Za-z0-9:._-]*)/.exec(rest);
      if (!s) return undefined;
      // A sentence's full stop or colon is not part of the script name.
      const script = s[1]!.replace(/[.:]+$/, '');
      if (!scriptDefined(script)) return undefined;
      const args = rest.slice(1 + script.length).split(/&&|\|\||[;|`#)]/)[0] ?? '';
      if (/(?:^|\s)-/.test(args)) return undefined;
      find = `${m[1]} run ${script}`;
      replace = `${preferred} run ${script}`;
    } else {
      if (!BARE_INSTALL_END.test(rest)) return undefined;
      find = text;
      replace = `${preferred} install`;
    }
    edits.push({ filePath: file.path, line: lineNo, find, replace });
  }
  return checkedEdits(files, edits, (file, next) => !stillOffends(file, next));
}

// ── Stale version mentions ──────────────────────────────────────────────────

/** One mention of a version the manifest has moved past, and what it should read. */
export type VersionMention = {
  /** Offset of the mention in the file's content. */
  index: number;
  /** The mention as written, such as `Node.js 18` or `Vite 6.x`. */
  text: string;
  /** The mention with the manifest's version, or undefined when no plain rewrite exists. */
  replacement: string | undefined;
};

/**
 * Wording that makes a version mention history, a fact about that release, or
 * a published support range rather than a statement of what the project uses
 * now ("dropped Node 16", "upgraded from React 17", "Node 18 added fetch",
 * "keep Python 2.7 shims", "supports React 17+"): rewriting the number there
 * would change what the sentence says.
 */
const VERSION_HISTORY_RE =
  /\b(?:drop(?:s|ped|ping)?|deprecat\w*|remov\w*|legacy|older|earlier|previous(?:ly)?|formerly|prior|until|eol|end[- ]of[- ]life|upgrad\w*|downgrad\w*|migrat\w*|switch\w*|replac\w*|was|were|no longer|changelog|released?|since|introduc\w*|add(?:s|ed)?|ship(?:s|ped)?|brought|keep|shims?|polyfill\w*|support\w*|compatib\w*|works?\s+with|tested)\b/i;

/** Right after a mention: a more precise version (`18.17`), or a second version (`18 or 20`, `16-18`). */
const VERSION_FOLLOWED_BY_ANOTHER =
  /^(?:\.\d|(?:\.x|\+)?\s*(?:[-\u2013\u2014/,&]|\bor\b|\band\b|\bto\b|\bthrough\b)\s*v?\d)/i;

/**
 * Right before a mention: another version leading into it (`16 or Node 18`),
 * or a character that makes the tool name the tail of another name
 * (`@vitejs/plugin-react 4`, `ts-jest 27`, `my.node 2`).
 */
const VERSION_PRECEDED_BY_ANOTHER = /(?:\d\s*(?:[-\u2013\u2014/,&]|\bor|\band|\bto)\s*|[-/@._\w])$/i;

/** A section heading over a mention that is about history or support ranges, not what the project uses. */
const VERSION_HEADING_RE = /\b(?:history|changelog|release\s+notes|compatib\w*|support\w*|legacy|migrat\w*|upgrad\w*|deprecat\w*|faq)\b/i;

/**
 * For a runtime (Node.js, Python), a line that states what the project needs:
 * a bare "Node 2" or "Python 3" at the end of a sentence may be anything.
 */
const RUNTIME_CUE_RE =
  /\b(?:requires?|required|requirements?|needs?|runtime|engines?|version|minimum|min|target|use|using|install(?:ed)?|lts)\b/i;

/**
 * What may stand before a version mention on its line, once list markers,
 * emphasis and code ticks are dropped: nothing, a generic label made of
 * {@link LABEL_WORD}s ("Build tool:", "Runtime:", "Prerequisites:"; never a
 * product's name, as in "Storybook: requires Node 18"), and a
 * requirement verb whose subject, if any, is this project ("Requires", "We
 * use", "This package requires"). Anything else is someone else's statement
 * ("Django 4.2 requires Python 3.8+", "Package `foo` requires Node 18", "Use
 * React Native 0.72 with React 17", "Use the following. Vite 3"), and the
 * number in it is theirs to state, not the manifest's.
 */
const LABEL_WORD =
  '(?:runtimes?|requirements?|prerequisites?|node(?:\\.js|js)?|python|versions?|build|tools?|tooling|engines?|toolchain|stack|tech|language|framework|bundler|platform|environment|ci|dev|development|target|minimum|min|library|libraries|local|production|package\\s+manager)';

const DECLARATION_LEAD = new RegExp(
  `^(?:${LABEL_WORD}(?:\\s+${LABEL_WORD})*\\s*:\\s*)?` +
    String.raw`(?:(?:(?:this|the|our)\s+(?:project|repo(?:sitory)?|app(?:lication)?|package|codebase|library|server|cli|site|extension|plugin|build|tooling)|we|it)\s+)?(?:(?:use|uses|using|target|targets|require|requires|required|need|needs|runs?\s+on|built\s+(?:on|with)|install|installs)\s*)?$`,
  'i',
);

/** A line holding a link or URL: the mention may be a label whose target still names the old version. */
const LINK_OR_URL = /\]\(|:\/\/|<https?:/i;

/**
 * After a mention, the rest of its line or table cell must be at most a "+",
 * an "or later", and closing punctuation: the mention DECLARES the version
 * ("Requires Node.js 18+", "Build tool: Vite 6"). Prose around a version
 * ("use React 17 lifecycle methods", "Node 18 added fetch", "Cluster Node 2 is
 * the leader") is left to a human: bumping the number there would leave the
 * sentence describing the old release, or another thing entirely.
 */
const DECLARATION_TAIL = /^(?:\+|\s+or\s+(?:later|newer|above|higher))?\s*(?:[.,;:)*_`]+\s*)?(?:\||$)/i;

/**
 * Edits rewriting every mention in `mentions` (one file, one finding), or
 * undefined when any mention is not a plain number swap: inside a fenced or
 * indented code block or an HTML comment (sample text, not instruction), on a
 * line naming the tool more than once (`toolRe` must be global) or holding a
 * link or URL, in a range or list of versions, more precise than the
 * manifest's version, the tail of another name, in history or support-range
 * wording, not a declaration ({@link DECLARATION_TAIL}, {@link DECLARATION_LEAD}),
 * under an ancestor heading about history or support ranges
 * ({@link VERSION_HEADING_RE}), or, for a runtime,
 * with no cue that the line states a requirement. `stillOffends` re-runs the
 * check on the rewritten text.
 */
export function versionMentionEdits(
  file: InstructionFile,
  mentions: readonly VersionMention[],
  toolRe: RegExp,
  /** A runtime (Node.js, Python): the line must also carry a {@link RUNTIME_CUE_RE} cue, a "+", or "or later". */
  runtime: boolean,
  stillOffends: (newContent: string) => boolean,
): FixEdit[] | undefined {
  // One edit per mention or none at all, as in packageManagerSwapEdits.
  if (mentions.length > MAX_RECIPE_EDITS) return undefined;
  const { fence, index, indented, comments } = factsOf(file);
  const edits: FixEdit[] = [];
  for (const mention of [...mentions].sort((a, b) => a.index - b.index)) {
    if (mention.replacement === undefined || mention.text.includes('\n')) return undefined;
    const line = index.lineOf(mention.index);
    if (fence[line - 1]?.inFence || indented[line - 1] || inRanges(comments, mention.index)) return undefined;
    const { start, text } = lineAround(file.content, mention.index);
    if (text.length > MAX_EDIT_LINE_LENGTH) return undefined;
    if ((text.match(new RegExp(toolRe.source, toolRe.flags)) ?? []).length !== 1) return undefined;
    if (VERSION_HISTORY_RE.test(text) || LINK_OR_URL.test(text)) return undefined;
    const before = text.slice(0, mention.index - start);
    const after = text.slice(mention.index - start + mention.text.length);
    if (VERSION_FOLLOWED_BY_ANOTHER.test(after) || VERSION_PRECEDED_BY_ANOTHER.test(before)) return undefined;
    if (!DECLARATION_TAIL.test(after)) return undefined;
    const lead = before.replace(/^\s*(?:(?:[-*+>]|\d+[.)])\s+)*/, '').replace(/[*_`]/g, '').trim();
    if (!DECLARATION_LEAD.test(lead)) return undefined;
    // A library mention needs its declaring label or verb on its own line, not a cue a line above.
    if (!runtime && lead === '') return undefined;
    if (runtime && !RUNTIME_CUE_RE.test(text) && !/^(?:\+|\s+or\s+(?:later|newer|above|higher))/i.test(after)) return undefined;
    const { heading } = index.framing(line);
    if (heading.length > MAX_FRAME_LENGTH) return undefined;
    if (VERSION_HEADING_RE.test(heading) || VERSION_HISTORY_RE.test(heading)) return undefined;
    edits.push({ filePath: file.path, line, find: mention.text, replace: mention.replacement });
  }
  return checkedEdits([file], edits, (_file, next) => !stillOffends(next));
}