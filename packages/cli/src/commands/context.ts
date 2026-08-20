import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { analyzeContext, scanFiles, optimizeContext } from '@promptci/core';
import type { ContextAnalysis, PromptCiIssue } from '@promptci/core';
import { loadConfig } from '../config.js';
import { applyChangesInteractively, NonInteractiveError, type ApplyUnit } from '../lib/interactive-apply.js';

export type ContextAnalyzeOptions = {
  scanPath?: string;
  json?: boolean;
};

async function validateDirectory(rawPath: string): Promise<string> {
  const resolvedPath = path.resolve(rawPath);
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
  return resolvedPath;
}

function severityRank(issue: PromptCiIssue): number {
  return { critical: 0, high: 1, warning: 2, info: 3 }[issue.severity];
}

function formatContextAnalysis(analysis: ContextAnalysis): string {
  const lines: string[] = [];
  lines.push('Context analysis complete');
  lines.push('');
  lines.push(`Repo: ${analysis.repoPath}`);
  lines.push(`Instruction files: ${analysis.metrics.instructionFileCount}`);
  lines.push(`Estimated instruction tokens: ${analysis.metrics.estimatedInstructionTokens}`);
  lines.push(`Package manager: ${analysis.packageJson.packageManagerName}`);
  if (analysis.packageJson.enginesNode) lines.push(`Node engine: ${analysis.packageJson.enginesNode}`);
  if (analysis.packageJson.scriptNames.length > 0) {
    lines.push(`Package scripts: ${analysis.packageJson.scriptNames.join(', ')}`);
  }
  lines.push(`Workflow commands: ${analysis.workflows.commands.length}`);
  lines.push('');

  if (analysis.metrics.largestInstructionFiles.length > 0) {
    lines.push('Largest instruction files:');
    for (const file of analysis.metrics.largestInstructionFiles) {
      lines.push(`- ${file.path}: ~${file.estimatedTokens} tokens`);
    }
    lines.push('');
  }

  if (analysis.issues.length === 0) {
    lines.push('No context issues found.');
  } else {
    lines.push('Context issues:');
    for (const issue of [...analysis.issues].sort((a, b) => severityRank(a) - severityRank(b))) {
      lines.push(`- [${issue.severity}] ${issue.title}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

export async function runContextAnalyze(options: ContextAnalyzeOptions): Promise<void> {
  const resolvedPath = await validateDirectory(options.scanPath ?? process.cwd());

  let config;
  try {
    config = await loadConfig(resolvedPath);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const analysis = await analyzeContext({
    repoPath: resolvedPath,
    projectType: config.projectType,
    include: config.include,
    exclude: config.exclude,
  });

  if (options.json) {
    process.stdout.write(JSON.stringify(analysis, null, 2) + '\n');
  } else {
    process.stdout.write(formatContextAnalysis(analysis));
  }
}

export type ContextOptimizeOptions = {
  scanPath?: string;
  /** Accepted for compatibility; previewing is the default. */
  dryRun?: boolean;
  /** Required to actually modify files. */
  write?: boolean;
  /**
   * Prompt for confirmation before each write. `--write` is itself the explicit
   * opt-in to apply, so this defaults to false (apply without prompting); tests
   * and callers that want per-change confirmation pass `interactive: true`.
   */
  interactive?: boolean;
  /** Scripted confirmation answers (tests / piped input). */
  answers?: string[];
  /** Whether stdin is a TTY. Injectable for tests. */
  isTTY?: boolean;
};

export async function runContextOptimize(options: ContextOptimizeOptions): Promise<void> {
  // `context optimize` rewrites instruction files in place and moves whole
  // sections into new documents, with no undo. It used to do that by default
  // with only --dry-run to opt out; previewing is now the default and --write
  // is the explicit opt-in. Both paths run through the shared diff/confirm
  // helper so a preview and a real apply render identically.
  const apply = options.write === true && options.dryRun !== true;

  if (options.write && options.dryRun) {
    console.error('Error: --write and --dry-run cannot be combined.');
    process.exit(1);
  }

  const resolvedPath = await validateDirectory(options.scanPath ?? process.cwd());

  let config;
  try {
    config = await loadConfig(resolvedPath);
  } catch (err) {
    console.error(`Error loading config: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const files = await scanFiles({
    repoPath: resolvedPath,
    projectType: config.projectType,
    include: config.include,
    exclude: config.exclude,
  });

  const { changes } = await optimizeContext(files, { repoRoot: resolvedPath });

  if (changes.length === 0) {
    print('No cache optimization changes needed.');
    return;
  }

  if (apply) {
    print(`\nApplying caching optimization changes (${changes.length} change(s)):`);
  } else {
    print(`\nProposed caching optimization changes (${changes.length} change(s)):`);
  }

  // Each change is its own confirmation unit. optimizeContext produces a single
  // change per file, so no per-file merge is needed here.
  const units: ApplyUnit[] = changes.map((change) => ({ changes: [change] }));

  let appliedCount: number;
  try {
    ({ appliedCount } = await applyChangesInteractively(units, {
      repoRoot: resolvedPath,
      dryRun: !apply,
      interactive: options.interactive ?? false,
      answers: options.answers,
      isTTY: options.isTTY,
      promptText: '\nApply this change? (y/N): ',
      log: print,
    }));
  } catch (err) {
    if (err instanceof NonInteractiveError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  if (!apply) {
    print('\nPreview only — no changes were made. Re-run with --write to apply them.');
  } else if (appliedCount > 0) {
    print('\nOptimization complete.');
  } else {
    print('\nNo changes applied.');
  }
}

function print(msg: string = '') {
  process.stdout.write(msg + '\n');
}

