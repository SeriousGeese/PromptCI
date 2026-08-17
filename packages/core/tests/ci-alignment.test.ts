/**
 * Tests for the CI and Workflow Alignment detector.
 *
 * Covers:
 *  - CI runs lint/typecheck/test/build but instructions omit one or more
 *  - CI uses a different package manager than instructions
 *  - Instructions reference a script absent from both CI and package.json
 *  - No-workflow guard: detector must be silent when no workflows exist
 *  - && multi-command splitting
 *  - Matrix-job command extraction
 *  - False-positive avoidance: negation lines, matching-pm, already-instructed tasks
 */

import { describe, it, expect } from 'vitest';
import { detectCiAlignment } from '../src/ci-alignment.js';
import type { InstructionFile } from '../src/types.js';
import { parsePackageJsonFacts, type RepoContext } from '../src/repo-context.js';

const MOCK_METRICS = {
  estimatedInstructionTokens: 0,
  instructionFileCount: 0,
  largestInstructionFiles: [],
};

function makeFile(content: string, filePath = '/repo/AGENTS.md'): InstructionFile {
  return {
    path: filePath,
    fileType: 'agents',
    content,
    sections: [],
    lineCount: content.split('\n').length,
    charCount: content.length,
    estimatedTokens: Math.round(content.length / 4),
  };
}

type WorkflowCommand = { filePath: string; command: string; line: number };

function makeContext(
  files: InstructionFile[],
  workflows: { files: string[]; commands: WorkflowCommand[] },
  packageJson?: string,
): RepoContext {
  const packageJsonFacts = parsePackageJsonFacts(
    packageJson,
    packageJson ? ['pnpm-lock.yaml'] : [],
  );
  return {
    repoRoot: '/repo',
    files,
    projectType: 'unknown',
    manifests: packageJson ? { packageJson } : {},
    packageJson: packageJsonFacts,
    workflows,
    metrics: MOCK_METRICS,
  };
}

const EMPTY_WORKFLOWS = { files: [], commands: [] };

function makeWorkflow(commands: WorkflowCommand[]): { files: string[]; commands: WorkflowCommand[] } {
  const files = [...new Set(commands.map((c) => c.filePath))];
  return { files, commands };
}

// ── No-workflow guard ─────────────────────────────────────────────────────────

describe('detectCiAlignment — no-workflow guard', () => {
  it('returns no issues when no workflow files exist', () => {
    const file = makeFile('Follow the project rules. Run `npm install` to set up.');
    const context = makeContext([file], EMPTY_WORKFLOWS);
    expect(detectCiAlignment(context)).toHaveLength(0);
  });

  it('returns no issues for an empty workflow commands list', () => {
    const file = makeFile('Follow the project rules.');
    const context = makeContext([file], { files: ['.github/workflows/ci.yml'], commands: [] });
    expect(detectCiAlignment(context)).toHaveLength(0);
  });
});

// ── Check 1: CI runs tasks that instructions omit ─────────────────────────────

describe('detectCiAlignment — missing CI tasks in instructions', () => {
  it('flags lint when CI runs it but instructions have no lint command', () => {
    const file = makeFile('Make sure to run pnpm test before submitting.');
    const context = makeContext(
      [file],
      makeWorkflow([{ filePath: '.github/workflows/ci.yml', command: 'pnpm run lint', line: 10 }]),
    );
    const issues = detectCiAlignment(context);
    const issue = issues.find((i) => i.title.includes('lint'));
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('warning');
    expect(issue!.category).toBe('missing_context');
  });

  it('flags typecheck when CI runs it but instructions omit it', () => {
    const file = makeFile('Run `pnpm test` to verify your changes.');
    const context = makeContext(
      [file],
      makeWorkflow([
        { filePath: '.github/workflows/ci.yml', command: 'pnpm run typecheck', line: 8 },
      ]),
    );
    const issues = detectCiAlignment(context);
    const issue = issues.find((i) => i.title.includes('typecheck'));
    expect(issue).toBeDefined();
  });

  it('flags build when CI runs it but instructions omit it', () => {
    const file = makeFile('Run `pnpm test` and `pnpm lint` before submitting.');
    const context = makeContext(
      [file],
      makeWorkflow([
        { filePath: '.github/workflows/ci.yml', command: 'pnpm run build', line: 12 },
      ]),
    );
    const issues = detectCiAlignment(context);
    const issue = issues.find((i) => i.title.includes('build'));
    expect(issue).toBeDefined();
  });

  it('flags lint, typecheck, and build when CI runs all four but instructions only mention test', () => {
    // The canonical scenario from the spec
    const file = makeFile(
      '## Verification\nRun `pnpm test` before marking work complete.',
    );
    const context = makeContext(
      [file],
      makeWorkflow([
        { filePath: '.github/workflows/ci.yml', command: 'pnpm run lint', line: 5 },
        { filePath: '.github/workflows/ci.yml', command: 'pnpm run typecheck', line: 7 },
        { filePath: '.github/workflows/ci.yml', command: 'pnpm test', line: 9 },
        { filePath: '.github/workflows/ci.yml', command: 'pnpm run build', line: 11 },
      ]),
    );
    const issues = detectCiAlignment(context);
    const titles = issues.map((i) => i.title);
    // test is mentioned in instructions → should NOT be flagged
    expect(titles.some((t) => t.includes('test'))).toBe(false);
    // lint, typecheck, build are NOT mentioned → all three should be flagged
    expect(titles.some((t) => t.includes('lint'))).toBe(true);
    expect(titles.some((t) => t.includes('typecheck'))).toBe(true);
    expect(titles.some((t) => t.includes('build'))).toBe(true);
  });

  // ── CI1: `tsc --noEmit` must classify as typecheck, not build ──────────────

  it('CI1: flags typecheck (not build) when CI runs `tsc --noEmit` and instructions omit typecheck', () => {
    const file = makeFile('Run `pnpm test` and `pnpm run build` before submitting.');
    // package.json present (with a real "build" script) so the unrelated
    // orphan-script check doesn't also fire on "build" and pollute this test.
    const packageJson = JSON.stringify({ scripts: { test: 'vitest', build: 'tsc' } });
    const context = makeContext(
      [file],
      makeWorkflow([
        { filePath: '.github/workflows/ci.yml', command: 'tsc --noEmit', line: 10 },
      ]),
      packageJson,
    );
    const issues = detectCiAlignment(context);
    // Old bug: `\b--noemit\b` never matched, so this was ALWAYS classified
    // 'build' — since instructions already mention build, no finding would
    // fire at all, silently hiding the real typecheck gap.
    const typecheckIssue = issues.find((i) => i.title === 'CI runs `typecheck` but no instruction file appears to include it');
    const buildIssue = issues.find((i) => i.title === 'CI runs `build` but no instruction file appears to include it');
    expect(typecheckIssue).toBeDefined();
    expect(buildIssue).toBeUndefined();
  });

  it('CI1: still classifies bare `tsc` (no --noEmit) as build', () => {
    const file = makeFile('Run `pnpm test` and `pnpm run typecheck` before submitting.');
    const packageJson = JSON.stringify({ scripts: { test: 'vitest', typecheck: 'tsc --noEmit' } });
    const context = makeContext(
      [file],
      makeWorkflow([
        { filePath: '.github/workflows/ci.yml', command: 'tsc', line: 10 },
      ]),
      packageJson,
    );
    const issues = detectCiAlignment(context);
    const buildIssue = issues.find((i) => i.title === 'CI runs `build` but no instruction file appears to include it');
    expect(buildIssue).toBeDefined();
  });

  it('does NOT flag a task that is already mentioned in instructions', () => {
    const file = makeFile('Run lint before submitting: `pnpm run lint`.');
    const context = makeContext(
      [file],
      makeWorkflow([{ filePath: '.github/workflows/ci.yml', command: 'pnpm run lint', line: 10 }]),
    );
    const issues = detectCiAlignment(context);
    expect(issues.find((i) => i.title.includes('lint'))).toBeUndefined();
  });

  it('recognises direct tool calls in CI (eslint, vitest)', () => {
    const file = makeFile('Run the project.');
    const context = makeContext(
      [file],
      makeWorkflow([
        { filePath: '.github/workflows/ci.yml', command: 'npx eslint .', line: 10 },
        { filePath: '.github/workflows/ci.yml', command: 'vitest run', line: 12 },
      ]),
    );
    const issues = detectCiAlignment(context);
    const lintIssue = issues.find((i) => i.title.includes('lint'));
    const testIssue = issues.find((i) => i.title.includes('test'));
    expect(lintIssue).toBeDefined();
    expect(testIssue).toBeDefined();
  });
});

// ── Check 1: && multi-command splitting ───────────────────────────────────────

describe('detectCiAlignment — && multi-command splitting', () => {
  it('extracts tasks from && joined commands in a single run: block', () => {
    // A single CI run: value like "pnpm lint && pnpm test" should produce two tasks
    const file = makeFile('Run the project following the standard rules.');
    const context = makeContext(
      [file],
      makeWorkflow([
        {
          filePath: '.github/workflows/ci.yml',
          command: 'pnpm run lint && pnpm run typecheck && pnpm test',
          line: 8,
        },
      ]),
    );
    const issues = detectCiAlignment(context);
    const lintIssue = issues.find((i) => i.title.includes('lint'));
    const typecheckIssue = issues.find((i) => i.title.includes('typecheck'));
    const testIssue = issues.find((i) => i.title.includes('test'));
    expect(lintIssue).toBeDefined();
    expect(typecheckIssue).toBeDefined();
    expect(testIssue).toBeDefined();
  });

  it('extracts tasks from multi-line run block (matrix job style)', () => {
    // repo-context extracts a multi-line block as one command with embedded newlines
    const multiLineCommand =
      'pnpm run lint\npnpm run typecheck\npnpm run test\npnpm run build';
    const file = makeFile('Run tests before submitting: `pnpm test`.');
    const context = makeContext(
      [file],
      makeWorkflow([
        {
          filePath: '.github/workflows/matrix.yml',
          command: multiLineCommand,
          line: 15,
        },
      ]),
    );
    const issues = detectCiAlignment(context);
    // test is mentioned in instructions
    expect(issues.find((i) => i.title.includes('`test`'))).toBeUndefined();
    // lint, typecheck, build should be flagged
    expect(issues.find((i) => i.title.includes('lint'))).toBeDefined();
    expect(issues.find((i) => i.title.includes('typecheck'))).toBeDefined();
    expect(issues.find((i) => i.title.includes('build'))).toBeDefined();
  });
});

// ── Check 2: Package manager mismatch ────────────────────────────────────────

describe('detectCiAlignment — package manager mismatch', () => {
  it('flags when instructions say npm but CI uses pnpm', () => {
    const file = makeFile('Run `npm install` and then `npm test`.');
    const packageJson = JSON.stringify({ name: 'test' });
    const context = makeContext(
      [file],
      makeWorkflow([
        { filePath: '.github/workflows/ci.yml', command: 'pnpm install', line: 5 },
        { filePath: '.github/workflows/ci.yml', command: 'pnpm run test', line: 10 },
      ]),
      packageJson,
    );
    context.packageJson.packageManagerName = 'pnpm';
    context.packageJson.lockfiles = ['pnpm-lock.yaml'];

    const issues = detectCiAlignment(context);
    const issue = issues.find((i) => i.title.includes('pnpm') && i.title.includes('npm'));
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('warning');
  });

  it('does NOT flag when instruction PM matches CI PM', () => {
    const file = makeFile('Run `pnpm install` and then `pnpm test`.');
    const context = makeContext(
      [file],
      makeWorkflow([
        { filePath: '.github/workflows/ci.yml', command: 'pnpm install', line: 5 },
        { filePath: '.github/workflows/ci.yml', command: 'pnpm run test', line: 10 },
      ]),
    );
    context.packageJson.packageManagerName = 'pnpm';
    const issues = detectCiAlignment(context);
    expect(issues.find((i) => i.title.includes('mismatch'))).toBeUndefined();
  });

  it('does NOT flag "do not use npm" advisory guidance in a pnpm CI project', () => {
    const file = makeFile(
      'This project uses pnpm. Do not use npm install — it will corrupt the lockfile.',
    );
    const context = makeContext(
      [file],
      makeWorkflow([
        { filePath: '.github/workflows/ci.yml', command: 'pnpm install', line: 5 },
        { filePath: '.github/workflows/ci.yml', command: 'pnpm run test', line: 10 },
      ]),
    );
    context.packageJson.packageManagerName = 'pnpm';
    const issues = detectCiAlignment(context);
    expect(issues.find((i) => i.title.toLowerCase().includes('mismatch'))).toBeUndefined();
  });
});

// ── Check 3: Orphaned instruction scripts ─────────────────────────────────────

describe('detectCiAlignment — orphaned instruction scripts', () => {
  // CI3: whenever package.json is present, manifest-consistency.ts's
  // checkMissingScripts already flags any script reference missing from
  // package.json (regardless of CI usage) — a strict superset of what this
  // check covers. ci-alignment.ts now defers entirely in that case, so this
  // scenario is covered by manifest-consistency.test.ts instead, and this
  // detector only adds value when there's no package.json to compare against.
  it('flags a script referenced in instructions that is absent from both CI and package.json when there is NO package.json', () => {
    const file = makeFile('Run `pnpm run check-types` to verify types.');
    const context = makeContext(
      [file],
      makeWorkflow([
        { filePath: '.github/workflows/ci.yml', command: 'pnpm test', line: 10 },
      ]),
      // no packageJson argument — manifests.packageJson stays undefined
    );
    const issues = detectCiAlignment(context);
    const issue = issues.find((i) => i.title.includes('check-types'));
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('warning');
    expect(issue!.category).toBe('stale_instruction');
  });

  it('CI3: does NOT flag an orphaned script when package.json is present (defers to manifest-consistency.ts)', () => {
    const file = makeFile('Run `pnpm run check-types` to verify types.');
    const packageJson = JSON.stringify({ scripts: { test: 'vitest' } });
    const context = makeContext(
      [file],
      makeWorkflow([
        { filePath: '.github/workflows/ci.yml', command: 'pnpm test', line: 10 },
      ]),
      packageJson,
    );
    const issues = detectCiAlignment(context);
    // No 'stale_instruction' orphan-script finding from THIS detector —
    // manifest-consistency.ts's checkMissingScripts owns this case now.
    expect(issues.find((i) => i.title.includes('check-types'))).toBeUndefined();
  });

  it('does NOT flag a script that exists in package.json', () => {
    const file = makeFile('Run `pnpm run typecheck` to verify types.');
    const packageJson = JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } });
    const context = makeContext(
      [file],
      makeWorkflow([
        { filePath: '.github/workflows/ci.yml', command: 'pnpm test', line: 10 },
      ]),
      packageJson,
    );
    const issues = detectCiAlignment(context);
    expect(issues.find((i) => i.title.includes('typecheck'))).toBeUndefined();
  });

  it('does NOT flag a script that appears in CI', () => {
    const file = makeFile('Run `pnpm run lint` before submitting.');
    const packageJson = JSON.stringify({ scripts: {} });
    const context = makeContext(
      [file],
      makeWorkflow([
        { filePath: '.github/workflows/ci.yml', command: 'pnpm run lint', line: 5 },
      ]),
      packageJson,
    );
    const issues = detectCiAlignment(context);
    expect(issues.find((i) => i.title.includes('lint'))).toBeUndefined();
  });

  it('does NOT flag standard package manager subcommands (install, test, etc.)', () => {
    const file = makeFile('Run `pnpm install` to set up, then `pnpm test`.');
    const packageJson = JSON.stringify({ scripts: { test: 'vitest' } });
    const context = makeContext(
      [file],
      makeWorkflow([
        { filePath: '.github/workflows/ci.yml', command: 'pnpm install', line: 3 },
        { filePath: '.github/workflows/ci.yml', command: 'pnpm test', line: 8 },
      ]),
      packageJson,
    );
    const issues = detectCiAlignment(context);
    const orphanIssues = issues.filter((i) => i.category === 'stale_instruction');
    expect(orphanIssues).toHaveLength(0);
  });

  // ── CI2: prose continuations must not be misread as script names ──────────

  it('CI2: does NOT flag "instead" as an orphan script in "use pnpm instead of npm"', () => {
    const file = makeFile('Prefer to use pnpm instead of npm for all commands.');
    const context = makeContext(
      [file],
      makeWorkflow([{ filePath: '.github/workflows/ci.yml', command: 'pnpm test', line: 5 }]),
      // no package.json — keeps this detector active (see CI3 tests above)
    );
    const issues = detectCiAlignment(context);
    expect(issues.find((i) => i.title.includes('`instead`'))).toBeUndefined();
  });

  it('CI2: does NOT flag "packages" as an orphan script in "npm packages are pinned"', () => {
    const file = makeFile('Our npm packages are pinned to exact versions in package.json.');
    const context = makeContext(
      [file],
      makeWorkflow([{ filePath: '.github/workflows/ci.yml', command: 'pnpm test', line: 5 }]),
    );
    const issues = detectCiAlignment(context);
    expect(issues.find((i) => i.title.includes('`packages`'))).toBeUndefined();
  });

  it('CI2: still flags a genuine orphan script alongside filler-word prose', () => {
    const file = makeFile(
      'Prefer to use pnpm instead of npm. Run `pnpm run check-types` to verify types.',
    );
    const context = makeContext(
      [file],
      makeWorkflow([{ filePath: '.github/workflows/ci.yml', command: 'pnpm test', line: 5 }]),
    );
    const issues = detectCiAlignment(context);
    expect(issues.find((i) => i.title.includes('`instead`'))).toBeUndefined();
    expect(issues.find((i) => i.title.includes('check-types'))).toBeDefined();
  });
});

// ── Correctness of issue fields ───────────────────────────────────────────────

describe('detectCiAlignment — issue field correctness', () => {
  it('locations on missing-task finding point to the workflow file, not instruction files', () => {
    const file = makeFile('Run the project.');
    const context = makeContext(
      [file],
      makeWorkflow([
        { filePath: '.github/workflows/ci.yml', command: 'pnpm run lint', line: 10 },
      ]),
    );
    const issues = detectCiAlignment(context);
    const issue = issues.find((i) => i.title.includes('lint'));
    expect(issue).toBeDefined();
    expect(issue!.locations[0]!.filePath).toBe('.github/workflows/ci.yml');
    expect(issue!.locations[0]!.startLine).toBe(10);
  });
});
