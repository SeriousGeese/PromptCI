/**
 * Phase 9 dogfood-polish tests.
 *
 * Validates the false-positive reductions introduced in Phase 9:
 *   - Duplicates: higher min length, min token count, boilerplate heading skip
 *   - Conflicts: generic-subject filtering
 *   - Stale: code-block stripping, extended year range to 2023
 *   - Missing context: broader keyword matching
 *   - Vague guidance: one issue per section, medium-length line flag
 *   - Health score: per-category top-fix dedup
 */

import { describe, it, expect } from 'vitest';
import { detectDuplicates } from '../src/duplicates.js';
import { detectConflicts } from '../src/conflicts.js';
import { detectStaleInstructions } from '../src/stale-instructions.js';
import { detectMissingContext } from '../src/missing-context.js';
import { detectVagueGuidance } from '../src/vague-guidance.js';
import { selectTopFixes } from '../src/health-score.js';
import type { InstructionFile, InstructionSection, PromptCiIssue, IssueSeverity } from '../src/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSection(
  overrides: Partial<InstructionSection> & { text: string },
): InstructionSection {
  const text = overrides.text;
  return {
    id: overrides.id ?? 'test-sec',
    filePath: overrides.filePath ?? '/repo/CLAUDE.md',
    heading: overrides.heading,
    startLine: overrides.startLine ?? 1,
    endLine: overrides.endLine ?? text.split('\n').length,
    text,
    normalizedText: text.toLowerCase().trim(),
    ...overrides,
  };
}

function makeFile(
  sections: InstructionSection[],
  filePath = '/repo/CLAUDE.md',
): InstructionFile {
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

function makeIssue(
  overrides: Partial<PromptCiIssue> & { severity: IssueSeverity; confidence: number },
): PromptCiIssue {
  return {
    id: overrides.id ?? `issue-${Math.random().toString(36).slice(2, 8)}`,
    severity: overrides.severity,
    category: overrides.category ?? 'duplicate',
    title: overrides.title ?? 'Test issue',
    summary: overrides.summary ?? 'A test issue.',
    filePaths: overrides.filePaths ?? ['/repo/CLAUDE.md'],
    locations: overrides.locations ?? [{ filePath: '/repo/CLAUDE.md' }],
    evidence: overrides.evidence ?? ['evidence'],
    recommendation: overrides.recommendation ?? 'Fix it.',
    confidence: overrides.confidence,
  };
}

// ─── Duplicate detector — Phase 9 changes ────────────────────────────────────

describe('detectDuplicates — Phase 9 polish', () => {
  it('does NOT flag sections shorter than 150 normalised chars (raised from 100)', () => {
    // ~110 chars normalised — above old 100-char threshold but below new 150-char threshold
    const text110 =
      'Always run npm test before committing. Ensure all new code has corresponding test coverage. Done.';
    const secA = makeSection({ text: text110, id: 'a', filePath: '/repo/A.md', startLine: 1 });
    const secB = makeSection({ text: text110, id: 'b', filePath: '/repo/B.md', startLine: 1 });
    const fileA = makeFile([secA], '/repo/A.md');
    const fileB = makeFile([secB], '/repo/B.md');
    // Normalised version is <150, so should NOT be flagged
    expect(detectDuplicates([fileA, fileB])).toHaveLength(0);
  });

  it('does NOT flag sections with fewer than 20 distinct tokens', () => {
    // A section that's long in chars but has very few unique words
    const text = 'Run test run test run test run test run test run test run test run test run test run test.';
    const secA = makeSection({ text, id: 'a', filePath: '/repo/A.md', startLine: 1 });
    const secB = makeSection({ text, id: 'b', filePath: '/repo/B.md', startLine: 1 });
    expect(detectDuplicates([makeFile([secA], '/repo/A.md'), makeFile([secB], '/repo/B.md')])).toHaveLength(0);
  });

  it('does NOT flag near-duplicate sections with boilerplate headings (Introduction, Overview)', () => {
    // Two "Overview" sections that are similar — should not trigger near-duplicate
    const textA =
      'This project is a TypeScript monorepo. It contains multiple packages. Use pnpm for package management. ' +
      'Run pnpm install before starting. All packages share the same tsconfig base. ' +
      'Tests are run with pnpm test. Build with pnpm build. Lint with pnpm lint.';
    const textB =
      'This project is a TypeScript monorepo. It contains several packages. Use pnpm for package management. ' +
      'Run pnpm install to get started. All packages share the same tsconfig base. ' +
      'Tests are run with vitest. Build with pnpm build. Lint with eslint.';

    const secA = makeSection({ text: textA, heading: 'Overview', id: 'a', filePath: '/repo/A.md', startLine: 1 });
    const secB = makeSection({ text: textB, heading: 'Overview', id: 'b', filePath: '/repo/B.md', startLine: 1 });
    const issues = detectDuplicates([makeFile([secA], '/repo/A.md'), makeFile([secB], '/repo/B.md')]);
    // Should not flag near-duplicates for boilerplate headings
    expect(issues.filter((i) => i.severity === 'warning')).toHaveLength(0);
  });

  it('does NOT flag exact-match boilerplate (overview/summary) sections across files', () => {
    // BUG-010 fix: project overview / summary sections are intentionally duplicated
    // across CLAUDE.md, AGENTS.md, etc. — even verbatim copies should not fire.
    const text =
      'This project is a TypeScript monorepo containing multiple packages managed by pnpm. ' +
      'Run pnpm install before starting development. Use pnpm test to run unit tests. ' +
      'Use pnpm build to compile. Lint with pnpm lint before opening a PR. ' +
      'All packages must have type declarations and pass typecheck.';
    const secA = makeSection({ text, heading: 'Overview', id: 'a', filePath: '/repo/A.md', startLine: 1 });
    const secB = makeSection({ text, heading: 'Overview', id: 'b', filePath: '/repo/B.md', startLine: 1 });
    const issues = detectDuplicates([makeFile([secA], '/repo/A.md'), makeFile([secB], '/repo/B.md')]);
    // Boilerplate headings are now filtered even for exact matches (BUG-010 fix)
    expect(issues).toHaveLength(0);
  });
});

// ─── Conflict detector — Phase 9 changes ─────────────────────────────────────

describe('detectConflicts — Phase 9 polish', () => {
  it('does NOT flag conflicts when the extracted subject is generic ("be careful" → "it")', () => {
    const secA = makeSection({
      text: [
        '## Security',
        'Always be careful when handling user input. Validate everything at the boundary.',
        'Use parameterised queries for database access.',
      ].join('\n'),
      filePath: '/repo/A.md',
      heading: 'Security',
      startLine: 1,
      endLine: 4,
    });
    const secB = makeSection({
      text: [
        '## Performance',
        'Never be careless with memory allocations in tight loops.',
        'Profile before optimising.',
      ].join('\n'),
      filePath: '/repo/B.md',
      heading: 'Performance',
      startLine: 1,
      endLine: 3,
    });
    const issues = detectConflicts([makeFile([secA], '/repo/A.md'), makeFile([secB], '/repo/B.md')]);
    // "be" is a stop-word so subjects are too short/generic to produce conflicts
    expect(issues.filter((i) => i.category === 'conflict')).toHaveLength(0);
  });

  it('does NOT flag "must be sure" vs "avoid" as a conflict (generic subject "sure")', () => {
    const secA = makeSection({
      text: 'You must be sure to handle errors in async functions. Use try/catch blocks.',
      filePath: '/repo/A.md',
      heading: 'Error handling',
      startLine: 1,
      endLine: 2,
    });
    const secB = makeSection({
      text: 'Avoid unnecessary error swallowing. Always propagate or log errors.',
      filePath: '/repo/B.md',
      heading: 'Error handling',
      startLine: 1,
      endLine: 2,
    });
    const issues = detectConflicts([makeFile([secA], '/repo/A.md'), makeFile([secB], '/repo/B.md')]);
    // "sure" is a generic subject — should not produce a false positive
    expect(issues.filter((i) => i.evidence[0]?.includes('must be sure'))).toHaveLength(0);
  });
});

// ─── Stale detector — Phase 9 changes ────────────────────────────────────────

describe('detectStaleInstructions — Phase 9 polish', () => {
  it('does NOT flag years inside fenced code blocks', () => {
    const text = [
      '## Dependencies',
      'Use the following lockfile entry:',
      '```',
      '# Installed 2022-01-15 via pnpm',
      'react@18.2.0',
      '```',
      'These are the approved versions.',
    ].join('\n');
    const sec = makeSection({ text, heading: 'Dependencies', startLine: 1 });
    const file = makeFile([sec]);
    const issues = detectStaleInstructions([file]);
    // Year 2022 is inside a code block — should not trigger
    expect(issues).toHaveLength(0);
  });

  it('does NOT flag years inside inline code', () => {
    const text =
      '## Versions\nThe config key is `created_2022` which maps to a timestamp field. Use it as-is.';
    const sec = makeSection({ text, heading: 'Versions', startLine: 1 });
    const file = makeFile([sec]);
    const issues = detectStaleInstructions([file]);
    expect(issues).toHaveLength(0);
  });

  it('flags year 2023 as potentially stale prose', () => {
    const text =
      '## Migration\nIn 2023 we migrated from Webpack to Vite. All legacy Webpack config should be removed.';
    const sec = makeSection({ text, heading: 'Migration', startLine: 1 });
    const file = makeFile([sec]);
    const issues = detectStaleInstructions([file]);
    expect(issues.length).toBeGreaterThanOrEqual(1);
    const issue = issues[0];
    expect(issue.category).toBe('stale_instruction');
  });

  it('does NOT flag years in ISO-format date strings (2022-01-15)', () => {
    const text =
      '## Changelog\nThis rule was added on 2022-03-10. See the linked commit for context.';
    const sec = makeSection({ text, heading: 'Changelog', startLine: 1 });
    const file = makeFile([sec]);
    const issues = detectStaleInstructions([file]);
    // ISO dates like 2022-03-10 have "-" adjacent to year — regex skips them
    expect(issues).toHaveLength(0);
  });
});

// ─── Missing context — Phase 9 changes ───────────────────────────────────────

describe('detectMissingContext — Phase 9 polish', () => {
  it('does NOT flag TypeScript project when tsconfig is mentioned', () => {
    const sec = makeSection({ text: 'See tsconfig.json for compiler settings. Use strict mode.' });
    const file = makeFile([sec]);
    const issues = detectMissingContext([file], 'typescript');
    // Global checks (setup, security) may still fire — assert the TS-specific issue is absent
    expect(issues.find((i) => i.title.includes('TypeScript-specific'))).toBeUndefined();
  });

  it('does NOT flag TypeScript project when tsc is mentioned', () => {
    const sec = makeSection({ text: 'Build the project with `tsc --project tsconfig.build.json`.' });
    const file = makeFile([sec]);
    const issues = detectMissingContext([file], 'typescript');
    // Global checks may still fire (setup, security) — assert the TS-specific issue is absent
    expect(issues.find((i) => i.title.includes('TypeScript-specific'))).toBeUndefined();
  });

  it('does NOT flag Next.js project when "next build" is mentioned', () => {
    const sec = makeSection({ text: 'Run next build before deploying. Use next dev for local development.' });
    const file = makeFile([sec]);
    const issues = detectMissingContext([file], 'nextjs');
    expect(issues.find((i) => i.title.includes('Next.js-specific'))).toBeUndefined();
  });

  it('flags TypeScript project when no TypeScript-specific signals exist', () => {
    const sec = makeSection({ text: 'Write clean, maintainable code. Follow team conventions.' });
    const file = makeFile([sec]);
    const issues = detectMissingContext([file], 'typescript');
    expect(issues.some((i) => i.title.includes('TypeScript-specific'))).toBe(true);
    expect(issues.every((i) => i.category === 'missing_context')).toBe(true);
  });
});

// ─── Vague guidance — Phase 9 changes ────────────────────────────────────────

describe('detectVagueGuidance — Phase 9 polish', () => {
  it('emits at most ONE issue per section even when multiple vague phrases are present', () => {
    const text = [
      '## Style',
      'Write clean code.',
      'Use best practices.',
      'Keep it simple.',
    ].join('\n');
    const sec = makeSection({ text, heading: 'Style', startLine: 1 });
    const file = makeFile([sec]);
    const issues = detectVagueGuidance([file]);
    // Multiple phrases in same section → exactly 1 issue
    expect(issues).toHaveLength(1);
  });

  it('includes all matched vague phrases in the single issue summary', () => {
    const text = [
      '## Style',
      'Write clean code.',
      'Use best practices.',
    ].join('\n');
    const sec = makeSection({ text, heading: 'Style', startLine: 1 });
    const file = makeFile([sec]);
    const [issue] = detectVagueGuidance([file]);
    expect(issue.summary).toContain('write clean code');
    expect(issue.summary).toContain('use best practices');
  });

  it('does NOT flag vague phrases that appear on long, context-rich lines (> 120 chars)', () => {
    // A line that starts with a vague phrase but has 120+ chars of context
    const longLine =
      'Use best practices for security hardening: always validate inputs at the boundary, ' +
      'sanitise HTML output, use parameterised queries, and rotate credentials every 90 days.';
    expect(longLine.length).toBeGreaterThan(120);
    const sec = makeSection({
      text: `## Security\n${longLine}`,
      heading: 'Security',
      startLine: 1,
    });
    const file = makeFile([sec]);
    const issues = detectVagueGuidance([file]);
    // The line is too long to be flagged as "just vague" — it has specifics
    expect(issues).toHaveLength(0);
  });

  it('each section in different files gets its own issue', () => {
    const text = '## Style\nWrite clean code.';
    const secA = makeSection({ text, heading: 'Style', filePath: '/repo/A.md', id: 'a' });
    const secB = makeSection({ text, heading: 'Style', filePath: '/repo/B.md', id: 'b' });
    const fileA = makeFile([secA], '/repo/A.md');
    const fileB = makeFile([secB], '/repo/B.md');
    const issues = detectVagueGuidance([fileA, fileB]);
    expect(issues).toHaveLength(2);
  });
});

// ─── Health score / top fixes — Phase 9 changes ──────────────────────────────

describe('selectTopFixes — Phase 9 polish (per-category dedup)', () => {
  it('returns at most one fix per category', () => {
    const issues = [
      makeIssue({ id: 'd1', title: 'Dup 1', severity: 'high', confidence: 0.9, category: 'duplicate' }),
      makeIssue({ id: 'd2', title: 'Dup 2', severity: 'high', confidence: 0.8, category: 'duplicate' }),
      makeIssue({ id: 'd3', title: 'Dup 3', severity: 'high', confidence: 0.7, category: 'duplicate' }),
      makeIssue({ id: 'c1', title: 'Conflict 1', severity: 'high', confidence: 0.9, category: 'conflict' }),
    ];
    const fixes = selectTopFixes(issues);
    // 2 categories → 2 fixes
    expect(fixes).toHaveLength(2);
    const titles = fixes.map((f) => f.title);
    // Highest-priority duplicate wins
    expect(titles).toContain('Dup 1');
    // The conflict also appears
    expect(titles).toContain('Conflict 1');
  });

  it('selects the highest-priority issue within each category', () => {
    const issues = [
      makeIssue({ id: 'd-low', title: 'Low dup', severity: 'warning', confidence: 0.5, category: 'duplicate' }),
      makeIssue({ id: 'd-high', title: 'High dup', severity: 'high', confidence: 0.9, category: 'duplicate' }),
    ];
    const fixes = selectTopFixes(issues);
    expect(fixes[0].title).toBe('High dup');
    expect(fixes).toHaveLength(1);
  });

  it('allows up to 3 fixes when they span 3 different categories', () => {
    const issues = [
      makeIssue({ id: 'a', severity: 'high', confidence: 0.9, category: 'duplicate' }),
      makeIssue({ id: 'b', severity: 'high', confidence: 0.8, category: 'conflict' }),
      makeIssue({ id: 'c', severity: 'warning', confidence: 0.7, category: 'stale_instruction' }),
    ];
    expect(selectTopFixes(issues)).toHaveLength(3);
  });
});

// ─── Fixture-based missing-context test ──────────────────────────────────────

describe('detectMissingContext — fixture-unity', () => {
  it('fires on fixture-unity AGENTS.md (no Unity-specific keywords present)', async () => {
    const { scanFiles } = await import('../src/scanner.js');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const fixturePath = path.resolve(__dirname, '../../../examples/fixture-unity');

    const files = await scanFiles({ repoPath: fixturePath });
    expect(files.length).toBeGreaterThan(0);

    const issues = detectMissingContext(files, 'unity');
    const unityIssue = issues.find((i) => i.title.includes('Unity'));
    expect(unityIssue).toBeDefined();
    expect(unityIssue!.category).toBe('missing_context');
  });
});

// ─── BUG-004: HTML-comment dated TODO markers ─────────────────────────────────

describe('detectStaleInstructions — HTML comment dated TODO (BUG-004)', () => {
  it('flags <!-- TODO (2022-03-10): ... --> as stale', () => {
    const text = [
      '## Session',
      'Auth uses getServerSession().',
      '<!-- TODO (2022-03-10): migrate remaining NextAuth v3 session callbacks to v4 shape -->',
    ].join('\n');
    const sec = makeSection({ text, heading: 'Session', startLine: 1 });
    const file = makeFile([sec]);
    const issues = detectStaleInstructions([file]);
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].category).toBe('stale_instruction');
  });

  it('flags <!-- WORKAROUND (2021-08-14): ... --> as stale', () => {
    const text =
      '## Save System\n' +
      '<!-- WORKAROUND (2021-08-14): SaveSystem uses BinaryFormatter. Rewrite planned Q3 2022 -->\n' +
      'Use SaveSystem.Load() for all persistence operations.';
    const sec = makeSection({ text, heading: 'Save System', startLine: 1 });
    const file = makeFile([sec]);
    const issues = detectStaleInstructions([file]);
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].category).toBe('stale_instruction');
  });

  it('still does NOT flag plain ISO dates in prose (no HTML comment, no TODO keyword)', () => {
    const text = '## Changelog\nThis rule was updated on 2022-03-10.';
    const sec = makeSection({ text, heading: 'Changelog', startLine: 1 });
    const file = makeFile([sec]);
    const issues = detectStaleInstructions([file]);
    expect(issues).toHaveLength(0);
  });
});

// ─── BUG-005: Extended stale version patterns ─────────────────────────────────

describe('detectStaleInstructions — extended version patterns (BUG-005)', () => {
  it('flags bare "Node 12" (without .js suffix)', () => {
    const text =
      '## Legacy\nThe codebase originally used Node 12 and CRA before migrating to Vite.';
    const sec = makeSection({ text, heading: 'Legacy', startLine: 1 });
    const file = makeFile([sec]);
    const issues = detectStaleInstructions([file]);
    expect(issues.some((i) => i.category === 'stale_instruction')).toBe(true);
  });

  it('flags "Node.js 14" and "Node 16"', () => {
    for (const label of ['Node.js 14', 'Node 16']) {
      const text = `## Info\nRuntime: ${label} or later.`;
      const sec = makeSection({ text, heading: 'Info', startLine: 1 });
      const file = makeFile([sec]);
      const issues = detectStaleInstructions([file]);
      expect(issues.some((i) => i.category === 'stale_instruction')).toBe(
        true,
        `Expected stale issue for "${label}"`,
      );
    }
  });

  it('flags Go 1.17 as stale', () => {
    const text =
      '## Go\nWe previously used Go 1.17 modules. If you see any // +build format constraints, update them.';
    const sec = makeSection({ text, heading: 'Go', startLine: 1 });
    const file = makeFile([sec]);
    const issues = detectStaleInstructions([file]);
    expect(issues.some((i) => i.category === 'stale_instruction')).toBe(true);
  });

  it('does NOT flag current Go 1.22+ as stale', () => {
    const text = '## Go\nThis project uses Go 1.22 with range-over-int.';
    const sec = makeSection({ text, heading: 'Go', startLine: 1 });
    const file = makeFile([sec]);
    const issues = detectStaleInstructions([file]);
    expect(issues.filter((i) => i.evidence.some((e) => e.includes('Go 1')))).toHaveLength(0);
  });

  it('flags Python 2 as stale', () => {
    const text = '## Python\nLegacy scripts use Python 2.7. Migrate to Python 3.';
    const sec = makeSection({ text, heading: 'Python', startLine: 1 });
    const file = makeFile([sec]);
    const issues = detectStaleInstructions([file]);
    expect(issues.some((i) => i.category === 'stale_instruction')).toBe(true);
  });
});

// ─── BUG-008: Vague guidance — missing patterns ───────────────────────────────

describe('detectVagueGuidance — additional patterns (BUG-008)', () => {
  const makeSimpleFile = (text: string) => {
    const sec = makeSection({ text, heading: 'Rules', startLine: 1 });
    return makeFile([sec]);
  };

  it('flags "Follow best practices." (no "use" prefix)', () => {
    const issues = detectVagueGuidance([makeSimpleFile('## Rules\nFollow best practices.')]);
    expect(issues).toHaveLength(1);
  });

  it('flags "Write production-quality code."', () => {
    const issues = detectVagueGuidance([makeSimpleFile('## Rules\nWrite production-quality code.')]);
    expect(issues).toHaveLength(1);
  });

  it('flags "Follow Go best practices for idiomatic code."', () => {
    const issues = detectVagueGuidance([
      makeSimpleFile('## Rules\nFollow Go best practices for idiomatic code.'),
    ]);
    expect(issues).toHaveLength(1);
  });

  it('flags "Make sure everything works before submitting a PR."', () => {
    const issues = detectVagueGuidance([
      makeSimpleFile('## Rules\nMake sure everything works before submitting a PR.'),
    ]);
    expect(issues).toHaveLength(1);
  });
});

// ─── BUG-007: Structure — Claude XML tags, auto-gen header ───────────────────

import { detectAgentPractices } from '../src/agent-practices.js';

describe('detectAgentPractices — structure issues (BUG-007)', () => {
  function makeCursorFile(content: string): InstructionFile {
    return {
      path: '/repo/.cursorrules',
      fileType: 'cursor',
      content,
      sections: [],
      lineCount: content.split('\n').length,
      charCount: content.length,
      estimatedTokens: Math.round(content.length / 4),
    };
  }

  function makeAutoGenFile(content: string, lineCount: number): InstructionFile {
    return {
      path: '/repo/CLAUDE.md',
      fileType: 'claude',
      content,
      sections: [],
      lineCount,
      charCount: content.length,
      estimatedTokens: Math.round(content.length / 4),
    };
  }

  it('flags <claude:thinking> tag in a .cursorrules file', () => {
    const content = [
      '# Cursor Rules',
      'Always check types.',
      '<claude:thinking>When making changes to gameplay systems, think through data flow.</claude:thinking>',
      'Use coroutines for animations.',
    ].join('\n');
    const file = makeCursorFile(content);
    const issues = detectAgentPractices([file]);
    const tagIssue = issues.find((i) => i.title.includes('Claude-specific XML'));
    expect(tagIssue).toBeDefined();
    expect(tagIssue!.severity).toBe('warning');
  });

  it('does NOT flag <claude:thinking> in an actual CLAUDE.md file', () => {
    const content = [
      '# CLAUDE.md',
      '<claude:thinking>Review the architecture before implementing.</claude:thinking>',
      'Use TypeScript strict mode.',
    ].join('\n');
    const file = {
      path: '/repo/CLAUDE.md',
      fileType: 'claude' as const,
      content,
      sections: [],
      lineCount: 3,
      charCount: content.length,
      estimatedTokens: 50,
    };
    const issues = detectAgentPractices([file]);
    expect(issues.find((i) => i.title.includes('Claude-specific XML'))).toBeUndefined();
  });

  it('flags AUTO-GENERATED header on a long human-maintained file', () => {
    const header =
      '<!-- AUTO-GENERATED — DO NOT EDIT MANUALLY -->\n' +
      '<!-- Generated by onboarding-docs-generator v2.1.3 on 2024-09-15 -->\n';
    const body = Array.from({ length: 30 }, (_, i) => `- Rule ${i}: Be specific.`).join('\n');
    const content = header + body;
    const file = makeAutoGenFile(content, 32);
    const issues = detectAgentPractices([file]);
    const genIssue = issues.find((i) => i.title.includes('Misleading auto-generated'));
    expect(genIssue).toBeDefined();
    expect(genIssue!.severity).toBe('warning');
  });

  it('does NOT flag AUTO-GENERATED header on a short file (genuinely generated)', () => {
    const content =
      '<!-- AUTO-GENERATED — DO NOT EDIT MANUALLY -->\n' +
      '<!-- Generated by tool -->\n' +
      'Use TypeScript.\n';
    const file = makeAutoGenFile(content, 3);
    const issues = detectAgentPractices([file]);
    expect(issues.find((i) => i.title.includes('Misleading auto-generated'))).toBeUndefined();
  });
});

// ─── BUG-011: Python/Go setup patterns in missing-context ────────────────────

describe('detectMissingContext — Python/Go setup commands (BUG-011)', () => {
  const makeSimpleFile = (content: string): InstructionFile => ({
    path: '/repo/CLAUDE.md',
    fileType: 'claude',
    content,
    sections: [],
    lineCount: content.split('\n').length,
    charCount: content.length,
    estimatedTokens: Math.round(content.length / 4),
  });

  it('does NOT flag missing setup when pip install is present', () => {
    const file = makeSimpleFile(
      '## Setup\npip install -r requirements.txt\npytest tests/ -v',
    );
    const issues = detectMissingContext([file], 'unknown');
    expect(issues.find((i) => i.title.includes('setup'))).toBeUndefined();
  });

  it('does NOT flag missing setup when "python -m venv" is present in a code block', () => {
    const file = makeSimpleFile(
      '## Setup\n```bash\npython -m venv .venv\nsource .venv/bin/activate\n```',
    );
    const issues = detectMissingContext([file], 'unknown');
    expect(issues.find((i) => i.title.includes('setup'))).toBeUndefined();
  });

  it('does NOT flag missing setup when pytest is mentioned', () => {
    const file = makeSimpleFile('## Testing\nRun `pytest tests/` to execute the test suite.');
    const issues = detectMissingContext([file], 'unknown');
    expect(issues.find((i) => i.title.includes('setup'))).toBeUndefined();
  });

  it('does NOT flag missing setup when go test is mentioned', () => {
    const file = makeSimpleFile('## Testing\nRun `go test ./...` before opening a PR.');
    const issues = detectMissingContext([file], 'unknown');
    expect(issues.find((i) => i.title.includes('setup'))).toBeUndefined();
  });
});
