import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import micromatch from 'micromatch';
import type { FixEdit, PromptCiIssue } from './types.js';
import { renderPromptCiGitignore } from './promptci-gitignore.js';
import { isWithinRoot, realPathWithinRoot } from './path-containment.js';
import { gitignoreLineMatchesTarget } from './security-pack.js';
import { MIRRORED_FILES_TAG } from './duplicates.js';
import { MIRROR_CANONICAL_BASENAME, consolidateWithImport, importRecipeTarget } from './mirror-import.js';

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
  repoRoot: string,
  /** `optIn`: the caller named this finding (`promptci fix --issue <id>`); needed for an {@link isOptInRecipe} recipe. */
  options: { optIn?: boolean } = {},
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

  // 4. Duplicate consolidation: no unattended edit (pcic-1ik0.10).
  //
  // The old recipe replaced each copied section with a markdown link ("See
  // canonical instructions in [AGENTS.md](./AGENTS.md)"), which no tool
  // loads, so the guidance silently left the agent's context. It is gone on
  // every path. Per-section duplicates get no edit. A mirrored-files finding
  // gets the CLAUDE.md import recipe ONLY when the caller opts in by naming
  // it (`promptci fix --issue <id>`), because the import does not load in a
  // session started in a subdirectory without a one-time approval (see
  // mirror-import.ts). A caller that ignores `autoApplySafe` and calls this
  // without the opt-in (a hosted autopilot) gets no edit.
  if (issue.category === 'duplicate') {
    // Every path the finding names must stay inside the repository; an
    // escaping one is an attack or a bug, so it throws, whatever the finding.
    for (const loc of issue.locations) resolveSafePath(repoRoot, loc.filePath);
    for (const p of issue.filePaths) resolveSafePath(repoRoot, p);
    if (!options.optIn || !isOptInRecipe(issue)) return changes;
    return (await planMirrorImport(issue, repoRoot)).changes;
  }

  return changes;
}

/**
 * True for a finding whose recipe is applied only on an explicit opt-in
 * (`promptci fix --issue <id>`), never by `promptci fix` on its own or by an
 * autopilot: today, the mirrored-files finding's CLAUDE.md import.
 */
export function isOptInRecipe(issue: PromptCiIssue): boolean {
  return issue.category === 'duplicate' && (issue.tags ?? []).includes(MIRRORED_FILES_TAG);
}

/**
 * True when any active pattern of a .gitignore could match `relPath` or one of
 * its parent directories. Negations are not applied: when in doubt the path
 * counts as ignored, the safe side for an edit that relies on the file.
 */
function mayBeIgnored(relPath: string, gitignore: string): boolean {
  const parts = relPath.split('/');
  const candidates = parts.map((_, i) => parts.slice(0, i + 1).join('/'));
  return gitignore
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#') && !l.startsWith('!'))
    .some((line) => {
      const pattern = line.replace(/^\/+/, '').replace(/\/+$/, '');
      if (pattern === '') return false;
      const glob = pattern.includes('/') ? pattern : `**/${pattern}`;
      return candidates.some((c) => micromatch.isMatch(c, glob, { dot: true }));
    });
}

export type MirrorImportPlan = {
  /** The edits, empty when anything was refused (all or nothing). */
  changes: FileChange[];
  /** Why no edit is made, one line each; empty when `changes` is the plan. */
  refusals: string[];
  /** Group members the recipe never edits (anything but a root CLAUDE.md copy), with the reason. */
  untouched: string[];
};

/**
 * The CLAUDE.md import recipe for one mirrored-files finding, re-checked
 * against the files on disk. Edits only a repo-root `CLAUDE.md` or
 * `.claude/CLAUDE.md` copy of the repo-root `AGENTS.md` (see
 * `importRecipeTarget`); every other member is left as it is. All or
 * nothing: any refusal means no edit to any file.
 */
export async function planMirrorImport(issue: PromptCiIssue, repoRoot: string): Promise<MirrorImportPlan> {
  const root = path.resolve(repoRoot);
  const rel = (abs: string) => path.relative(root, abs).split(path.sep).join('/');
  const none = (...refusals: string[]): MirrorImportPlan => ({ changes: [], refusals, untouched: [] });
  if (!isOptInRecipe(issue)) return none('not a mirrored-files finding');
  const [canonicalRaw, ...copiesRaw] = issue.filePaths;
  if (canonicalRaw === undefined || copiesRaw.length === 0) return none('the finding names no copies');
  const canonicalPath = resolveSafePath(root, canonicalRaw);
  const copies = copiesRaw.map((p) => resolveSafePath(root, p));
  const canonicalRel = rel(canonicalPath);
  if (canonicalRel !== MIRROR_CANONICAL_BASENAME) {
    return none(`the canonical file is ${canonicalRel}, not the repository-root ${MIRROR_CANONICAL_BASENAME}`);
  }
  if (copies.some((c) => path.basename(c) === MIRROR_CANONICAL_BASENAME || c === canonicalPath)) {
    return none(`more than one ${MIRROR_CANONICAL_BASENAME} in the group: the canonical file is ambiguous`);
  }

  const read = async (p: string): Promise<string | undefined> => {
    if (!realPathWithinRoot(root, p)) return undefined;
    try {
      return await fs.readFile(p, 'utf-8');
    } catch {
      return undefined;
    }
  };
  const canonicalContent = await read(canonicalPath);
  if (canonicalContent === undefined || canonicalContent.trim() === '') {
    return none(`${canonicalRel} cannot be read (or is empty) here`);
  }
  // An import of a file other clones do not have would load nothing there.
  const gitignore = await read(path.join(root, '.gitignore'));
  if (gitignore !== undefined && mayBeIgnored(canonicalRel, gitignore)) {
    return none(`the root .gitignore may ignore ${canonicalRel}`);
  }

  const changes: FileChange[] = [];
  const refusals: string[] = [];
  const untouched: string[] = [];
  for (const copy of copies) {
    const copyRel = rel(copy);
    const importPath = importRecipeTarget(copyRel, canonicalRel);
    if (importPath === undefined) {
      untouched.push(
        path.basename(copy) === 'GEMINI.md'
          ? `${copyRel}: not edited (an @ import in GEMINI.md does not load in every Gemini tool)`
          : path.basename(copy) === 'CLAUDE.md'
            ? `${copyRel}: not edited (a CLAUDE.md below the root imports AGENTS.md as an external file)`
            : `${copyRel}: not edited (its tool loads no @ import)`,
      );
      continue;
    }
    const content = await read(copy);
    if (content === undefined) {
      refusals.push(`${copyRel} cannot be read here`);
      continue;
    }
    const result = consolidateWithImport(content, canonicalContent, { copyRel, canonicalRel, importPath });
    if (!result.ok) {
      refusals.push(result.reason);
      continue;
    }
    changes.push({ filePath: copy, originalContent: content, newContent: result.newContent });
  }
  if (refusals.length > 0) return { changes: [], refusals, untouched };
  if (changes.length === 0) return { changes: [], refusals: ['no repository-root CLAUDE.md copy to edit'], untouched };
  return { changes, refusals: [], untouched };
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
