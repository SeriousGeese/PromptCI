/**
 * Consolidating a mirrored CLAUDE.md with an `@AGENTS.md` import
 * (pcic-1ik0.10). OPT-IN ONLY: the mirrored-files finding is advisory
 * (`autoApplySafe: false`), and the fix engine runs this recipe only when the
 * caller names the finding (`promptci fix --issue <id>`).
 *
 * Why opt-in: Claude Code's memory docs say an import that resolves outside
 * the session's working directory is "external" and needs a one-time
 * approval; declined, it stays disabled. A repo-root CLAUDE.md is also loaded
 * by sessions started in a subdirectory, and from there `@AGENTS.md` is
 * external, so the import loads when the session starts at the repository
 * root but not, without that approval, from a subdirectory (a headless session
 * there was observed not to load it). The copied text loads in both cases.
 * That trade-off is the user's to make.
 *
 * Scope: only a repo-root `CLAUDE.md` copy of the repo-root `AGENTS.md`
 * (same directory, so relative `@` paths in the shared text resolve the same
 * before and after the edit). `.claude/CLAUDE.md` is never edited: relative
 * paths in its shared text would resolve from another directory after the
 * edit, and spotting every such mention is not reliable. GEMINI.md is never edited: Gemini CLI documents
 * `@file.md` imports, but Antigravity CLI, which replaced it for many users,
 * documents that `@filename` does not inline the file. A markdown link is
 * never written: no tool loads one.
 *
 * Refused (no edit, with a reason) unless the copy is exactly "AGENTS.md plus
 * trailing tool-specific sections": see {@link consolidateWithImport}.
 *
 * Pure: content in, content out. The caller reads and writes files.
 */

import * as path from 'node:path';
import type { InstructionSection } from './types.js';
import { parseSections } from './scanner.js';
import { scanFencedLines } from './markdown-fences.js';
import { sameSectionText } from './same-text.js';

/** The file a mirror group consolidates into. */
export const MIRROR_CANONICAL_BASENAME = 'AGENTS.md';

/**
 * Tools whose instruction file loads an `@path` import, by the file's
 * basename. Used to judge whether a file FORWARDS to AGENTS.md (an import
 * there puts the canonical guidance in that tool's context). The recipe
 * itself edits only CLAUDE.md (see {@link importRecipeTarget}).
 */
const IMPORTING_TOOL_BY_BASENAME: Readonly<Record<string, 'claude-code' | 'gemini-cli'>> = {
  'CLAUDE.md': 'claude-code',
  'GEMINI.md': 'gemini-cli',
};

/** The importing tool for an instruction file, or undefined when it documents no import. */
export function importingToolFor(filePath: string): 'claude-code' | 'gemini-cli' | undefined {
  return IMPORTING_TOOL_BY_BASENAME[path.basename(filePath)];
}

/**
 * The import recipe's rule for which copies it may edit, by repo-relative
 * POSIX path: only the repo-root `CLAUDE.md`, importing the repo-root
 * `AGENTS.md` (`@AGENTS.md`). It is in AGENTS.md's own directory, so a
 * relative `@` path inside the shared text resolves to the same file before
 * and after the edit, and from a session at the repository root the import
 * resolves inside the working directory (not external). `.claude/CLAUDE.md`
 * is refused (its relative paths resolve from `.claude/`), and a CLAUDE.md in
 * a subdirectory too (its import of the root AGENTS.md is external where it is
 * loaded). Returns the import path, or undefined.
 */
export function importRecipeTarget(copyRel: string, canonicalRel: string): string | undefined {
  if (canonicalRel !== MIRROR_CANONICAL_BASENAME) return undefined;
  return copyRel === 'CLAUDE.md' ? 'AGENTS.md' : undefined;
}

/** POSIX path from the importing file's directory to the canonical file. */
export function importTarget(importingFile: string, canonicalFile: string): string {
  return path.relative(path.dirname(importingFile), canonicalFile).split(path.sep).join('/');
}

/** `@path` on a line of its own (trailing spaces allowed). */
const IMPORT_LINE_RE = /^@(\S+)\s*$/;

/** Normalises an import path for comparison: forward slashes, no leading `./`. */
function normImport(p: string): string {
  return p.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
}

/** An HTML block whose content runs to its closing tag (CommonMark type 1). */
const HTML_RAW_BLOCK_RE = /^ {0,3}<(pre|script|style|textarea)(?=[\s>]|$)/i;
/** Any other HTML tag opening a line starts an HTML block that runs to the next blank line. */
const HTML_BLOCK_RE = /^ {0,3}<\/?[A-Za-z][A-Za-z0-9-]*(?=[\s/>]|$)/;

/**
 * Line indices that hold live Markdown text: outside fenced code, HTML
 * comments (`<!-- ... -->`) and HTML blocks (`<pre>` to `</pre>`, or a line
 * opening with a tag such as `<div>` up to the next blank line). Claude Code
 * loads none of those as an import. A line that only partly overlaps a
 * comment counts as inside it. Code spans are removed before looking for a
 * comment, so `` `<!--` `` in prose does not open one. Errs on the side of
 * "not live": a line it cannot place for sure is not counted as an import.
 */
function liveLines(content: string): boolean[] {
  const lines = content.split(/\r?\n/);
  const fences = scanFencedLines(content);
  const live: boolean[] = [];
  let inComment = false;
  let rawTag: string | undefined;
  let inHtmlBlock = false;
  lines.forEach((line, i) => {
    if (fences[i]?.inFence) {
      live.push(false);
      return;
    }
    if (rawTag !== undefined) {
      live.push(false);
      if (line.toLowerCase().includes(`</${rawTag}>`)) rawTag = undefined;
      return;
    }
    if (inHtmlBlock) {
      if (line.trim() === '') {
        inHtmlBlock = false;
        live.push(true);
      } else {
        live.push(false);
      }
      return;
    }
    if (!inComment) {
      const raw = HTML_RAW_BLOCK_RE.exec(line);
      if (raw) {
        const tag = raw[1]!.toLowerCase();
        if (!line.toLowerCase().includes(`</${tag}>`)) rawTag = tag;
        live.push(false);
        return;
      }
      if (!/^ {0,3}<!--/.test(line) && HTML_BLOCK_RE.test(line)) {
        inHtmlBlock = true;
        live.push(false);
        return;
      }
    }
    let touchedComment = inComment;
    let rest = line.replace(/(`+)(?:(?!\1)[\s\S])*?\1/g, '');
    for (;;) {
      if (inComment) {
        const close = rest.indexOf('-->');
        if (close < 0) break;
        inComment = false;
        rest = rest.slice(close + 3);
      } else {
        const open = rest.indexOf('<!--');
        if (open < 0) break;
        inComment = true;
        touchedComment = true;
        rest = rest.slice(open + 4);
      }
    }
    live.push(!touchedComment);
  });
  return live;
}

/** Import targets on live lines of their own (outside fences and HTML comments), normalised. */
export function importTargets(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const live = liveLines(content);
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (!live[i]) return;
    const m = IMPORT_LINE_RE.exec(line);
    if (m) out.push(normImport(m[1]!));
  });
  return out;
}

/**
 * The repo-relative POSIX paths a file's live import lines point at, resolved
 * from the importing file's directory (the rule both Claude Code and Gemini
 * CLI document).
 */
export function resolvedImports(fileRel: string, content: string): string[] {
  const dir = path.posix.dirname(fileRel.replace(/\\/g, '/'));
  return importTargets(content).map((t) => path.posix.normalize(path.posix.join(dir, t)));
}

/** True when a section is nothing but import lines (and blank lines) under its heading, if any. */
export function isImportOnlySection(section: Pick<InstructionSection, 'text' | 'heading'>): boolean {
  const lines = section.text.split(/\r?\n/).slice(section.heading !== undefined ? 1 : 0);
  const content = lines.map((l) => l.trim()).filter((l) => l !== '');
  return content.length > 0 && content.every((l) => IMPORT_LINE_RE.test(l));
}

/** Leading YAML front matter (`---` ... `---`) line count, 0 when there is none. */
function frontMatterLines(lines: string[]): number {
  if (lines[0]?.trim() !== '---') return 0;
  for (let i = 1; i < lines.length; i++) if (lines[i]!.trim() === '---') return i + 1;
  return 0;
}

/** Heading level of a section (1 for `#`), or 0 for the preamble before the first heading. */
function headingLevel(section: InstructionSection): number {
  if (section.heading === undefined) return 0;
  const m = /^ {0,3}(#{1,6})\s/.exec(section.text.split('\n')[0] ?? '');
  return m ? m[1]!.length : 0;
}

export type ImportConsolidation =
  | {
      ok: true;
      newContent: string;
      /** Headings of the sections dropped from the copy, in order. */
      dropped: string[];
      /** Headings of the copy-only sections kept below the import, in order. */
      kept: string[];
    }
  | { ok: false; reason: string };

/**
 * Rewrite `copyContent`, a CLAUDE.md that mirrors the canonical AGENTS.md, so
 * it imports the canonical file instead of repeating it. The edit is made
 * only when the copy is exactly "every section of AGENTS.md, then sections
 * only the copy has"; otherwise it is refused with a reason:
 *
 * - every section of the canonical file, its preamble included, must be in
 *   the copy, the same text under {@link sameSectionText} (byte-identical up
 *   to line endings, trailing whitespace, BOM and edge blank lines): an
 *   import must not ADD text Claude did not have;
 * - a copy section under a heading the canonical file also has, with other
 *   text, is drift: refused (importing would put both versions in context);
 * - the copied sections are the canonical sections, once each, in the
 *   canonical order: the import must not reorder what Claude reads;
 * - every dropped section comes before every kept one, and the first kept
 *   section is no deeper than the dropped sections (ignoring an H1 title):
 *   a kept section must not move, or read as part of AGENTS.md (a kept
 *   tail may nest under its own first section);
 * - the copy must be in the canonical file's directory, so a relative `@`
 *   path in the shared text (on its own line or inline in prose) resolves to
 *   the same file before and after the edit;
 * - the canonical file must not hold the same section twice (the copy's
 *   duplicate would be dropped, and the canonical duplicate is then imported);
 * - the canonical file must not import the copy (circular);
 * - there must be something to drop.
 *
 * The import line goes at the top (after front matter) unless the leading
 * import-only block already imports the canonical file. Line endings and
 * the final newline are kept.
 */
export function consolidateWithImport(
  copyContent: string,
  canonicalContent: string,
  paths: { copyRel: string; canonicalRel: string; importPath: string },
): ImportConsolidation {
  const refuse = (reason: string): ImportConsolidation => ({ ok: false, reason });
  if (path.posix.dirname(paths.copyRel) !== path.posix.dirname(paths.canonicalRel)) {
    return refuse(
      `${paths.copyRel} is not in ${paths.canonicalRel}'s directory: relative @ paths in the shared text would resolve from another directory after the edit`,
    );
  }
  if (resolvedImports(paths.canonicalRel, canonicalContent).includes(paths.copyRel)) {
    return refuse(`${paths.canonicalRel} imports ${paths.copyRel} (circular)`);
  }

  const eol = copyContent.includes('\r\n') ? '\r\n' : '\n';
  const canonicalSections = parseSections(canonicalContent, 'canonical');
  const canonicalTexts = new Set(canonicalSections.map((s) => sameSectionText(s)).filter((t) => t !== ''));
  if (canonicalTexts.size !== canonicalSections.filter((s) => sameSectionText(s) !== '').length) {
    return refuse(`${paths.canonicalRel} has the same section more than once; consolidate it there first`);
  }
  const headingKey = (h: string | undefined) => (h ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const canonicalHeadings = new Set(
    canonicalSections.filter((s) => s.heading !== undefined).map((s) => headingKey(s.heading)),
  );

  const lines = copyContent.split(/\r?\n/);
  const frontCount = frontMatterLines(lines);
  const front = lines.slice(0, frontCount);
  const body = lines.slice(frontCount).join('\n');
  const allSections = parseSections(body, 'copy').filter((s) => sameSectionText(s) !== '');
  // Text before the first heading that is only import lines stays on top, as
  // is: it is not content that could move or read as part of AGENTS.md.
  const leading = allSections[0] !== undefined && allSections[0].heading === undefined && isImportOnlySection(allSections[0])
    ? allSections[0]
    : undefined;
  const sections = leading ? allSections.slice(1) : allSections;

  const copyTexts = new Set(sections.map((s) => sameSectionText(s)));
  const missing = canonicalSections.filter((s) => sameSectionText(s) !== '' && !copyTexts.has(sameSectionText(s)));
  if (missing.length > 0) {
    const names = missing.map((s) => s.heading ?? '(text before the first heading)').join(', ');
    return refuse(`${paths.copyRel} lacks text that ${paths.canonicalRel} has (${names}); an import would add it`);
  }

  const dropped: InstructionSection[] = [];
  const kept: InstructionSection[] = [];
  for (const section of sections) {
    if (canonicalTexts.has(sameSectionText(section))) {
      if (kept.length > 0) {
        return refuse(`a section only ${paths.copyRel} has comes before "${section.heading ?? '(preamble)'}"; it would move`);
      }
      dropped.push(section);
      continue;
    }
    if (section.heading !== undefined && canonicalHeadings.has(headingKey(section.heading))) {
      return refuse(`"${section.heading}" differs between ${paths.copyRel} and ${paths.canonicalRel} (drift)`);
    }
    kept.push(section);
  }
  if (dropped.length === 0) return refuse(`${paths.copyRel} repeats nothing from ${paths.canonicalRel}`);

  // The copied sections must be AGENTS.md's sections, once each, in AGENTS.md's
  // order: otherwise the import changes the order (or count) Claude reads them in.
  const canonicalOrder = canonicalSections.map((s) => sameSectionText(s)).filter((t) => t !== '');
  const droppedOrder = dropped.map((s) => sameSectionText(s));
  if (droppedOrder.length !== canonicalOrder.length || droppedOrder.some((t, i) => t !== canonicalOrder[i])) {
    return refuse(`${paths.copyRel} has the sections of ${paths.canonicalRel} in another order (or more than once)`);
  }

  // A kept tail must start at the top level (no deeper than the dropped
  // sections, an H1 title aside): its first section must not read as part of
  // the last section of AGENTS.md. Sections after it may nest under it.
  const droppedLevels = dropped.map(headingLevel).filter((l) => l >= 2);
  const topLevel = droppedLevels.length > 0 ? Math.min(...droppedLevels) : 2;
  const firstKept = kept[0];
  if (firstKept && (headingLevel(firstKept) === 0 || headingLevel(firstKept) > topLevel)) {
    return refuse(`"${firstKept.heading ?? '(preamble)'}" sits under a section being removed; it would read as part of ${paths.canonicalRel}`);
  }

  const leadingLines = leading ? sameSectionText(leading).split('\n') : [];
  const keptLines = kept.flatMap((s) => s.text.split('\n'));
  // Only an import in the leading import-only block counts as already there:
  // anywhere else (a kept section, raw HTML, a comment) it may not load, and
  // a second import line is harmless.
  const alreadyImports = importTargets(leadingLines.join('\n')).includes(normImport(paths.importPath));
  // Drop leading and trailing blank lines of what is kept, and squeeze the
  // seams the removals left to one blank line.
  const squeezed: string[] = [];
  for (const line of keptLines) {
    if (line.trim() === '' && (squeezed.length === 0 || squeezed[squeezed.length - 1]!.trim() === '')) continue;
    squeezed.push(line);
  }
  while (squeezed.length > 0 && squeezed[squeezed.length - 1]!.trim() === '') squeezed.pop();

  const head = [...leadingLines, ...(alreadyImports ? [] : [`@${paths.importPath}`])];
  const out = [...front, ...head];
  if (squeezed.length > 0) {
    if (head.length > 0) out.push('');
    out.push(...squeezed);
  }
  const finalNewline = /\r?\n$/.test(copyContent) ? eol : '';
  return {
    ok: true,
    newContent: out.join(eol) + finalNewline,
    dropped: dropped.map((s) => s.heading ?? '(preamble)'),
    kept: kept.map((s) => s.heading ?? '(preamble)'),
  };
}
