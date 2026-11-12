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
 * silenced and why. SARIF's `suppressions` field marks them without counting
 * them as open — GitHub excludes `suppressions`-bearing results from the
 * default alert count. The justification is generic because the inline
 * `promptci-ignore` reason text is not threaded onto `PromptCiIssue` today.
 */
const SUPPRESSED_JUSTIFICATION =
  "Suppressed via an inline `promptci-ignore` annotation in the scanned repository.";

/** Forward-slash, repo-relative path for a SARIF artifactLocation.uri. */
function toRelativeUri(absPath: string, repoPath: string): string {
  const rel = nodePath.relative(repoPath, absPath);
  const safe = !rel || rel.startsWith('..') ? absPath : rel;
  return safe.replace(/\\/g, '/');
}

function buildLocations(issue: PromptCiIssue, rel: (p: string) => string): SarifLocation[] {
  if (issue.locations.length > 0) {
    return issue.locations.map((loc) => ({
      physicalLocation: {
        artifactLocation: { uri: rel(loc.filePath), uriBaseId: '%SRCROOT%' },
        ...(loc.startLine !== undefined
          ? {
              region: {
                startLine: loc.startLine,
                ...(loc.endLine !== undefined ? { endLine: loc.endLine } : {}),
              },
            }
          : {}),
      },
    }));
  }
  // Whole-file findings (e.g. total context-bloat) carry no locations, only
  // filePaths: one location per file, with no region.
  return issue.filePaths.map((fp) => ({
    physicalLocation: {
      artifactLocation: { uri: rel(fp), uriBaseId: '%SRCROOT%' },
    },
  }));
}

/** Title + recommendation, worded as cautiously as the issue itself already is. */
function buildMessageText(issue: PromptCiIssue): string {
  const summary = issue.summary.trim();
  const recommendation = issue.recommendation.trim();
  return recommendation ? `${summary} Recommendation: ${recommendation}` : summary;
}

/**
 * Sort key used to order results deterministically: primary file, then
 * primary line, then category, then the issue's own id — independent of
 * detector run order.
 */
function sortKey(issue: PromptCiIssue, rel: (p: string) => string): string {
  const loc = issue.locations.find((l) => l.startLine !== undefined) ?? issue.locations[0];
  const file = loc ? rel(loc.filePath) : issue.filePaths[0] ? rel(issue.filePaths[0]) : '';
  const line = loc?.startLine ?? 0;
  return [file, String(line).padStart(10, '0'), issue.category, issue.id].join(' ');
}

function buildResult(
  issue: PromptCiIssue,
  rel: (p: string) => string,
  repoPath: string,
  ruleIndex: number,
  suppressed: boolean,
): SarifResult {
  const result: SarifResult = {
    ruleId: issue.category,
    ruleIndex,
    level: SEVERITY_TO_SARIF_LEVEL[issue.severity],
    message: { text: buildMessageText(issue) },
    locations: buildLocations(issue, rel),
    // GitHub dedupes alerts across runs on partialFingerprints; computeFingerprint
    // is the same category+title+filePaths+evidence key the baseline/ratchet
    // feature already uses to answer "is this the same finding?".
    partialFingerprints: { 'promptci/v1': computeFingerprint(issue, repoPath) },
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

  const entries: Array<{ issue: PromptCiIssue; suppressed: boolean }> = [
    ...report.issues.map((issue) => ({ issue, suppressed: false })),
    ...(report.suppressedIssues ?? []).map((issue) => ({ issue, suppressed: true })),
  ];
  entries.sort((a, b) => sortKey(a.issue, rel).localeCompare(sortKey(b.issue, rel)));

  const categoriesUsed = [...new Set(entries.map(({ issue }) => issue.category))].sort();
  const rules = categoriesUsed.map((category) => buildRule(category));
  const ruleIndexOf = new Map(categoriesUsed.map((category, i) => [category, i]));

  const results = entries.map(({ issue, suppressed }) =>
    buildResult(issue, rel, report.repoPath, ruleIndexOf.get(issue.category)!, suppressed),
  );

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
