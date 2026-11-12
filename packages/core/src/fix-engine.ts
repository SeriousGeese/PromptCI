import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type { FixEdit, PromptCiIssue } from './types.js';
import { renderPromptCiGitignore } from './promptci-gitignore.js';
import { isWithinRoot, realPathWithinRoot } from './path-containment.js';
import { gitignoreLineMatchesTarget } from './security-pack.js';

export interface FileChange {
  filePath: string; // Absolute path
  originalContent: string;
  newContent: string;
}

/**
 * True when an active (non-comment) line of the given .gitignore content
 * already covers `target`, using the same segment-based matching as the
 * security-pack detector. The fix side must agree with the detector: a
 * substring test would let an entry like `mydist/` suppress adding `dist/`
 * even though the detector (correctly) still flags `dist` as unignored.
 */
function gitignoreCovers(content: string, target: string): boolean {
  return content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .some((line) => gitignoreLineMatchesTarget(line, target));
}

/**
 * Validates and resolves a path relative to the repo root to prevent path traversal.
 */
export function resolveSafePath(repoRoot: string, relativeOrAbsolutePath: string): string {
  const resolvedRoot = path.resolve(repoRoot);
  const resolvedPath = path.isAbsolute(relativeOrAbsolutePath)
    ? path.resolve(relativeOrAbsolutePath)
    : path.resolve(resolvedRoot, relativeOrAbsolutePath);

  if (!isWithinRoot(resolvedRoot, resolvedPath)) {
    throw new Error(`Path traversal detected: "${relativeOrAbsolutePath}" is outside repo root "${resolvedRoot}"`);
  }
  return resolvedPath;
}

/** Occurrences of `needle` (a plain string, never a pattern) in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
    count++;
  }
  return count;
}

/**
 * pcic-oonz: applies the line-anchored substitutions a detector computed (see
 * {@link FixEdit}).
 *
 * All-or-nothing on purpose. Every edit must land on an existing line whose
 * text contains its `find` exactly once; the first one that does not abandons
 * the whole issue and returns no changes. A finding whose recipe is stale
 * (someone edited the file between the scan and the fix) is then re-detected
 * on the next scan against the current text, rather than half-rewritten here.
 *
 * Lines are split with their terminators attached and rejoined verbatim, so a
 * one-token substitution leaves every other byte of the file — including mixed
 * or CRLF line endings and a missing trailing newline — exactly as it was.
 */
async function applyLineEdits(edits: readonly FixEdit[], repoRoot: string): Promise<FileChange[]> {
  const byFile = new Map<string, FixEdit[]>();
  for (const edit of edits) {
    const filePath = resolveSafePath(repoRoot, edit.filePath);
    const list = byFile.get(filePath) ?? [];
    list.push(edit);
    byFile.set(filePath, list);
  }

  const changes: FileChange[] = [];
  for (const [filePath, fileEdits] of byFile) {
    // The lexical check in resolveSafePath cannot see a symlink: an in-root
    // `AGENTS.md` committed as a link to a file outside the root would be
    // written THROUGH. Refuse that, the same policy reads already follow.
    if (!realPathWithinRoot(path.resolve(repoRoot), filePath)) return [];

    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch {
      return []; // a file the recipe needs is gone: apply nothing
    }

    // Terminators stay attached to their line, so join('') restores the file.
    const lines = content.split(/(?<=\n)/);
    for (const { line, find, replace } of fileEdits) {
      const idx = line - 1;
      const text = lines[idx];
      if (text === undefined || !find || find.includes('\n')) return [];
      if (countOccurrences(text, find) !== 1) return [];
      // Spliced by index, not via String.replace: a `$&`, `$1` or `$$` in the
      // replacement is replacement-pattern syntax there, and a path or script
      // name containing `$` would be silently corrupted.
      const at = text.indexOf(find);
      lines[idx] = text.slice(0, at) + replace + text.slice(at + find.length);
    }

    const newContent = lines.join('');
    if (newContent === content) continue;
    changes.push({ filePath, originalContent: content, newContent });
  }
  return changes;
}

/**
 * Computes the proposed file changes to fix a given PromptCiIssue.
 * Returns an array of FileChanges that would be applied.
 */
export async function applyFixRecipe(
  issue: PromptCiIssue,
  repoRoot: string
): Promise<FileChange[]> {
  const changes: FileChange[] = [];

  // 0. Detector-computed substitutions (pcic-oonz): a mistyped package-manager
  // script name with exactly one close match in the manifest, and a broken
  // relative link whose basename exists exactly once in the tree. The detector
  // knew the parsed command / link target and the candidate set, so it carries
  // the edit rather than making the fix engine re-derive any of it.
  if (issue.fixEdits && issue.fixEdits.length > 0) {
    return applyLineEdits(issue.fixEdits, repoRoot);
  }

  // 1. Missing .promptci/ in .gitignore
  if (issue.id === 'security-pack-no-promptci-gitignore') {
    const gitignorePath = resolveSafePath(repoRoot, '.gitignore');
    let content = '';
    try {
      content = await fs.readFile(gitignorePath, 'utf-8');
    } catch {
      // file doesn't exist, which is fine
    }

    if (!gitignoreCovers(content, '.promptci')) {
      const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
      // BUG-7: write the baseline-preserving stanza, not a bare `.promptci/`
      // — the latter also ignores baseline.json and breaks the CI ratchet.
      const block = renderPromptCiGitignore(lineEnding);
      const suffix = content.endsWith('\n') || content.endsWith('\r')
        ? block
        : `${lineEnding}${block}`;
      changes.push({
        filePath: gitignorePath,
        originalContent: content,
        newContent: content + suffix,
      });
    }
    return changes;
  }

  // 2. Unignored directories in .gitignore
  if (issue.id === 'security-pack-unignored-dirs') {
    const gitignorePath = resolveSafePath(repoRoot, '.gitignore');
    let content = '';
    try {
      content = await fs.readFile(gitignorePath, 'utf-8');
    } catch {
      // file doesn't exist
    }

    let newLines = '';
    const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';

    for (const ev of issue.evidence) {
      const m = /Directory "([^"]+)" exists/.exec(ev);
      if (m && m[1]) {
        const dirName = m[1];
        if (!gitignoreCovers(content, dirName)) {
          newLines += `${dirName}/${lineEnding}`;
        }
      }
    }

    if (newLines) {
      const suffix = content.endsWith('\n') || content.endsWith('\r')
        ? newLines
        : `${lineEnding}${newLines}`;
      changes.push({
        filePath: gitignorePath,
        originalContent: content,
        newContent: content + suffix,
      });
    }
    return changes;
  }

  // 3. Stale years are intentionally NOT auto-fixable.
  //
  // BUG-14: this branch used to rewrite every year matching a hardcoded
  // 2019–2023 alternation to the literal string '2026' across the whole
  // flagged section. Three problems, any one of which is disqualifying:
  //   - the source range and the replacement year were both hardcoded, so the
  //     recipe was wrong from Jan 1 2027 onward;
  //   - the range disagreed with the detector's own (2019–2025), so the fixer
  //     silently skipped most of what the detector flagged; and
  //   - a bare year substitution cannot tell a stale instruction from a
  //     copyright line, a release date, or a version pin — it rewrote
  //     "© 2021", "shipped in 2020", and "the 2022 spec" alike.
  //
  // The finding now carries an advisory `fixRecipe` string instead (see
  // stale-instructions.ts) and produces no automated edit.
  if (issue.id.startsWith('stale-') && issue.category === 'stale_instruction') {
    return changes;
  }

  // 4. Duplicate Markdown Section Consolidation
  if (issue.category === 'duplicate' && issue.locations.length >= 2) {
    // 4a. Identify canonical path: AGENTS.md preferred, otherwise the first in location list
    let canonicalLoc = issue.locations.find(loc =>
      path.basename(loc.filePath).toLowerCase() === 'agents.md'
    );
    if (!canonicalLoc) {
      canonicalLoc = issue.locations[0];
    }
    const canonicalPath = resolveSafePath(repoRoot, canonicalLoc.filePath);
    const canonicalBase = path.basename(canonicalPath);

    // 4b. Group the non-canonical locations by file. A single file can contain
    // the duplicated section more than once; computing one FileChange per
    // location from the original content and writing them in sequence would
    // clobber all but the last, so each file is rewritten exactly once with
    // every one of its duplicate ranges replaced (BUG: same-file collision).
    const byFile = new Map<string, Array<{ startLine?: number; endLine?: number }>>();
    for (const loc of issue.locations) {
      const filePath = resolveSafePath(repoRoot, loc.filePath);
      if (filePath === canonicalPath) continue; // skip canonical file
      const list = byFile.get(filePath) ?? [];
      list.push(loc);
      byFile.set(filePath, list);
    }

    for (const [filePath, locs] of byFile) {
      let content: string;
      try {
        content = await fs.readFile(filePath, 'utf-8');
      } catch {
        continue;
      }

      const lines = content.split(/\r?\n/);
      const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';

      // Relative path from this file to the canonical file for a clean link.
      const relPath = path.relative(path.dirname(filePath), canonicalPath).replace(/\\/g, '/');
      const linkTarget = relPath.startsWith('.') ? relPath : `./${relPath}`;
      const pointerText = `See canonical instructions in [${canonicalBase}](${linkTarget}) for details.`;

      // Replace each duplicate range bottom-up so an earlier (higher-line)
      // replacement never shifts the indices of ranges still to be processed.
      const ranges = locs
        .map(loc => ({
          startIdx: (loc.startLine ?? 1) - 1,
          endIdx: (loc.endLine ?? lines.length) - 1,
        }))
        .sort((a, b) => b.startIdx - a.startIdx);

      let working = lines;
      for (const { startIdx, endIdx } of ranges) {
        const sectionLines = working.slice(startIdx, endIdx + 1);
        // Preserve a leading heading line (e.g. "## Deployment") and replace
        // only the body below it; otherwise replace the whole range.
        const hasHeading = sectionLines.length > 0 && sectionLines[0].trim().startsWith('#');
        const replaceStartIdx = hasHeading ? startIdx + 1 : startIdx;
        working = [
          ...working.slice(0, replaceStartIdx),
          pointerText,
          ...working.slice(endIdx + 1),
        ];
      }

      changes.push({
        filePath,
        originalContent: content,
        newContent: working.join(lineEnding),
      });
    }
  }

  return changes;
}

/**
 * True when `promptci fix` may mechanically apply this issue's recipe.
 *
 * Driven by the explicit `autoApplySafe` flag the emitting detector sets — it is
 * deliberately NOT `Boolean(issue.fixRecipe)`. Most `fixRecipe` strings are
 * advisory prose that needs human judgment (stale years, framework/runtime
 * guidance, agent-practices), and auto-applying them would corrupt files. Only
 * the handful of recipes that `applyFixRecipe` implements as a mechanical,
 * reversible edit are marked safe at their source.
 */
export function isRepairable(issue: PromptCiIssue): boolean {
  return issue.autoApplySafe === true;
}
