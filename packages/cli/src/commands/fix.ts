import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { scan, applyFixRecipe, isRepairable, isScriptRenameRecipe, requiresOptIn, planMirrorImport, subsetImportCaveat } from '@promptci/core';
import type { PromptCiIssue } from '@promptci/core';
import { loadConfig } from '../config.js';
import { applyChangesInteractively, NonInteractiveError, type ApplyUnit } from '../lib/interactive-apply.js';

export type FixOptions = {
  scanPath?: string;
  issueId?: string;
  interactive?: boolean;
  dryRun?: boolean;
  answers?: string[];
  /** With `issueId` naming a mirrored-files finding: allow the import into a CLAUDE.md that is a subset of AGENTS.md (pcic-5rop.64). */
  importSubset?: boolean;
};

export async function runFix(options: FixOptions): Promise<void> {
  const rawPath = options.scanPath ?? process.cwd();
  const resolvedPath = path.resolve(rawPath);

  // Validate path
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

  // Load config
  let config;
  try {
    config = await loadConfig(resolvedPath);
  } catch (err) {
    console.error(`Error loading config: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Run initial scan
  if (!options.dryRun) {
    console.log('Scanning repository to identify issues...');
  }
  const report = await scan({
    repoPath: resolvedPath,
    projectType: config.projectType,
    include: config.include,
    exclude: config.exclude,
    vagueGuidanceSeverity: config.vagueGuidanceSeverity,
  });

  let repairable = report.issues.filter(issue => isRepairable(issue));
  // pcic-1ik0.10 / pcic-1ik0.18: an opt-in recipe (the mirrored-files
  // CLAUDE.md import, a script rename) is never applied by a plain `fix`;
  // naming the finding with --issue is the opt-in. The import's plan is
  // re-checked on disk and printed with any refusal.
  let optIn = false;
  if (options.issueId) {
    let target = repairable.find(issue => issue.id === options.issueId);
    if (!target) {
      const named = report.issues.find(issue => issue.id === options.issueId && requiresOptIn(issue));
      if (named && isScriptRenameRecipe(named)) {
        target = named;
        optIn = true;
      } else if (named) {
        const importSubset = options.importSubset === true;
        const plan = await planMirrorImport(named, resolvedPath, { subset: importSubset });
        for (const line of plan.untouched) console.log(`  ${line}`);
        if (plan.changes.length === 0) {
          console.log(`No edit for ${named.id}:`);
          for (const reason of plan.refusals) console.log(`  - ${reason}`);
          // pcic-5rop.64: name the subset mode only when it would make the edit.
          if (!importSubset) {
            const subset = await planMirrorImport(named, resolvedPath, { subset: true });
            if (subset.changes.length > 0) {
              console.log(`  ${subsetImportCaveat(subset.gained)}`);
              console.log(`  To import anyway: promptci fix --issue ${named.id} --import-subset`);
            }
          }
          return;
        }
        if (plan.gained.length > 0) console.log(`  ${subsetImportCaveat(plan.gained)}`);
        target = named;
        optIn = true;
      }
    }
    if (!target) {
      console.error(`Error: No repairable issue found with ID "${options.issueId}".`);
      process.exit(1);
    }
    repairable = [target];
  } else {
    for (const issue of report.issues.filter(requiresOptIn)) {
      console.log(`Opt-in fix available (not applied by default): promptci fix --issue ${issue.id}  (${issue.title})`);
    }
  }
  if (repairable.length === 0) {
    console.log('No repairable issues found.');
    return;
  }

  // Each issue is one confirmation unit. Its changes are computed lazily, when
  // the unit's turn comes, so an issue sees the on-disk result of the issues
  // applied before it — two issues that both edit `.gitignore` compose instead
  // of the second clobbering the first.
  const units: ApplyUnit[] = repairable.map((issue: PromptCiIssue) => ({
    headerLines: [
      `Issue ID:   ${issue.id}`,
      `Title:      ${issue.title}`,
      `Severity:   ${issue.severity.toUpperCase()}`,
      `Summary:    ${issue.summary}`,
    ],
    changes: () =>
      applyFixRecipe(issue, resolvedPath, { optIn: optIn && requiresOptIn(issue), importSubset: options.importSubset === true }),
    // Duplicate consolidation replaces the line ranges recorded at scan time.
    // If an earlier unit in this run rewrote one of the same files, those
    // ranges point at shifted content, so the unit must be skipped and picked
    // up by a re-run instead of editing the wrong lines. Content-based recipes
    // (.gitignore appends) compose safely and don't need this — and neither do
    // the pcic-oonz `fixEdits` recipes: each edit names the exact text to
    // replace and is refused unless that text occurs exactly once on its line,
    // so a shifted file either matches the same text (the same correct
    // rewrite) or applies nothing at all.
    skipIfModified:
      issue.category === 'duplicate'
        ? issue.locations.map((loc) => path.resolve(resolvedPath, loc.filePath))
        : undefined,
  }));

  let appliedCount: number;
  let staleSkippedCount: number;
  try {
    ({ appliedCount, staleSkippedCount } = await applyChangesInteractively(units, {
      repoRoot: resolvedPath,
      dryRun: options.dryRun,
      interactive: options.interactive,
      answers: options.answers,
      promptText: '\nApply this fix? (y/N): ',
    }));
  } catch (err) {
    if (err instanceof NonInteractiveError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  // Run rescan if any changes were made
  if (appliedCount > 0 && !options.dryRun) {
    console.log('\nRe-scanning repository...');
    const finalReport = await scan({
      repoPath: resolvedPath,
      projectType: config.projectType,
      include: config.include,
      exclude: config.exclude,
      vagueGuidanceSeverity: config.vagueGuidanceSeverity,
    });
    console.log(`\nFixes complete. Initial score: ${report.healthScore}/100 -> New score: ${finalReport.healthScore}/100`);
    if (staleSkippedCount > 0) {
      console.log(
        `${staleSkippedCount} fix(es) were skipped because an earlier fix changed the same file. ` +
          'Run `promptci fix` again to apply them.',
      );
    }
  } else if (options.dryRun) {
    console.log('\nDry run complete. No changes were made.');
  } else {
    console.log('\nNo changes applied.');
  }
}
