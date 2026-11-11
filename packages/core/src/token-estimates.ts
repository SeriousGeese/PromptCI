/**
 * Token estimates for findings and the report-level "addressable" figure.
 *
 * Uses the same chars/4 estimator as `InstructionFile.estimatedTokens`, applied
 * to the lines a finding covers. Pure and deterministic: no I/O, no clock.
 */

import * as path from 'node:path';
import type { InstructionFile, IssueCategory, PromptCiIssue } from './types.js';

/**
 * Categories whose savings come from removing or condensing text, so the lines
 * they flag count toward `estimatedAddressableTokens`.
 *
 * Deliberately excluded: `structure`, `security`, `missing_context`,
 * `command_validity`, `ai_config`, `agent_practices` and `custom`. Those findings
 * are about placement, correctness, absence or configuration, not size; fixing
 * them rarely shrinks the file (structure fixes move lines or correct a path,
 * missing_context asks for MORE text), so counting their lines would overstate
 * what a visitor could save. Every finding still gets its own `estimatedTokens`
 * regardless of category.
 */
export const ADDRESSABLE_CATEGORIES: ReadonlySet<IssueCategory> = new Set<IssueCategory>([
  'duplicate',
  'context_bloat',
  'stale_instruction',
  'conflict',
  'vague_guidance',
]);

/** The chars/4 estimator shared with `InstructionFile.estimatedTokens`. */
export function estimateTokens(charCount: number): number {
  return Math.round(charCount / 4);
}

type Range = [start: number, end: number]; // 1-based, inclusive

// Windows and macOS file systems are case-insensitive by default; Linux is not.
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

function normPath(p: string): string {
  const normalized = path.resolve(p).split(path.sep).join('/');
  return CASE_INSENSITIVE_FS ? normalized.toLowerCase() : normalized;
}

/** Lines of a file with their char cost (line text plus its newline). */
function lineCosts(file: InstructionFile): number[] {
  const parts = file.content.split('\n');
  if (file.content.endsWith('\n')) parts.pop();
  return parts.map((line) => line.length + 1);
}

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Range[] = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** Tokens in the merged ranges of one file, never above the file's own estimate. */
function tokensInRanges(file: InstructionFile, costs: number[], ranges: Range[]): number {
  let chars = 0;
  for (const [start, end] of mergeRanges(ranges)) {
    for (let line = Math.max(1, start); line <= Math.min(end, costs.length); line++) {
      chars += costs[line - 1]!;
    }
  }
  return Math.min(estimateTokens(chars), file.estimatedTokens);
}

type Resolver = (filePath: string) => InstructionFile | undefined;

/**
 * Maps a location's path to the scanned file it refers to. A symlink alias
 * (`CLAUDE.md -> README.md`) is registered under its own path and resolves to
 * the real file in `files`, so findings reported against the alias still count.
 * An alias whose target is not in `files` (for example an on-demand file when
 * only always-loaded files are passed) resolves to nothing.
 */
function makeResolver(files: InstructionFile[], aliases: InstructionFile[] = []): Resolver {
  const byPath = new Map<string, InstructionFile>();
  for (const f of files) byPath.set(normPath(f.path), f);
  const byRelative = new Map<string, InstructionFile>();
  for (const f of files) if (f.relativePath) byRelative.set(f.relativePath, f);
  for (const alias of aliases) {
    const target = alias.aliasOf ? byRelative.get(alias.aliasOf) : undefined;
    if (target) byPath.set(normPath(alias.path), target);
  }
  return (filePath) => byPath.get(normPath(filePath));
}

/** A location with no start line is a whole-file finding. */
function locationRange(
  loc: { startLine?: number; endLine?: number },
  file: InstructionFile,
): Range {
  if (loc.startLine === undefined) return [1, Math.max(1, file.lineCount)];
  const start = Math.max(1, loc.startLine);
  return [start, Math.max(start, loc.endLine ?? loc.startLine)];
}

type Entry = { file: InstructionFile; range: Range; whole: boolean };

/** One entry per location that resolves to a scanned file; the rest are ignored. */
function issueEntries(issue: PromptCiIssue, resolve: Resolver): Entry[] {
  const out: Entry[] = [];
  for (const loc of issue.locations ?? []) {
    const file = resolve(loc.filePath);
    if (!file) continue;
    out.push({ file, range: locationRange(loc, file), whole: loc.startLine === undefined });
  }
  return out;
}

function groupByFile(entries: Entry[]): Map<InstructionFile, Range[]> {
  const out = new Map<InstructionFile, Range[]>();
  for (const { file, range } of entries) {
    const list = out.get(file) ?? [];
    list.push(range);
    out.set(file, list);
  }
  return out;
}

/**
 * Return the issues with `estimatedTokens` set to the tokens in the lines each
 * covers (overlaps within one finding counted once). Issues that point at no
 * scanned file are returned untouched. Never mutates its input.
 */
export function annotateIssueTokens(
  issues: PromptCiIssue[],
  files: InstructionFile[],
  aliases: InstructionFile[] = [],
): PromptCiIssue[] {
  const resolve = makeResolver(files, aliases);
  const costCache = new Map<InstructionFile, number[]>();
  return issues.map((issue) => {
    const ranges = groupByFile(issueEntries(issue, resolve));
    if (ranges.size === 0) return issue;
    let tokens = 0;
    for (const [file, list] of ranges) {
      let costs = costCache.get(file);
      if (!costs) costCache.set(file, (costs = lineCosts(file)));
      tokens += tokensInRanges(file, costs, list);
    }
    return { ...issue, estimatedTokens: tokens };
  });
}

/**
 * Categories where the same text appears in several places and fixing keeps
 * one copy: every location counts except the largest one.
 */
const KEEP_LARGEST_CATEGORIES: ReadonlySet<IssueCategory> = new Set<IssueCategory>([
  'duplicate',
  'conflict',
]);

/**
 * Tokens in the lines flagged by addressable-category findings, across
 * ALWAYS-LOADED files only. Rules, in order:
 *  - Whole-file locations (no `startLine`) contribute nothing: a finding about
 *    the file as a whole (total size, a version conflict) says nothing about
 *    which text could go, and would otherwise make the figure 100% of the load.
 *  - For duplicate and conflict findings with several located sections, the
 *    largest one is kept (fixing leaves one copy), the others count.
 *  - Remaining ranges are merged per file, so overlaps count once.
 * On-demand files are not in `alwaysLoaded`, so they never contribute. The
 * result is capped at the sum of the always-loaded files' own estimates.
 */
export function computeAddressableTokens(
  issues: PromptCiIssue[],
  alwaysLoaded: InstructionFile[],
  aliases: InstructionFile[] = [],
): number {
  const resolve = makeResolver(alwaysLoaded, aliases);
  const costCache = new Map<InstructionFile, number[]>();
  const costsOf = (file: InstructionFile): number[] => {
    let costs = costCache.get(file);
    if (!costs) costCache.set(file, (costs = lineCosts(file)));
    return costs;
  };
  const chars = (e: Entry): number => {
    const costs = costsOf(e.file);
    let sum = 0;
    for (let l = Math.max(1, e.range[0]); l <= Math.min(e.range[1], costs.length); l++) sum += costs[l - 1]!;
    return sum;
  };

  const perFile = new Map<InstructionFile, Range[]>();
  for (const issue of issues) {
    if (!ADDRESSABLE_CATEGORIES.has(issue.category)) continue;
    let entries = issueEntries(issue, resolve).filter((e) => !e.whole);
    if (KEEP_LARGEST_CATEGORIES.has(issue.category) && entries.length > 1) {
      let largest = 0;
      entries.forEach((e, i) => {
        if (chars(e) > chars(entries[largest]!)) largest = i;
      });
      entries = entries.filter((_, i) => i !== largest);
    }
    for (const { file, range } of entries) {
      const list = perFile.get(file);
      if (list) list.push(range);
      else perFile.set(file, [range]);
    }
  }
  let total = 0;
  for (const [file, list] of perFile) total += tokensInRanges(file, costsOf(file), list);
  const ceiling = alwaysLoaded.reduce((sum, f) => sum + f.estimatedTokens, 0);
  return Math.min(total, ceiling);
}
