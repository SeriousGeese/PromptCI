/**
 * SARIF 2.1.0 report generation for PromptCI scan results (pcic-aq2f).
 *
 * Competing tools already emit SARIF, which lands their findings in GitHub's
 * Security tab for teams that gate merges on code scanning; PromptCI findings
 * otherwise only show up in its own markdown/JSON report. This module maps a
 * `ScanReport` onto a SARIF log without changing anything about how findings
 * are detected or scored.
 *
 * Deterministic like the rest of the report pipeline (see report.ts /
 * AGENTS.md): no timestamps, no run-invocation metadata, stable ordering.
 */

import * as nodePath from 'node:path';
import type { IssueCategory, IssueSeverity, PromptCiIssue, ScanReport } from './types.js';
import { INSTRUCTION_FILE_TYPES } from './types.js';
import { computeFingerprint } from './baseline.js';

const PROMPTCI_REPO_URL = 'https://github.com/SeriousGeese/PromptCI';
// No per-category anchor exists in the README today; point every rule at the
// section that documents what gets detected until one does.
const DETECTOR_REFERENCE_URL = `${PROMPTCI_REPO_URL}#what-gets-detected`;

const SARIF_SCHEMA_URI =
  'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/sarif-2.1/schema/sarif-schema-2.1.0.json';

/**
 * Severity → SARIF level mapping (pcic-aq2f judgment call).
 *
 * GitHub's code-scanning UI only recognizes three levels, and `error` is the
 * only one that can block a PR by default. PromptCI's two "this is a real
 * problem" tiers (`critical`, `high`) both map to `error` so either one is
 * visible to a security-tab gate; `warning` keeps its name; `info` (the
 * lowest, advisory tier) maps to SARIF's `note`, its "worth seeing, not a
 * problem" level.
 */
const SEVERITY_TO_SARIF_LEVEL: Record<IssueSeverity, 'error' | 'warning' | 'note'> = {
  critical: 'error',
  high: 'error',
  warning: 'warning',
  info: 'note',
};

type CategoryInfo = {
  name: string;
  shortDescription: string;
  /**
   * Level advertised on the rule itself (`tool.driver.rules[].defaultConfiguration.level`).
   * Every result also carries its own `level` (from SEVERITY_TO_SARIF_LEVEL),
   * which takes precedence in consumers that honour it — this is only the
   * rule's advertised default and is otherwise a judgment call per category.
   */
  defaultLevel: 'error' | 'warning' | 'note';
};

const CATEGORY_INFO: Record<IssueCategory, CategoryInfo> = {
  duplicate: {
    name: 'Duplicate instruction content',
    shortDescription: 'Repeated or near-identical guidance across sections or files.',
    defaultLevel: 'warning',
  },
  conflict: {
    name: 'Conflicting directives',
    shortDescription: 'Contradictory instructions, versions, or competing framework/tech choices.',
    defaultLevel: 'error',
  },
  context_bloat: {
    name: 'Context bloat',
    shortDescription: 'Instruction files exceeding size or token-budget thresholds.',
    defaultLevel: 'warning',
  },
  missing_context: {
    name: 'Missing setup context',
    shortDescription: 'Missing setup, validation, or project-specific guidance.',
    defaultLevel: 'warning',
  },
  stale_instruction: {
    name: 'Stale instructions',
    shortDescription: 'Old years, dated TODOs, deprecated wording, or outdated versions.',
    defaultLevel: 'warning',
  },
  vague_guidance: {
    name: 'Vague guidance',
    shortDescription: 'Guidance too vague for an agent or contributor to act on.',
    defaultLevel: 'note',
  },
  structure: {
    name: 'Structural issue',
    shortDescription: 'Malformed suppression annotations or other structural problems.',
    defaultLevel: 'warning',
  },
  command_validity: {
    name: 'Invalid command reference',
    shortDescription: 'Documented commands, scripts, or make targets that no longer exist.',
    defaultLevel: 'warning',
  },
  agent_practices: {
    name: 'Agent practice gap',
    shortDescription: 'Gaps in agent-facing operational guidance.',
    defaultLevel: 'note',
  },
  ai_config: {
    name: 'AI setup config rot',
    shortDescription:
      'Agent Skills, subagents, hooks/settings, MCP servers, or editor rule files drifted from filesystem reality.',
    defaultLevel: 'warning',
  },
  security: {
    name: 'Security or privacy gap',
    shortDescription: 'Security or privacy gaps in instruction guidance.',
    defaultLevel: 'error',
  },
  custom: {
    name: 'Custom rule finding',
    shortDescription: "A finding from the repository's own .promptci/custom-rules.json rules.",
    defaultLevel: 'warning',
  },
};

// ── Minimal local SARIF types ───────────────────────────────────────────────
// Just enough structure to build a valid 2.1.0 log; not a general-purpose
// SARIF type library, so no new runtime dependency is needed to produce it.

type SarifArtifactLocation = { uri: string; uriBaseId: string };
type SarifRegion = { startLine: number; endLine?: number };
type SarifLocation = { physicalLocation: { artifactLocation: SarifArtifactLocation; region?: SarifRegion } };
type SarifSuppression = { kind: 'external'; justification: string };
type SarifResult = {
  ruleId: string;
  ruleIndex: number;
  level: 'error' | 'warning' | 'note';
  message: { text: string };
  locations: SarifLocation[];
  partialFingerprints: Record<string, string>;
  suppressions?: SarifSuppression[];
};
type SarifRule = {
  id: string;
  name: string;
  shortDescription: { text: string };
  helpUri: string;
  defaultConfiguration: { level: 'error' | 'warning' | 'note' };
};
type SarifLog = {
  $schema: string;
  version: '2.1.0';
  runs: Array<{
    tool: { driver: { name: string; version: string; informationUri: string; rules: SarifRule[] } };
    results: SarifResult[];
  }>;
};

/**
 * Suppressed findings are included rather than omitted (pcic-aq2f judgment
 * call): dropping them would make a repo's suppressions invisible in the
 * Security tab, where a reviewer might reasonably want to see what was
 * silenced and why. SARIF's `suppressions` field marks a result as
 * suppressed — GitHub's SARIF documentation does not promise any particular
 * handling of a `suppressions`-bearing result, so this is "marked suppressed
 * in the SARIF," not a guarantee about how a given consumer displays it. The
 * justification is generic because the inline `promptci-ignore` reason text
 * is not threaded onto `PromptCiIssue` today.
 */
const SUPPRESSED_JUSTIFICATION =
  "Suppressed via an inline `promptci-ignore` annotation in the scanned repository.";

/**
 * A `ScanReport.repoPath`/finding path is produced by whatever machine ran
 * the scan — a Windows checkout (`C:\git\repo`) or a POSIX one
 * (`/home/runner/work/repo`) — and this module must handle either SHAPE
 * regardless of which platform IT is running on (a repo scanned on Windows
 * can still have its SARIF generated, or tested, on Linux CI and vice versa).
 * `node:path`'s plain `path.relative`/`path.isAbsolute` bind to the CURRENT
 * process's platform, so on Linux they treat a Windows-shaped path like
 * `C:\git\repo\sub\CLAUDE.md` as just an opaque string with no recognized
 * separators — `path.relative` between two such strings does not compute a
 * real relative path, and the "is this outside the repo" check in
 * `toRelativeUri` below then misfires. Detect the SHAPE of the input paths
 * instead and pick `path.win32` or `path.posix` explicitly, independent of
 * `process.platform`.
 */
function isWindowsShapedPath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.includes('\\');
}

/** Platform-independent basename (see isWindowsShapedPath) for a single path. */
function basenameOf(p: string): string {
  return (isWindowsShapedPath(p) ? nodePath.win32 : nodePath.posix).basename(p);
}

/**
 * Forward-slash, percent-encoded, repo-relative URI for a SARIF
 * artifactLocation.uri — or null when `absPath` does not resolve inside
 * `repoPath` at all (such a location is dropped rather than pointing outside
 * the scanned tree). `relative()` can return a path that climbs out with a
 * leading `..`, or (given an unrelated absolute path) something that is not
 * relative at all; only those two cases mean "outside" — a real directory or
 * file NAMED `..something` (e.g. `..hidden/x`) does not start with `..`
 * followed by a separator (or equal `..` outright), so it is left alone.
 */
function toRelativeUri(absPath: string, repoPath: string): string | null {
  // Platform-independent (see isWindowsShapedPath): either input looking
  // Windows-shaped is enough to pick path.win32 for BOTH, since relative()
  // needs a consistent separator convention across the two arguments.
  const pathImpl = isWindowsShapedPath(repoPath) || isWindowsShapedPath(absPath) ? nodePath.win32 : nodePath.posix;
  const rel = pathImpl.relative(repoPath, absPath);
  if (rel === '..' || rel.startsWith(`..${pathImpl.sep}`) || pathImpl.isAbsolute(rel)) {
    return null;
  }
  const posix = rel.split(pathImpl.sep).join('/');
  // RFC 3986: each path SEGMENT is percent-encoded independently, so a
  // literal '/' produced by encoding one segment can never be mistaken for a
  // path separator, and characters like '#', '%', ' ', or non-ASCII bytes in
  // a real filename round-trip into a valid uri-reference.
  return posix
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/** One SARIF location for `absPath`, or null if it falls outside the repo (see toRelativeUri). */
function buildOneLocation(
  absPath: string,
  rel: (p: string) => string | null,
  startLine: number | undefined,
  endLine: number | undefined,
): SarifLocation | null {
  const uri = rel(absPath);
  if (uri === null) return null;
  // A detector-supplied line number is always >= 1 in practice, but never
  // invent a line (or trust a stray 0/negative one) for a result that has
  // none — SARIF regions are 1-based, and a fabricated "line 1" would point a
  // reviewer at the wrong text for what is really a file-level finding.
  const region = startLine !== undefined && startLine >= 1
    ? { startLine, ...(endLine !== undefined && endLine >= startLine ? { endLine } : {}) }
    : undefined;
  return {
    physicalLocation: {
      artifactLocation: { uri, uriBaseId: '%SRCROOT%' },
      ...(region ? { region } : {}),
    },
  };
}

/**
 * SARIF locations for one finding, plus whether a fallback location had to
 * be substituted (pcic-aq2f #3/#12): a finding with no usable location — no
 * `locations` entries (or none that resolve inside the repo), and no
 * `filePaths` either (or none that resolve inside the repo) — would
 * otherwise serialize to `locations: []`, which GitHub's code-scanning
 * ingestion silently drops. Falling back to the repo's primary instruction
 * file (whichever of AGENTS.md/CLAUDE.md the scan found first, else the
 * first scanned instruction file) keeps the finding visible, with no region
 * attached since the fallback file is not where the finding specifically is.
 * When nothing was scanned at all, there is nothing to fall back to and the
 * result legitimately carries no locations.
 */
function buildLocations(
  issue: PromptCiIssue,
  rel: (p: string) => string | null,
  fallbackAbsPath: string | undefined,
): { locations: SarifLocation[]; usedFallback: boolean } {
  const fromLocations = issue.locations
    .map((loc) => buildOneLocation(loc.filePath, rel, loc.startLine, loc.endLine))
    .filter((l): l is SarifLocation => l !== null);
  if (fromLocations.length > 0) return { locations: fromLocations, usedFallback: false };

  const fromFilePaths = issue.filePaths
    .map((fp) => buildOneLocation(fp, rel, undefined, undefined))
    .filter((l): l is SarifLocation => l !== null);
  if (fromFilePaths.length > 0) return { locations: fromFilePaths, usedFallback: false };

  if (fallbackAbsPath) {
    const fallback = buildOneLocation(fallbackAbsPath, rel, undefined, undefined);
    if (fallback) return { locations: [fallback], usedFallback: true };
  }
  return { locations: [], usedFallback: false };
}

/**
 * Title + recommendation, worded as cautiously as the issue itself already
 * is. Falls back to the title when `summary` is somehow empty, so a result
 * never serializes with blank message text. `fallbackNote`, when set,
 * documents that `locations` points at the repo's primary instruction file
 * rather than the finding's actual location (see buildLocations).
 */
function buildMessageText(issue: PromptCiIssue, fallbackNote: string | undefined): string {
  const summary = issue.summary.trim() || issue.title.trim();
  const recommendation = issue.recommendation.trim();
  const base = recommendation ? `${summary} Recommendation: ${recommendation}` : summary;
  return fallbackNote ? `${base} ${fallbackNote}` : base;
}

/**
 * Sort key used to order results deterministically: primary file, then
 * primary line, then category, then the issue's own id — independent of
 * detector run order. Out-of-repo locations/filePaths are excluded the same
 * way buildLocations excludes them, so the key never diverges from where a
 * result's own locations actually point.
 */
function sortKey(issue: PromptCiIssue, rel: (p: string) => string | null): string {
  const loc =
    issue.locations.find((l) => l.startLine !== undefined && rel(l.filePath) !== null) ??
    issue.locations.find((l) => rel(l.filePath) !== null);
  const file = loc ? rel(loc.filePath)! : issue.filePaths.map(rel).find((p): p is string => p !== null) ?? '';
  const line = loc?.startLine ?? 0;
  return [file, String(line).padStart(10, '0'), issue.category, issue.id].join('\u0000');
}

/**
 * Ordinal (UTF-16 code-unit) string comparison, not `localeCompare`:
 * `localeCompare`'s collation depends on the running engine's ICU data and
 * the active locale, which is not guaranteed identical between the machine
 * that runs this and CI's — the same input could sort differently and break
 * the "identical reports produce byte-identical SARIF" guarantee. Plain
 * `<`/`>` on strings compares UTF-16 code units and is the same everywhere
 * Node runs.
 */
function ordinalCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * `promptci/v1` is PromptCI's OWN stable-identity key (the same
 * category+title+filePaths+evidence fingerprint `--baseline` already uses),
 * not GitHub's `primaryLocationLineHash` — GitHub computes and uses that one
 * itself. The fingerprint deliberately excludes line numbers, so two distinct
 * findings of the same category/title/evidence (e.g. the same duplicate
 * check firing on two different line ranges) can share a raw value; the
 * caller's trailing `:N` (rawFingerprintWithSuffix) keeps their
 * partialFingerprints distinct WITHIN this run without touching what makes
 * two findings "the same" ACROSS runs.
 */
function buildResult(
  issue: PromptCiIssue,
  rel: (p: string) => string | null,
  rawFingerprintWithSuffix: string,
  ruleIndex: number,
  suppressed: boolean,
  fallbackAbsPath: string | undefined,
): SarifResult {
  const { locations, usedFallback } = buildLocations(issue, rel, fallbackAbsPath);
  const fallbackNote =
    usedFallback && fallbackAbsPath
      ? `(No specific location was recorded for this finding; pointing at ${basenameOf(
          fallbackAbsPath,
        )} as the repository's primary instruction file.)`
      : undefined;

  const result: SarifResult = {
    ruleId: issue.category,
    ruleIndex,
    level: SEVERITY_TO_SARIF_LEVEL[issue.severity],
    message: { text: buildMessageText(issue, fallbackNote) },
    locations,
    partialFingerprints: { 'promptci/v1': rawFingerprintWithSuffix },
  };
  if (suppressed) {
    result.suppressions = [{ kind: 'external', justification: SUPPRESSED_JUSTIFICATION }];
  }
  return result;
}

function buildRule(category: IssueCategory): SarifRule {
  const info = CATEGORY_INFO[category];
  return {
    id: category,
    name: info.name,
    shortDescription: { text: info.shortDescription },
    helpUri: DETECTOR_REFERENCE_URL,
    defaultConfiguration: { level: info.defaultLevel },
  };
}

/**
 * Absolute path of the repo's "primary" instruction file, for buildLocations'
 * fallback: whichever of AGENTS.md/CLAUDE.md was scanned first (scan order,
 * not alphabetical), else the first scanned instruction-type file, else
 * undefined when nothing was scanned at all.
 */
function primaryInstructionFile(report: ScanReport): string | undefined {
  const scanned = report.filesScanned.filter(
    (f) => f.aliasOf === undefined && INSTRUCTION_FILE_TYPES.has(f.fileType),
  );
  const primary = scanned.find((f) => {
    const base = basenameOf(f.path).toLowerCase();
    return base === 'agents.md' || base === 'claude.md';
  });
  return (primary ?? scanned[0])?.path;
}

/**
 * Serialize a ScanReport to a SARIF 2.1.0 log.
 *
 * `toolVersion` is threaded in by the caller (the CLI's own `--version`
 * value) rather than read from a package.json here, so this module stays
 * decoupled from any particular package's on-disk layout.
 *
 * Active issues and suppressed issues are both included (suppressed ones
 * carry a `suppressions` entry — see SUPPRESSED_JUSTIFICATION above); ruleId
 * is the issue's `category`, the only detector/category identifier that is
 * both present on every issue and stable across detector refactors.
 */
export function generateSarifReport(report: ScanReport, toolVersion: string, pretty = true): string {
  const rel = (absPath: string) => toRelativeUri(absPath, report.repoPath);
  const fallbackAbsPath = primaryInstructionFile(report);

  const entries: Array<{ issue: PromptCiIssue; suppressed: boolean }> = [
    ...report.issues.map((issue) => ({ issue, suppressed: false })),
    ...(report.suppressedIssues ?? []).map((issue) => ({ issue, suppressed: true })),
  ];
  entries.sort((a, b) => ordinalCompare(sortKey(a.issue, rel), sortKey(b.issue, rel)));

  const categoriesUsed = [...new Set(entries.map(({ issue }) => issue.category))].sort(ordinalCompare);
  const rules = categoriesUsed.map((category) => buildRule(category));
  const ruleIndexOf = new Map(categoriesUsed.map((category, i) => [category, i]));

  // Raw (pre-suffix) fingerprints can collide within a single run — the
  // fingerprint excludes line numbers — so track how many of each have been
  // seen, in the already-established sort order, and give each occurrence a
  // 0-based `:N` suffix (see buildResult).
  const fingerprintOccurrence = new Map<string, number>();
  const results = entries.map(({ issue, suppressed }) => {
    const rawFingerprint = computeFingerprint(issue, report.repoPath);
    const suffix = fingerprintOccurrence.get(rawFingerprint) ?? 0;
    fingerprintOccurrence.set(rawFingerprint, suffix + 1);
    return buildResult(
      issue,
      rel,
      `${rawFingerprint}:${suffix}`,
      ruleIndexOf.get(issue.category)!,
      suppressed,
      fallbackAbsPath,
    );
  });

  const log: SarifLog = {
    $schema: SARIF_SCHEMA_URI,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'PromptCI',
            version: toolVersion,
            informationUri: PROMPTCI_REPO_URL,
            rules,
          },
        },
        results,
      },
    ],
  };

  return pretty ? JSON.stringify(log, null, 2) : JSON.stringify(log);
}
