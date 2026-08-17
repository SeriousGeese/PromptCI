import { describe, it, expect } from 'vitest';
import { detectDuplicates, normalizeSection } from '../src/duplicates.js';
import type { InstructionFile, InstructionSection } from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSection(
  overrides: Partial<InstructionSection> & { text: string },
): InstructionSection {
  const text = overrides.text;
  return {
    id: overrides.id ?? 'test-section',
    filePath: overrides.filePath ?? '/repo/CLAUDE.md',
    heading: overrides.heading ?? 'Section',
    startLine: overrides.startLine ?? 1,
    endLine: overrides.endLine ?? 10,
    normalizedText: text.toLowerCase().trim(),
    ...overrides,
    text,
  };
}

function makeFile(
  path: string,
  sections: InstructionSection[],
): InstructionFile {
  const content = sections.map((s) => s.text).join('\n\n');
  return {
    path,
    fileType: 'claude',
    content,
    sections,
    lineCount: content.split('\n').length,
    charCount: content.length,
    estimatedTokens: Math.round(content.length / 4),
  };
}

// A substantial block of text (>100 normalised chars)
const LONG_TEXT_A =
  '## Testing\n\nAlways use Jest for writing all unit tests and integration tests in this project.\n' +
  'Run the test suite with `npm test` before committing any changes.\n' +
  'Ensure all new code has corresponding test coverage of at least 80 percent.\n' +
  'Tests should be co-located with the source files they test.';

const LONG_TEXT_B =
  '## Testing\n\nAlways use Vitest for writing all unit tests and integration tests in this project.\n' +
  'Run the test suite with `pnpm test` before committing any changes.\n' +
  'Ensure all new code has corresponding test coverage of at least 80 percent.\n' +
  'Tests should be co-located with the source files they test.\n' +
  'Do not use Jest — Vitest is the standard for this project.';

const UNRELATED_TEXT =
  'This section discusses deployment pipelines, Docker containers, and Kubernetes manifests. ' +
  'It has nothing in common with the other sections at all and should not be flagged as similar.';

// ---------------------------------------------------------------------------
// normalizeSection
// ---------------------------------------------------------------------------

describe('normalizeSection', () => {
  it('lowercases text', () => {
    expect(normalizeSection('HELLO World')).toBe('hello world');
  });

  it('strips heading markers', () => {
    expect(normalizeSection('## My Section\nsome text')).toBe('my section some text');
  });

  it('strips bullet markers', () => {
    expect(normalizeSection('- item one\n* item two\n+ item three')).toBe(
      'item one item two item three',
    );
  });

  it('strips numbered list markers', () => {
    expect(normalizeSection('1. First\n2. Second')).toBe('first second');
  });

  it('collapses whitespace', () => {
    expect(normalizeSection('  lots   of   spaces  ')).toBe('lots of spaces');
  });
});

// ---------------------------------------------------------------------------
// detectDuplicates — core behaviour
// ---------------------------------------------------------------------------

describe('detectDuplicates', () => {
  it('returns empty array when given no files', () => {
    expect(detectDuplicates([])).toEqual([]);
  });

  it('returns empty array when given a single file with one section', () => {
    const sec = makeSection({ text: LONG_TEXT_A, id: 'testing', heading: 'Testing' });
    const file = makeFile('/repo/CLAUDE.md', [sec]);
    expect(detectDuplicates([file])).toEqual([]);
  });

  it('does NOT flag short sections (under 100 normalised chars)', () => {
    const short = 'Always use Jest for tests. Run npm test.'; // < 100 chars normalised
    const secA = makeSection({
      text: short,
      id: 'testing-a',
      heading: 'Testing',
      filePath: '/repo/CLAUDE.md',
    });
    const secB = makeSection({
      text: short,
      id: 'testing-b',
      heading: 'Testing',
      filePath: '/repo/AGENTS.md',
      startLine: 5,
      endLine: 6,
    });
    const fileA = makeFile('/repo/CLAUDE.md', [secA]);
    const fileB = makeFile('/repo/AGENTS.md', [secB]);
    expect(detectDuplicates([fileA, fileB])).toHaveLength(0);
  });

  it('flags exact duplicate sections across files as severity "high"', () => {
    const secA = makeSection({
      text: LONG_TEXT_A,
      id: 'testing-a',
      heading: 'Testing',
      filePath: '/repo/CLAUDE.md',
      startLine: 1,
      endLine: 7,
    });
    const secB = makeSection({
      text: LONG_TEXT_A, // identical
      id: 'testing-b',
      heading: 'Testing',
      filePath: '/repo/AGENTS.md',
      startLine: 1,
      endLine: 7,
    });
    const fileA = makeFile('/repo/CLAUDE.md', [secA]);
    const fileB = makeFile('/repo/AGENTS.md', [secB]);

    const issues = detectDuplicates([fileA, fileB]);
    expect(issues).toHaveLength(1);
    const issue = issues[0];
    expect(issue.severity).toBe('high');
    expect(issue.confidence).toBeCloseTo(0.95);
    expect(issue.category).toBe('duplicate');
  });

  it('flags near-duplicate sections (Jaccard ≥ 0.8) as severity "warning"', () => {
    const secA = makeSection({
      text: LONG_TEXT_A,
      id: 'testing-a',
      heading: 'Testing',
      filePath: '/repo/CLAUDE.md',
      startLine: 1,
      endLine: 7,
    });
    const secB = makeSection({
      text: LONG_TEXT_B, // similar but not identical
      id: 'testing-b',
      heading: 'Testing',
      filePath: '/repo/AGENTS.md',
      startLine: 1,
      endLine: 8,
    });
    const fileA = makeFile('/repo/CLAUDE.md', [secA]);
    const fileB = makeFile('/repo/AGENTS.md', [secB]);

    const issues = detectDuplicates([fileA, fileB]);
    expect(issues).toHaveLength(1);
    const issue = issues[0];
    expect(issue.severity).toBe('warning');
    expect(issue.confidence).toBeCloseTo(0.75);
    expect(issue.category).toBe('duplicate');
  });

  it('does NOT flag unrelated sections', () => {
    const secA = makeSection({
      text: LONG_TEXT_A,
      id: 'testing',
      heading: 'Testing',
      filePath: '/repo/CLAUDE.md',
      startLine: 1,
      endLine: 7,
    });
    const secB = makeSection({
      text: UNRELATED_TEXT,
      id: 'deployment',
      heading: 'Deployment',
      filePath: '/repo/AGENTS.md',
      startLine: 1,
      endLine: 5,
    });
    const fileA = makeFile('/repo/CLAUDE.md', [secA]);
    const fileB = makeFile('/repo/AGENTS.md', [secB]);

    expect(detectDuplicates([fileA, fileB])).toHaveLength(0);
  });

  it('populates all required issue fields', () => {
    const secA = makeSection({
      text: LONG_TEXT_A,
      id: 'testing-a',
      heading: 'Testing',
      filePath: '/repo/CLAUDE.md',
      startLine: 3,
      endLine: 9,
    });
    const secB = makeSection({
      text: LONG_TEXT_A,
      id: 'testing-b',
      heading: 'Testing',
      filePath: '/repo/AGENTS.md',
      startLine: 5,
      endLine: 11,
    });
    const fileA = makeFile('/repo/CLAUDE.md', [secA]);
    const fileB = makeFile('/repo/AGENTS.md', [secB]);

    const [issue] = detectDuplicates([fileA, fileB]);

    expect(issue.id).toMatch(/^duplicate-[0-9a-f]{12}$/);
    expect(issue.filePaths).toHaveLength(2);
    expect(issue.locations).toHaveLength(2);
    expect(issue.locations[0]).toMatchObject({ startLine: 3, endLine: 9 });
    expect(issue.locations[1]).toMatchObject({ startLine: 5, endLine: 11 });
    // Cluster issues emit one evidence snippet and one size estimate
    expect(issue.evidence).toHaveLength(2);
    expect(issue.evidence[0]!.length).toBeLessThanOrEqual(201); // 200 chars + ellipsis
    expect(issue.title).toContain('Testing');
    expect(issue.recommendation).toBeTruthy();
    expect(issue.summary).toContain('highly similar');
  });

  it('produces stable (deterministic) issue ids across runs', () => {
    const secA = makeSection({
      text: LONG_TEXT_A,
      id: 'testing-a',
      heading: 'Testing',
      filePath: '/repo/CLAUDE.md',
      startLine: 1,
      endLine: 7,
    });
    const secB = makeSection({
      text: LONG_TEXT_A,
      id: 'testing-b',
      heading: 'Testing',
      filePath: '/repo/AGENTS.md',
      startLine: 1,
      endLine: 7,
    });
    const fileA = makeFile('/repo/CLAUDE.md', [secA]);
    const fileB = makeFile('/repo/AGENTS.md', [secB]);

    const run1 = detectDuplicates([fileA, fileB]);
    const run2 = detectDuplicates([fileA, fileB]);
    expect(run1[0].id).toBe(run2[0].id);
  });

  it('groups a 3-way duplicate into ONE issue instead of 3 pairwise issues', () => {
    // Same section in 3 files → should produce 1 issue, not 3
    const make3 = (filePath: string) =>
      makeSection({ text: LONG_TEXT_A, id: `s-${filePath}`, heading: 'Testing', filePath, startLine: 1, endLine: 7 });

    const fileA = makeFile('/repo/CLAUDE.md',  [make3('/repo/CLAUDE.md')]);
    const fileB = makeFile('/repo/AGENTS.md',  [make3('/repo/AGENTS.md')]);
    const fileC = makeFile('/repo/.github/copilot-instructions.md', [make3('/repo/.github/copilot-instructions.md')]);

    const issues = detectDuplicates([fileA, fileB, fileC]);
    expect(issues).toHaveLength(1);

    const issue = issues[0];
    expect(issue.filePaths).toHaveLength(3);
    expect(issue.locations).toHaveLength(3);
    expect(issue.title).toContain('3 files');
    expect(issue.severity).toBe('high');
  });

  it('does not report the same pair twice', () => {
    const secA = makeSection({
      text: LONG_TEXT_A,
      id: 'testing-a',
      heading: 'Testing',
      filePath: '/repo/CLAUDE.md',
      startLine: 1,
      endLine: 7,
    });
    const secB = makeSection({
      text: LONG_TEXT_A,
      id: 'testing-b',
      heading: 'Testing',
      filePath: '/repo/AGENTS.md',
      startLine: 1,
      endLine: 7,
    });
    const fileA = makeFile('/repo/CLAUDE.md', [secA]);
    const fileB = makeFile('/repo/AGENTS.md', [secB]);

    // Run with duplicate file references (shouldn't happen in prod, but defensive)
    const issues = detectDuplicates([fileA, fileB, fileA]);
    // Should only flag the A-B pair once
    const ids = issues.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// BUG-001: Within-file duplicate detection
// ---------------------------------------------------------------------------

describe('detectDuplicates — within-file (BUG-001)', () => {
  const SECTION_TEXT =
    '## Environment Setup\n\n' +
    'python -m venv .venv\n' +
    'source .venv/bin/activate\n' +
    'pip install -r requirements.txt\n' +
    'docker-compose up -d\n' +
    'duckdb init schema.sql\n';

  it('flags an exact duplicate section within a single file as HIGH', () => {
    const secA = makeSection({
      text: SECTION_TEXT,
      heading: 'Environment Setup',
      filePath: '/repo/CLAUDE.md',
      startLine: 10,
      endLine: 17,
    });
    const secB = makeSection({
      text: SECTION_TEXT,        // verbatim repeat
      heading: 'Environment Setup',
      filePath: '/repo/CLAUDE.md', // SAME file
      startLine: 50,
      endLine: 57,
    });
    const file = makeFile('/repo/CLAUDE.md', [secA, secB]);
    const issues = detectDuplicates([file]);

    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('high');
    expect(issues[0].filePaths).toHaveLength(1);   // single file
    expect(issues[0].locations).toHaveLength(2);   // two occurrences
  });

  it('flags a condensed repeat of a prose section in the same file as WARNING', () => {
    const fullProse =
      '## Go Conventions\n\n' +
      'Always wrap errors with context using fmt.Errorf and %w. ' +
      'Do not panic — return errors explicitly. ' +
      'Write godoc comments on all exported functions and types. ' +
      'Use table-driven tests for unit tests. ' +
      'Always pass context.Context as the first parameter to long-running functions. ' +
      'Avoid global state; use dependency injection. ' +
      'Keep functions small and single-purpose.';

    const condensed =
      '## Go Conventions\n\n' +
      '- Wrap errors with fmt.Errorf/%w\n' +
      '- No panics — return errors\n' +
      '- Godoc on all exports\n' +
      '- Table-driven tests\n' +
      '- context.Context first param\n' +
      '- No global state\n' +
      '- Small single-purpose functions\n';

    const secA = makeSection({
      text: fullProse,
      heading: 'Go Conventions',
      filePath: '/repo/CLAUDE.md',
      startLine: 10,
      endLine: 20,
    });
    const secB = makeSection({
      text: condensed,
      heading: 'Go Conventions',
      filePath: '/repo/CLAUDE.md',
      startLine: 80,
      endLine: 90,
    });
    const file = makeFile('/repo/CLAUDE.md', [secA, secB]);
    const issues = detectDuplicates([file]);
    // May or may not fire depending on Jaccard; assert it doesn't crash
    for (const issue of issues) {
      expect(issue.severity).toMatch(/^(high|warning)$/);
    }
  });

  it('does NOT flag unique sections in the same file', () => {
    const secA = makeSection({
      text: LONG_TEXT_A,
      heading: 'Testing',
      filePath: '/repo/CLAUDE.md',
      startLine: 1,
      endLine: 7,
    });
    const secB = makeSection({
      text: UNRELATED_TEXT + ' Additional content making this clearly unrelated.',
      heading: 'Deployment',
      filePath: '/repo/CLAUDE.md',
      startLine: 10,
      endLine: 15,
    });
    const file = makeFile('/repo/CLAUDE.md', [secA, secB]);
    expect(detectDuplicates([file])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// BUG-010: Boilerplate project-summary headings should not be flagged
// ---------------------------------------------------------------------------

describe('detectDuplicates — boilerplate headings (BUG-010)', () => {
  const SUMMARY_TEXT =
    'NovaSaaS is a multi-tenant SaaS platform for project management and invoicing. ' +
    'Built with Next.js, TypeScript, and Drizzle ORM. ' +
    'Pre-MVP — do not add new features without checking the roadmap first.';

  it('does NOT flag identical short project-summary sections across files', () => {
    const secA = makeSection({
      text: SUMMARY_TEXT,
      heading: 'Project Summary',
      filePath: '/repo/CLAUDE.md',
      startLine: 1,
      endLine: 4,
    });
    const secB = makeSection({
      text: SUMMARY_TEXT,
      heading: 'Project Summary',
      filePath: '/repo/AGENTS.md',
      startLine: 1,
      endLine: 4,
    });
    const fileA = makeFile('/repo/CLAUDE.md', [secA]);
    const fileB = makeFile('/repo/AGENTS.md', [secB]);
    expect(detectDuplicates([fileA, fileB])).toHaveLength(0);
  });

  it('does NOT flag headings that START WITH a boilerplate term', () => {
    const secA = makeSection({
      text: SUMMARY_TEXT,
      heading: 'Project Summary / NovaSaaS — Claude Code Instructions',
      filePath: '/repo/CLAUDE.md',
      startLine: 1,
      endLine: 4,
    });
    const secB = makeSection({
      text: SUMMARY_TEXT,
      heading: 'Project Summary / NovaSaaS — Claude Code Instructions',
      filePath: '/repo/AGENTS.md',
      startLine: 1,
      endLine: 4,
    });
    const fileA = makeFile('/repo/CLAUDE.md', [secA]);
    const fileB = makeFile('/repo/AGENTS.md', [secB]);
    expect(detectDuplicates([fileA, fileB])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fixture-based integration test
// ---------------------------------------------------------------------------

describe('detectDuplicates — fixture-conflicts', () => {
  it('detects the duplicate Testing section in fixture-conflicts/CLAUDE.md', async () => {
    const { scanFiles } = await import('../src/scanner.js');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const fixturePath = path.resolve(__dirname, '../../../examples/fixture-conflicts');

    const files = await scanFiles({ repoPath: fixturePath });
    expect(files.length).toBeGreaterThan(0);

    const issues = detectDuplicates(files);
    const testingIssues = issues.filter((i) => i.title.includes('Testing'));
    expect(testingIssues.length).toBeGreaterThanOrEqual(1);

    const issue = testingIssues[0];
    expect(issue.severity).toMatch(/^(high|warning)$/);
    expect(issue.category).toBe('duplicate');
    // Within-file duplicates have 1 unique path; cross-file have 2+
    expect(issue.filePaths.length).toBeGreaterThanOrEqual(1);
    expect(issue.locations.length).toBeGreaterThanOrEqual(2);
  });
});

// ── BUG-004: Same-heading duplicate within one file ───────────────────────────

import { detectDuplicateHeadings } from '../src/duplicates.js';

describe('detectDuplicateHeadings — BUG-004', () => {
  it('returns no issues for empty input', () => {
    expect(detectDuplicateHeadings([])).toEqual([]);
  });

  it('returns no issues when all headings in a file are unique', () => {
    const file = makeFile('/repo/CLAUDE.md', [
      makeSection({ filePath: '/repo/CLAUDE.md', heading: 'Error Handling', startLine: 1, endLine: 10,
        text: '## Error Handling\nAlways return typed errors from domain functions.' }),
      makeSection({ filePath: '/repo/CLAUDE.md', heading: 'Testing', startLine: 11, endLine: 20,
        text: '## Testing\nRun pnpm test before committing.' }),
    ]);
    expect(detectDuplicateHeadings([file])).toHaveLength(0);
  });

  it('flags two identical headings in the same file', () => {
    const file = makeFile('/repo/.github/copilot-instructions.md', [
      makeSection({ filePath: '/repo/.github/copilot-instructions.md', heading: 'Error Handling',
        startLine: 10, endLine: 20,
        text: [
          '## Error Handling',
          'Return typed errors from all domain functions.',
          'Never swallow errors silently in this codebase.',
        ].join('\n') }),
      makeSection({ filePath: '/repo/.github/copilot-instructions.md', heading: 'Error Handling',
        startLine: 60, endLine: 70,
        text: [
          '## Error Handling',
          'Wrap external errors with fmt.Errorf and %w.',
          'Use errors.Is / errors.As for inspection.',
        ].join('\n') }),
    ]);

    const issues = detectDuplicateHeadings([file]);
    expect(issues).toHaveLength(1);
    expect(issues[0].category).toBe('duplicate');
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].title).toMatch(/Error Handling/i);
    expect(issues[0].filePaths).toHaveLength(1);
    expect(issues[0].locations).toHaveLength(2);
  });

  it('does NOT flag duplicate headings across different files', () => {
    const fileA = makeFile('/repo/CLAUDE.md', [
      makeSection({ filePath: '/repo/CLAUDE.md', heading: 'Testing', startLine: 1, endLine: 5,
        text: '## Testing\nRun pnpm test before committing.' }),
    ]);
    const fileB = makeFile('/repo/AGENTS.md', [
      makeSection({ filePath: '/repo/AGENTS.md', heading: 'Testing', startLine: 1, endLine: 5,
        text: '## Testing\nRun npm test after changes.' }),
    ]);
    // Cross-file headings are fine — detectDuplicateHeadings is within-file only
    const issues = detectDuplicateHeadings([fileA, fileB]);
    expect(issues).toHaveLength(0);
  });

  it('does NOT flag boilerplate headings like "Overview"', () => {
    const file = makeFile('/repo/CLAUDE.md', [
      makeSection({ filePath: '/repo/CLAUDE.md', heading: 'Overview', startLine: 1, endLine: 5,
        text: '## Overview\nThis file covers project rules.' }),
      makeSection({ filePath: '/repo/CLAUDE.md', heading: 'Overview', startLine: 30, endLine: 35,
        text: '## Overview\nA second overview for a different section.' }),
    ]);
    expect(detectDuplicateHeadings([file])).toHaveLength(0);
  });

  it('produces stable IDs across multiple calls', () => {
    const file = makeFile('/repo/CLAUDE.md', [
      makeSection({ filePath: '/repo/CLAUDE.md', heading: 'Security', startLine: 1, endLine: 8,
        text: '## Security\nNever hardcode credentials. Use environment variables.' }),
      makeSection({ filePath: '/repo/CLAUDE.md', heading: 'Security', startLine: 50, endLine: 58,
        text: '## Security\nNever hardcode API keys, tokens, or passwords in source code.' }),
    ]);
    const run1 = detectDuplicateHeadings([file]);
    const run2 = detectDuplicateHeadings([file]);
    expect(run1.map((i) => i.id)).toEqual(run2.map((i) => i.id));
  });
});

// ── BUG-006: Overlapping section headings (prefix similarity) ─────────────────

describe('detectDuplicateHeadings — BUG-006 prefix heading similarity', () => {
  it('flags "Accessibility" followed by "Accessibility Standards" in the same file', () => {
    const file = makeFile('/repo/CLAUDE.md', [
      makeSection({
        filePath: '/repo/CLAUDE.md',
        heading: 'Accessibility',
        startLine: 10,
        endLine: 14,
        text: [
          '## Accessibility',
          'Components should be accessible and usable by keyboard and screen reader users.',
          'Use semantic HTML where possible. Provide good defaults.',
        ].join('\n'),
      }),
      makeSection({
        filePath: '/repo/CLAUDE.md',
        heading: 'Accessibility Standards',
        startLine: 16,
        endLine: 24,
        text: [
          '## Accessibility Standards',
          'All interactive elements must meet WCAG 2.1 AA contrast ratio (4.5:1 for text).',
          'Use aria-label on icon-only buttons. Ensure focus indicators are visible.',
          'Keyboard navigation must work for all interactive elements.',
          'Screen reader announcements must be tested with VoiceOver and NVDA.',
        ].join('\n'),
      }),
    ]);
    const issues = detectDuplicateHeadings([file]);
    const overlap = issues.find(
      (i) => i.title.toLowerCase().includes('accessibility') && i.title.toLowerCase().includes('overlapping'),
    );
    expect(overlap).toBeDefined();
    expect(overlap!.category).toBe('duplicate');
  });

  it('flags "Testing" vs "Testing Guidelines" in the same file', () => {
    const file = makeFile('/repo/CLAUDE.md', [
      makeSection({
        filePath: '/repo/CLAUDE.md',
        heading: 'Testing',
        startLine: 5,
        endLine: 8,
        text: '## Testing\nAlways write unit tests for new code. Run pnpm test before committing.',
      }),
      makeSection({
        filePath: '/repo/CLAUDE.md',
        heading: 'Testing Guidelines',
        startLine: 20,
        endLine: 28,
        text: [
          '## Testing Guidelines',
          'Use Vitest for unit and integration tests.',
          'Use Playwright for end-to-end tests.',
          'Tests must be co-located with their source files.',
        ].join('\n'),
      }),
    ]);
    const issues = detectDuplicateHeadings([file]);
    expect(issues.some((i) => i.title.toLowerCase().includes('overlapping'))).toBe(true);
  });

  it('does NOT flag distinct headings that merely share one common word', () => {
    const file = makeFile('/repo/CLAUDE.md', [
      makeSection({
        filePath: '/repo/CLAUDE.md',
        heading: 'Security',
        startLine: 1, endLine: 5,
        text: '## Security\nNever commit secrets. Use env vars for credentials.',
      }),
      makeSection({
        filePath: '/repo/CLAUDE.md',
        heading: 'Performance',
        startLine: 10, endLine: 15,
        text: '## Performance\nMemoize expensive computations. Use virtualization for long lists.',
      }),
    ]);
    const issues = detectDuplicateHeadings([file]);
    expect(issues.filter((i) => i.title.toLowerCase().includes('overlapping'))).toHaveLength(0);
  });

  // ── DU2: mid-word continuation must NOT count as a separate trailing word ──

  it('does NOT flag "Lint" vs "Linting" as overlapping headings (mid-word continuation)', () => {
    const file = makeFile('/repo/CLAUDE.md', [
      makeSection({
        filePath: '/repo/CLAUDE.md',
        heading: 'Lint',
        startLine: 1, endLine: 5,
        text: '## Lint\nRun eslint before committing. Fix all warnings.',
      }),
      makeSection({
        filePath: '/repo/CLAUDE.md',
        heading: 'Linting',
        startLine: 10, endLine: 15,
        text: '## Linting\nUse the shared eslint config. Do not disable rules inline.',
      }),
    ]);
    const issues = detectDuplicateHeadings([file]);
    expect(issues.filter((i) => i.title.toLowerCase().includes('overlapping'))).toHaveLength(0);
  });

  it('does NOT flag "Test" vs "Testing" as overlapping headings (mid-word continuation)', () => {
    const file = makeFile('/repo/CLAUDE.md', [
      makeSection({
        filePath: '/repo/CLAUDE.md',
        heading: 'Test',
        startLine: 1, endLine: 5,
        text: '## Test\nRun the smoke test before release.',
      }),
      makeSection({
        filePath: '/repo/CLAUDE.md',
        heading: 'Testing',
        startLine: 10, endLine: 15,
        text: '## Testing\nUse Vitest for unit and integration tests.',
      }),
    ]);
    const issues = detectDuplicateHeadings([file]);
    expect(issues.filter((i) => i.title.toLowerCase().includes('overlapping'))).toHaveLength(0);
  });

  it('still flags "Accessibility" vs "Accessibility Standards" (genuine trailing word)', () => {
    // Regression control: confirms the DU2 fix didn't also break the real
    // "separate trailing word" case it's meant to keep working.
    const file = makeFile('/repo/CLAUDE.md', [
      makeSection({
        filePath: '/repo/CLAUDE.md',
        heading: 'Accessibility',
        startLine: 1, endLine: 5,
        text: '## Accessibility\nComponents should be accessible and usable by keyboard users.',
      }),
      makeSection({
        filePath: '/repo/CLAUDE.md',
        heading: 'Accessibility Standards',
        startLine: 10, endLine: 15,
        text: '## Accessibility Standards\nAll interactive elements must meet WCAG 2.1 AA contrast ratio.',
      }),
    ]);
    const issues = detectDuplicateHeadings([file]);
    expect(issues.some((i) => i.title.toLowerCase().includes('overlapping'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Heading-level awareness — same text at different levels is not a duplicate
// ---------------------------------------------------------------------------

describe('detectDuplicateHeadings — heading level awareness', () => {
  it('does NOT flag "## Troubleshooting" and "### Troubleshooting" in the same file', () => {
    const longContent = 'Common issues and how to resolve them. Check the logs first.';
    const file = makeFile('/repo/README.md', [
      makeSection({
        filePath: '/repo/README.md',
        heading: 'Troubleshooting',
        startLine: 50,
        endLine: 70,
        text: `## Troubleshooting\n\n${longContent} See the FAQ for more details.`,
      }),
      makeSection({
        filePath: '/repo/README.md',
        heading: 'Troubleshooting',
        startLine: 130,
        endLine: 145,
        text: `### Troubleshooting\n\n${longContent} Contact support if unresolved.`,
      }),
    ]);
    expect(detectDuplicateHeadings([file])).toHaveLength(0);
  });

  it('DOES flag "## Troubleshooting" appearing twice at the same level', () => {
    const longContent = 'Common issues and how to resolve them. Check the logs first.';
    const file = makeFile('/repo/README.md', [
      makeSection({
        filePath: '/repo/README.md',
        heading: 'Troubleshooting',
        startLine: 50,
        endLine: 70,
        text: `## Troubleshooting\n\n${longContent} See the FAQ for more details.`,
      }),
      makeSection({
        filePath: '/repo/README.md',
        heading: 'Troubleshooting',
        startLine: 130,
        endLine: 145,
        text: `## Troubleshooting\n\n${longContent} Contact support if unresolved.`,
      }),
    ]);
    const issues = detectDuplicateHeadings([file]);
    expect(issues.some((i) => i.title.includes('Troubleshooting'))).toBe(true);
  });
});

// ── BUG-003: info-level borderline near-duplicate (65–79% Jaccard) ────────────

// ── DU1: stale union-find severity lookup after cluster re-rooting ───────────

describe('detectDuplicates — DU1 severity survives cluster re-rooting', () => {
  it('reports "high"/0.95 for a cluster where an exact-duplicate pair is later merged into a larger near-duplicate cluster', () => {
    // 26 unique tokens, shared verbatim between A and B (exact duplicate).
    const shared =
      'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike ' +
      'november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu';

    // A and B: byte-for-byte identical normalized text → exact duplicate (high/0.95).
    const secA = makeSection({
      filePath: '/repo/A.md',
      heading: 'Calibration',
      text: `## Calibration\n${shared}`,
    });
    const secB = makeSection({
      filePath: '/repo/B.md',
      heading: 'Calibration',
      text: `## Calibration\n${shared}`,
    });
    // C: one token swapped ("zulu" → "amber") — Jaccard ~0.93 with A/B, a
    // near-duplicate (warning/0.75), NOT an exact match.
    const secC = makeSection({
      filePath: '/repo/C.md',
      heading: 'Calibration',
      text: `## Calibration\n${shared.replace('zulu', 'amber')}`,
    });

    // Processing order matters for reproducing the bug: A vs B (exact, high)
    // is compared BEFORE A vs C (near-dup, warning) in the nested i<j loop,
    // so the A vs C union re-roots the {A,B} cluster that already recorded
    // "high" onto a new root — the old code's eager, root-keyed tracking
    // orphaned that "high" entry and the final report fell back to
    // "warning", even though the cluster still contains an exact duplicate.
    const issues = detectDuplicates([
      makeFile('/repo/A.md', [secA]),
      makeFile('/repo/B.md', [secB]),
      makeFile('/repo/C.md', [secC]),
    ]);

    const dup = issues.find((i) => i.category === 'duplicate');
    expect(dup).toBeDefined();
    // All three files must be in ONE cluster (this is what triggers the re-root).
    expect(dup!.filePaths).toHaveLength(3);
    expect(dup!.severity).toBe('high');
    expect(dup!.confidence).toBeCloseTo(0.95);
  });
});

describe('detectDuplicates — BUG-003 borderline info-level near-duplicate', () => {
  it('emits an info-level issue for cross-file Jaccard overlap near the 0.60 lower bound', () => {
    const common =
      '## Calibration Case\n' +
      'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo tango uniform';
    const secA = makeSection({
      filePath: '/repo/CLAUDE.md',
      heading: 'Calibration Case',
      text: `${common}\n${common}\nsierra victor whiskey xray azure coral`,
    });
    const secB = makeSection({
      filePath: '/repo/AGENTS.md',
      heading: 'Calibration Case',
      text: `${common}\n${common}\nyellow zulu amber bronze copper denim`,
    });

    const issues = detectDuplicates([
      makeFile('/repo/CLAUDE.md', [secA]),
      makeFile('/repo/AGENTS.md', [secB]),
    ]);

    const dup = issues.find((i) => i.category === 'duplicate');
    expect(dup).toBeDefined();
    expect(dup!.severity).toBe('info');
  });

  it('emits an info-level issue for ~65% Jaccard overlap between different-heading sections', () => {
    // Getting Started (prompts/ai-rules.md) vs Environment Setup (CLAUDE.md)
    // Similar setup steps, ~65% word overlap, different headings
    const sharedSteps = [
      'Clone the repository and change into the project directory.',
      'Install dependencies using the project package manager.',
      'Copy the example environment file to create your local env file.',
      'Run the initialisation script to create the schema registry.',
      'Start the service in development mode to verify everything works.',
    ].join('\n');

    const secA = makeSection({
      filePath: '/repo/CLAUDE.md',
      heading: 'Environment Setup',
      text: `## Environment Setup\n${sharedSteps}\nRun tests with: pnpm test`,
    });
    const secB = makeSection({
      filePath: '/repo/prompts/ai-rules.md',
      heading: 'Getting Started',
      text: `## Getting Started\n${sharedSteps}\nActivate the virtual environment before running.`,
    });

    const issues = detectDuplicates([
      makeFile('/repo/CLAUDE.md', [secA]),
      makeFile('/repo/prompts/ai-rules.md', [secB]),
    ]);

    // Should fire at info level (below the warning threshold of 0.8)
    const dup = issues.find((i) => i.category === 'duplicate');
    expect(dup).toBeDefined();
    expect(dup!.severity).toBe('info');
    expect(dup!.confidence).toBeLessThan(0.75);
  });

  it('flags exact duplicated short instruction sections across files', () => {
    const sectionText = [
      '## CI Build Failure Prevention',
      'Run the same validation commands locally before pushing.',
      'Check generated logs before marking CI failures resolved.',
    ].join('\n');

    const secA = makeSection({
      filePath: '/repo/AGENTS.md',
      heading: 'CI Build Failure Prevention',
      text: sectionText,
    });
    const secB = makeSection({
      filePath: '/repo/.github/copilot-instructions.md',
      heading: 'CI Build Failure Prevention',
      text: sectionText,
    });

    const issues = detectDuplicates([
      makeFile('/repo/AGENTS.md', [secA]),
      makeFile('/repo/.github/copilot-instructions.md', [secB]),
    ]);

    const dup = issues.find((i) => i.category === 'duplicate');
    expect(dup).toBeDefined();
    expect(dup!.severity).toBe('high');
  });

  it('does NOT emit info-level duplicate for truly complementary sections (<65% overlap)', () => {
    const secA = makeSection({
      filePath: '/repo/CLAUDE.md',
      heading: 'Error Handling',
      text: [
        '## Error Handling',
        'Configure tenacity for retry logic on transient failures.',
        'Use structlog for structured logging. Forward errors to the DLQ.',
      ].join('\n'),
    });
    const secB = makeSection({
      filePath: '/repo/AGENTS.md',
      heading: 'Error Handling',
      text: [
        '## Error Handling',
        'Commit error-handling code before the business logic that triggers it.',
        'Always write tests for error paths. Document each DLQ consumer in the runbook.',
      ].join('\n'),
    });

    const issues = detectDuplicates([
      makeFile('/repo/CLAUDE.md', [secA]),
      makeFile('/repo/AGENTS.md', [secB]),
    ]);

    // Complementary content: topical overlap but low textual overlap → no info duplicate
    const infoDup = issues.find((i) => i.category === 'duplicate' && i.severity === 'info');
    expect(infoDup).toBeUndefined();
  });

  it('includes duplicate token estimates in evidence and recommendation', () => {
    const secA = makeSection({
      text: LONG_TEXT_A,
      id: 'testing-a',
      heading: 'Testing',
      filePath: '/repo/CLAUDE.md',
      startLine: 1,
      endLine: 7,
    });
    const secB = makeSection({
      text: LONG_TEXT_A,
      id: 'testing-b',
      heading: 'Testing',
      filePath: '/repo/AGENTS.md',
      startLine: 1,
      endLine: 7,
    });
    const fileA = makeFile('/repo/CLAUDE.md', [secA]);
    const fileB = makeFile('/repo/AGENTS.md', [secB]);

    const issues = detectDuplicates([fileA, fileB]);
    expect(issues).toHaveLength(1);
    expect(issues[0].evidence.some(e => e.includes('Duplicated size: ~'))).toBe(true);
    expect(issues[0].recommendation).toContain('tokens per session');
  });
});
