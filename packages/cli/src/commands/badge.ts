import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { scan } from '@promptci/core';
import { loadConfig } from '../config.js';
import { BADGE_LABEL, badgeMarkdown, buildBadge, gitignoreException } from '../badge.js';
import type { ShieldsBadge } from '../badge.js';

/**
 * `promptci badge` — write a Shields.io endpoint JSON for the health score.
 *
 * The badge is self-reported: commit the file and point a shields.io endpoint
 * badge at its raw URL. Only the score is written — no finding text, file
 * names, or file contents — so the committed file discloses nothing a README
 * badge should not.
 */

export const DEFAULT_BADGE_PATH = path.join('.promptci', 'health-badge.json');

export type BadgeOptions = {
  scanPath?: string;
  /** Read the score from an existing report.json instead of scanning (relative to scanPath). */
  report?: string;
  /** Where to write the badge JSON (relative to scanPath). */
  output?: string;
  label?: string;
};

export type BadgeResult = {
  outputPath: string;
  badge: ShieldsBadge;
  score: number;
};

async function assertDirectory(resolvedPath: string): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(resolvedPath);
  } catch {
    throw new Error(`path does not exist: "${resolvedPath}"`);
  }
  if (!stat.isDirectory()) throw new Error(`"${resolvedPath}" is not a directory.`);
}

async function scoreFromReport(reportPath: string): Promise<number> {
  let raw: string;
  try {
    raw = await fs.readFile(reportPath, 'utf-8');
  } catch {
    throw new Error(`report file not found: "${reportPath}". Run "promptci scan" first, or omit --report to scan now.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `report file "${reportPath}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  const score = (parsed as { healthScore?: unknown } | null)?.healthScore;
  if (typeof score !== 'number' || !Number.isFinite(score)) {
    throw new Error(`report file "${reportPath}" has no numeric "healthScore" field.`);
  }
  return score;
}

async function scoreFromScan(resolvedPath: string): Promise<number> {
  // Same config the `scan` command applies, so the badge shows the score a
  // `promptci scan` of this repo would print. Reports are not written.
  const config = await loadConfig(resolvedPath);
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
  return report.healthScore;
}

/**
 * The enclosing git work tree root (nearest ancestor holding `.git`), or
 * `start` itself when there is none. The raw.githubusercontent URL is relative
 * to the repository root, not to a nested `--path` package.
 */
function repoRootFor(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

export async function runBadge(options: BadgeOptions): Promise<BadgeResult> {
  const resolvedPath = path.resolve(options.scanPath ?? process.cwd());
  await assertDirectory(resolvedPath);

  const label = options.label?.trim() || BADGE_LABEL;
  const score = options.report
    ? await scoreFromReport(path.resolve(resolvedPath, options.report))
    : await scoreFromScan(resolvedPath);

  const badge = buildBadge(score, label);
  const outputPath = path.resolve(resolvedPath, options.output ?? DEFAULT_BADGE_PATH);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(badge, null, 2) + '\n', 'utf-8');

  const posixRel = (from: string) => path.relative(from, outputPath).replace(/\\/g, '/') || outputPath;
  const shown = posixRel(resolvedPath);
  const repoPath = posixRel(repoRootFor(resolvedPath));
  process.stdout.write(
    `Wrote ${shown} (${badge.message}, ${badge.color}).\n` +
      '\n' +
      'Commit it, then add a shields.io endpoint badge to your README:\n' +
      '\n' +
      `  ${badgeMarkdown(label, repoPath)}\n`,
  );
  const exception = gitignoreException(repoPath);
  if (exception) {
    // The recommended stanza ignores `.promptci/*`; without a negation the
    // badge file would silently never be committed.
    process.stdout.write(
      '\nThe recommended PromptCI .gitignore stanza ignores .promptci/*; add an exception so the\n' +
        'badge file can be committed:\n' +
        '\n' +
        `  ${exception}\n`,
    );
  }

  return { outputPath, badge, score };
}
