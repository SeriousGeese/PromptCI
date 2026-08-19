import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { analyzeContext, scanFiles, optimizeContext } from '@promptci/core';
import type { ContextAnalysis, PromptCiIssue, FileChange } from '@promptci/core';
import { loadConfig } from '../config.js';

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
};

export async function runContextOptimize(options: ContextOptimizeOptions): Promise<void> {
  // `context optimize` rewrites instruction files in place and moves whole
  // sections into new documents, with no undo. It used to do that by default
  // with only --dry-run to opt out; previewing is now the default and --write
  // is the explicit opt-in.
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

  for (const change of changes) {
    print('\n================================================================================');
    showDiffPreview(change, resolvedPath);
    print('--------------------------------------------------------------------------------');

    if (apply) {
      await fs.mkdir(path.dirname(change.filePath), { recursive: true });
      await fs.writeFile(change.filePath, change.newContent, 'utf-8');
      print(`Applied change to ${path.relative(resolvedPath, change.filePath)}`);
    } else {
      print(`[Preview] ${path.relative(resolvedPath, change.filePath)} would be rewritten. No changes written.`);
    }
  }

  if (apply) {
    print('\nOptimization complete.');
  } else {
    print('\nPreview only — no changes were made. Re-run with --write to apply them.');
  }
}

function print(msg: string = '') {
  process.stdout.write(msg + '\n');
}

function showDiffPreview(change: FileChange, repoRoot: string) {
  const relPath = path.relative(repoRoot, change.filePath);

  if (change.originalContent === '') {
    print(`File: ${relPath} (new file)`);
    const newLines = change.newContent.split(/\r?\n/);
    for (const line of newLines) {
      print(`\x1b[32m+ ${line}\x1b[0m`);
    }
    return;
  }

  print(`File: ${relPath}`);

  const origLines = change.originalContent.split(/\r?\n/);
  const newLines = change.newContent.split(/\r?\n/);

  if (origLines.length === newLines.length) {
    for (let i = 0; i < origLines.length; i++) {
      if (origLines[i] !== newLines[i]) {
        print(`  Line ${i + 1}:`);
        print(`\x1b[31m- ${origLines[i]}\x1b[0m`);
        print(`\x1b[32m+ ${newLines[i]}\x1b[0m`);
      }
    }
  } else {
    let startDiverge = 0;
    while (
      startDiverge < origLines.length &&
      startDiverge < newLines.length &&
      origLines[startDiverge] === newLines[startDiverge]
    ) {
      startDiverge++;
    }

    let endDivergeOrig = origLines.length - 1;
    let endDivergeNew = newLines.length - 1;
    while (
      endDivergeOrig >= startDiverge &&
      endDivergeNew >= startDiverge &&
      origLines[endDivergeOrig] === newLines[endDivergeNew]
    ) {
      endDivergeOrig--;
      endDivergeNew--;
    }

    print(`  Replacement in lines ${startDiverge + 1} to ${endDivergeOrig + 1}:`);
    for (let i = startDiverge; i <= endDivergeOrig; i++) {
      if (origLines[i] !== undefined) {
        print(`\x1b[31m- ${origLines[i]}\x1b[0m`);
      }
    }
    for (let i = startDiverge; i <= endDivergeNew; i++) {
      if (newLines[i] !== undefined) {
        print(`\x1b[32m+ ${newLines[i]}\x1b[0m`);
      }
    }
  }
}

