/**
 * Markdown and JSON report generation for PromptCI scan results.
 */

import * as fs from 'node:fs/promises';
import * as nodePath from 'node:path';
import type { IssueSeverity, PromptCiIssue, ScanReport, ScanReportJson, ScanTrend } from './types.js';
import { computeFingerprint } from './baseline.js';

export type WriteReportOptions = {
  /** Override path for the markdown report (default: <repoPath>/.promptci/latest.md) */
  mdPath?: string;
  /** Override path for the JSON report (default: <repoPath>/.promptci/report.json) */
  jsonPath?: string;
  /**
   * If false, skip archiving the previous report before overwriting.
   * Defaults to true. Set to false when writing to custom paths.
   */
  archive?: boolean;
};

/**
 * One entry in the history index — a compact summary of a single past scan.
 * Stored in .promptci/history/index.json as an append-only array.
 */
export type HistoryEntry = {
  /** ISO-8601 timestamp of when the scan was run. */
  generatedAt: string;
  /** Health score at time of scan (0–100). */
  healthScore: number;
  /** Issue counts by severity. */
  issueCount: {
    critical: number;
    high: number;
    warning: number;
    info: number;
  };
  /** Path to the archived markdown report, relative to the repo root. */
  archiveMdPath: string;
  /** Path to the archived JSON report, relative to the repo root. */
  archiveJsonPath: string;
};

const SEVERITY_LABEL: Record<IssueSeverity, string> = {
  critical: 'CRITICAL',
  high: 'HIGH',
  warning: 'WARNING',
  info: 'INFO',
};

const SEVERITY_EMOJI: Record<IssueSeverity, string> = {
  critical: '🔴',
  high: '🟠',
  warning: '🟡',
  info: '🔵',
};

const SEVERITY_ORDER: Record<IssueSeverity, number> = {
  critical: 0,
  high: 1,
  warning: 2,
  info: 3,
};

/**
 * Return a path relative to repoPath for display in reports.
 * Falls back to the absolute path if the relative form escapes the repo root.
 */
function relPath(absPath: string, repoPath: string): string {
  const rel = nodePath.relative(repoPath, absPath);
  if (!rel || rel.startsWith('..')) return absPath;
  return rel;
}

type TrendIssueLike = {
  id?: string;
  category?: string;
  severity?: string;
  title?: string;
  filePaths?: string[];
  evidence?: string[];
};

/**
 * Issue identity for the trend, delegated to the baseline's fingerprint so
 * both answer "is this the same issue?" the same way.
 *
 * The trend used to hash severity into its own key and leave evidence out.
 * A finding that merely got worse therefore vanished from one side and
 * appeared on the other — reported as one resolved plus one new issue, while
 * the baseline, reading the same two scans, correctly reported a single
 * issue whose severity had risen.
 */
function trendIssueKey(issue: TrendIssueLike, repoPath?: string): string {
  return computeFingerprint(
    {
      category: issue.category ?? '',
      title: issue.title ?? '',
      filePaths: issue.filePaths ?? [],
      evidence: issue.evidence ?? [],
    },
    repoPath,
  );
}

/**
 * No pre-dedup by raw id here. That guard (R2) belonged to the old
 * severity+idFamily key; with content-based fingerprints, exact duplicates
 * already collapse in the callers' Sets, and skipping on a repeated id would
 * silently drop a DISTINCT finding that happens to share an id — the very
 * detector-bug class R2 existed to keep out of the counts. The baseline
 * (createBaseline/filterNewIssues) keeps both findings in that case, and after
 * issue-identity unification the trend must agree with it.
 */
function trendIssueKeys(issues: TrendIssueLike[], repoPath?: string): string[] {
  return issues.map((issue) => trendIssueKey(issue, repoPath));
}

function scoreBar(score: number): string {
  const filled = Math.round(score / 10);
  const empty = 10 - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

// Exported so consumers that band the score (e.g. scripts/health-badge.mjs via
// its test) stay locked to the same thresholds used in the rendered report.
export function scoreLabel(score: number): string {
  if (score >= 90) return 'Healthy';
  if (score >= 70) return 'Fair';
  if (score >= 50) return 'Needs attention';
  return 'Critical issues found';
}

function groupIssuesBySeverity(issues: PromptCiIssue[]): Map<IssueSeverity, PromptCiIssue[]> {
  const map = new Map<IssueSeverity, PromptCiIssue[]>();
  for (const sev of ['critical', 'high', 'warning', 'info'] as IssueSeverity[]) {
    map.set(sev, []);
  }
  for (const issue of issues) {
    map.get(issue.severity)!.push(issue);
  }
  return map;
}

function sortedIssues(issues: PromptCiIssue[]): PromptCiIssue[] {
  return [...issues].sort((a, b) => {
    const sevDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (sevDiff !== 0) return sevDiff;
    const confDiff = b.confidence - a.confidence;
    if (confDiff !== 0) return confDiff;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Truncate evidence strings so the report stays readable.
 * Evidence items are often normalised section blobs — 100 chars is enough.
 */
function truncateEvidence(ev: string, maxLen = 100): string {
  const single = ev.replace(/\s+/g, ' ').trim();
  return single.length <= maxLen ? single : `${single.slice(0, maxLen)}…`;
}

function renderIssue(issue: PromptCiIssue, idx: number, rel: (p: string) => string): string {
  const emoji = SEVERITY_EMOJI[issue.severity];
  const label = SEVERITY_LABEL[issue.severity];
  const lines: string[] = [];

  lines.push(`### ${idx}. ${emoji} [${label}] ${issue.title}`);
  lines.push('');
  lines.push(`${issue.summary}`);
  lines.push('');

  // Always show affected files (canonical list)
  if (issue.filePaths.length > 0) {
    for (const fp of issue.filePaths) {
      lines.push(`**File:** \`${rel(fp)}\``);
    }
    lines.push('');
  }

  // Show line-number locations when available
  const withLines = issue.locations.filter((l) => l.startLine !== undefined);
  if (withLines.length > 0) {
    for (const loc of withLines) {
      const range =
        loc.endLine !== undefined ? `L${loc.startLine}–L${loc.endLine}` : `L${loc.startLine}`;
      lines.push(`**Location:** \`${rel(loc.filePath)}\` ${range}`);
    }
    lines.push('');
  }

  if (issue.evidence.length > 0) {
    lines.push('**Evidence:**');
    for (const ev of issue.evidence) {
      lines.push(`- ${truncateEvidence(ev)}`);
    }
    lines.push('');
  }

  lines.push(`> **Recommendation:** ${issue.recommendation}`);

  if (issue.fixRecipe) {
    lines.push('');
    lines.push('**Suggested text to add:**');
    lines.push('```markdown');
    lines.push(issue.fixRecipe);
    lines.push('```');
  }

  return lines.join('\n');
}

/**
 * Generate a Markdown-formatted scan report.
 */
export function generateMarkdownReport(report: ScanReport): string {
  const lines: string[] = [];
  const { healthScore, topFixes, issues, projectType, repoPath, generatedAt, filesScanned } =
    report;
  const rel = (absPath: string) => relPath(absPath, repoPath);

  // Header
  lines.push('# PromptCI Health Report');
  lines.push('');
  lines.push(`**Generated:** ${generatedAt}`);
  lines.push(`**Repo:** \`${repoPath}\``);
  lines.push(`**Project type:** ${projectType}`);
  lines.push(`**Files scanned:** ${filesScanned.length}`);
  if (report.metrics) {
    lines.push(`**Estimated instruction tokens:** ${report.metrics.estimatedInstructionTokens} (always-loaded)`);
    if (report.metrics.estimatedOnDemandTokens) {
      lines.push(
        `**On-demand skill/agent tokens:** ${report.metrics.estimatedOnDemandTokens} ` +
          `across ${report.metrics.onDemandFileCount} file(s) — loaded only when invoked, not counted above`,
      );
    }
  }
  lines.push('');

  // Health score
  lines.push('## Health Score');
  lines.push('');
  lines.push('```');
  lines.push(`${scoreBar(healthScore)}  ${healthScore}/100  ${scoreLabel(healthScore)}`);
  lines.push('```');
  lines.push('');

  // Issue summary counts
  const grouped = groupIssuesBySeverity(issues);
  if (issues.length > 0) {
    const countParts: string[] = [];
    for (const sev of ['critical', 'high', 'warning', 'info'] as IssueSeverity[]) {
      const n = grouped.get(sev)!.length;
      if (n > 0) countParts.push(`${SEVERITY_EMOJI[sev]} ${n} ${sev}`);
    }
    lines.push(countParts.join(' · '));
    lines.push('');
  }

  // Trend
  lines.push('## Trend');
  lines.push('');
  if (report.trend) {
    const t = report.trend;
    if (t.previousScanDate) {
      lines.push(`- **Previous scan:** ${t.previousScanDate}`);
    }
    const scoreSign = t.scoreDelta > 0 ? `+${t.scoreDelta}` : `${t.scoreDelta}`;
    lines.push(`- **Score change:** ${scoreSign}`);
    lines.push(`- **New issues:** ${t.newIssuesCount}`);
    lines.push(`- **Resolved issues:** ${t.resolvedIssuesCount}`);

    const cats = Object.keys(t.categoryDeltas);
    if (cats.length > 0) {
      lines.push('- **Category changes:**');
      for (const cat of cats) {
        const deltaVal = t.categoryDeltas[cat]!;
        const deltaSign = deltaVal > 0 ? `+${deltaVal}` : `${deltaVal}`;
        lines.push(`  - ${cat}: ${deltaSign}`);
      }
    }

    if (t.streak > 0) {
      lines.push(`- **Streak:** ${t.streak} scan(s) without high/critical issues`);
    }
  } else {
    lines.push('First scan — no trend data available yet.');
  }
  lines.push('');

  // Top fixes
  if (topFixes.length > 0) {
    lines.push('## Top Fixes');
    lines.push('');
    topFixes.forEach((fix, i) => {
      lines.push(`**${i + 1}. ${fix.title}**`);
      lines.push('');
      lines.push(`${fix.reason}`);
      lines.push('');
      lines.push(`*Action:* ${fix.suggestedAction}`);
      lines.push('');
    });
  }

  // Issues
  if (issues.length === 0) {
    lines.push('## Issues');
    lines.push('');
    lines.push('No issues found. Instruction files look good!');
    lines.push('');
  } else {
    lines.push('## Issues');
    lines.push('');

    const ordered = sortedIssues(issues);
    ordered.forEach((issue, i) => {
      lines.push(renderIssue(issue, i + 1, rel));
      lines.push('');
      lines.push('---');
      lines.push('');
    });
  }

  // Suppressed issues
  const suppressed = report.suppressedIssues;
  if (suppressed && suppressed.length > 0) {
    lines.push(`## Suppressed (${suppressed.length})`);
    lines.push('');
    lines.push(
      `The following ${suppressed.length === 1 ? 'issue was' : 'issues were'} silenced by ` +
      `inline \`promptci-ignore\` annotations and do not affect the health score.`,
    );
    lines.push('');
    for (const s of suppressed) {
      const primaryFile = s.filePaths[0] ? rel(s.filePaths[0]) : '(unknown)';
      const loc = s.locations.find((l) => l.startLine !== undefined);
      const lineRef = loc
        ? ` L${loc.startLine}${loc.endLine ? `–${loc.endLine}` : ''}`
        : '';
      lines.push(`- **${s.category}** in \`${primaryFile}\`${lineRef}`);
    }
    lines.push('');
  }

  // Files scanned
  if (filesScanned.length > 0) {
    lines.push('## Files Scanned');
    lines.push('');
    for (const f of filesScanned) {
      lines.push(`- \`${rel(f.path)}\` (${f.fileType}, ${f.lineCount} lines, ~${f.estimatedTokens} tokens)`);
    }
    lines.push('');
  }

  // Footer
  lines.push('---');
  lines.push(
    '> Findings are heuristic. Review each item before acting. ' +
      'This report identifies patterns — it does not auto-fix.',
  );
  lines.push('');
  lines.push('*Generated by [PromptCI](https://github.com/SeriousGeese/PromptCI)*');

  return lines.join('\n');
}

/**
 * Serialize a ScanReport to JSON (schema v0.1).
 *
 * All file paths are repo-relative so reports are portable — the absolute
 * repo root is preserved as `repoPath` so callers can reconstruct full paths.
 * Verbose section content is excluded from filesScanned to keep output compact.
 */
export function generateJsonReport(report: ScanReport, pretty = true): string {
  const rel = (absPath: string) => relPath(absPath, report.repoPath);

  // R1: typed as ScanReportJson (the COMPACT shape actually written to disk),
  // not ScanReport — filesScanned below intentionally omits `content` and
  // `sections` to keep report.json from duplicating every scanned file's
  // full text. Typing the payload accurately here means a consumer that
  // imports ScanReportJson (instead of misusing ScanReport) gets a type that
  // matches reality.
  const payload: ScanReportJson = {
    schemaVersion: report.schemaVersion,
    generatedAt: report.generatedAt,
    repoPath: report.repoPath,
    projectType: report.projectType,
    healthScore: report.healthScore,
    topFixes: report.topFixes,
    ...(report.metrics ? { metrics: report.metrics } : {}),
    ...(report.trend ? { trend: report.trend } : {}),
    issues: report.issues.map((issue) => ({
      ...issue,
      filePaths: issue.filePaths.map(rel),
      locations: issue.locations.map((loc) => ({
        ...loc,
        filePath: rel(loc.filePath),
      })),
    })),
    filesScanned: report.filesScanned.map((f) => ({
      path: rel(f.path),
      fileType: f.fileType,
      lineCount: f.lineCount,
      charCount: f.charCount,
      estimatedTokens: f.estimatedTokens,
    })),
    ...(report.suppressedIssues && report.suppressedIssues.length > 0
      ? {
          suppressedIssues: report.suppressedIssues.map((issue) => ({
            ...issue,
            filePaths: issue.filePaths.map(rel),
            locations: issue.locations.map((loc) => ({ ...loc, filePath: rel(loc.filePath) })),
          })),
        }
      : {}),
  };
  return pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
}

// ── History helpers ───────────────────────────────────────────────────────────

/** Path to the history index file for a given repo. */
export function historyIndexPath(repoPath: string): string {
  return nodePath.join(repoPath, '.promptci', 'history', 'index.json');
}

/**
 * Read the history index for a repo, returning an empty array if it doesn't
 * exist yet or cannot be parsed.
 */
export async function readHistoryIndex(repoPath: string): Promise<HistoryEntry[]> {
  const indexPath = historyIndexPath(repoPath);
  try {
    const raw = await fs.readFile(indexPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as HistoryEntry[];
  } catch {
    // File missing or corrupt — start fresh
  }
  return [];
}

/**
 * Archive the current latest.md and report.json (if they exist) into
 * .promptci/history/<slug>/ and append a compact entry to the history index.
 *
 * The slug is derived from the report's generatedAt timestamp so archives are
 * human-readable on disk. Returns the new HistoryEntry, or null if there was
 * nothing to archive.
 */
export async function archiveExistingReport(
  repoPath: string,
  latestMdPath: string,
  latestJsonPath: string,
): Promise<HistoryEntry | null> {
  // Check whether there is an existing JSON report to archive
  let existingJson: string;
  try {
    existingJson = await fs.readFile(latestJsonPath, 'utf8');
  } catch {
    return null; // Nothing to archive yet
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(existingJson) as Record<string, unknown>;
  } catch {
    return null; // Corrupt report — skip archiving
  }

  const generatedAt = typeof parsed.generatedAt === 'string' ? parsed.generatedAt : new Date().toISOString();

  // Build a filesystem-safe slug from the timestamp (replace colons and dots)
  const slug = generatedAt.replace(/[:.]/g, '-').replace(/Z$/, 'Z');
  const archiveDir = nodePath.join(repoPath, '.promptci', 'history', slug);
  await fs.mkdir(archiveDir, { recursive: true });

  const archiveMdRel = nodePath.join('.promptci', 'history', slug, 'report.md');
  const archiveJsonRel = nodePath.join('.promptci', 'history', slug, 'report.json');
  const archiveMdAbs = nodePath.join(repoPath, archiveMdRel);
  const archiveJsonAbs = nodePath.join(repoPath, archiveJsonRel);

  // Copy existing md (best-effort — may not exist on first run)
  try {
    await fs.copyFile(latestMdPath, archiveMdAbs);
  } catch {
    // latest.md didn't exist; write a placeholder
    await fs.writeFile(archiveMdAbs, existingJson, 'utf8');
  }
  await fs.copyFile(latestJsonPath, archiveJsonAbs);

  // Build the compact history entry from the parsed JSON
  const issues = Array.isArray(parsed.issues) ? (parsed.issues as Array<{ severity: string }>) : [];
  const issueCount = { critical: 0, high: 0, warning: 0, info: 0 };
  for (const issue of issues) {
    const sev = issue.severity as keyof typeof issueCount;
    if (sev in issueCount) issueCount[sev]++;
  }

  const entry: HistoryEntry = {
    generatedAt,
    healthScore: typeof parsed.healthScore === 'number' ? parsed.healthScore : 0,
    issueCount,
    archiveMdPath: archiveMdRel,
    archiveJsonPath: archiveJsonRel,
  };

  // Append to the index
  const existing = await readHistoryIndex(repoPath);
  existing.push(entry);
  const indexPath = historyIndexPath(repoPath);
  await fs.mkdir(nodePath.dirname(indexPath), { recursive: true });
  await fs.writeFile(indexPath, JSON.stringify(existing, null, 2), 'utf8');

  return entry;
}

// ── writeReport ───────────────────────────────────────────────────────────────

/**
 * Write markdown and JSON reports to disk.
 *
 * Default output paths (relative to the repo root):
 *   .promptci/latest.md
 *   .promptci/report.json
 *
 * Before overwriting, the previous reports are archived to:
 *   .promptci/history/<timestamp>/report.md
 *   .promptci/history/<timestamp>/report.json
 *
 * A compact history index is maintained at:
 *   .promptci/history/index.json
 *
 * The .promptci/ directory is created if it does not exist.
 */
export async function writeReport(
  report: ScanReport,
  options: WriteReportOptions = {},
): Promise<{ mdPath: string; jsonPath: string; archivedEntry: HistoryEntry | null }> {
  const outputDir = nodePath.join(report.repoPath, '.promptci');
  const resolvedMd = options.mdPath ?? nodePath.join(outputDir, 'latest.md');
  const resolvedJson = options.jsonPath ?? nodePath.join(outputDir, 'report.json');

  await fs.mkdir(nodePath.dirname(resolvedMd), { recursive: true });
  await fs.mkdir(nodePath.dirname(resolvedJson), { recursive: true });

  // Load previous report and history index to compute trend
  const previousReport = await loadPreviousReport(resolvedJson);
  const history = await readHistoryIndex(report.repoPath);
  const trend = await computeTrend(report, previousReport, history);
  if (trend) {
    report.trend = trend;
  }

  // Archive the previous report before overwriting (only for default paths)
  const shouldArchive = options.archive !== false && !options.mdPath && !options.jsonPath;
  const archivedEntry = shouldArchive
    ? await archiveExistingReport(report.repoPath, resolvedMd, resolvedJson)
    : null;

  const md = generateMarkdownReport(report);
  const json = generateJsonReport(report);

  await Promise.all([fs.writeFile(resolvedMd, md, 'utf8'), fs.writeFile(resolvedJson, json, 'utf8')]);

  return { mdPath: resolvedMd, jsonPath: resolvedJson, archivedEntry };
}

async function loadPreviousReport(path: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(path, 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function computeTrend(
  report: ScanReport,
  previousReport: Record<string, unknown> | null,
  history: HistoryEntry[],
): Promise<ScanTrend | null> {
  if (!previousReport) return null;
  try {
    const currentIssues = report.issues || [];
    const previousIssues = Array.isArray(previousReport.issues)
      ? (previousReport.issues as TrendIssueLike[])
      : [];

    // Both sides are keyed against the same repo root. The previous report's
    // paths are already repo-relative and pass through untouched, but its
    // EVIDENCE was serialized raw — absolute paths and all — so it needs the
    // same `<repo>` substitution the current side gets, or identical findings
    // fingerprint differently across the two scans.
    const currentIds = new Set(trendIssueKeys(currentIssues, report.repoPath));
    const previousIds = new Set(trendIssueKeys(previousIssues, report.repoPath));

    // R2: derive new/resolved ids from the DEDUPLICATED id sets, not by
    // filtering the raw (possibly duplicated) issues arrays. The old code
    // assumed every issue in `currentIssues`/`previousIssues` had a unique
    // id — if a detector bug ever emits the same id for two different
    // findings (the exact BUG-B class of bug, now fixed at the source, but
    // this function shouldn't silently corrupt counts if it recurs), both
    // duplicates got counted/listed, inflating newIssuesCount/
    // resolvedIssuesCount and putting the same id twice in
    // newIssueIds/resolvedIssueIds.
    const newIssueIds = [...currentIds].filter((id) => !previousIds.has(id));
    const resolvedIssueIds = [...previousIds].filter((id) => !currentIds.has(id));

    const categories = new Set<string>([
      ...currentIssues.map((i) => i.category),
      ...previousIssues.map((i) => i.category),
    ].filter((category): category is string => typeof category === 'string'));
    const categoryDeltas: Record<string, number> = {};
    for (const cat of categories) {
      if (!cat) continue;
      const currentCount = currentIssues.filter((i) => i.category === cat).length;
      const previousCount = previousIssues.filter((i) => i.category === cat).length;
      categoryDeltas[cat] = currentCount - previousCount;
    }

    const severities: IssueSeverity[] = ['critical', 'high', 'warning', 'info'];
    const severityDeltas: Record<string, number> = {};
    for (const sev of severities) {
      const currentCount = currentIssues.filter((i) => i.severity === sev).length;
      const previousCount = previousIssues.filter((i) => i.severity === sev).length;
      severityDeltas[sev] = currentCount - previousCount;
    }

    const currentHighOrCriticalCount = currentIssues.filter(
      (i) => i.severity === 'high' || i.severity === 'critical',
    ).length;

    let streak = 0;
    if (currentHighOrCriticalCount === 0) {
      streak = 1;
      const prevHighOrCriticalCount = previousIssues.filter(
        (i) => i.severity === 'high' || i.severity === 'critical',
      ).length;

      if (prevHighOrCriticalCount === 0) {
        streak++;
        // Go backwards through history
        for (let i = history.length - 1; i >= 0; i--) {
          const h = history[i];
          if (h && (h.issueCount.high ?? 0) === 0 && (h.issueCount.critical ?? 0) === 0) {
            streak++;
          } else {
            break;
          }
        }
      }
    }

    const prevDate = typeof previousReport.generatedAt === 'string' ? previousReport.generatedAt : undefined;
    const prevScore = typeof previousReport.healthScore === 'number' ? previousReport.healthScore : 0;

    return {
      previousScanDate: prevDate,
      scoreDelta: report.healthScore - prevScore,
      newIssuesCount: newIssueIds.length,
      resolvedIssuesCount: resolvedIssueIds.length,
      severityDeltas,
      categoryDeltas,
      newIssueIds,
      resolvedIssueIds,
      streak,
    };
  } catch {
    return null;
  }
}
