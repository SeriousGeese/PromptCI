/**
 * Shared diff / confirm / apply loop.
 *
 * Both `promptci fix` and `promptci context optimize --write` rewrite files on
 * disk after showing the user what will change. They used to carry their own
 * near-identical copy of the "print a colored diff, ask y/N, write on yes"
 * loop; this module is the single implementation both call.
 *
 * Invariants it enforces for every caller:
 *   - Nothing is written without the diff having been shown first, and — unless
 *     the caller opts out with `interactive: false` — without a confirmation.
 *   - Piped stdin is a valid way to answer prompts (`printf 'y\n' | promptci fix`),
 *     but a prompt whose input ends with no answer left fails fast with
 *     NonInteractiveError instead of blocking forever. Units that produce no
 *     changes never need a prompt, so a no-op run succeeds even with no TTY.
 *   - A unit whose line numbers were computed at scan time is skipped (not
 *     applied against shifted content) when an earlier unit in the same run
 *     already rewrote one of the files it targets — see `skipIfModified`.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import type { Readable } from 'node:stream';
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
  /**
   * Absolute paths whose scan-time line numbers this unit's changes depend on.
   * If an earlier unit in the same run wrote any of them, this unit's recorded
   * line ranges may point at shifted content, so it is skipped with a re-run
   * hint instead of being applied against the wrong lines. Content-based
   * changes (e.g. `.gitignore` appends) compose safely and should leave this
   * unset.
   */
  skipIfModified?: string[];
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
  /** Input stream for prompts. Injectable for tests; defaults to process.stdin. */
  input?: Readable;
  /** Output sink. Defaults to console.log. */
  log?: (msg?: string) => void;
};

export type InteractiveApplyResult = {
  appliedCount: number;
  /** Units skipped because an earlier unit rewrote a file they target (see `skipIfModified`). */
  staleSkippedCount: number;
};

/**
 * Thrown when a confirmation prompt is actually needed but can never be
 * answered — stdin is not a TTY and ended without providing an answer, and no
 * scripted answers were given. The caller should print `.message` and exit
 * non-zero rather than hang on a prompt nobody can answer.
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
  const promptText = options.promptText ?? '\nApply this change? (y/N): ';

  // readline reads answers from a TTY and from piped stdin alike, so
  // `printf 'y\n' | promptci fix` works. If the input is already exhausted when
  // a prompt is needed (e.g. stdin is /dev/null in CI), the prompt site throws
  // a clear NonInteractiveError instead of blocking forever. Units that produce
  // no changes never prompt, so a no-op run needs no input at all.
  const rl =
    !options.dryRun && isInteractive && !options.answers
      ? readline.createInterface({ input: options.input ?? process.stdin, output: process.stdout })
      : null;

  // Buffer lines as they arrive instead of using rl.question: piped input can
  // deliver its lines (and EOF) before a question is ever asked, and
  // rl.question drops lines that arrive with no question pending and rejects
  // once the interface closes. With a buffer, early answers wait for their
  // prompt and EOF resolves to null exactly when no answer is left.
  const pendingLines: string[] = [];
  let lineWaiter: ((line: string | null) => void) | null = null;
  let inputClosed = false;
  if (rl) {
    rl.on('line', (line) => {
      if (lineWaiter) {
        const w = lineWaiter;
        lineWaiter = null;
        w(line);
      } else {
        pendingLines.push(line);
      }
    });
    rl.on('close', () => {
      inputClosed = true;
      if (lineWaiter) {
        const w = lineWaiter;
        lineWaiter = null;
        w(null);
      }
    });
  }
  /** Prints the prompt and resolves with the next input line, or null on EOF. */
  function nextAnswer(prompt: string): Promise<string | null> {
    process.stdout.write(prompt);
    if (pendingLines.length > 0) return Promise.resolve(pendingLines.shift()!);
    if (inputClosed) return Promise.resolve(null);
    return new Promise((resolve) => {
      lineWaiter = resolve;
    });
  }

  let appliedCount = 0;
  let staleSkippedCount = 0;
  let answerIndex = 0;
  const written = new Set<string>();

  try {
    for (const unit of units) {
      const staleFiles = (unit.skipIfModified ?? [])
        .map((p) => path.resolve(options.repoRoot, p))
        .filter((p) => written.has(p));
      if (staleFiles.length > 0) {
        log('\n' + RULE);
        for (const line of unit.headerLines ?? []) log(line);
        const rels = staleFiles.map((p) => path.relative(options.repoRoot, p)).join(', ');
        log(
          `Skipped: ${rels} changed earlier in this run, so this fix's line numbers may be stale. ` +
            'Re-run the command to apply it against the updated file.',
        );
        staleSkippedCount++;
        continue;
      }

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
          const answer = await nextAnswer(promptText);
          if (answer === null) {
            throw new NonInteractiveError(
              'The confirmation prompt could not be answered: stdin is not an interactive terminal and ended with no answer. ' +
                'Re-run with --no-interactive to apply changes without prompting, pipe answers on stdin, or run inside a TTY.',
            );
          }
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
        written.add(resolvedFile);
        log(`Applied change to ${path.relative(options.repoRoot, resolvedFile)}`);
      }
      appliedCount++;
    }
  } finally {
    rl?.close();
  }

  return { appliedCount, staleSkippedCount };
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
