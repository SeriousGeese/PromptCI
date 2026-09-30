import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { scan, scoreLabel } from '@promptci/core';
import type { IssueSeverity, PromptCiIssue, ScanReport } from '@promptci/core';
import { loadConfig } from '../config.js';

/**
 * `promptci score` — the zero-signup, zero-footprint teaser.
 *
 * Scans locally and prints one overall score plus the three highest-severity
 * findings. Unlike `promptci scan` it writes NOTHING (no `.promptci/` reports,
 * no history archive) and, in cli.ts, skips the once-a-day npm version probe,
 * so the whole path is offline and read-only. It stores no report and has no
 * account, login, or upload step: the dashboard pointer below is plain text.
 */

/** Number of findings the teaser shows. */
export const TOP_FINDINGS_COUNT = 3;

/**
 * One-line pointer printed under the teaser. Plain text only: no account, no
 * upload URL, no tracking parameters. Set to '' to drop the line entirely.
 */
export const DASHBOARD_POINTER =
  'Full report, score history, and PR reviews: https://promptci.dev (hosted dashboard; optional)';

const SEVERITY_RANK: Record<IssueSeverity, number> = {
  critical: 3,
  high: 2,
  warning: 1,
  info: 0,
};

/**
 * The `count` top findings: severity descending, then confidence descending,
 * then id for a stable, deterministic tie-break. Same leading order as
 * `scan`'s "Top fixes", but without its one-per-category dedupe, so the list is
 * always exactly min(count, issues.length) long.
 */
export function selectTopFindings(
  issues: readonly PromptCiIssue[],
  count: number = TOP_FINDINGS_COUNT,
): PromptCiIssue[] {
  return [...issues]
    .sort(
      (a, b) =>
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
        b.confidence - a.confidence ||
        a.id.localeCompare(b.id),
    )
    .slice(0, count);
}

// Finding text is derived from scanned files, so strip control characters
// (including ESC) before printing: a repo must not be able to drive the
// terminal of whoever scores it.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const clean = (s: string): string => s.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();

/** Max characters of a fix recommendation shown in the teaser (full text lives in `scan`'s report). */
const FIX_PREVIEW_CHARS = 160;
const preview = (s: string): string => {
  const text = clean(s);
  return text.length > FIX_PREVIEW_CHARS ? `${text.slice(0, FIX_PREVIEW_CHARS - 1).trimEnd()}…` : text;
};

function locationOf(issue: PromptCiIssue, repoPath: string): string | undefined {
  const loc = issue.locations[0];
  const file = loc?.filePath ?? issue.filePaths[0];
  if (!file) return undefined;
  const rel = path.isAbsolute(file) ? path.relative(repoPath, file) : file;
  const shown = (rel || file).split(path.sep).join('/');
  return loc?.startLine !== undefined ? `${shown}:${loc.startLine}` : shown;
}

export function formatScoreTeaser(report: ScanReport): string {
  const lines: string[] = [''];

  if (report.filesScanned.length === 0) {
    lines.push('No instruction files found, so there is nothing to score.');
    lines.push('');
    return lines.join('\n');
  }

  const n = report.issues.length;
  lines.push(`PromptCI instruction health: ${report.healthScore}/100 (${scoreLabel(report.healthScore)})`);

  if (n === 0) {
    lines.push('No findings. Nice.');
  } else {
    const top = selectTopFindings(report.issues);
    lines.push('');
    lines.push(
      `Top ${top.length} finding${top.length === 1 ? '' : 's'} (of ${n}):`,
    );
    top.forEach((issue, i) => {
      const at = locationOf(issue, report.repoPath);
      lines.push(`  ${i + 1}. [${issue.severity}] ${clean(issue.title)}${at ? ` (${clean(at)})` : ''}`);
      lines.push(`     Fix: ${preview(issue.recommendation)}`);
    });
  }

  if (DASHBOARD_POINTER) {
    lines.push('');
    lines.push(DASHBOARD_POINTER);
  }
  lines.push('');
  return lines.join('\n');
}

export type ScoreOptions = {
  scanPath?: string;
};

/**
 * Run the teaser. Exit codes: 0 after printing a score (or "nothing to
 * score"), regardless of findings, because this is a glance, not a gate; 1 for
 * a bad path or unreadable config. Use `scan --fail-on` to gate CI.
 */
export async function runScore(options: ScoreOptions): Promise<void> {
  const resolvedPath = path.resolve(options.scanPath ?? process.cwd());

  try {
    const stat = await fs.stat(resolvedPath);
    if (!stat.isDirectory()) {
      console.error(`Error: "${resolvedPath}" is not a directory.`);
      process.exit(1);
    }
  } catch {
    console.error(`Error: path does not exist: "${resolvedPath}"`);
    process.exit(1);
  }

  let config;
  try {
    config = await loadConfig(resolvedPath);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Same scan inputs as `promptci scan`, so the two commands agree on the score.
  const report = await scan({
    repoPath: resolvedPath,
    projectType: config.projectType,
    include: config.include,
    exclude: config.exclude,
    contextBudget: config.contextBudget,
    fileContextBudget: config.fileContextBudget,
    targetModel: config.targetModel,
    vagueGuidanceSeverity: config.vagueGuidanceSeverity,
  });

  process.stdout.write(formatScoreTeaser(report));
}
