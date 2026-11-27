/**
 * Reference documents: README, CONTRIBUTING and the other human-facing project
 * docs (pcic-5rop.110). They are scanned by the detectors like any other file,
 * but no agent loads them on its own: Claude Code reads a README only when a
 * CLAUDE.md imports it with `@README.md`, and never follows a markdown link;
 * Codex, Cursor and Copilot load their own rule files only. So an un-imported
 * reference doc is left out of the always-loaded token figures
 * (`estimatedInstructionTokens`, `largestInstructionFiles`) and reported on its
 * own (`estimatedReferenceDocTokens`).
 *
 * An `@path` import on a line of its own, outside code, in an always-loaded
 * CLAUDE.md or GEMINI.md (and, one level down, in a file that import brings in)
 * puts the target in context on every turn, up to 4 hops, the depth Claude
 * Code's memory docs give. The import reader is the one in mirror-import.ts.
 *
 * Deterministic and offline: it reads only the scanned files' own text.
 */

import * as path from 'node:path';
import type { InstructionFile } from './types.js';
import { fileIdPath } from './finding-id.js';
import { importingToolFor, liveLines } from './mirror-import.js';
import { ruleActivation } from './rule-activation.js';

/** Basenames of the reference docs besides README.md (the scanner's default patterns). */
const REFERENCE_DOC_BASENAMES: ReadonlySet<string> = new Set([
  'README.md',
  'CONTRIBUTING.md',
  'QA.md',
  'ARCHITECTURE.md',
  'DEVELOPMENT.md',
  'CODING_STANDARDS.md',
  'CONVENTIONS.md',
  'GUIDELINES.md',
]);

/** How many import hops Claude Code expands (CLAUDE.md -> a -> b -> c -> d). */
const MAX_IMPORT_HOPS = 4;

/** True for a README or one of the other human-facing project docs: a file no agent loads by itself. */
export function isReferenceDoc(file: Pick<InstructionFile, 'path' | 'fileType'>): boolean {
  if (file.fileType !== 'readme' && file.fileType !== 'unknown') return false;
  return REFERENCE_DOC_BASENAMES.has(path.basename(file.path));
}

/** An `@path` after whitespace or at line start; the path runs to unescaped whitespace. */
const INLINE_IMPORT_RE = /(?:^|\s)@((?:\\ |\S)+)/g;

/**
 * Every `@path` import a file holds, anywhere in a live line (Claude Code
 * expands one in prose, "See @README.md", or in a list item): outside fenced
 * code, HTML comments and HTML blocks, and outside code spans. A trailing
 * `.,;:)` is not part of the path. Resolved from the file's directory; the
 * caller keeps only targets that are scanned files. A separate reader from
 * mirror-import's own-line one, which the fix engine and other detectors share.
 */
function inlineImports(fileRel: string, content: string): string[] {
  const dir = path.posix.dirname(fileRel);
  const lines = content.split(/\r?\n/);
  const live = liveLines(content);
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (!live[i] || !line.includes('@')) return;
    const text = line.replace(/(`+)(?:(?!\1)[\s\S])*?\1/g, ' ');
    for (const m of text.matchAll(INLINE_IMPORT_RE)) {
      const raw = m[1]!.replace(/\\ /g, ' ').replace(/[.,;:)]+$/, '').replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
      if (raw === '' || raw.startsWith('~') || raw.startsWith('/')) continue;
      out.push(path.posix.normalize(path.posix.join(dir, raw)));
    }
  });
  return out;
}

/** True for a file whose `@` imports a session always expands: CLAUDE.md, GEMINI.md, the root AGENTS.md, an always-on .claude/rules file. */
function startsImportWalk(file: InstructionFile): boolean {
  const rel = fileIdPath(file);
  if (importingToolFor(file.path) !== undefined) return ruleActivation(file) === 'always';
  if (rel === 'AGENTS.md') return true;
  // A rule with `paths:` frontmatter loads only when matching files are open.
  return /^\.claude\/rules\/.+\.md$/.test(rel) && !/^---\r?\n[\s\S]*?^paths[ \t]*:/m.test(file.content);
}

/** Repo-relative paths of the scanned files an always-loaded file imports, directly or through up to 4 hops. */
function importedPaths(files: InstructionFile[], aliases: InstructionFile[] = []): Set<string> {
  const byPath = new Map<string, InstructionFile>();
  for (const file of files) byPath.set(fileIdPath(file), file);
  const imported = new Set<string>();
  let frontier = [...files, ...aliases].filter(startsImportWalk);
  const seen = new Set<string>(frontier.map((file) => fileIdPath(file)));
  for (let hop = 1; hop <= MAX_IMPORT_HOPS && frontier.length > 0; hop++) {
    const next: InstructionFile[] = [];
    for (const file of frontier) {
      for (const target of inlineImports(fileIdPath(file), file.content)) {
        const targetFile = byPath.get(target);
        if (!targetFile) continue;
        imported.add(target);
        if (!seen.has(target)) {
          seen.add(target);
          next.push(targetFile);
        }
      }
    }
    frontier = next;
  }
  return imported;
}

/**
 * Split scanned files into those an agent loads on its own (`loaded`) and the
 * reference docs nothing imports (`reference`). Order is kept.
 */
export function splitReferenceDocs(
  files: InstructionFile[],
  aliases: InstructionFile[] = [],
): { loaded: InstructionFile[]; reference: InstructionFile[] } {
  if (!files.some(isReferenceDoc)) return { loaded: files, reference: [] };
  const imported = importedPaths(files, aliases);
  const loaded: InstructionFile[] = [];
  const reference: InstructionFile[] = [];
  for (const file of files) (isReferenceDoc(file) && !imported.has(fileIdPath(file)) ? reference : loaded).push(file);
  return { loaded, reference };
}
