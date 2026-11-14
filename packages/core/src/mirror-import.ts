/**
 * Consolidating a mirrored instruction file with an `@` import (pcic-1ik0.10).
 *
 * When CLAUDE.md or GEMINI.md is a copy of AGENTS.md, the fix replaces the
 * copied sections with ONE import line at the top, which those tools load in
 * place: Claude Code's CLAUDE.md and Gemini CLI's GEMINI.md both document an
 * `@path` import resolved relative to the importing file (see the provenance
 * record `duplicates/mirror-import`). A markdown link is NOT loaded by either
 * tool, which is why the old recipe ("See canonical instructions in [..](..)")
 * silently removed the copied guidance from what the agent sees, and the next
 * scan then reported "no behavioral guidance" in the trimmed file.
 *
 * Tools that document no import syntax (Copilot instructions, Cursor rules,
 * Windsurf rules) get no edit: the recipe is offered only when every copy is a
 * file of an importing tool.
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

/** Tools whose instruction file loads an `@path` import, by the file's basename. */
const IMPORTING_TOOL_BY_BASENAME: Readonly<Record<string, 'claude-code' | 'gemini-cli'>> = {
  'CLAUDE.md': 'claude-code',
  'GEMINI.md': 'gemini-cli',
};

/** The importing tool for an instruction file, or undefined when it documents no import. */
export function importingToolFor(filePath: string): 'claude-code' | 'gemini-cli' | undefined {
  return IMPORTING_TOOL_BY_BASENAME[path.basename(filePath)];
}

/** POSIX path from the importing file's directory to the canonical file. */
export function importTarget(importingFile: string, canonicalFile: string): string {
  return path.relative(path.dirname(importingFile), canonicalFile).split(path.sep).join('/');
}

/**
 * The import line for a tool. Claude Code's docs write `@AGENTS.md` /
 * `@path/to/import`; Gemini CLI's import processor documents `@./file.md`
 * and `@../file.md`, so Gemini gets an explicit `./` for a sibling.
 */
export function importLine(tool: 'claude-code' | 'gemini-cli', target: string): string {
  if (tool === 'gemini-cli' && !target.startsWith('../')) return `@./${target}`;
  return `@${target}`;
}

/** `@path` on a line of its own (trailing spaces allowed). */
const IMPORT_LINE_RE = /^@(\S+)\s*$/;

/** Normalises an import path for comparison: forward slashes, no leading `./`. */
function normImport(p: string): string {
  return p.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
}

/** Import targets on lines of their own, outside fenced code. */
export function importTargets(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const fences = scanFencedLines(content);
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (fences[i]?.inFence) return;
    const m = IMPORT_LINE_RE.exec(line);
    if (m) out.push(normImport(m[1]!));
  });
  return out;
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

export type ImportConsolidation = {
  newContent: string;
  /** Headings of the sections dropped from the copy, in order. */
  dropped: string[];
  /** Headings of the sections kept below the import (content only the copy has). */
  kept: string[];
};

/**
 * Rewrite `copyContent` (a CLAUDE.md or GEMINI.md that mirrors the canonical
 * file) so it imports the canonical file instead of repeating it:
 *
 * - drops every section whose text is the SAME as a section of the canonical
 *   file under {@link sameSectionText} (code verbatim, prose modulo reflow);
 * - keeps every other section, in order, below the import, so content only
 *   the copy has stays;
 * - refuses (undefined) when a kept section has a heading the canonical file
 *   also has: the copy has drifted, and that needs a person;
 * - adds one import line at the top (after front matter), unless the copy
 *   already imports the canonical file;
 * - keeps the copy's line endings and its final newline.
 *
 * Returns undefined when there is nothing to drop (no edit).
 */
export function consolidateWithImport(
  copyContent: string,
  canonicalContent: string,
  tool: 'claude-code' | 'gemini-cli',
  target: string,
): ImportConsolidation | undefined {
  const eol = copyContent.includes('\r\n') ? '\r\n' : '\n';
  const canonicalSections = parseSections(canonicalContent, 'canonical');
  const canonicalTexts = new Set(canonicalSections.map((s) => sameSectionText(s)).filter((t) => t !== ''));
  const headingKey = (h: string | undefined) => (h ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const canonicalHeadings = new Set(canonicalSections.filter((s) => s.heading !== undefined).map((s) => headingKey(s.heading)));

  const lines = copyContent.split(/\r?\n/);
  const frontCount = frontMatterLines(lines);
  const front = lines.slice(0, frontCount);
  const body = lines.slice(frontCount).join('\n');
  const sections = parseSections(body, 'copy');

  const dropped: string[] = [];
  const kept: string[] = [];
  const keptLines: string[] = [];
  for (const section of sections) {
    const text = sameSectionText(section);
    if (text === '') {
      keptLines.push(...section.text.split('\n'));
      continue;
    }
    if (canonicalTexts.has(text)) {
      dropped.push(section.heading ?? '(preamble)');
      continue;
    }
    // A section under a heading the canonical file also has, with different
    // text, is a drifted copy: importing would put both versions in front of
    // the agent and the fix would hide that they disagree. No edit at all.
    if (section.heading !== undefined && canonicalHeadings.has(headingKey(section.heading))) return undefined;
    if (section.heading !== undefined) kept.push(section.heading);
    keptLines.push(...section.text.split('\n'));
  }
  if (dropped.length === 0) return undefined;

  const alreadyImports = importTargets(copyContent).includes(normImport(target));
  // Drop leading and trailing blank lines of what is kept, and squeeze the
  // seams the removals left to one blank line.
  const squeezed: string[] = [];
  for (const line of keptLines) {
    if (line.trim() === '' && (squeezed.length === 0 || squeezed[squeezed.length - 1]!.trim() === '')) continue;
    squeezed.push(line);
  }
  while (squeezed.length > 0 && squeezed[squeezed.length - 1]!.trim() === '') squeezed.pop();

  const out = [...front];
  if (!alreadyImports) out.push(importLine(tool, target));
  if (squeezed.length > 0) {
    if (!alreadyImports) out.push('');
    out.push(...squeezed);
  }
  const finalNewline = /\r?\n$/.test(copyContent) ? eol : '';
  return { newContent: out.join(eol) + finalNewline, dropped, kept };
}
