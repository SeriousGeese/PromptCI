/**
 * Shared diff / confirm / apply loop.
 *
 * Both `promptci fix` and `promptci context optimize --write` rewrite files on
 * disk after showing the user what will change. They used to carry their own
 * near-identical copy of the "print a colored diff, ask y/N, write on yes"
 * loop; this module is the single implementation both call.
 *
 * Two invariants it enforces for every caller:
 *   - Nothing is written without the diff having been shown first, and — unless
 *     the caller opts out with `interactive: false` — without a confirmation.
 *   - A confirmation prompt is never issued into a non-TTY with no scripted
 *     answers: readline.question would block forever, so we fail fast instead.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { isWithinRoot } from '@promptci/core';
import type { FileChange } from '@promptci/core';

/** A group of file changes the user confirms and applies together. */
export type ApplyUnit = {
  /** Lines printed as the block header before the diffs (issue metadata, etc.). */
  headerLines?: string[];
  /**
   * File changes applied together once this unit is confirmed. May be a thunk
   * that computes them lazily: `fix` produces each issue's changes only when its
   * turn comes, so a unit reads the on-disk result of the units applied before
   * it (two issues that both edit `.gitignore` must compose, not clobber).
   */
  changes: FileChange[] | (() => Promise<FileChange[]>);
};

export type InteractiveApplyOptions = {
  /** Absolute repo root; every write is contained within it. */
  repoRoot: string;
  /** Show diffs but never write. */
  dryRun?: boolean;
  /** Prompt before writing. Default true. `false` applies every unit without asking. */
  interactive?: boolean;
  /** Scripted answers (tests / piped input); consumed in order, one per prompt. */
  answers?: string[];
  /** Confirmation prompt text. */
  promptText?: string;
  /** Whether stdin is a TTY. Injectable for tests; defaults to process.stdin.isTTY. */
  isTTY?: boolean;
  /** Output sink. Defaults to console.log. */
  log?: (msg?: string) => void;
};

export type InteractiveApplyResult = { appliedCount: number };

/**
 * Thrown when an interactive apply is requested with no TTY and no scripted
 * answers — the caller should print `.message` and exit non-zero rather than
 * hang on a prompt nobody can answer.
 */
export class NonInteractiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonInteractiveError';
  }
}

const RULE = '='.repeat(80);
const SUBRULE = '-'.repeat(80);

export async function applyChangesInteractively(
  units: ApplyUnit[],
  options: InteractiveApplyOptions,
): Promise<InteractiveApplyResult> {
  const log = options.log ?? ((m = '') => console.log(m));
  const isInteractive = options.interactive !== false;
  const isTTY = options.isTTY ?? Boolean(process.stdin.isTTY);
  const promptText = options.promptText ?? '\nApply this change? (y/N): ';

  // A prompt into a non-TTY with nothing to read blocks forever. Surface it as
  // a clear, actionable error before any file is touched.
  if (!options.dryRun && isInteractive && !options.answers && !isTTY) {
    throw new NonInteractiveError(
      'No interactive terminal detected, so the confirmation prompt cannot be answered. ' +
        'Re-run with --no-interactive to apply changes without prompting, or run inside a TTY.',
    );
  }

  const rl =
    !options.dryRun && isInteractive && !options.answers
      ? readline.createInterface({ input: process.stdin, output: process.stdout })
      : null;

  let appliedCount = 0;
  let answerIndex = 0;

  try {
    for (const unit of units) {
      const raw = typeof unit.changes === 'function' ? await unit.changes() : unit.changes;
      const changes = dedupeChangesByFile(raw);
      if (changes.length === 0) continue;

      log('\n' + RULE);
      const header = unit.headerLines ?? [];
      for (const line of header) log(line);
      if (header.length > 0) log(SUBRULE);
      for (const change of changes) showDiffPreview(change, options.repoRoot, log);

      if (options.dryRun) {
        log('\n[Dry run] No changes written.');
        continue;
      }

      let apply = true;
      if (isInteractive) {
        if (options.answers) {
          const ans = options.answers[answerIndex] ?? 'n';
          answerIndex++;
          log(`${promptText}${ans}`);
          apply = ans.toLowerCase().trim() === 'y';
        } else if (rl) {
          const answer = await rl.question(promptText);
          apply = answer.toLowerCase().trim() === 'y';
        } else {
          apply = false;
        }
      }

      if (!apply) {
        log('Skipped.');
        continue;
      }

      for (const change of changes) {
        // FileChange.filePath is absolute; resolve is a no-op that also guards
        // against a producer handing us a relative path outside the root.
        const resolvedFile = path.resolve(options.repoRoot, change.filePath);
        if (!isWithinRoot(options.repoRoot, resolvedFile)) {
          throw new Error(`Path traversal guard triggered: "${change.filePath}" is outside repo root.`);
        }
        await fs.mkdir(path.dirname(resolvedFile), { recursive: true });
        await fs.writeFile(resolvedFile, change.newContent, 'utf-8');
        log(`Applied change to ${path.relative(options.repoRoot, resolvedFile)}`);
      }
      appliedCount++;
    }
  } finally {
    rl?.close();
  }

  return { appliedCount };
}

/**
 * Collapses exact-duplicate changes (same absolute path AND same newContent) so
 * a file is not written twice in a row. Producers are expected to emit at most
 * one change per file (see fix-engine's per-file merge); two *different* changes
 * to the same file would clobber each other on sequential write, so we reject
 * that rather than silently drop one.
 */
function dedupeChangesByFile(changes: FileChange[]): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const change of changes) {
    const key = path.resolve(change.filePath);
    const existing = byPath.get(key);
    if (!existing) {
      byPath.set(key, change);
    } else if (existing.newContent !== change.newContent) {
      throw new Error(
        `Conflicting changes for "${change.filePath}": two different rewrites of the same file ` +
          `cannot be applied sequentially. Merge them into one change before applying.`,
      );
    }
  }
  return [...byPath.values()];
}

/** Colored, minimal terminal preview of one file change. */
function showDiffPreview(change: FileChange, repoRoot: string, log: (msg?: string) => void): void {
  const relPath = path.relative(repoRoot, change.filePath);

  if (change.originalContent === '') {
    log(`File: ${relPath} (new file)`);
    for (const line of change.newContent.split(/\r?\n/)) {
      log(`\x1b[32m+ ${line}\x1b[0m`);
    }
    return;
  }

  log(`File: ${relPath}`);

  const origLines = change.originalContent.split(/\r?\n/);
  const newLines = change.newContent.split(/\r?\n/);

  if (origLines.length === newLines.length) {
    // Same line count: show only the lines that differ (e.g. in-place edits).
    for (let i = 0; i < origLines.length; i++) {
      if (origLines[i] !== newLines[i]) {
        log(`  Line ${i + 1}:`);
        log(`\x1b[31m- ${origLines[i]}\x1b[0m`);
        log(`\x1b[32m+ ${newLines[i]}\x1b[0m`);
      }
    }
    return;
  }

  // Different line counts: bracket the changed region between the shared
  // prefix and suffix and print the removed/added lines in between.
  let startDiverge = 0;
  while (
    startDiverge < origLines.length &&
    startDiverge < newLines.length &&
    origLines[startDiverge] === newLines[startDiverge]
  ) {
    startDiverge++;
  }

  let endDivergeOrig = origLines.length - 1;
  let endDivergeNew = newLines.length - 1;
  while (
    endDivergeOrig >= startDiverge &&
    endDivergeNew >= startDiverge &&
    origLines[endDivergeOrig] === newLines[endDivergeNew]
  ) {
    endDivergeOrig--;
    endDivergeNew--;
  }

  log(`  Replacement in lines ${startDiverge + 1} to ${endDivergeOrig + 1}:`);
  for (let i = startDiverge; i <= endDivergeOrig; i++) {
    if (origLines[i] !== undefined) log(`\x1b[31m- ${origLines[i]}\x1b[0m`);
  }
  for (let i = startDiverge; i <= endDivergeNew; i++) {
    if (newLines[i] !== undefined) log(`\x1b[32m+ ${newLines[i]}\x1b[0m`);
  }
}
