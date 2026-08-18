import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type { IssueSeverity, PromptCiIssue, BaselineEntry, Baseline } from './types.js';

/**
 * Baseline & Ratchet Support
 *
 * Provides stable fingerprinting of issues and filtering logic so CI can fail
 * only on new or worsened issues — not pre-existing noise.
 *
 * Baseline file: `.promptci/baseline.json`
 * Format: `BaselineEntry[]`
 *
 * Fingerprint stability contract:
 *  - Based on category + title + sorted file paths + sorted evidence.
 *  - Line numbers are excluded so minor file edits do not break the baseline.
 *  - Severity is stored separately and checked for worsening.
 */

// ── Severity ordering ─────────────────────────────────────────────────────────

const SEVERITY_ORDER: Record<IssueSeverity, number> = {
  info: 0,
  warning: 1,
  high: 2,
  critical: 3,
};

function severityValue(s: string): number {
  return SEVERITY_ORDER[s as IssueSeverity] ?? -1;
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

function normalizePathForRoot(filePath: string, repoRoot?: string): string {
  if (!repoRoot) return filePath;

  try {
    const relative = path.relative(repoRoot, filePath);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      return normalizeSlashes(relative);
    }
  } catch {
    // Fall through to string normalization for unusual path formats.
  }

  const normalizedPath = normalizeSlashes(filePath);
  const rootCandidates = [
    normalizeSlashes(repoRoot).replace(/\/+$/, ''),
    normalizeSlashes(path.resolve(repoRoot)).replace(/\/+$/, ''),
  ];
  for (const normalizedRoot of rootCandidates) {
    if (normalizedPath === normalizedRoot) return '.';
    if (normalizedPath.startsWith(`${normalizedRoot}/`)) {
      return normalizedPath.slice(normalizedRoot.length + 1);
    }
  }
  return normalizedPath;
}

function normalizeEvidenceForRoot(evidence: string, repoRoot?: string): string {
  if (!repoRoot) return evidence;

  const normalizedEvidence = normalizeSlashes(evidence);
  const rootCandidates = [
    normalizeSlashes(repoRoot).replace(/\/+$/, ''),
    normalizeSlashes(path.resolve(repoRoot)).replace(/\/+$/, ''),
  ];
  return rootCandidates.reduce(
    (current, normalizedRoot) => current.replaceAll(normalizedRoot, '<repo>'),
    normalizedEvidence,
  );
}

// ── Fingerprinting ────────────────────────────────────────────────────────────

/**
 * The fields identity is computed from. Structural rather than
 * `PromptCiIssue`, so an issue rehydrated from a report's JSON — where
 * `category` is a plain string — fingerprints identically to the live one.
 */
export type FingerprintableIssue = {
  category: string;
  title: string;
  filePaths: string[];
  evidence: string[];
};

/**
 * Computes a stable fingerprint for an issue.
 *
 * This is the ONE answer to "are these two findings the same issue?" — the
 * report's trend section used to carry a second, incompatible one that keyed
 * on severity, so a severity bump read as "resolved + new" in the trend while
 * the baseline correctly reported one issue that had worsened.
 *
 * Excluded from fingerprint:
 *  - `id` (may change between versions)
 *  - `severity` (tracked separately for worsening detection)
 *  - `locations` / line numbers (unstable across minor file edits)
 *  - `confidence` (heuristic, may fluctuate)
 *
 * Included:
 *  - `category`, `title`, sorted `filePaths`, sorted `evidence`
 */
export function computeFingerprint(issue: FingerprintableIssue, repoRoot?: string): string {
  const normalizedFilePaths = issue.filePaths
    .map((filePath) => normalizePathForRoot(filePath, repoRoot))
    .sort();
  const normalizedEvidence = issue.evidence
    .map((evidence) => normalizeEvidenceForRoot(evidence, repoRoot))
    .sort();

  const content = [
    issue.category,
    issue.title,
    ...normalizedFilePaths,
    ...normalizedEvidence,
  ].join('|');

  return crypto.createHash('sha256').update(content).digest('hex');
}

// ── Baseline creation ─────────────────────────────────────────────────────────

/**
 * Creates a baseline from a list of active issues.
 * Produces deterministic JSON when sorted by fingerprint.
 */
export function createBaseline(issues: PromptCiIssue[], repoRoot?: string): Baseline {
  return issues
    .map((issue): BaselineEntry => ({
      id: issue.id,
      category: issue.category,
      title: issue.title,
      filePaths: issue.filePaths.map((filePath) => normalizePathForRoot(filePath, repoRoot)).sort(),
      severity: issue.severity,
      fingerprint: computeFingerprint(issue, repoRoot),
    }))
    .sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
}

// ── Baseline validation ───────────────────────────────────────────────────────

/**
 * Type-guard that asserts a parsed JSON value is a valid Baseline array.
 * Throws a descriptive error if the shape is unexpected.
 */
export function assertValidBaseline(value: unknown): asserts value is Baseline {
  if (!Array.isArray(value)) {
    throw new Error('Baseline file must contain a JSON array.');
  }
  for (let i = 0; i < value.length; i++) {
    const entry = value[i];
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`Baseline entry at index ${i} is not an object.`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e['fingerprint'] !== 'string') {
      throw new Error(`Baseline entry at index ${i} is missing a "fingerprint" string field.`);
    }
    if (typeof e['category'] !== 'string') {
      throw new Error(`Baseline entry at index ${i} is missing a "category" string field.`);
    }
  }
}

// ── Filtering ─────────────────────────────────────────────────────────────────

/**
 * Partitions a list of active issues into new and baselined issues.
 *
 * An issue is considered NEW (not baselined) if:
 *  - Its fingerprint is not in the baseline, OR
 *  - Its fingerprint IS in the baseline but its severity has worsened
 *    (e.g. was `warning`, now `high`).
 *
 * Issues with the same fingerprint and equal-or-lesser severity are
 * considered baselined (pre-existing) and do not fail `--fail-on-new` CI.
 */
export function filterNewIssues(
  issues: PromptCiIssue[],
  baseline: Baseline,
  repoRoot?: string,
): { newIssues: PromptCiIssue[]; baselinedIssues: PromptCiIssue[] } {
  // Build a map from fingerprint → baseline severity for worsening checks
  const baselineMap = new Map<string, string>();
  for (const entry of baseline) {
    baselineMap.set(entry.fingerprint, entry.severity ?? 'info');
  }

  const newIssues: PromptCiIssue[] = [];
  const baselinedIssues: PromptCiIssue[] = [];

  for (const issue of issues) {
    const fp = computeFingerprint(issue, repoRoot);
    const baselinedSeverity = baselineMap.get(fp);

    if (baselinedSeverity === undefined) {
      // Not in baseline at all → new
      newIssues.push(issue);
    } else if (severityValue(issue.severity) > severityValue(baselinedSeverity)) {
      // Severity worsened → treat as new/worsened
      newIssues.push(issue);
    } else {
      // Same or reduced severity → pre-existing
      baselinedIssues.push(issue);
    }
  }

  return { newIssues, baselinedIssues };
}
