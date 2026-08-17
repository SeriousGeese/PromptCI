import * as nodePath from 'node:path';
import type { IssueSeverity, PromptCiIssue, ScanReport, TopFix, HistoryEntry } from '@promptci/core';

export type SummaryOptions = {
  mdPath?: string;
  jsonPath?: string;
  /** The archived entry from the previous scan, used to show a score delta. */
  previousEntry?: HistoryEntry | null;
};

const SEVERITY_EMOJI: Record<IssueSeverity, string> = {
  critical: '🔴',
  high: '🟠',
  warning: '🟡',
  info: '🔵',
};

const SEVERITIES: IssueSeverity[] = ['critical', 'high', 'warning', 'info'];

const SEVERITY_RANK: Record<IssueSeverity, number> = {
  critical: 3,
  high: 2,
  warning: 1,
  info: 0,
};

export function severityRank(s: IssueSeverity): number {
  return SEVERITY_RANK[s];
}

export function meetsThreshold(severity: IssueSeverity, threshold: IssueSeverity): boolean {
  return severityRank(severity) >= severityRank(threshold);
}

export function anyIssuesMeetThreshold(report: ScanReport, threshold: IssueSeverity): boolean {
  return report.issues.some((i: PromptCiIssue) => meetsThreshold(i.severity, threshold));
}

function formatDelta(current: number, previous: number): string {
  const diff = current - previous;
  if (diff > 0) return `  \x1b[32m(↑${diff} vs last run)\x1b[0m`;
  if (diff < 0) return `  \x1b[31m(↓${Math.abs(diff)} vs last run)\x1b[0m`;
  return `  \x1b[90m(= no change vs last run)\x1b[0m`;
}

export function formatSummary(report: ScanReport, options: SummaryOptions = {}): string {
  const { healthScore, issues, topFixes } = report;

  const counts: Partial<Record<IssueSeverity, number>> = {};
  for (const issue of issues) {
    counts[issue.severity] = (counts[issue.severity] ?? 0) + 1;
  }

  const countParts = SEVERITIES.filter((s) => (counts[s] ?? 0) > 0)
    .map((s) => `${SEVERITY_EMOJI[s]} ${counts[s]!} ${s}`)
    .join(' · ');

  const delta =
    options.previousEntry != null ? formatDelta(healthScore, options.previousEntry.healthScore) : '';

  let healthScoreLine = `  Health score: ${healthScore}/100`;
  if (report.trend) {
    const t = report.trend;
    const diff = t.scoreDelta;
    let deltaStr = '';
    if (diff > 0) deltaStr = `\x1b[32m(+${diff} vs last scan)\x1b[0m`;
    else if (diff < 0) deltaStr = `\x1b[31m(${diff} vs last scan)\x1b[0m`;
    else deltaStr = `\x1b[90m(+0 vs last scan)\x1b[0m`;

    healthScoreLine += ` ${deltaStr}; new issues: ${t.newIssuesCount}; resolved: ${t.resolvedIssuesCount}`;
  } else if (options.previousEntry != null) {
    healthScoreLine += delta;
  }

  const lines: string[] = [];
  lines.push('');
  lines.push('✔ Scan complete');
  lines.push('');
  lines.push(healthScoreLine);
  lines.push(`  Issues: ${countParts || 'none'}`);

  if (report.trend && report.trend.streak > 0) {
    lines.push(`  Streak: ${report.trend.streak} scan(s) without high/critical issues`);
  }

  if (report.newIssues !== undefined && report.baselinedIssues !== undefined) {
    lines.push(
      `  Baseline: ${report.baselinedIssues.length} issues in baseline, ` +
        `${report.newIssues.length} new issues.`,
    );
  }

  const suppressedCount = report.suppressedIssues?.length ?? 0;
  if (suppressedCount > 0) {
    lines.push(`  Suppressed: ${suppressedCount} (see report for details)`);
  }

  if (topFixes.length > 0) {
    lines.push('');
    lines.push('  Top fixes:');
    topFixes.forEach((fix: TopFix, i: number) => {
      lines.push(`    ${i + 1}. ${fix.title}`);
    });
  }

  const toRel = (p: string) => nodePath.relative(process.cwd(), p) || p;
  const outputLines: string[] = [];
  if (options.mdPath) outputLines.push(`    Markdown : ${toRel(options.mdPath)}`);
  if (options.jsonPath) outputLines.push(`    JSON     : ${toRel(options.jsonPath)}`);
  if (outputLines.length > 0) {
    lines.push('');
    lines.push('  Output:');
    lines.push(...outputLines);
  }

  lines.push('');
  return lines.join('\n');
}
