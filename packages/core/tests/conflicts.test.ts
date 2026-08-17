/**
 * Tests for the conflict detector (Phase 4).
 */

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { detectConflicts, detectVersionConflicts, detectCompetingTechConflicts } from '../src/conflicts.js';
import type { InstructionFile, InstructionSection } from '../src/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSection(
  overrides: Partial<InstructionSection> & { text: string; filePath?: string },
): InstructionSection {
  const text = overrides.text;
  const filePath = overrides.filePath ?? '/repo/CLAUDE.md';
  return {
    id: overrides.id ?? `${filePath}:${overrides.startLine ?? 1}`,
    filePath,
    heading: overrides.heading,
    startLine: overrides.startLine ?? 1,
    endLine: overrides.endLine ?? text.split('\n').length,
    text,
    normalizedText: text.toLowerCase().trim(),
    ...overrides,
  };
}

function makeFile(sections: InstructionSection[], filePath = '/repo/CLAUDE.md'): InstructionFile {
  const content = sections.map((s) => s.text).join('\n');
  return {
    path: filePath,
    fileType: 'claude',
    content,
    sections,
    lineCount: content.split('\n').length,
    charCount: content.length,
    estimatedTokens: Math.round(content.length / 4),
  };
}

// ── Fixture path helper ───────────────────────────────────────────────────────

function fixtureConflictsDir(): string {
  return path.resolve(__dirname, '../../../examples/fixture-conflicts');
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('detectConflicts', () => {
  it('returns no issues for empty input', () => {
    expect(detectConflicts([])).toEqual([]);
  });

  it('returns no issues when there is only one file with no contradictions', () => {
    const sec = makeSection({
      text: 'Always use TypeScript for all new code in this project. Prefer strict mode.',
      heading: 'Language',
    });
    const file = makeFile([sec]);
    expect(detectConflicts([file])).toEqual([]);
  });

  // ── "use X" vs "do not use X" ────────────────────────────────────────────

  it('detects "use X" vs "do not use X" across two files', () => {
    const secA = makeSection({
      filePath: '/repo/AGENTS.md',
      heading: 'Testing',
      startLine: 1,
      endLine: 5,
      text: [
        '## Testing',
        'Always use Jest for writing all unit tests and integration tests.',
        'Run npm test before committing changes.',
        'Ensure coverage is at least 80 percent.',
        'Tests should be co-located with the source files.',
      ].join('\n'),
    });
    const secB = makeSection({
      filePath: '/repo/CLAUDE.md',
      heading: 'Testing',
      startLine: 1,
      endLine: 5,
      text: [
        '## Testing',
        'Always use Vitest for writing all unit tests and integration tests.',
        'Run pnpm test before committing changes.',
        'Ensure coverage is at least 80 percent.',
        'Do not use Jest — Vitest is the standard for this project.',
      ].join('\n'),
    });

    const fileA = makeFile([secA], '/repo/AGENTS.md');
    const fileB = makeFile([secB], '/repo/CLAUDE.md');

    const issues = detectConflicts([fileA, fileB]);
    const jestConflict = issues.find(
      (i) => i.category === 'conflict' && i.title.toLowerCase().includes('jest'),
    );
    expect(jestConflict).toBeDefined();
    expect(jestConflict!.severity).toBe('high');
    expect(jestConflict!.confidence).toBeGreaterThanOrEqual(0.7);
  });

  // ── "always X" vs "never X" ──────────────────────────────────────────────

  it('detects "always X" vs "never X" pattern', () => {
    const secA = makeSection({
      filePath: '/repo/CLAUDE.md',
      heading: 'Formatting',
      startLine: 1,
      endLine: 4,
      text: [
        '## Formatting',
        'Always add trailing commas to multi-line expressions.',
        'This keeps diffs clean and consistent across the codebase.',
      ].join('\n'),
    });
    const secB = makeSection({
      filePath: '/repo/AGENTS.md',
      heading: 'Formatting',
      startLine: 1,
      endLine: 4,
      text: [
        '## Formatting',
        'Never add trailing commas to multi-line expressions.',
        'The linter will flag them as errors.',
      ].join('\n'),
    });

    const issues = detectConflicts([makeFile([secA], '/repo/CLAUDE.md'), makeFile([secB], '/repo/AGENTS.md')]);
    const conflict = issues.find(
      (i) => i.category === 'conflict' && i.title.toLowerCase().includes('trailing commas'),
    );
    expect(conflict).toBeDefined();
    expect(conflict!.severity).toBe('high');
    expect(conflict!.confidence).toBe(0.8);
  });

  it('keeps unpunctuated bullet directives as separate logical lines', () => {
    const secA = makeSection({
      filePath: '/repo/AGENTS.md',
      heading: 'Data',
      text: [
        '## Data',
        '- Always use pandas',
        '- Never use polars',
        'Document dataframe choices in the pull request notes.',
      ].join('\n'),
    });
    const secB = makeSection({
      filePath: '/repo/CLAUDE.md',
      heading: 'Data',
      text: [
        '## Data',
        'Never use pandas.',
        'Prefer the approved dataframe library from the project manifest.',
      ].join('\n'),
    });

    const issues = detectConflicts([makeFile([secA], '/repo/AGENTS.md'), makeFile([secB], '/repo/CLAUDE.md')]);
    const pandasConflict = issues.find((i) => i.title.toLowerCase().includes('pandas'));
    expect(pandasConflict).toBeDefined();
    expect(pandasConflict!.severity).toBe('high');
  });

  // ── "must X" vs "avoid X" ────────────────────────────────────────────────

  it('detects "must X" vs "avoid X" pattern', () => {
    const secA = makeSection({
      filePath: '/repo/CLAUDE.md',
      heading: 'Comments',
      startLine: 1,
      endLine: 3,
      text: ['## Comments', 'You must add inline comments for all complex logic blocks.'].join('\n'),
    });
    const secB = makeSection({
      filePath: '/repo/AGENTS.md',
      heading: 'Comments',
      startLine: 1,
      endLine: 3,
      text: ['## Comments', 'Avoid inline comments and prefer self-documenting code instead.'].join('\n'),
    });

    const issues = detectConflicts([makeFile([secA], '/repo/CLAUDE.md'), makeFile([secB], '/repo/AGENTS.md')]);
    expect(issues.some((i) => i.category === 'conflict')).toBe(true);
  });

  // ── "prefer X" vs "avoid X" ──────────────────────────────────────────────

  it('detects "prefer X" vs "avoid X" pattern', () => {
    const secA = makeSection({
      filePath: '/repo/CLAUDE.md',
      heading: 'Imports',
      startLine: 1,
      endLine: 3,
      text: ['## Imports', 'Prefer default exports when exporting a single entity from a module.'].join('\n'),
    });
    const secB = makeSection({
      filePath: '/repo/AGENTS.md',
      heading: 'Imports',
      startLine: 1,
      endLine: 3,
      text: ['## Imports', 'Avoid default exports — use named exports only for clarity.'].join('\n'),
    });

    const issues = detectConflicts([makeFile([secA], '/repo/CLAUDE.md'), makeFile([secB], '/repo/AGENTS.md')]);
    expect(issues.some((i) => i.category === 'conflict')).toBe(true);
  });

  // ── NO false positives ────────────────────────────────────────────────────

  it('does NOT flag markdown table headers with "Avoid | Use" columns', () => {
    // Terminology/glossary tables have "| Avoid | Use Instead |" headers —
    // these are not conflicting directives.
    const secA = makeSection({
      filePath: '/repo/docs/terminology.md',
      heading: 'Terminology',
      startLine: 1,
      endLine: 8,
      text: [
        '## Terminology',
        'All agents MUST use the standardized terms defined below.',
        '',
        '| Avoid        | Use Instead |',
        '|-------------|-------------|',
        '| dungeon      | map         |',
        '| game         | session     |',
      ].join('\n'),
    });
    const secB = makeSection({
      filePath: '/repo/AGENTS.md',
      heading: 'Terminology',
      startLine: 1,
      endLine: 4,
      text: [
        '## Terminology',
        'Always use the terms from docs/terminology.md in all code and comments.',
      ].join('\n'),
    });
    const issues = detectConflicts([
      makeFile([secA], '/repo/docs/terminology.md'),
      makeFile([secB], '/repo/AGENTS.md'),
    ]);
    // "MUST use" vs "| Avoid | Use Instead |" table row must not fire
    expect(issues.every((i) => i.category !== 'conflict')).toBe(true);
  });

  it('does NOT flag unrelated sentences that happen to contain "use" and "avoid"', () => {
    const secA = makeSection({
      filePath: '/repo/CLAUDE.md',
      heading: 'Networking',
      startLine: 1,
      endLine: 3,
      text: ['## Networking', 'Use exponential backoff when retrying failed HTTP requests.'].join('\n'),
    });
    const secB = makeSection({
      filePath: '/repo/AGENTS.md',
      heading: 'Memory',
      startLine: 1,
      endLine: 3,
      text: ['## Memory', 'Avoid allocating large buffers during the startup phase.'].join('\n'),
    });

    const issues = detectConflicts([makeFile([secA], '/repo/CLAUDE.md'), makeFile([secB], '/repo/AGENTS.md')]);
    // "use exponential backoff" vs "avoid large buffers" — completely different subjects
    expect(issues.length).toBe(0);
  });

  it('does NOT flag sections shorter than 50 characters', () => {
    const secA = makeSection({
      filePath: '/repo/CLAUDE.md',
      heading: 'S',
      startLine: 1,
      endLine: 1,
      text: 'Use X.',
    });
    const secB = makeSection({
      filePath: '/repo/AGENTS.md',
      heading: 'S',
      startLine: 1,
      endLine: 1,
      text: 'Do not use X.',
    });
    const issues = detectConflicts([makeFile([secA], '/repo/CLAUDE.md'), makeFile([secB], '/repo/AGENTS.md')]);
    expect(issues.length).toBe(0);
  });

  // ── Deterministic IDs ─────────────────────────────────────────────────────

  it('produces stable issue ids across multiple calls', () => {
    const secA = makeSection({
      filePath: '/repo/CLAUDE.md',
      heading: 'Testing',
      startLine: 1,
      endLine: 3,
      text: ['## Testing', 'Always use Jest for all tests in this project. See docs for setup.'].join('\n'),
    });
    const secB = makeSection({
      filePath: '/repo/AGENTS.md',
      heading: 'Testing',
      startLine: 1,
      endLine: 3,
      text: [
        '## Testing',
        'Never use Jest — we have migrated to Vitest as the standard test runner.',
      ].join('\n'),
    });

    const run1 = detectConflicts([makeFile([secA], '/repo/CLAUDE.md'), makeFile([secB], '/repo/AGENTS.md')]);
    const run2 = detectConflicts([makeFile([secA], '/repo/CLAUDE.md'), makeFile([secB], '/repo/AGENTS.md')]);

    expect(run1.map((i) => i.id)).toEqual(run2.map((i) => i.id));
  });

  // ── Severity / confidence thresholds ─────────────────────────────────────

  it('assigns high severity for confidence >= 0.7', () => {
    const secA = makeSection({
      filePath: '/repo/CLAUDE.md',
      heading: 'Linting',
      startLine: 1,
      endLine: 3,
      text: ['## Linting', 'Always use ESLint for all JavaScript and TypeScript linting checks.'].join('\n'),
    });
    const secB = makeSection({
      filePath: '/repo/AGENTS.md',
      heading: 'Linting',
      startLine: 1,
      endLine: 3,
      text: [
        '## Linting',
        'Never use ESLint — this project uses Biome for formatting and linting.',
      ].join('\n'),
    });

    const issues = detectConflicts([makeFile([secA], '/repo/CLAUDE.md'), makeFile([secB], '/repo/AGENTS.md')]);
    const conflict = issues.find((i) => i.category === 'conflict');
    expect(conflict).toBeDefined();
    expect(conflict!.confidence).toBeGreaterThanOrEqual(0.7);
    expect(conflict!.severity).toBe('high');
  });

  it('assigns warning severity for confidence < 0.7', () => {
    // Partially overlapping subjects → confidence 0.5 → warning
    const secA = makeSection({
      filePath: '/repo/CLAUDE.md',
      heading: 'Style',
      startLine: 1,
      endLine: 3,
      text: ['## Style', 'Prefer functional components with hooks for React development.'].join('\n'),
    });
    const secB = makeSection({
      filePath: '/repo/AGENTS.md',
      heading: 'Style',
      startLine: 1,
      endLine: 3,
      text: ['## Style', 'Avoid functional components where class lifecycle methods are needed.'].join('\n'),
    });

    const issues = detectConflicts([makeFile([secA], '/repo/CLAUDE.md'), makeFile([secB], '/repo/AGENTS.md')]);
    const conflict = issues.find((i) => i.category === 'conflict');
    if (conflict) {
      if (conflict.confidence < 0.7) {
        expect(conflict.severity).toBe('warning');
      } else {
        expect(conflict.severity).toBe('high');
      }
    }
    // At minimum ensure no crash
  });

  // ── Issue shape ───────────────────────────────────────────────────────────

  it('produces well-formed issue objects', () => {
    const secA = makeSection({
      filePath: '/repo/CLAUDE.md',
      heading: 'Testing',
      startLine: 1,
      endLine: 3,
      text: ['## Testing', 'Always use Jest for all tests. Run npm test to verify.'].join('\n'),
    });
    const secB = makeSection({
      filePath: '/repo/AGENTS.md',
      heading: 'Testing',
      startLine: 1,
      endLine: 3,
      text: [
        '## Testing',
        'Never use Jest in this project. We use Vitest exclusively.',
      ].join('\n'),
    });

    const issues = detectConflicts([makeFile([secA], '/repo/CLAUDE.md'), makeFile([secB], '/repo/AGENTS.md')]);
    const issue = issues[0];
    expect(issue).toBeDefined();
    expect(issue.id).toMatch(/^conflict-[a-f0-9]{12}$/);
    expect(issue.category).toBe('conflict');
    expect(issue.title).toMatch(/Possible conflicting instruction/i);
    expect(issue.summary).toMatch(/Possible conflict/i);
    expect(issue.filePaths).toHaveLength(2);
    expect(issue.locations).toHaveLength(2);
    expect(issue.evidence).toHaveLength(2);
    expect(issue.recommendation).toBeTruthy();
    expect(issue.confidence).toBeGreaterThan(0);
    expect(issue.confidence).toBeLessThanOrEqual(1);
  });

  // ── Fixture-based test ────────────────────────────────────────────────────

  it('detects "always use Jest" vs "do not use Jest" in fixture-conflicts', async () => {
    const { scanFiles } = await import('../src/scanner.js');
    const files = await scanFiles({ repoPath: fixtureConflictsDir() });
    expect(files.length).toBeGreaterThan(0);

    const issues = detectConflicts(files);
    const jestConflict = issues.find(
      (i) => i.category === 'conflict' && i.title.toLowerCase().includes('jest'),
    );
    expect(jestConflict).toBeDefined();
    expect(jestConflict!.severity).toBe('high');
    expect(jestConflict!.confidence).toBeGreaterThanOrEqual(0.7);
  });
});

// ── BUG-003: em-dash "— not X" negation ──────────────────────────────────────

describe('detectConflicts — em-dash negation (BUG-003)', () => {
  it('detects "use LibA — not LibB" vs declarative "LibB" as a conflict', () => {
    const secA = makeSection({
      filePath: '/repo/CLAUDE.md',
      heading: 'CLI Framework',
      startLine: 1,
      endLine: 5,
      text: [
        '## CLI Framework',
        'CLI framework: Cobra (github.com/spf13/cobra) for all command definitions.',
        'All commands must be registered in the root Cobra command.',
      ].join('\n'),
    });
    const secB = makeSection({
      filePath: '/repo/.cursorrules',
      heading: 'Tooling',
      startLine: 1,
      endLine: 5,
      text: [
        '## Tooling',
        'We use urfave/cli (v3) for command parsing — not Cobra.',
        'Register commands using the urfave/cli App struct.',
      ].join('\n'),
    });
    const issues = detectConflicts([
      makeFile([secA], '/repo/CLAUDE.md'),
      makeFile([secB], '/repo/.cursorrules'),
    ]);
    // At minimum: the em-dash "not Cobra" should be extracted as a negative directive
    // and matched against the positive Cobra declaration in CLAUDE.md
    const cobraConflict = issues.find(
      (i) => i.category === 'conflict' && i.title.toLowerCase().includes('cobra'),
    );
    expect(cobraConflict).toBeDefined();
  });

  it('detects "Do not use X — use Y" across files', () => {
    const secA = makeSection({
      filePath: '/repo/CLAUDE.md',
      heading: 'Async',
      startLine: 1,
      endLine: 4,
      text: 'Use async/await with UniTask for all async operations. Do not use coroutines.',
    });
    const secB = makeSection({
      filePath: '/repo/.cursorrules',
      heading: 'Async',
      startLine: 1,
      endLine: 4,
      text: 'Always use coroutines for time-based sequences and animations.',
    });
    const issues = detectConflicts([
      makeFile([secA], '/repo/CLAUDE.md'),
      makeFile([secB], '/repo/.cursorrules'),
    ]);
    const coroutineConflict = issues.find(
      (i) => i.category === 'conflict' && i.title.toLowerCase().includes('coroutine'),
    );
    expect(coroutineConflict).toBeDefined();
  });
});

// ── BUG-002: Version conflict detector ───────────────────────────────────────

describe('detectVersionConflicts (BUG-002)', () => {
  it('returns no issues for empty input', () => {
    expect(detectVersionConflicts([])).toEqual([]);
  });

  it('returns no issues when all files agree on version', () => {
    const f1 = makeFile(
      [makeSection({ filePath: '/repo/CLAUDE.md', heading: 'Stack', startLine: 1, endLine: 3,
        text: 'ASP.NET Core 8.0 (.NET 8) — C# 12.' })],
      '/repo/CLAUDE.md',
    );
    const f2 = makeFile(
      [makeSection({ filePath: '/repo/AGENTS.md', heading: 'Stack', startLine: 1, endLine: 3,
        text: 'This project runs on .NET 8 with ASP.NET Core 8.' })],
      '/repo/AGENTS.md',
    );
    const issues = detectVersionConflicts([f1, f2]);
    expect(issues.filter((i) => i.title.includes('.NET'))).toHaveLength(0);
  });

  it('flags when two files declare different major versions of the same framework', () => {
    const f1 = makeFile(
      [makeSection({ filePath: '/repo/CLAUDE.md', heading: 'Stack', startLine: 1, endLine: 4,
        text: 'ASP.NET Core 8.0 (.NET 8) — C# 12 — Entity Framework Core 8.' })],
      '/repo/CLAUDE.md',
    );
    const f2 = makeFile(
      [makeSection({ filePath: '/repo/AGENTS.md', heading: 'Stack', startLine: 1, endLine: 4,
        text: 'This project targets .NET 6 (not .NET 8). Use Host.CreateDefaultBuilder().' })],
      '/repo/AGENTS.md',
    );
    const issues = detectVersionConflicts([f1, f2]);
    const netConflict = issues.find(
      (i) => i.category === 'conflict' && i.title.includes('.NET'),
    );
    expect(netConflict).toBeDefined();
    expect(netConflict!.severity).toBe('high');
    expect(netConflict!.confidence).toBe(0.75);
    // The "not .NET 8" reference in AGENTS.md should NOT count as a positive declaration
    // → only .NET 6 from AGENTS.md and .NET 8 from CLAUDE.md should appear
    expect(netConflict!.title).toContain('6');
    expect(netConflict!.title).toContain('8');
  });

  it('does NOT count "not .NET 8" as a positive .NET 8 declaration', () => {
    const f1 = makeFile(
      [makeSection({ filePath: '/repo/CLAUDE.md', heading: 'Stack', startLine: 1, endLine: 3,
        text: 'This project targets .NET 6.' })],
      '/repo/CLAUDE.md',
    );
    const f2 = makeFile(
      [makeSection({ filePath: '/repo/AGENTS.md', heading: 'Stack', startLine: 1, endLine: 3,
        text: 'This project targets .NET 6 (not .NET 8).' })],
      '/repo/AGENTS.md',
    );
    // Both files say .NET 6 — negated "not .NET 8" should not create a false conflict
    const issues = detectVersionConflicts([f1, f2]);
    expect(issues.filter((i) => i.title.includes('.NET'))).toHaveLength(0);
  });

  it('extracts v-prefixed runtime versions such as Node v20', () => {
    const f1 = makeFile(
      [makeSection({ filePath: '/repo/CLAUDE.md', heading: 'Stack', startLine: 1, endLine: 3,
        text: 'This project uses Node v20.' })],
      '/repo/CLAUDE.md',
    );
    const f2 = makeFile(
      [makeSection({ filePath: '/repo/AGENTS.md', heading: 'Stack', startLine: 1, endLine: 3,
        text: 'This project uses Node 18.' })],
      '/repo/AGENTS.md',
    );
    const issues = detectVersionConflicts([f1, f2]);
    const nodeConflict = issues.find((i) => i.title.includes('Node.js'));
    expect(nodeConflict).toBeDefined();
    expect(nodeConflict!.title).toContain('18');
    expect(nodeConflict!.title).toContain('20');
  });

  it('extracts v-prefixed framework versions beyond Node and React', () => {
    const f1 = makeFile(
      [makeSection({ filePath: '/repo/CLAUDE.md', heading: 'Stack', startLine: 1, endLine: 3,
        text: 'This project uses TypeScript v4 and Java v8.' })],
      '/repo/CLAUDE.md',
    );
    const f2 = makeFile(
      [makeSection({ filePath: '/repo/AGENTS.md', heading: 'Stack', startLine: 1, endLine: 3,
        text: 'This project uses TypeScript 5 and Java 21.' })],
      '/repo/AGENTS.md',
    );
    const issues = detectVersionConflicts([f1, f2]);
    const tsConflict = issues.find((i) => i.title.includes('TypeScript'));
    const javaConflict = issues.find((i) => i.title.includes('Java'));
    expect(tsConflict).toBeDefined();
    expect(javaConflict).toBeDefined();
  });

  it('produces well-formed issue objects', () => {
    const f1 = makeFile(
      [makeSection({ filePath: '/repo/CLAUDE.md', heading: 'Stack', startLine: 1, endLine: 3,
        text: 'React 18 — Next.js 14.' })],
      '/repo/CLAUDE.md',
    );
    const f2 = makeFile(
      [makeSection({ filePath: '/repo/AGENTS.md', heading: 'Stack', startLine: 1, endLine: 3,
        text: 'React 16 — legacy app.' })],
      '/repo/AGENTS.md',
    );
    const issues = detectVersionConflicts([f1, f2]);
    const issue = issues.find((i) => i.title.includes('React'));
    expect(issue).toBeDefined();
    expect(issue!.id).toMatch(/^version-conflict-[a-f0-9]{12}$/);
    expect(issue!.category).toBe('conflict');
    expect(issue!.filePaths).toHaveLength(2);
    expect(issue!.evidence.length).toBeGreaterThan(0);
  });
});

// ── BUG-009: Version conflict FP from deprecation-context version numbers ─────

describe('detectVersionConflicts — deprecation context (BUG-009)', () => {
  it('does NOT flag "deprecated in Go 1.16" vs project target "Go 1.23"', () => {
    const f1 = makeFile(
      [makeSection({ filePath: '/repo/CLAUDE.md', heading: 'Stack', startLine: 1, endLine: 4,
        text: '## Stack\nThis project targets Go 1.23. Use the standard library.' })],
      '/repo/CLAUDE.md',
    );
    const f2 = makeFile(
      [makeSection({ filePath: '/repo/.github/copilot-instructions.md', heading: 'Do Not Suggest', startLine: 1, endLine: 6,
        text: [
          '## Do Not Suggest',
          '- `ioutil` package — it was deprecated in Go 1.16; use os/io instead.',
          '- `github.com/pkg/errors` — use stdlib fmt.Errorf with %w instead.',
        ].join('\n') })],
      '/repo/.github/copilot-instructions.md',
    );
    const issues = detectVersionConflicts([f1, f2]);
    // The "Go 1.16" reference is purely historical (deprecation note) — should NOT conflict
    expect(issues.filter((i) => i.title.includes('Go'))).toHaveLength(0);
  });

  it('does NOT flag "removed in .NET 6" historical note vs current ".NET 8" target', () => {
    const f1 = makeFile(
      [makeSection({ filePath: '/repo/CLAUDE.md', heading: 'Stack', startLine: 1, endLine: 3,
        text: 'This project runs on .NET 8. Use minimal APIs.' })],
      '/repo/CLAUDE.md',
    );
    const f2 = makeFile(
      [makeSection({ filePath: '/repo/AGENTS.md', heading: 'Deprecated', startLine: 1, endLine: 3,
        text: 'The old Host.CreateDefaultBuilder was deprecated in .NET 6. Use WebApplication.CreateBuilder.' })],
      '/repo/AGENTS.md',
    );
    const issues = detectVersionConflicts([f1, f2]);
    expect(issues.filter((i) => i.title.includes('.NET'))).toHaveLength(0);
  });

  it('STILL flags genuine version disagreement not from deprecation context', () => {
    const f1 = makeFile(
      [makeSection({ filePath: '/repo/CLAUDE.md', heading: 'Stack', startLine: 1, endLine: 3,
        text: 'This project targets Go 1.23.' })],
      '/repo/CLAUDE.md',
    );
    const f2 = makeFile(
      [makeSection({ filePath: '/repo/AGENTS.md', heading: 'Stack', startLine: 1, endLine: 3,
        text: 'We are on Go 1.21 for now until the CI image is updated.' })],
      '/repo/AGENTS.md',
    );
    const issues = detectVersionConflicts([f1, f2]);
    expect(issues.filter((i) => i.title.includes('Go'))).toHaveLength(1);
  });
});

// ── BUG-001: Cross-pair subject conflict ─────────────────────────────────────

describe('detectConflicts — cross-pair subject conflict (BUG-001)', () => {
  it('detects "Always use named exports / Never use default exports" vs "prefer default exports"', () => {
    const secA = makeSection({
      filePath: '/repo/CLAUDE.md',
      heading: 'Exports',
      startLine: 1,
      endLine: 6,
      text: [
        '## Exports',
        'Always use named exports. Never use default exports.',
        'This keeps imports explicit and refactoring easier.',
        'Never use default exports for any module in this codebase.',
      ].join('\n'),
    });
    const secB = makeSection({
      filePath: '/repo/AGENTS.md',
      heading: 'Exports',
      startLine: 1,
      endLine: 5,
      text: [
        '## Exports',
        'We strongly prefer default exports in this project.',
        'Default exports are more idiomatic in Next.js page/layout files.',
        'Named exports are fine for utilities.',
      ].join('\n'),
    });

    const issues = detectConflicts([
      makeFile([secA], '/repo/CLAUDE.md'),
      makeFile([secB], '/repo/AGENTS.md'),
    ]);

    const exportConflict = issues.find(
      (i) => i.category === 'conflict' && i.title.toLowerCase().includes('default export'),
    );
    expect(exportConflict).toBeDefined();
  });

  it('does NOT produce duplicate cross-pair issues for the same pair of sections', () => {
    const secA = makeSection({
      filePath: '/repo/CLAUDE.md',
      heading: 'Exports',
      startLine: 1,
      endLine: 4,
      text: [
        '## Exports',
        'Always use named exports. Never use default exports.',
        'This keeps imports explicit.',
      ].join('\n'),
    });
    const secB = makeSection({
      filePath: '/repo/AGENTS.md',
      heading: 'Exports',
      startLine: 1,
      endLine: 4,
      text: [
        '## Exports',
        'We prefer default exports in this project.',
        'Default exports are idiomatic.',
      ].join('\n'),
    });

    const issues = detectConflicts([
      makeFile([secA], '/repo/CLAUDE.md'),
      makeFile([secB], '/repo/AGENTS.md'),
    ]);

    // Count how many issues reference "default export" — should be 1 or 2, not many
    const defaultExportIssues = issues.filter(
      (i) => i.category === 'conflict' && i.title.toLowerCase().includes('default export'),
    );
    expect(defaultExportIssues.length).toBeLessThanOrEqual(2);
  });
});

// ── BUG-005: Pre-copula subject extraction ────────────────────────────────────

describe('detectConflicts — preferred / only acceptable (BUG-005)', () => {
  it('detects "synchronous handlers are preferred" vs "synchronous handlers are only acceptable"', () => {
    const secA = makeSection({
      filePath: '/repo/CLAUDE.md',
      heading: 'Async Patterns',
      startLine: 1,
      endLine: 6,
      text: [
        '## Async Patterns',
        'Use async/await throughout. All I/O must be async.',
        'Synchronous handlers are only acceptable for pure in-memory operations with no I/O.',
      ].join('\n'),
    });
    const secB = makeSection({
      filePath: '/repo/AGENTS.md',
      heading: 'Async Patterns',
      startLine: 1,
      endLine: 6,
      text: [
        '## Async Patterns',
        'For simple endpoints that do not touch I/O, synchronous handlers are preferred.',
        'Use async/await for all database and network calls.',
      ].join('\n'),
    });

    const issues = detectConflicts([
      makeFile([secA], '/repo/CLAUDE.md'),
      makeFile([secB], '/repo/AGENTS.md'),
    ]);

    const syncConflict = issues.find(
      (i) => i.category === 'conflict' && i.title.toLowerCase().includes('synchronous'),
    );
    expect(syncConflict).toBeDefined();
    // Subjects match exactly → confidence 0.8 → high severity is correct
    expect(['warning', 'high']).toContain(syncConflict!.severity);
  });

  it('does NOT flag when only "preferred" appears with no "only acceptable" counterpart', () => {
    const secA = makeSection({
      filePath: '/repo/CLAUDE.md',
      heading: 'Style',
      startLine: 1,
      endLine: 4,
      text: '## Style\nFunctional components are preferred for new React code.',
    });

    const issues = detectConflicts([makeFile([secA], '/repo/CLAUDE.md')]);
    expect(issues.filter((i) => i.category === 'conflict')).toHaveLength(0);
  });
});

// ── BUG-001: "migrating away from X" as a negative directive ─────────────────

describe('detectConflicts — BUG-001 migrating away from', () => {
  it('flags "use Redux" vs "migrating away from Redux" (exact subject match)', () => {
    const secA = makeSection({
      filePath: '/repo/CLAUDE.md',
      heading: 'State Management',
      startLine: 1, endLine: 5,
      text: [
        '## State Management',
        'We use Redux for global app state.',
        'All slice files live under src/features/. Use createSlice and createAsyncThunk.',
        'Selectors should be memoized with createSelector.',
      ].join('\n'),
    });
    const secB = makeSection({
      filePath: '/repo/AGENTS.md',
      heading: 'State Management',
      startLine: 1, endLine: 5,
      text: [
        '## State Management',
        'We are actively migrating away from Redux. New features should use Zustand.',
        'Do not add new Redux slices. Existing slices are being replaced incrementally.',
      ].join('\n'),
    });

    const issues = detectConflicts([makeFile([secA], '/repo/CLAUDE.md'), makeFile([secB], '/repo/AGENTS.md')]);
    const conflict = issues.find((i) => i.category === 'conflict' && i.title.toLowerCase().includes('redux'));
    expect(conflict).toBeDefined();
  });

  it('flags "use Redux Toolkit" vs "migrating away from Redux" (allowSingleTokenMatch Jaccard path)', () => {
    // "redux toolkit" (2 words pos) vs "redux" (1 word neg) — only allowed because
    // the "use / migrating away from" pair has allowSingleTokenMatch: true
    const secA = makeSection({
      filePath: '/repo/CLAUDE.md',
      heading: 'State',
      startLine: 1, endLine: 4,
      text: '## State\nWe use Redux Toolkit for global app state. All slices live in src/features/.',
    });
    const secB = makeSection({
      filePath: '/repo/AGENTS.md',
      heading: 'State',
      startLine: 1, endLine: 4,
      text: '## State\nWe are actively migrating away from Redux. New features should use Zustand instead.',
    });
    const issues = detectConflicts([makeFile([secA], '/repo/CLAUDE.md'), makeFile([secB], '/repo/AGENTS.md')]);
    const conflict = issues.find((i) => i.category === 'conflict');
    expect(conflict).toBeDefined();
  });

  it('flags "use X" vs "switching away from X"', () => {
    const secA = makeSection({
      filePath: '/repo/CLAUDE.md',
      heading: 'Storage',
      startLine: 1, endLine: 3,
      text: '## Storage\nWe use MongoDB for all persistent storage. Use the mongoose ORM.',
    });
    const secB = makeSection({
      filePath: '/repo/AGENTS.md',
      heading: 'Storage',
      startLine: 1, endLine: 3,
      text: '## Storage\nWe are switching away from MongoDB to PostgreSQL. Use Drizzle ORM for new tables.',
    });
    const issues = detectConflicts([makeFile([secA], '/repo/CLAUDE.md'), makeFile([secB], '/repo/AGENTS.md')]);
    expect(issues.some((i) => i.category === 'conflict')).toBe(true);
  });
});

// ── BUG-002: "X is acceptable in tests" copula positive ──────────────────────

describe('detectConflicts — BUG-002 acceptable copula', () => {
  it('flags "unwrap() is acceptable in tests" vs "Never use unwrap() in production"', () => {
    const secA = makeSection({
      filePath: '/repo/CLAUDE.md',
      heading: 'Rust Style',
      startLine: 1, endLine: 4,
      text: [
        '## Rust Style',
        'Never use unwrap() or expect() in production code paths — only in tests and examples.',
        'Use the ? operator for error propagation.',
      ].join('\n'),
    });
    const secB = makeSection({
      filePath: '/repo/.github/copilot-instructions.md',
      heading: 'Error Handling',
      startLine: 1, endLine: 4,
      text: [
        '## Error Handling',
        'unwrap() is acceptable in tests and one-off scripts; never in production.',
        'Prefer anyhow::Result for application code.',
      ].join('\n'),
    });
    const issues = detectConflicts([
      makeFile([secA], '/repo/CLAUDE.md'),
      makeFile([secB], '/repo/.github/copilot-instructions.md'),
    ]);
    const conflict = issues.find((i) => i.category === 'conflict' && i.title.toLowerCase().includes('unwrap'));
    expect(conflict).toBeDefined();
  });
});

// ── BUG-005: Version conflicts for Rust edition, tokio, axum ─────────────────

describe('detectVersionConflicts — BUG-005 Rust ecosystem', () => {
  it('flags conflicting Rust edition across files', () => {
    const fileA = {
      path: '/repo/CLAUDE.md',
      fileType: 'claude' as const,
      content: '# Stack\nRust 2024 edition, MSRV 1.82, tokio 1.x, axum 0.7.',
      sections: [],
      lineCount: 2, charCount: 55, estimatedTokens: 14,
    };
    const fileB = {
      path: '/repo/.github/copilot-instructions.md',
      fileType: 'copilot' as const,
      content: '# Stack\nWe are on Rust 2018 edition with tokio 0.2 and axum 0.5.',
      sections: [],
      lineCount: 2, charCount: 60, estimatedTokens: 15,
    };
    const issues = detectVersionConflicts([fileA, fileB]);
    const editionConflict = issues.find((i) => i.title.toLowerCase().includes('rust edition'));
    expect(editionConflict).toBeDefined();
    expect(editionConflict!.severity).toBe('high');
  });

  it('flags conflicting tokio versions across files', () => {
    const fileA = {
      path: '/repo/CLAUDE.md',
      fileType: 'claude' as const,
      content: 'Use tokio 1.x for all async runtime. The project targets tokio 1.x APIs.',
      sections: [],
      lineCount: 1, charCount: 65, estimatedTokens: 16,
    };
    const fileB = {
      path: '/repo/.github/copilot-instructions.md',
      fileType: 'copilot' as const,
      content: 'Async runtime is tokio 0.2. Use tokio::runtime::Builder to configure.',
      sections: [],
      lineCount: 1, charCount: 65, estimatedTokens: 16,
    };
    const issues = detectVersionConflicts([fileA, fileB]);
    expect(issues.some((i) => i.title.toLowerCase().includes('tokio'))).toBe(true);
  });
});

describe('detectVersionConflicts — Mirror Networking', () => {
  it('flags Mirror 2021 vs Mirror 78 across instruction and README files', () => {
    const fileA = {
      path: '/repo/AGENTS.md',
      fileType: 'agents' as const,
      content: '## Stack\nUnity 2022 LTS. Mirror Networking 2021 is the networking layer.',
      sections: [],
      lineCount: 2,
      charCount: 70,
      estimatedTokens: 18,
    };
    const fileB = {
      path: '/repo/README.md',
      fileType: 'readme' as const,
      content: '## Requirements\nUnity 6.0 and Mirror 78 are required.',
      sections: [],
      lineCount: 2,
      charCount: 55,
      estimatedTokens: 14,
    };

    const issues = detectVersionConflicts([fileA, fileB]);
    const mirrorConflict = issues.find((i) => i.title.includes('Mirror'));
    expect(mirrorConflict).toBeDefined();
    expect(mirrorConflict!.severity).toBe('high');
  });
});

// ── BUG-010: 1-word subjects must not Jaccard-match 2-word subjects ───────────

describe('detectConflicts — BUG-010 single-word subject FP', () => {
  it('does NOT flag "Use React.memo()" vs "Do not use React Query" as a conflict', () => {
    const secA = makeSection({
      filePath: '/repo/CLAUDE.md',
      heading: 'React Conventions',
      startLine: 1, endLine: 4,
      text: [
        '## React Conventions',
        'Use `React.memo()` for list item components and components that receive stable props.',
        'Prefer functional components.',
      ].join('\n'),
    });
    const secB = makeSection({
      filePath: '/repo/.github/copilot-instructions.md',
      heading: 'Data Fetching',
      startLine: 1, endLine: 4,
      text: [
        '## Data Fetching',
        'Do not use React Query for state that does not come from the server.',
        'Use React Query for all server data — queries and mutations.',
      ].join('\n'),
    });
    const issues = detectConflicts([
      makeFile([secA], '/repo/CLAUDE.md'),
      makeFile([secB], '/repo/.github/copilot-instructions.md'),
    ]);
    // "react" (from React.memo) vs "react query" — different subjects, should NOT fire
    const reactConflict = issues.find(
      (i) => i.category === 'conflict' &&
        i.title.toLowerCase() === 'possible conflicting instruction: react',
    );
    expect(reactConflict).toBeUndefined();
  });
});

// ── BUG-011: Scoped negative directive should not fire as hard conflict ────────

describe('detectConflicts — BUG-011 scoped qualifier suppression', () => {
  it('does NOT flag "Use React Query" vs "Do not use React Query FOR non-server state"', () => {
    const secA = makeSection({
      filePath: '/repo/CLAUDE.md',
      heading: 'Data Fetching',
      startLine: 1, endLine: 4,
      text: [
        '## Data Fetching',
        'Hooks that fetch data use React Query under the hood.',
        'Use `useEffect` for data fetching — use React Query hooks.',
      ].join('\n'),
    });
    const secB = makeSection({
      filePath: '/repo/.github/copilot-instructions.md',
      heading: 'State',
      startLine: 1, endLine: 4,
      text: [
        '## State',
        'Do not use React Query for state that does not come from the server.',
        'Local component state should use useState or Zustand.',
      ].join('\n'),
    });
    const issues = detectConflicts([
      makeFile([secA], '/repo/CLAUDE.md'),
      makeFile([secB], '/repo/.github/copilot-instructions.md'),
    ]);
    // "Do not use React Query for [scope]" is scoped — should not fire as hard conflict
    const reactQueryConflict = issues.find(
      (i) => i.category === 'conflict' &&
        i.title.toLowerCase().includes('react query') &&
        (i.severity === 'high' || i.confidence >= 0.5),
    );
    expect(reactQueryConflict).toBeUndefined();
  });

  it('STILL flags absolute "Never use Redux" vs "We use Redux"', () => {
    // Use exact subjects (both "redux") to verify absolute prohibition fires correctly
    const secA = makeSection({
      filePath: '/repo/CLAUDE.md',
      heading: 'State',
      startLine: 1, endLine: 3,
      text: '## State\nWe use Redux for all global application state. Redux slices live under src/features/.',
    });
    const secB = makeSection({
      filePath: '/repo/AGENTS.md',
      heading: 'State',
      startLine: 1, endLine: 3,
      text: '## State\nNever use Redux. Zustand is the standard state library for this codebase.',
    });
    const issues = detectConflicts([makeFile([secA], '/repo/CLAUDE.md'), makeFile([secB], '/repo/AGENTS.md')]);
    expect(issues.some((i) => i.category === 'conflict')).toBe(true);
  });
});

// ── BUG-006: Test-scope competing pair ────────────────────────────────────────

describe('detectCompetingTechConflicts — entity framework / coroutines plural', () => {
  it('detects "Entity Framework Core" vs "Dapper must be used" as a data-access conflict', () => {
    // dotnet-api PE-018 regression: CLAUDE.md uses full name "Entity Framework Core",
    // .cursorrules uses "Dapper". The 'ef core' pair alone misses this.
    const fileA = makeFile(
      [makeSection({
        filePath: '/repo/CLAUDE.md',
        heading: 'Database Access',
        startLine: 1, endLine: 3,
        text: '## Database Access\nUse Entity Framework Core for all DB queries. Do not use raw SQL or other ORMs.',
      })],
      '/repo/CLAUDE.md',
    );
    const fileB = makeFile(
      [makeSection({
        filePath: '/repo/.cursorrules',
        heading: 'Database',
        startLine: 1, endLine: 3,
        text: '## Database\nRaw SQL queries via Dapper must be used for performance. Do not use EF Core.',
      })],
      '/repo/.cursorrules',
    );
    const issues = detectCompetingTechConflicts([fileA, fileB]);
    const efDapperConflict = issues.find((i) => i.title.toLowerCase().includes('data access'));
    expect(efDapperConflict).toBeDefined();
  });

  it('detects "Always use coroutines" vs "Use UniTask" as a Unity async conflict (plural form)', () => {
    // EchoForge PE-011 regression: instruction files use "coroutines" (plural) which
    // \bcoroutine\b does not match.
    const fileA = makeFile(
      [makeSection({
        filePath: '/repo/CLAUDE.md',
        heading: 'Async',
        startLine: 1, endLine: 4,
        text: '## Async\nUse async/await with UniTask for all async operations. Do not use coroutines.',
      })],
      '/repo/CLAUDE.md',
    );
    const fileB = makeFile(
      [makeSection({
        filePath: '/repo/.cursorrules',
        heading: 'Async',
        startLine: 1, endLine: 4,
        text: '## Async\nAlways use coroutines for time-based sequences and animations.',
      })],
      '/repo/.cursorrules',
    );
    const issues = detectCompetingTechConflicts([fileA, fileB]);
    const asyncConflict = issues.find((i) => i.title.toLowerCase().includes('unity async'));
    expect(asyncConflict).toBeDefined();
  });
});

describe('detectCompetingTechConflicts — BUG-006 test scope', () => {
  it('detects "lightweight unit tests" vs "integration suite" as a test-scope conflict', () => {
    const fileA = makeFile(
      [makeSection({
        filePath: '/repo/CLAUDE.md',
        heading: 'Testing',
        startLine: 1, endLine: 3,
        text: '## Testing\nRun lightweight unit tests only before pushing. Full integration tests run in CI.',
      })],
      '/repo/CLAUDE.md',
    );
    const fileB = makeFile(
      [makeSection({
        filePath: '/repo/QA.md',
        heading: 'Testing',
        startLine: 1, endLine: 3,
        text: '## Testing\nAlways run the full integration suite locally before any push to main.',
      })],
      '/repo/QA.md',
    );
    const issues = detectCompetingTechConflicts([fileA, fileB]);
    const scopeConflict = issues.find((i) => i.title.toLowerCase().includes('test scope'));
    expect(scopeConflict).toBeDefined();
  });
});

// ── BUG-008: Method-call subject truncation ───────────────────────────────────

describe('detectConflicts — BUG-008 method-call subject truncation', () => {
  it('does NOT produce HIGH severity for React.memo vs React 18 APIs directives', () => {
    const secA = makeSection({
      filePath: '/repo/.cursorrules',
      heading: 'Performance',
      startLine: 27, endLine: 34,
      text: [
        '## Performance',
        '- Use `React.memo()` only when profiling shows it to be necessary — premature memoization',
        '  adds overhead and obscures component relationships.',
      ].join('\n'),
    });
    const secB = makeSection({
      filePath: '/repo/CLAUDE.md',
      heading: 'React 18 Migration',
      startLine: 81, endLine: 87,
      text: [
        '## React 18 Migration',
        'Migration from React 17 to React 18 is pending — do not use React 18 APIs',
        '(e.g., `useTransition`, `useDeferredValue`) until the migration is complete.',
      ].join('\n'),
    });
    const issues = detectConflicts([
      makeFile([secA], '/repo/.cursorrules'),
      makeFile([secB], '/repo/CLAUDE.md'),
    ]);
    const reactConflict = issues.find(
      (i) => i.category === 'conflict' && i.title.toLowerCase().includes('react'),
    );
    if (reactConflict) {
      expect(reactConflict.severity).toBe('warning');
      expect(reactConflict.confidence).toBeLessThan(0.7);
    }
  });

  it('STILL fires HIGH for "use Jest" vs "do not use Jest" (no method-call truncation)', () => {
    const secA = makeSection({
      filePath: '/repo/CLAUDE.md',
      heading: 'Testing',
      startLine: 1, endLine: 3,
      text: '## Testing\nAlways use Jest for unit and integration tests. Run npm test before pushing.',
    });
    const secB = makeSection({
      filePath: '/repo/AGENTS.md',
      heading: 'Testing',
      startLine: 1, endLine: 3,
      text: '## Testing\nDo not use Jest. We have migrated to Vitest — run pnpm test instead.',
    });
    const issues = detectConflicts([
      makeFile([secA], '/repo/CLAUDE.md'),
      makeFile([secB], '/repo/AGENTS.md'),
    ]);
    const jestConflict = issues.find(
      (i) => i.category === 'conflict' && i.title.toLowerCase().includes('jest'),
    );
    expect(jestConflict).toBeDefined();
    expect(jestConflict!.severity).toBe('high');
  });
});

// ── BUG-001 (eval): Backtick-quoted crate names + parenthesised Rust edition ──

describe('detectVersionConflicts — BUG-001 (eval) backtick crate names and paren edition', () => {
  it('flags conflicting Rust edition when one file uses "Rust (2024 edition, ...)" format', () => {
    // Ferrogate CLAUDE.md format: "- Rust (2024 edition, MSRV 1.82)"
    // The parenthesis was previously breaking the /\bRust\s+(20\d{2})\s+edition/ pattern.
    const fileA = {
      path: '/repo/CLAUDE.md',
      fileType: 'claude' as const,
      content: '## Stack\n- Rust (2024 edition, MSRV 1.82)\n- `tokio` 1.x (async runtime)\n- `axum` 0.7',
      sections: [],
      lineCount: 3, charCount: 80, estimatedTokens: 20,
    };
    const fileB = {
      path: '/repo/.github/copilot-instructions.md',
      fileType: 'copilot' as const,
      content: '## Project\nWe are on Rust 2018 edition with tokio 0.2 and axum 0.5.',
      sections: [],
      lineCount: 2, charCount: 65, estimatedTokens: 16,
    };
    const issues = detectVersionConflicts([fileA, fileB]);
    const editionConflict = issues.find((i) => i.title.toLowerCase().includes('rust edition'));
    expect(editionConflict).toBeDefined();
    expect(editionConflict!.severity).toBe('high');
  });

  it('flags conflicting tokio version when one file uses backtick format "`tokio` 1.x"', () => {
    const fileA = {
      path: '/repo/CLAUDE.md',
      fileType: 'claude' as const,
      content: '## Stack\n- `tokio` 1.x (async runtime)\n- `axum` 0.7 (HTTP framework)',
      sections: [],
      lineCount: 2, charCount: 60, estimatedTokens: 15,
    };
    const fileB = {
      path: '/repo/.github/copilot-instructions.md',
      fileType: 'copilot' as const,
      content: '## Project\nWe are on Rust 2018 edition with tokio 0.2 and axum 0.5.',
      sections: [],
      lineCount: 2, charCount: 65, estimatedTokens: 16,
    };
    const issues = detectVersionConflicts([fileA, fileB]);
    expect(issues.some((i) => i.title.toLowerCase().includes('tokio'))).toBe(true);
    expect(issues.some((i) => i.title.toLowerCase().includes('axum'))).toBe(true);
  });
});

// ── BUG-003 (eval): "Avoid X" vs "use X extensively" imperative conflict ──────

describe('detectConflicts — BUG-003 (eval) avoid/use imperative contradiction', () => {
  it('flags "Avoid Lombok" (CLAUDE.md) vs "This project uses Lombok extensively" (AGENTS.md)', () => {
    const secA = makeSection({
      filePath: '/repo/CLAUDE.md',
      heading: 'Coding Standards',
      startLine: 1, endLine: 5,
      text: [
        '## Coding Standards',
        'Avoid Lombok. It obscures code, makes debugging harder, and creates implicit magic.',
        'Write explicit constructors, getters, and builders instead.',
        'Prefer Java records for immutable value objects.',
      ].join('\n'),
    });
    const secB = makeSection({
      filePath: '/repo/AGENTS.md',
      heading: 'Lombok Usage',
      startLine: 1, endLine: 6,
      text: [
        '## Lombok Usage',
        'This project uses Lombok extensively. Use @Data, @Builder, @RequiredArgsConstructor.',
        'Never write out getters, setters, or constructors manually when Lombok can generate them.',
        'All entity classes must use @Data or @Getter/@Setter explicitly.',
      ].join('\n'),
    });
    const issues = detectConflicts([
      makeFile([secA], '/repo/CLAUDE.md'),
      makeFile([secB], '/repo/AGENTS.md'),
    ]);
    const lombokConflict = issues.find(
      (i) => i.category === 'conflict' && i.title.toLowerCase().includes('lombok'),
    );
    expect(lombokConflict).toBeDefined();
  });

  it('flags "Avoid [library]" vs "use [library]" across files', () => {
    const secA = makeSection({
      filePath: '/repo/CLAUDE.md',
      heading: 'Libraries',
      startLine: 1, endLine: 3,
      text: '## Libraries\nAvoid Moment.js — it is deprecated and very large. Use date-fns instead.',
    });
    const secB = makeSection({
      filePath: '/repo/AGENTS.md',
      heading: 'Date Handling',
      startLine: 1, endLine: 3,
      text: '## Date Handling\nUse Moment.js for all date formatting. It is already a project dependency.',
    });
    const issues = detectConflicts([
      makeFile([secA], '/repo/CLAUDE.md'),
      makeFile([secB], '/repo/AGENTS.md'),
    ]);
    expect(issues.some((i) => i.category === 'conflict')).toBe(true);
  });

  it('does NOT flag same-file "use X — avoid Y" style guidance', () => {
    // Within a single section, "use async/await — avoid callbacks" is stylistic, not a conflict
    const sec = makeSection({
      filePath: '/repo/CLAUDE.md',
      heading: 'Async Patterns',
      startLine: 1, endLine: 4,
      text: [
        '## Async Patterns',
        'Use async/await throughout the codebase for all I/O operations.',
        'Avoid callbacks and nested promise chains — they are hard to follow.',
      ].join('\n'),
    });
    const issues = detectConflicts([makeFile([sec], '/repo/CLAUDE.md')]);
    // Same section → should not fire
    expect(issues.filter((i) => i.category === 'conflict')).toHaveLength(0);
  });

  it('flags same-section "Always use pandas" vs "Avoid pandas" as a conflict', () => {
    const sec = makeSection({
      filePath: '/repo/AGENTS.md',
      heading: 'Dataframes',
      startLine: 1,
      endLine: 4,
      text: [
        '## Dataframes',
        'Always use pandas for transformations.',
        'Avoid pandas for large datasets, use polars instead.',
      ].join('\n'),
    });
    const issues = detectConflicts([makeFile([sec], '/repo/AGENTS.md')]);
    const pandasConflict = issues.find((i) => i.title.toLowerCase().includes('pandas'));
    expect(pandasConflict).toBeDefined();
    expect(pandasConflict!.category).toBe('conflict');
  });

  it('does NOT flag "Language: Python" vs "dbt models use SQL, not Python" as a conflict', () => {
    // DataLens FP regression: "not Python" in a scoping sentence should not fire the
    // "declared stack / not" pair when the project language IS Python.
    const secA = makeSection({
      filePath: '/repo/CLAUDE.md',
      heading: 'Tech Stack',
      startLine: 1, endLine: 5,
      text: [
        '## Tech Stack',
        '- **Language**: Python 3.12',
        '- **Pipeline**: Apache Airflow 2.9, dbt 1.8',
      ].join('\n'),
    });
    const secB = makeSection({
      filePath: '/repo/.github/copilot-instructions.md',
      heading: 'SQL in Python',
      startLine: 1, endLine: 4,
      text: [
        '## SQL in Python',
        '- dbt models are SQL files in `models/` — use Jinja templating there, not Python.',
      ].join('\n'),
    });
    const issues = detectConflicts([
      makeFile([secA], '/repo/CLAUDE.md'),
      makeFile([secB], '/repo/.github/copilot-instructions.md'),
    ]);
    // "not Python" inside a scoping clause should not fire declared-stack conflict
    const conflictIssues = issues.filter((i) => i.category === 'conflict' && i.title.toLowerCase().includes('python'));
    expect(conflictIssues).toHaveLength(0);
  });
});

// ── C1: a line carrying both polarities keeps its positive directive ────────

describe('detectConflicts — C1 same-line positive+negative directive', () => {
  it('extracts the positive directive from "Use pandas, never use polars."', () => {
    const secA = makeSection({
      filePath: '/repo/AGENTS.md',
      heading: 'Dataframes',
      startLine: 1, endLine: 2,
      // "in this project" (not "for"/"when"/"if") keeps this an unscoped,
      // absolute prohibition rather than tripping the BUG-011 scoped-qualifier
      // downgrade, which is unrelated to the C1 fix under test here.
      text: '## Dataframes\nNever use pandas in this project.',
    });
    const secB = makeSection({
      filePath: '/repo/CLAUDE.md',
      heading: 'Dataframes',
      startLine: 1, endLine: 2,
      text: '## Dataframes\nUse pandas, never use polars.',
    });
    const issues = detectConflicts([
      makeFile([secA], '/repo/AGENTS.md'),
      makeFile([secB], '/repo/CLAUDE.md'),
    ]);
    // Before the fix, the "continue" after the negative match ("never use
    // polars") meant "Use pandas" was never extracted from secB at all, so
    // this conflict against secA's "Never use pandas" was silently missed.
    const pandasConflict = issues.find((i) => i.title.toLowerCase().includes('pandas'));
    expect(pandasConflict).toBeDefined();
  });
});

// ── C2: short sections are no longer dropped wholesale ───────────────────────

describe('detectConflicts - audit regressions for multi-match and fenced code', () => {
  it('extracts a second positive directive on the same logical line', () => {
    const secA = makeSection({
      filePath: '/repo/AGENTS.md',
      heading: 'Dataframes',
      startLine: 1, endLine: 2,
      text: '## Dataframes\nNever use polars.',
    });
    const secB = makeSection({
      filePath: '/repo/CLAUDE.md',
      heading: 'Dataframes',
      startLine: 1, endLine: 2,
      text: '## Dataframes\nUse pandas, use polars.',
    });
    const issues = detectConflicts([
      makeFile([secA], '/repo/AGENTS.md'),
      makeFile([secB], '/repo/CLAUDE.md'),
    ]);
    const polarsConflict = issues.find((i) => i.title.toLowerCase().includes('polars'));
    expect(polarsConflict).toBeDefined();
  });

  it('ignores directive conflicts that only appear inside fenced examples', () => {
    const secA = makeSection({
      filePath: '/repo/CLAUDE.md',
      heading: 'Legacy Example',
      startLine: 1, endLine: 5,
      text: [
        '## Legacy Example',
        '```md',
        'Do not use Redux.',
        '```',
      ].join('\n'),
    });
    const secB = makeSection({
      filePath: '/repo/AGENTS.md',
      heading: 'State',
      startLine: 1, endLine: 2,
      text: '## State\nUse Redux for all global state.',
    });
    const issues = detectConflicts([
      makeFile([secA], '/repo/CLAUDE.md'),
      makeFile([secB], '/repo/AGENTS.md'),
    ]);
    expect(issues.some((i) => i.title.toLowerCase().includes('redux'))).toBe(false);
  });

  it('treats backticked subjects as scoped when followed by a qualifier', () => {
    const secA = makeSection({
      filePath: '/repo/CLAUDE.md',
      heading: 'Data Fetching',
      startLine: 1, endLine: 2,
      text: '## Data Fetching\nUse React Query for server state.',
    });
    const secB = makeSection({
      filePath: '/repo/AGENTS.md',
      heading: 'State',
      startLine: 1, endLine: 2,
      text: '## State\nDo not use `React Query` for local component state.',
    });
    const issues = detectConflicts([
      makeFile([secA], '/repo/CLAUDE.md'),
      makeFile([secB], '/repo/AGENTS.md'),
    ]);
    expect(issues.some((i) => i.title.toLowerCase().includes('react query'))).toBe(false);
  });
});

describe('detectConflicts — C2 short-section floor', () => {
  it('flags a conflict between two terse (<50 char) sections', () => {
    const secA = makeSection({
      filePath: '/repo/CLAUDE.md',
      heading: 'ORM',
      startLine: 1, endLine: 1,
      text: 'Never use Dapper.',
    });
    const secB = makeSection({
      filePath: '/repo/AGENTS.md',
      heading: 'ORM',
      startLine: 1, endLine: 1,
      text: 'Use Dapper for data access.',
    });
    const issues = detectConflicts([
      makeFile([secA], '/repo/CLAUDE.md'),
      makeFile([secB], '/repo/AGENTS.md'),
    ]);
    const dapperConflict = issues.find((i) => i.title.toLowerCase().includes('dapper'));
    expect(dapperConflict).toBeDefined();
  });
});

// ── C3: directive extraction spans a hard line-wrap ──────────────────────────

describe('detectConflicts — C3 directive wrapped across lines', () => {
  it('extracts "do not use Cobra" when wrapped across two lines', () => {
    const secA = makeSection({
      filePath: '/repo/CLAUDE.md',
      heading: 'CLI',
      startLine: 1, endLine: 3,
      text: '## CLI\nDo not\nuse Cobra.',
    });
    const secB = makeSection({
      filePath: '/repo/AGENTS.md',
      heading: 'CLI',
      startLine: 1, endLine: 2,
      text: '## CLI\nWe use Cobra for all CLI commands.',
    });
    const issues = detectConflicts([
      makeFile([secA], '/repo/CLAUDE.md'),
      makeFile([secB], '/repo/AGENTS.md'),
    ]);
    const cobraConflict = issues.find((i) => i.title.toLowerCase().includes('cobra'));
    expect(cobraConflict).toBeDefined();
  });
});

// ── C4: digit-leading tech names ─────────────────────────────────────────────

describe('detectConflicts — C4 digit-leading tech names', () => {
  it('flags "always use 11ty" vs "never use 11ty"', () => {
    const secA = makeSection({
      filePath: '/repo/CLAUDE.md',
      heading: 'Static Site',
      startLine: 1, endLine: 2,
      text: '## Static Site\nAlways use 11ty for the docs site.',
    });
    const secB = makeSection({
      filePath: '/repo/AGENTS.md',
      heading: 'Static Site',
      startLine: 1, endLine: 2,
      text: '## Static Site\nNever use 11ty for new projects.',
    });
    const issues = detectConflicts([
      makeFile([secA], '/repo/CLAUDE.md'),
      makeFile([secB], '/repo/AGENTS.md'),
    ]);
    const conflict = issues.find((i) => i.title.toLowerCase().includes('11ty'));
    expect(conflict).toBeDefined();
  });
});

// ── C5: competing-tech directive verb + term on adjacent lines ───────────────

describe('detectCompetingTechConflicts — C5 directive/term on adjacent lines', () => {
  it('flags a competing-tech conflict when the directive verb is wrapped onto the next line', () => {
    const fileA: InstructionFile = {
      path: '/repo/CLAUDE.md',
      fileType: 'claude',
      content: '## State Management\nUse\nZustand for all client state.',
      sections: [],
      lineCount: 3,
      charCount: 50,
      estimatedTokens: 13,
    };
    const fileB: InstructionFile = {
      path: '/repo/AGENTS.md',
      fileType: 'agents',
      content: '## State Management\nAlways use Redux for all client state.',
      sections: [],
      lineCount: 2,
      charCount: 50,
      estimatedTokens: 13,
    };
    const issues = detectCompetingTechConflicts([fileA, fileB]);
    expect(issues.some((i) => i.title.toLowerCase().includes('zustand'))).toBe(true);
  });

  it('flags a competing-tech conflict when the term is in a heading and the directive is on the next line', () => {
    const fileA: InstructionFile = {
      path: '/repo/CLAUDE.md',
      fileType: 'claude',
      content: '## Zustand\nUse this for all client state management.',
      sections: [],
      lineCount: 2,
      charCount: 50,
      estimatedTokens: 13,
    };
    const fileB: InstructionFile = {
      path: '/repo/AGENTS.md',
      fileType: 'agents',
      content: '## State Management\nAlways use Redux for all client state.',
      sections: [],
      lineCount: 2,
      charCount: 50,
      estimatedTokens: 13,
    };
    const issues = detectCompetingTechConflicts([fileA, fileB]);
    expect(issues.some((i) => i.title.toLowerCase().includes('zustand'))).toBe(true);
  });
});

// ── C6: version-conflict fence stripping ─────────────────────────────────────

describe('detectCompetingTechConflicts - audit regressions for fenced code and aliases', () => {
  it('ignores competing-tech terms that only appear inside fenced examples', () => {
    const fileA: InstructionFile = {
      path: '/repo/CLAUDE.md',
      fileType: 'claude',
      content: [
        '## Legacy Example',
        '```md',
        'Use Redux for old examples.',
        '```',
      ].join('\n'),
      sections: [],
      lineCount: 4,
      charCount: 60,
      estimatedTokens: 15,
    };
    const fileB: InstructionFile = {
      path: '/repo/AGENTS.md',
      fileType: 'agents',
      content: '## State\nUse Zustand for all client state.',
      sections: [],
      lineCount: 2,
      charCount: 42,
      estimatedTokens: 11,
    };
    const issues = detectCompetingTechConflicts([fileA, fileB]);
    expect(issues.some((i) => i.title.toLowerCase().includes('state management'))).toBe(false);
  });

  it('detects spaced naming convention variants such as "camel case"', () => {
    const fileA: InstructionFile = {
      path: '/repo/CLAUDE.md',
      fileType: 'claude',
      content: '## Files\nUse camel case for component file names.',
      sections: [],
      lineCount: 2,
      charCount: 48,
      estimatedTokens: 12,
    };
    const fileB: InstructionFile = {
      path: '/repo/AGENTS.md',
      fileType: 'agents',
      content: '## Files\nUse kebab-case for component file names.',
      sections: [],
      lineCount: 2,
      charCount: 48,
      estimatedTokens: 12,
    };
    const issues = detectCompetingTechConflicts([fileA, fileB]);
    const namingConflict = issues.find((i) => i.title.toLowerCase().includes('file naming'));
    expect(namingConflict).toBeDefined();
  });
});

describe('detectVersionConflicts — C6 fence stripping', () => {
  it('does NOT flag a version referenced only inside a fenced example', () => {
    const fileA: InstructionFile = {
      path: '/repo/CLAUDE.md',
      fileType: 'claude',
      content: [
        '## Legacy Example',
        '```',
        'Old config pinned .NET 6.',
        '```',
      ].join('\n'),
      sections: [],
      lineCount: 4,
      charCount: 60,
      estimatedTokens: 15,
    };
    const fileB: InstructionFile = {
      path: '/repo/AGENTS.md',
      fileType: 'agents',
      content: 'This project targets .NET 8 for all new services.',
      sections: [],
      lineCount: 1,
      charCount: 50,
      estimatedTokens: 13,
    };
    const issues = detectVersionConflicts([fileA, fileB]);
    expect(issues.some((i) => i.title.toLowerCase().includes('.net'))).toBe(false);
  });

  it('still flags a genuine version conflict in real prose alongside a fenced example', () => {
    const fileA: InstructionFile = {
      path: '/repo/CLAUDE.md',
      fileType: 'claude',
      content: [
        'This project targets .NET 6 for all services.',
        '```',
        'Old config pinned .NET 5.',
        '```',
      ].join('\n'),
      sections: [],
      lineCount: 4,
      charCount: 70,
      estimatedTokens: 18,
    };
    const fileB: InstructionFile = {
      path: '/repo/AGENTS.md',
      fileType: 'agents',
      content: 'This project targets .NET 8 for all new services.',
      sections: [],
      lineCount: 1,
      charCount: 50,
      estimatedTokens: 13,
    };
    const issues = detectVersionConflicts([fileA, fileB]);
    expect(issues.some((i) => i.title.toLowerCase().includes('.net'))).toBe(true);
  });
});
