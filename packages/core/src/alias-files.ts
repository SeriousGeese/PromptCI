/**
 * Symlink aliases for file-type-specific checks.
 *
 * A symlinked instruction file (`CLAUDE.md -> AGENTS.md`, `.windsurfrules ->
 * AGENTS.md`) is scanned once, as the real file; the symlink name is kept as an
 * ALIAS (`RepoContext.aliasFiles`, each with `aliasOf` and the real content).
 * The tool that reads the alias name still reads that content, so a check that
 * belongs to ONE tool's file type has to run against the alias under the
 * alias's own type — `.windsurfrules -> AGENTS.md` is a Windsurf rules file.
 *
 * Generic checks must not run again: an alias qualifies only when the real
 * file's type does NOT (otherwise the same content would be reported twice, once
 * per name). The same helper serves the generic detectors that are gated by a
 * set of types (`INSTRUCTION_FILE_TYPES`): an alias whose type is in the set
 * while the real file's is not (`CLAUDE.md -> README.md`) is the only way that
 * content reaches them.
 */

import type { FileType, InstructionFile } from './types.js';

/**
 * Aliases whose own `fileType` passes `qualifies` while the file they alias
 * does not. A real file that is not among `files` (an on-demand skill or agent
 * body, or a file outside the scanned set) does not qualify, so the alias does.
 */
export function aliasesWithNewType(
  files: InstructionFile[],
  aliases: InstructionFile[],
  qualifies: (fileType: FileType) => boolean,
): InstructionFile[] {
  if (aliases.length === 0) return [];
  const byRelativePath = new Map<string, InstructionFile>();
  for (const file of files) {
    if (file.relativePath !== undefined) byRelativePath.set(file.relativePath, file);
  }
  return aliases.filter((alias) => {
    if (!qualifies(alias.fileType)) return false;
    const real = alias.aliasOf === undefined ? undefined : byRelativePath.get(alias.aliasOf);
    return real === undefined || !qualifies(real.fileType);
  });
}

/** `files` plus the aliases from {@link aliasesWithNewType} (the same array when there are none). */
export function withTypeAliases(
  files: InstructionFile[],
  aliases: InstructionFile[] | undefined,
  qualifies: (fileType: FileType) => boolean,
): InstructionFile[] {
  const extra = aliasesWithNewType(files, aliases ?? [], qualifies);
  return extra.length === 0 ? files : [...files, ...extra];
}
