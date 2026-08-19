#!/usr/bin/env node
import { Command } from 'commander';
import { runScan } from './commands/scan.js';
import { runInit } from './commands/init.js';
import { runFix } from './commands/fix.js';
import { runReviewDiff } from './commands/review-diff.js';
import { runUpload } from './commands/upload.js';
import { runLogin } from './commands/login.js';
import { runAuth, type AuthSubcommand } from './commands/auth.js';
import { runContextAnalyze, runContextOptimize } from './commands/context.js';
import { runExplain } from './commands/explain.js';
import { runDoctor } from './commands/doctor.js';
import { getNewVersionNotice } from './commands/version-notice.js';

// Single source of truth for the version: esbuild resolves this require at
// build time and inlines package.json into the CJS bundle, so --version and
// the update-notice comparison can never drift from what was published.
// (require, not import: a JSON import needs resolveJsonModule plus a rootDir
// that includes ../package.json, and the bundle is CJS anyway.)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version: VERSION } = require('../package.json') as { version: string };

const program = new Command();

program
  .name('promptci')
  .description('Instruction health for AI coding workflows')
  .version(VERSION, '-v, --version', 'print version');

program
  .command('scan')
  .description('Scan instruction files and generate a health report')
  .option('--path <dir>', 'target directory to scan (default: current directory)')
  .option('--json', 'print JSON report to stdout (files are still written)')
  .option('--output <file>', 'write markdown report to this path instead of default')
  .option(
    '--fail-on <severity>',
    'exit non-zero if any issue meets or exceeds this severity (info|warning|high|critical)',
  )
  .option('--baseline <path>', 'load baseline from file (relative to scan path)')
  .option('--update-baseline', 'run scan and write result as the new baseline')
  .option(
    '--fail-on-new <severity>',
    'exit non-zero only if NEW issues (not in baseline) meet this threshold; requires --baseline',
  )
  .option('--fail-on-budget', 'exit non-zero if any context bloat issue is found')
  .option('--context-budget <chars>', 'override total context budget (in characters)')
  .option('--file-context-budget <chars>', 'override per-file context budget (in characters)')
  .action(async (opts: {
    path?: string;
    json?: boolean;
    output?: string;
    failOn?: string;
    baseline?: string;
    updateBaseline?: boolean;
    failOnNew?: string;
    failOnBudget?: boolean;
    contextBudget?: string;
    fileContextBudget?: string;
  }) => {
    await runScan({
      scanPath: opts.path,
      json: opts.json,
      output: opts.output,
      failOn: opts.failOn as import('@promptci/core').IssueSeverity | undefined,
      baseline: opts.baseline,
      updateBaseline: opts.updateBaseline,
      failOnNew: opts.failOnNew as import('@promptci/core').IssueSeverity | undefined,
      failOnBudget: opts.failOnBudget,
      contextBudget: opts.contextBudget ? parseInt(opts.contextBudget, 10) : undefined,
      fileContextBudget: opts.fileContextBudget ? parseInt(opts.fileContextBudget, 10) : undefined,
    });
  });

program
  .command('fix')
  .description('Resolve deterministic instruction and configuration issues interactively')
  .option('--path <dir>', 'target directory to scan and fix (default: current directory)')
  .option('--issue <id>', 'fix a specific issue by its ID')
  .option('--no-interactive', 'disable interactive prompting and apply all fixes')
  .option('--dry-run', 'print proposed changes without writing to disk')
  .option('--llm', 'use an LLM to automatically resolve vague or conflicting instructions')
  .action(async (opts: {
    path?: string;
    issue?: string;
    interactive?: boolean;
    dryRun?: boolean;
    llm?: boolean;
  }) => {
    await runFix({
      scanPath: opts.path,
      issueId: opts.issue,
      interactive: opts.interactive,
      dryRun: opts.dryRun || false,
      llm: opts.llm || false,
    });
  });

program
  .command('explain')
  .description('Generate a prioritized, human-readable cleanup plan for scan issues using an LLM')
  .option('--path <dir>', 'target directory to scan and explain (default: current directory)')
  .action(async (opts: { path?: string }) => {
    await runExplain({ scanPath: opts.path });
  });

program
  .command('review-diff')
  .description('Compare branch instruction file changes against a base branch')
  .option('--base <branch-or-commit>', 'base branch or commit to compare against (default: main)')
  .option('--path <dir>', 'target directory (default: current directory)')
  .option('--json', 'print structured comparison JSON to stdout')
  .option('--fail-on-regression', 'exit non-zero if score decreases or new issues are introduced')
  .option(
    '--fail-on <severity>',
    'exit non-zero if any issue on this branch is at or above severity (info/warning/high/critical)',
  )
  .option(
    '--working-tree',
    'compare the working tree instead of the HEAD commit (includes uncommitted edits)',
  )
  .action(async (opts: {
    base?: string;
    path?: string;
    json?: boolean;
    failOnRegression?: boolean;
    failOn?: string;
    workingTree?: boolean;
  }) => {
    await runReviewDiff({
      baseBranch: opts.base || 'main',
      scanPath: opts.path,
      json: opts.json || false,
      failOnRegression: opts.failOnRegression || false,
      failOn: opts.failOn as import('@promptci/core').IssueSeverity | undefined,
      workingTree: opts.workingTree || false,
    });
  });

program
  .command('init')
  .description('Create a default .promptci/config.json in the target directory')
  .option('--path <dir>', 'target directory (default: current directory)')
  .action(async (opts: { path?: string }) => {
    await runInit(opts.path ?? process.cwd(), { interactive: process.stdin.isTTY });
  });

program
  .command('doctor')
  .description('Verify local PromptCI configuration, gitignore settings, and system dependencies')
  .option('--path <dir>', 'target directory (default: current directory)')
  .action(async (opts: { path?: string }) => {
    await runDoctor({ scanPath: opts.path });
  });

program
  .command('upload')
  .description('Upload the latest scan report to your PromptCI dashboard')
  .option('--path <dir>', 'repo directory containing .promptci/ (default: current directory)')
  .option(
    '--url <url>',
    'dashboard API URL (overrides PROMPTCI_API_URL and config; required if neither is set)',
  )
  .action(async (opts: { path?: string; url?: string }) => {
    await runUpload({ uploadPath: opts.path, url: opts.url });
  });

const contextCommand = program
  .command('context')
  .description('Analyze instruction context size, cost, and retrieval-readiness');

contextCommand
  .command('analyze')
  .description('Print deterministic context analysis without writing scan reports')
  .option('--path <dir>', 'target directory to analyze (default: current directory)')
  .option('--json', 'print JSON analysis to stdout')
  .action(async (opts: { path?: string; json?: boolean }) => {
    await runContextAnalyze({ scanPath: opts.path, json: opts.json });
  });

contextCommand
  .command('optimize')
  .description(
    'Preview a refactor of instruction files that splits volatile or large sections ' +
      '(previews by default; pass --write to apply)',
  )
  .option('--path <dir>', 'target directory to optimize (default: current directory)')
  .option('--write', 'apply the changes to disk (without this, only a diff is printed)')
  .option('--dry-run', 'print the diff without modifying files (the default)')
  .action(async (opts: { path?: string; dryRun?: boolean; write?: boolean }) => {
    await runContextOptimize({ scanPath: opts.path, dryRun: opts.dryRun, write: opts.write });
  });

program
  .command('login')
  .description('Authenticate the CLI with your PromptCI dashboard via GitHub OAuth')
  .option(
    '--url <url>',
    'dashboard URL (overrides PROMPTCI_API_URL and config; required if neither is set)',
  )
  .action(async (opts: { url?: string }) => {
    await runLogin({ url: opts.url });
  });

program
  .command('auth <subcommand> [args...]')
  .description(
    'Manage CLI authentication tokens\n' +
      '  set-token <token>  Store your access token\n' +
      '  status             Show current auth state\n' +
      '  logout             Clear stored token',
  )
  .action(async (sub: string, args: string[]) => {
    await runAuth(sub as AuthSubcommand, args);
  });

async function main(): Promise<void> {
  // Start the best-effort update check now so its once-a-day registry probe
  // overlaps the command's own work, but print any notice only after the
  // command has produced its output. Commands that call process.exit (and
  // Commander's own --version/--help) skip the notice entirely — it is
  // best-effort by design.
  const notice = getNewVersionNotice(VERSION);
  await program.parseAsync(process.argv);
  const message = await notice;
  if (message) process.stderr.write(message);
}

main().catch((err: unknown) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
