import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { scan, generateJsonReport, writeReport, createBaseline, assertValidBaseline } from '@promptci/core';

import type { IssueSeverity, PromptCiIssue, Baseline } from '@promptci/core';
import { loadConfig } from '../config.js';
import { formatSummary, anyIssuesMeetThreshold } from '../summary.js';

export type ScanOptions = {
  scanPath?: string;
  json?: boolean;
  output?: string;
  failOn?: IssueSeverity;
  baseline?: string;
  updateBaseline?: boolean;
  failOnNew?: IssueSeverity;
  failOnBudget?: boolean;
  contextBudget?: number;
  fileContextBudget?: number;
};

const SEVERITY_VALUES: IssueSeverity[] = ['info', 'warning', 'high', 'critical'];

function isValidSeverity(v: string): v is IssueSeverity {
  return (SEVERITY_VALUES as string[]).includes(v);
}

export async function runScan(options: ScanOptions): Promise<void> {
  const rawPath = options.scanPath ?? process.cwd();
  const resolvedPath = path.resolve(rawPath);

  // Validate that path exists and is a directory
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

  // Load config (missing config is fine; bad JSON is a hard error)
  let config;
  try {
    config = await loadConfig(resolvedPath);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // CLI flags take precedence over config file values
  const effectiveFailOn: IssueSeverity | undefined =
    options.failOn ?? config.severityThreshold;

  if (effectiveFailOn !== undefined && !isValidSeverity(effectiveFailOn)) {
    console.error(
      `Error: invalid --fail-on value "${effectiveFailOn}". Must be one of: ${SEVERITY_VALUES.join(', ')}`,
    );
    process.exit(1);
  }

  // Load baseline if requested
  let baseline: Baseline | undefined;
  if (options.baseline) {
    const baselinePath = path.resolve(resolvedPath, options.baseline);
    try {
      const content = await fs.readFile(baselinePath, 'utf-8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch (jsonErr) {
        console.error(
          `Error: baseline file "${baselinePath}" contains invalid JSON: ` +
            `${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`,
        );
        process.exit(1);
      }
      try {
        assertValidBaseline(parsed);
        baseline = parsed;
      } catch (shapeErr) {
        console.error(
          `Error: baseline file "${baselinePath}" has an unexpected format: ` +
            `${shapeErr instanceof Error ? shapeErr.message : String(shapeErr)}`,
        );
        process.exit(1);
      }
    } catch (err) {
      // ENOENT: baseline file does not exist yet — treat as empty baseline
      if ((err as { code?: string }).code !== 'ENOENT') {
        console.error(`Error loading baseline: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    }
  }

  const report = await scan({
    repoPath: resolvedPath,
    projectType: config.projectType,
    include: config.include,
    exclude: config.exclude,
    baseline,
    contextBudget: options.contextBudget ?? config.contextBudget,
    fileContextBudget: options.fileContextBudget ?? config.fileContextBudget,
  });

  // Write markdown and JSON files.
  // For the default case pass no path overrides so writeReport archives the
  // previous run before overwriting. When --output is set, write to the custom
  // path only and skip archiving.
  const written = options.output
    ? await writeReport(report, { mdPath: path.resolve(options.output), archive: false })
    : await writeReport(report);

  // Update baseline if requested
  if (options.updateBaseline) {
    const newBaseline = createBaseline(report.issues, resolvedPath);
    const baselinePath = options.baseline
      ? path.resolve(resolvedPath, options.baseline)
      : path.join(resolvedPath, '.promptci', 'baseline.json');

    await fs.mkdir(path.dirname(baselinePath), { recursive: true });
    await fs.writeFile(baselinePath, JSON.stringify(newBaseline, null, 2));
    if (!options.json) {
      console.log(`\nBaseline updated: ${baselinePath}`);
    }
  }

  // Output
  if (options.json) {
    // Print JSON to stdout; summary was suppressed
    process.stdout.write(generateJsonReport(report) + '\n');
  } else {
    process.stdout.write(
      formatSummary(report, {
        mdPath: written.mdPath,
        jsonPath: written.jsonPath,
        previousEntry: written.archivedEntry,
      }),
    );
  }

  // Fail-on check
  if (effectiveFailOn && anyIssuesMeetThreshold(report, effectiveFailOn)) {
    const matching = report.issues.filter(
      (i: PromptCiIssue) =>
        isValidSeverity(i.severity) &&
        anyIssuesMeetThreshold({ ...report, issues: [i] }, effectiveFailOn),
    ).length;
    console.error(
      `\nFailed: ${matching} issue(s) at or above "${effectiveFailOn}" threshold. ` +
        `See ${written.mdPath} for details.`,
    );
    process.exit(1);
  }

  // Fail-on-new check
  const failOnNew = options.failOnNew;
  if (failOnNew && report.newIssues) {
    if (anyIssuesMeetThreshold({ ...report, issues: report.newIssues }, failOnNew)) {
      const matching = report.newIssues.filter(
        (i: PromptCiIssue) =>
          isValidSeverity(i.severity) &&
          anyIssuesMeetThreshold({ ...report, issues: [i] }, failOnNew),
      ).length;
      console.error(
        `\nFailed: ${matching} NEW issue(s) at or above "${failOnNew}" threshold. ` +
          `See ${written.mdPath} for details.`,
      );
      process.exit(1);
    }
  }

  // Fail-on-budget check
  if (options.failOnBudget) {
    const bloatIssues = report.issues.filter(i => i.category === 'context_bloat');
    if (bloatIssues.length > 0) {
      console.error(
        `\nFailed: ${bloatIssues.length} context bloat issue(s) found and --fail-on-budget is enabled. ` +
          `See ${written.mdPath} for details.`,
      );
      process.exit(1);
    }
  }
}
