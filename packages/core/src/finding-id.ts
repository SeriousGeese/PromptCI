/**
 * Location-independent path segments for finding-id hash keys.
 *
 * Finding ids are sha1 hashes over a key that usually embeds the file the
 * finding is about. `InstructionFile.path` / `InstructionSection.filePath` are
 * ABSOLUTE, so hashing them made an id depend on where the repo was checked out:
 * the same unchanged file scanned from two directories (two CI runners, two
 * temp dirs, a PR's base and head worktrees) produced two different ids, and
 * anything keying on `id` saw every such finding as new.
 *
 * Every detector that puts a scanned file's path into an id key goes through
 * these helpers, which prefer the scanner-computed repo-relative, forward-slash
 * path. The absolute path is only a fallback for hand-built fixtures that never
 * went through the scanner — it never occurs in a real scan.
 */

import type { InstructionFile, InstructionSection } from './types.js';

/**
 * Forward slashes only, no leading `./`: the same file must hash the same on
 * Windows and POSIX, whoever computed the relative path.
 */
function normalizeIdPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
}

/** Path to embed in an id key for a scanned file. */
export function fileIdPath(file: Pick<InstructionFile, 'path' | 'relativePath'>): string {
  return normalizeIdPath(file.relativePath ?? file.path);
}

/** Path to embed in an id key for a section of a scanned file. */
export function sectionIdPath(section: Pick<InstructionSection, 'filePath' | 'relativePath'>): string {
  return normalizeIdPath(section.relativePath ?? section.filePath);
}
