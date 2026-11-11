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
 * Deliberately excluded: `security`, `missing_context`, `command_validity`,
 * `ai_config`, `agent_practices` and `custom`. Those findings are about
 * correctness, absence or configuration, not size; fixing them rarely shrinks
 * the file (missing_context asks for MORE text), so counting their lines would
 * overstate what a visitor could save. Every finding still gets its own
 * `estimatedTokens` regardless of category.
 */
export const ADDRESSABLE_CATEGORIES: ReadonlySet<IssueCategory> = new Set<IssueCategory>([
  'duplicate',
  'context_bloat',
  'stale_instruction',
  'conflict',
  'vague_guidance',
  'structure',
]);

/** The chars/4 estimator shared with `InstructionFile.estimatedTokens`. */
export function estimateTokens(charCount: number): number {
  return Math.round(charCount / 4);
}

type Range = [start: number, end: number]; // 1-based, inclusive

function normPath(p: string): string {
  return path.resolve(p).split(path.sep).join('/').toLowerCase();
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

function makeResolver(files: InstructionFile[]): Resolver {
  const byPath = new Map<string, InstructionFile>();
  for (const f of files) byPath.set(normPath(f.path), f);
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

/** Ranges the issue covers, grouped per scanned file. Locations outside `files` are ignored. */
function issueRanges(issue: PromptCiIssue, resolve: Resolver): Map<InstructionFile, Range[]> {
  const out = new Map<InstructionFile, Range[]>();
  for (const loc of issue.locations ?? []) {
    const file = resolve(loc.filePath);
    if (!file) continue;
    const list = out.get(file) ?? [];
    list.push(locationRange(loc, file));
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
): PromptCiIssue[] {
  const resolve = makeResolver(files);
  const costCache = new Map<InstructionFile, number[]>();
  return issues.map((issue) => {
    const ranges = issueRanges(issue, resolve);
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
 * Tokens in the lines flagged by addressable-category findings, across
 * ALWAYS-LOADED files only. Overlapping ranges (from one or many findings) are
 * merged per file so a shared section counts once. On-demand files are not in
 * `alwaysLoaded`, so they can never contribute. The result is capped at the sum
 * of the always-loaded files' own estimates.
 */
export function computeAddressableTokens(
  issues: PromptCiIssue[],
  alwaysLoaded: InstructionFile[],
): number {
  const resolve = makeResolver(alwaysLoaded);
  const perFile = new Map<InstructionFile, Range[]>();
  for (const issue of issues) {
    if (!ADDRESSABLE_CATEGORIES.has(issue.category)) continue;
    for (const [file, list] of issueRanges(issue, resolve)) {
      perFile.set(file, [...(perFile.get(file) ?? []), ...list]);
    }
  }
  let total = 0;
  for (const [file, list] of perFile) {
    total += tokensInRanges(file, lineCosts(file), list);
  }
  const ceiling = alwaysLoaded.reduce((sum, f) => sum + f.estimatedTokens, 0);
  return Math.min(total, ceiling);
}
