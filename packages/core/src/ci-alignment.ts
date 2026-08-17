import * as crypto from 'node:crypto';
import type { RepoContext, WorkflowCommand } from './repo-context.js';
import type { InstructionFile, PromptCiIssue } from './types.js';

/**
 * CI and Workflow Alignment Detector
 *
 * Compares what GitHub Actions workflows actually run against what instruction
 * files tell agents to run locally.  Surfaces drift between the CI gate and
 * the agent verification loop so agents know which steps must pass before
 * declaring work complete.
 *
 * Findings are heuristic — wording is intentionally cautious.
 */

function issueId(key: string): string {
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
  return `ci-align-${hash}`;
}

// ── Task identification ───────────────────────────────────────────────────────

type CommonTask = 'test' | 'lint' | 'build' | 'typecheck' | 'format';


/**
 * Split a raw CI command that may contain multiple sub-commands joined with
 * `&&` or newlines (multi-line `run:` blocks) into individual segments.
 */
function splitCommand(command: string): string[] {
  return command
    .split(/&&|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Normalizes a single command segment to identify a CommonTask.
 * Returns the task name if recognised, otherwise null.
 */
function identifyTaskInSegment(segment: string): CommonTask | null {
  const cmd = segment.toLowerCase();

  // Package-manager run patterns: "pnpm run lint", "npm test", "yarn build", etc.
  const pmRunMatch = /\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(test|lint|build|typecheck|format)\b/.exec(cmd);
  if (pmRunMatch) return pmRunMatch[1] as CommonTask;

  // Direct tool invocations
  if (/\bjest\b|\bvitest\b|\bmocha\b|\bplaywright\s+test\b/.test(cmd)) return 'test';
  if (/\beslint\b|\bprettier\s+--check\b/.test(cmd)) return 'lint';
  // CI1: `\b` immediately before `--noemit` can never match — `\b` requires a
  // word-char/non-word-char transition, but "--noemit" is always preceded by
  // whitespace (non-word char before a non-word `-`), so `/\b--noemit\b/`
  // never matched real input like "tsc --noEmit". This made `tsc --noEmit`
  // in CI ALWAYS classify as 'build', never 'typecheck'. No leading boundary
  // is needed — "--noemit" is unambiguous on its own.
  if (/\btsc\b/.test(cmd) && /--noemit\b/i.test(cmd)) return 'typecheck';
  if (/\btsc\b/.test(cmd) && !/--noemit\b/i.test(cmd)) return 'build';
  if (/\bprettier\s+--write\b/.test(cmd)) return 'format';

  return null;
}

/**
 * Returns all CommonTasks found in a (possibly multi-command) CI run: string.
 * Handles `&&`-joined lines and multi-line blocks.
 */
function identifyTasksInCommand(command: string): CommonTask[] {
  const tasks: CommonTask[] = [];
  for (const segment of splitCommand(command)) {
    const t = identifyTaskInSegment(segment);
    if (t && !tasks.includes(t)) tasks.push(t);
  }
  return tasks;
}

// ── Instruction-file task matching ────────────────────────────────────────────

/**
 * Patterns that indicate an instruction file is actively directing the agent
 * to run a given task.  We look for command-like contexts to avoid matching
 * the word "test" in prose like "make sure to test your assumptions".
 *
 * For each task we accept:
 *  - An explicit package-manager command  (`pnpm lint`, `npm run lint`, …)
 *  - A heading or list item that names the task  (## Lint, - Run lint)
 *  - The word in a run/execute/check context
 */
const TASK_INSTRUCTION_PATTERNS: Record<CommonTask, RegExp> = {
  lint: /\b(?:(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?lint|eslint\b|run\s+lint|lint\s+the\s+code|linting)\b/i,
  typecheck: /\b(?:(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?typecheck|tsc\b|type.?check|run\s+typecheck)\b/i,
  test: /\b(?:(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?test|vitest\b|jest\b|run\s+(?:the\s+)?tests?|pnpm\s+test)\b/i,
  build: /\b(?:(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?build|tsc\b(?!\s+--noemit)|run\s+(?:the\s+)?build)\b/i,
  format: /\b(?:(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?format|prettier\b|run\s+format)\b/i,
};

/**
 * Returns true when any scanned instruction file directs the agent to run the
 * given task in a command-like context (not just mentions the word in prose).
 */
function isTaskInstructed(task: CommonTask, files: InstructionFile[]): boolean {
  const pattern = TASK_INSTRUCTION_PATTERNS[task];
  return files.some((f) => pattern.test(f.content));
}

// ── Package manager extraction ────────────────────────────────────────────────

/** Returns the package manager name used in a single command segment, or null. */
function extractPackageManager(command: string): string | null {
  const match = /\b(pnpm|npm|yarn|bun)\b/.exec(command.toLowerCase());
  return match ? match[1]! : null;
}

/** Collects all distinct package managers mentioned across all CI commands. */
function collectCiPackageManagers(commands: WorkflowCommand[]): Set<string> {
  const pms = new Set<string>();
  for (const wc of commands) {
    for (const segment of splitCommand(wc.command)) {
      const pm = extractPackageManager(segment);
      if (pm) pms.add(pm);
    }
  }
  return pms;
}

// ── Script normalisation ──────────────────────────────────────────────────────

/** Standard pm subcommands that are not user-defined package scripts. */
const STANDARD_SUBCOMMANDS = new Set([
  'install', 'i', 'add', 'remove', 'uninstall', 'init', 'help',
  'test', 'start', 'stop', 'restart', 'exec', 'dlx', 'run',
  'workspace', 'workspaces',
]);

/**
 * CI2: common English words that follow a package-manager name in ordinary
 * PROSE, not a command invocation — "use pnpm instead of npm" and "npm
 * packages are pinned" both matched the extraction regex below (which
 * accepts ANY following alphanumeric word as a candidate script name),
 * producing bogus orphan-script findings for "instead" and "packages".
 * pnpm/yarn support a real bare `pnpm <script>` invocation (no "run"
 * needed), so this can't be fixed by requiring "run" — only by excluding
 * words that are clearly prose continuations, not script names.
 */
const ENGLISH_FILLER_WORDS = new Set([
  'instead', 'of', 'packages', 'package', 'are', 'is', 'the', 'a', 'an',
  'that', 'this', 'for', 'to', 'and', 'or', 'not', 'with', 'without', 'via',
  'because', 'since', 'before', 'after', 'than', 'as', 'like', 'but', 'so',
]);


/** Extracts a user-defined script name from a pm run command, or null. */
function extractScriptName(command: string): string | null {
  const match = /\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?([a-z0-9][a-z0-9:_-]*)\b/i.exec(command);
  if (!match) return null;
  const name = match[1]!.toLowerCase();
  if (STANDARD_SUBCOMMANDS.has(name) || ENGLISH_FILLER_WORDS.has(name)) return null;
  return name;
}

// ── Check 1: CI runs a task that instructions do not mention ──────────────────

/**
 * Flags tasks that CI enforces (lint, typecheck, test, build) but that no
 * instruction file directs the agent to run.
 *
 * Only emits findings when at least one workflow file exists.
 */
function checkMissingCiTasks(context: RepoContext): PromptCiIssue[] {
  const { workflows, files } = context;
  if (workflows.files.length === 0) return [];

  // Collect tasks from ALL CI commands, handling && and multi-line blocks.
  const ciTasks = new Map<CommonTask, WorkflowCommand[]>();
  for (const wc of workflows.commands) {
    for (const task of identifyTasksInCommand(wc.command)) {
      if (!ciTasks.has(task)) ciTasks.set(task, []);
      ciTasks.get(task)!.push(wc);
    }
  }

  const issues: PromptCiIssue[] = [];
  for (const [task, wcs] of ciTasks.entries()) {
    if (isTaskInstructed(task, files)) continue;

    const sourceFiles = [...new Set(wcs.map((wc) => wc.filePath))];
    issues.push({
      id: issueId(`missing-ci-task:${task}`),
      severity: 'warning',
      category: 'missing_context',
      title: `CI runs \`${task}\` but no instruction file appears to include it`,
      summary:
        `The GitHub workflow${sourceFiles.length > 1 ? 's' : ''} (${sourceFiles.join(', ')}) ` +
        `run \`${task}\`, but no instruction file appears to direct the agent to run this step ` +
        `locally. Agents that follow only the instruction files may skip \`${task}\` and miss ` +
        `failures before declaring work complete.`,
      filePaths: files.map((f) => f.path),
      locations: wcs.map((wc) => ({ filePath: wc.filePath, startLine: wc.line })),
      evidence: wcs.map((wc) => `CI command: \`${wc.command}\` in ${wc.filePath} (line ${wc.line})`),
      recommendation:
        `Consider adding \`${task}\` to the verification loop in the relevant instruction ` +
        `file (e.g., AGENTS.md or CLAUDE.md) so agents run the same checks as CI.`,
      confidence: 0.8,
    });
  }

  return issues;
}

// ── Check 2: CI uses a different package manager than instructions ─────────────

/**
 * Flags when instruction files direct the agent to use a different package
 * manager than the one CI workflows actually use.
 *
 * Only emits findings when at least one workflow file exists and CI commands
 * mention a package manager.
 */
function checkCiPackageManagerMismatch(context: RepoContext): PromptCiIssue[] {
  const { workflows, files, packageJson } = context;
  if (workflows.files.length === 0) return [];

  const ciPms = collectCiPackageManagers(workflows.commands);
  if (ciPms.size === 0) return [];

  // Determine the project's preferred PM: package.json field > lockfile > CI
  const preferredPm =
    packageJson.packageManagerName !== 'unknown'
      ? packageJson.packageManagerName
      : Array.from(ciPms)[0]!;

  if (!ciPms.has(preferredPm)) return [];

  const issues: PromptCiIssue[] = [];
  for (const file of files) {
    for (const pm of ['npm', 'pnpm', 'yarn', 'bun'] as const) {
      if (pm === preferredPm) continue;

      // Only match positive command usage (not negation lines)
      const re = new RegExp(`\\b${pm}\\s+(?:install|add|run|exec|dlx|i)\\b`, 'gi');
      let match: RegExpExecArray | null;
      let positiveHit = false;
      while ((match = re.exec(file.content)) !== null) {
        const lineStart = file.content.lastIndexOf('\n', match.index - 1) + 1;
        const lineEnd = file.content.indexOf('\n', match.index);
        const line = file.content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
        const isNegation = /\b(?:do\s+not|don'?t|avoid|never|not\s+use|refrain)\b/i.test(line);
        if (!isNegation) { positiveHit = true; break; }
      }
      if (!positiveHit) continue;

      issues.push({
        id: issueId(`pm-mismatch-ci:${file.path}:${pm}`),
        severity: 'warning',
        category: 'conflict',
        title: `Possible package manager mismatch: instructions use \`${pm}\` but CI uses \`${preferredPm}\``,
        summary:
          `The instruction file appears to direct the agent to use \`${pm}\`, but the CI ` +
          `workflows use \`${preferredPm}\`. This may lead to lockfile conflicts or unexpected ` +
          `installation behaviour. Consider reviewing whether the instructions match the CI setup.`,
        filePaths: [file.path],
        locations: [{ filePath: file.path }],
        evidence: [
          `CI workflows use: ${Array.from(ciPms).join(', ')}`,
          `Instruction file appears to use \`${pm}\``,
        ],
        recommendation:
          `Update the instruction file to use \`${preferredPm}\` commands to align with CI.`,
        confidence: 0.85,
      });
    }
  }

  return issues;
}

// ── Check 3: Instructions reference a script absent from CI and manifest ────────

/**
 * Flags when an instruction file tells the agent to run a named package script
 * that appears in neither package.json nor any CI workflow.  These commands
 * would fail immediately if executed.
 *
 * Only applied when at least one workflow file exists (otherwise the CI-absent
 * half of the signal is meaningless).
 */
function checkOrphanedInstructionScripts(context: RepoContext): PromptCiIssue[] {
  const { workflows, files, packageJson, manifests } = context;
  if (workflows.files.length === 0) return [];

  // CI3: manifest-consistency.ts's checkMissingScripts already flags any
  // instruction reference to a script missing from package.json — regardless
  // of whether the script is used in CI — and it runs whenever
  // manifests.packageJson is present. Every finding THIS check produces
  // requires that same "missing from package.json" condition (see the
  // `!packageScripts.has(scriptName)` check below), so whenever
  // manifest-consistency.ts is active, its check is a strict superset of
  // this one — the same underlying gap was reported TWICE (different ids,
  // both 'stale_instruction') whenever a workflow file also existed. Defer
  // entirely to manifest-consistency.ts in that case; this check only adds
  // value when there's no package.json for that detector to compare against.
  if (manifests.packageJson) return [];

  const packageScripts = new Set(Object.keys(packageJson.scripts));

  // Collect all script names CI actually runs
  const ciScriptNames = new Set<string>();
  for (const wc of workflows.commands) {
    for (const segment of splitCommand(wc.command)) {
      const name = extractScriptName(segment);
      if (name) ciScriptNames.add(name);
    }
  }

  const reported = new Set<string>();
  const issues: PromptCiIssue[] = [];

  for (const file of files) {
    const runRe = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([a-z0-9][a-z0-9:_-]*)\b/gi;
    let match: RegExpExecArray | null;
    while ((match = runRe.exec(file.content)) !== null) {
      const scriptName = match[1]!.toLowerCase();
      // CI2: also exclude common English prose continuations — see
      // ENGLISH_FILLER_WORDS for why this can't be fixed by requiring "run".
      if (STANDARD_SUBCOMMANDS.has(scriptName) || ENGLISH_FILLER_WORDS.has(scriptName)) continue;

      if (!packageScripts.has(scriptName) && !ciScriptNames.has(scriptName)) {
        const dedupeKey = `${file.path}:${scriptName}`;
        if (reported.has(dedupeKey)) continue;
        reported.add(dedupeKey);

        issues.push({
          id: issueId(`orphan-script:${file.path}:${scriptName}`),
          severity: 'warning',
          category: 'stale_instruction',
          title: `Possible reference to missing script: \`${scriptName}\` (not in CI or package.json)`,
          summary:
            `The instruction file appears to tell the agent to run \`${scriptName}\`, but this ` +
            `script does not appear in package.json and is not used in any CI workflow. ` +
            `This command may fail if executed. Consider reviewing whether the script name is current.`,
          filePaths: [file.path],
          locations: [{ filePath: file.path }],
          evidence: [
            `Found reference to \`${scriptName}\` in ${file.path}`,
            `Script not found in package.json scripts`,
            `Script not found in .github/workflows/*.yml`,
          ],
          recommendation:
            `Verify the script name. If it was renamed, update the instruction file. ` +
            `If it is a new script, add it to package.json.`,
          confidence: 0.8,
        });
      }
    }
  }

  return issues;
}

// ── Public detector ───────────────────────────────────────────────────────────

/**
 * Entry point for the CI and Workflow Alignment detector.
 *
 * Returns an empty array when no workflow files exist so the detector never
 * creates noise in repos without GitHub Actions.
 */
export function detectCiAlignment(context: RepoContext): PromptCiIssue[] {
  if (context.workflows.files.length === 0) return [];

  return [
    ...checkMissingCiTasks(context),
    ...checkCiPackageManagerMismatch(context),
    ...checkOrphanedInstructionScripts(context),
  ];
}
