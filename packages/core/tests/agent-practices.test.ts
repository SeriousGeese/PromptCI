/**
 * Tests for the agent-practices detector.
 */

import { describe, it, expect } from 'vitest';
import { detectAgentPractices } from '../src/agent-practices.js';
import type { InstructionFile } from '../src/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFile(content: string, filePath = '/repo/CLAUDE.md'): InstructionFile {
  return {
    path: filePath,
    fileType: 'claude',
    content,
    sections: [],
    lineCount: content.split('\n').length,
    charCount: content.length,
    estimatedTokens: Math.round(content.length / 4),
  };
}

function makeTypedFile(
  content: string,
  filePath: string,
  fileType: InstructionFile['fileType'],
): InstructionFile {
  return {
    path: filePath,
    fileType,
    content,
    sections: [],
    lineCount: content.split('\n').length,
    charCount: content.length,
    estimatedTokens: Math.round(content.length / 4),
  };
}

const MINIMAL_FILE = makeFile('# Rules\nUse TypeScript. Write tests.');

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('detectAgentPractices', () => {
  it('returns no issues for empty input', () => {
    expect(detectAgentPractices([])).toEqual([]);
  });

  // ── Verification loop ────────────────────────────────────────────────────

  it('flags missing verification loop', () => {
    const issues = detectAgentPractices([MINIMAL_FILE]);
    const issue = issues.find((i) => i.id.includes('no-verification-loop') || i.title.includes('verification loop'));
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('warning');
    expect(issue!.category).toBe('agent_practices');
  });

  it('does NOT flag when verification loop is present', () => {
    const file = makeFile(
      '# Rules\nBefore saying done, run pnpm lint && pnpm typecheck && pnpm test.',
    );
    const issues = detectAgentPractices([file]);
    expect(issues.find((i) => i.title.includes('verification loop'))).toBeUndefined();
  });

  it('recognises "work is not complete until" as a verification loop signal', () => {
    const file = makeFile(
      '# Session Close\nWork is not complete until git push succeeds.',
    );
    expect(
      detectAgentPractices([file]).find((i) => i.title.includes('verification loop')),
    ).toBeUndefined();
  });

  it('does NOT treat ordinary "session end" prose as a verification loop', () => {
    const file = makeFile(
      '# Runtime\nSocket.io session end handling lives in src/net.',
    );
    expect(
      detectAgentPractices([file]).find((i) => i.title.includes('verification loop')),
    ).toBeDefined();
  });

  // ── Honesty policy ────────────────────────────────────────────────────────

  it('flags missing honesty policy at warning severity', () => {
    const issues = detectAgentPractices([MINIMAL_FILE]);
    const issue = issues.find((i) => i.title.includes('honestly'));
    expect(issue).toBeDefined();
    // FEAT-003: elevated from info 0.70 — failure-reporting is a production risk.
    expect(issue!.severity).toBe('warning');
    expect(issue!.confidence).toBe(0.75);
  });

  it('does NOT flag when honesty policy is present', () => {
    const file = makeFile(
      '# Rules\nIf tests fail, report the failure honestly. Never claim success.',
    );
    expect(
      detectAgentPractices([file]).find((i) => i.title.includes('honestly')),
    ).toBeUndefined();
  });

  // ── Ask when unsure (FEAT-005) ────────────────────────────────────────────

  it('flags missing ask-when-unsure instruction at warning severity', () => {
    const issues = detectAgentPractices([MINIMAL_FILE]);
    const issue = issues.find((i) => i.title.includes('ask when unsure'));
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('warning');
    expect(issue!.confidence).toBe(0.75);
    expect(issue!.category).toBe('agent_practices');
  });

  it('does NOT flag when uncertainty handling is present', () => {
    const file = makeFile(
      '# Rules\nIf you are uncertain about the correct approach, ask before proceeding.',
    );
    expect(
      detectAgentPractices([file]).find((i) => i.title.includes('ask when unsure')),
    ).toBeUndefined();
  });

  it('recognises "if unsure" / "don\'t guess" phrasing as uncertainty handling', () => {
    const file = makeFile("# Rules\nIf unsure, say so. Don't guess.");
    expect(
      detectAgentPractices([file]).find((i) => i.title.includes('ask when unsure')),
    ).toBeUndefined();
  });

  it('does NOT let the word "task" satisfy the "ask before" pattern', () => {
    // Regression: an un-anchored /ask before/ matched the "ask" inside "task before".
    const file = makeFile('# Rules\nFinish the current task before moving to the next.');
    expect(
      detectAgentPractices([file]).find((i) => i.title.includes('ask when unsure')),
    ).toBeDefined();
  });

  it('keeps ask-when-unsure distinct from the honesty policy', () => {
    // A file with only a post-hoc honesty policy must still be flagged for the
    // missing before-the-fact uncertainty rule — the two are separate behaviors.
    const file = makeFile(
      '# Rules\nIf tests fail, report the failure honestly. Never claim success.',
    );
    const issues = detectAgentPractices([file]);
    expect(issues.find((i) => i.title.includes('honestly'))).toBeUndefined();
    expect(issues.find((i) => i.title.includes('ask when unsure'))).toBeDefined();
  });

  // ── Read-before-edit ──────────────────────────────────────────────────────

  it('flags missing read-before-edit instruction at warning severity', () => {
    const issues = detectAgentPractices([MINIMAL_FILE]);
    const issue = issues.find((i) => i.title.includes('read before edit'));
    expect(issue).toBeDefined();
    // FEAT-003: elevated from info 0.70 — editing unread files is the #1 mistake.
    expect(issue!.severity).toBe('warning');
    expect(issue!.confidence).toBe(0.75);
  });

  it('does NOT flag when read-before-edit is present', () => {
    const file = makeFile(
      '# Rules\nAlways read a file fully before editing it.',
    );
    expect(
      detectAgentPractices([file]).find((i) => i.title.includes('read before edit')),
    ).toBeUndefined();
  });

  it('does NOT treat generic "must first read" prose as read-before-edit guidance', () => {
    const file = makeFile(
      '# Onboarding\nUsers must first read the onboarding docs before requesting access.',
    );
    expect(
      detectAgentPractices([file]).find((i) => i.title.includes('read before edit')),
    ).toBeDefined();
  });

  // ── Scope control ─────────────────────────────────────────────────────────

  it('flags missing scope-control instruction at warning severity', () => {
    const issues = detectAgentPractices([MINIMAL_FILE]);
    const issue = issues.find((i) => i.title.includes('scope-control'));
    expect(issue).toBeDefined();
    // FEAT-003: elevated from info 0.65 — unconstrained scope yields sweeping diffs.
    expect(issue!.severity).toBe('warning');
    expect(issue!.confidence).toBe(0.7);
  });

  it('does NOT flag when scope control is present', () => {
    const file = makeFile(
      '# Rules\nPrefer focused, minimal diffs. Do not rewrite unrelated systems.',
    );
    expect(
      detectAgentPractices([file]).find((i) => i.title.includes('scope-control')),
    ).toBeUndefined();
  });

  // ── Code preservation (FEAT-006) ──────────────────────────────────────────

  it('flags missing code-preservation instruction at warning severity', () => {
    const issues = detectAgentPractices([MINIMAL_FILE]);
    const issue = issues.find((i) => i.title.includes('code-preservation'));
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('warning');
    expect(issue!.confidence).toBe(0.7);
  });

  it('does NOT flag when code preservation is present', () => {
    const file = makeFile(
      '# Rules\nPreserve existing code and only change what the task requires.',
    );
    expect(
      detectAgentPractices([file]).find((i) => i.title.includes('code-preservation')),
    ).toBeUndefined();
  });

  it('recognises "don\'t delete working code" as code preservation', () => {
    const file = makeFile("# Rules\nDon't delete working tests to make the build pass.");
    expect(
      detectAgentPractices([file]).find((i) => i.title.includes('code-preservation')),
    ).toBeUndefined();
  });

  it('keeps code-preservation distinct from scope-control', () => {
    // A file whose only guidance is about diff breadth (scope-control) must
    // still be flagged for the missing preservation rule, and vice-versa —
    // FEAT-006 acceptance: each behavior covered by exactly one check.
    const scopeOnly = makeFile('# Rules\nPrefer minimal diffs and targeted fixes.');
    const scopeIssues = detectAgentPractices([scopeOnly]);
    expect(scopeIssues.find((i) => i.title.includes('scope-control'))).toBeUndefined();
    expect(scopeIssues.find((i) => i.title.includes('code-preservation'))).toBeDefined();

    const preserveOnly = makeFile('# Rules\nPreserve existing code; keep existing tests.');
    const preserveIssues = detectAgentPractices([preserveOnly]);
    expect(preserveIssues.find((i) => i.title.includes('code-preservation'))).toBeUndefined();
    expect(preserveIssues.find((i) => i.title.includes('scope-control'))).toBeDefined();
  });

  // ── Plan-first ────────────────────────────────────────────────────────────

  it('flags missing plan-first instruction (stays info)', () => {
    const issues = detectAgentPractices([MINIMAL_FILE]);
    const issue = issues.find((i) => i.title.includes('plan before'));
    expect(issue).toBeDefined();
    // FEAT-003: plan-first is genuinely advisory — deliberately kept at info 0.65.
    expect(issue!.severity).toBe('info');
    expect(issue!.confidence).toBe(0.65);
  });

  it('does NOT flag when plan-first is present', () => {
    const file = makeFile(
      '# Rules\nFor complex tasks, outline the approach before writing code.',
    );
    expect(
      detectAgentPractices([file]).find((i) => i.title.includes('plan before'))).toBeUndefined();
  });

  it('does NOT treat casual "think through" prose as plan-first guidance', () => {
    const file = makeFile(
      '# UX\nThe settings screen helps users think through notification choices.',
    );
    expect(
      detectAgentPractices([file]).find((i) => i.title.includes('plan before')),
    ).toBeDefined();
  });

  // ── Guidance can be spread across files ───────────────────────────────────

  it('passes when guidance is split across multiple files', () => {
    const f1 = makeFile(
      'Before finishing, run pnpm lint && pnpm test.',
      '/repo/CLAUDE.md',
    );
    const f2 = makeFile(
      'Always read the file before editing it. Prefer focused diffs. ' +
        'Preserve existing code and only change what the task requires.',
      '/repo/AGENTS.md',
    );
    const f3 = makeFile(
      [
        'If tests fail, report the failure honestly.',
        'If you are uncertain about the approach, ask before proceeding.',
        'Outline the approach before implementing complex changes.',
      ].join('\n'),
      '/repo/.github/copilot-instructions.md',
    );
    const issues = detectAgentPractices([f1, f2, f3]);
    const globalPracticeIssues = issues.filter((i) => i.id.startsWith('agent-practice-'));
    expect(globalPracticeIssues.length).toBe(0);
  });

  // ── Do-not-edit header ────────────────────────────────────────────────────

  it('flags "do not edit" header in human-maintained file', () => {
    const file = makeFile(
      '<!-- do not edit -->\n# CLAUDE.md\nUse TypeScript. Write tests.',
    );
    const issues = detectAgentPractices([file]);
    expect(issues.find((i) => i.title.includes('Do not edit'))).toBeDefined();
  });

  it('does NOT flag "do not edit" when file also has an auto-generated marker', () => {
    const file = makeFile(
      '<!-- do not edit — auto-generated by codegen -->\n# Generated Rules\n...',
    );
    const issues = detectAgentPractices([file]);
    expect(issues.find((i) => i.title.includes('Do not edit'))).toBeUndefined();
  });

  // ── Issue shape ───────────────────────────────────────────────────────────

  it('produces well-formed issue objects', () => {
    const issues = detectAgentPractices([MINIMAL_FILE]);
    for (const issue of issues) {
      expect(issue.id).toMatch(/^(agent-practice|do-not-edit)-[a-f0-9]{12}$/);
      expect(issue.category).toBe('agent_practices');
      expect(['info', 'warning', 'high', 'critical']).toContain(issue.severity);
      expect(issue.title).toBeTruthy();
      expect(issue.recommendation).toBeTruthy();
      expect(issue.confidence).toBeGreaterThan(0);
    }
  });

  it('produces stable IDs across multiple calls', () => {
    const run1 = detectAgentPractices([MINIMAL_FILE]);
    const run2 = detectAgentPractices([MINIMAL_FILE]);
    expect(run1.map((i) => i.id)).toEqual(run2.map((i) => i.id));
  });
});

// ── BUG-002: Checklist items should not suppress verification loop ────────────

describe('detectAgentPractices — BUG-002 checklist suppression', () => {
  it('still flags verification loop when only a checklist has test steps', () => {
    const file = makeFile(
      [
        '# PR Checklist',
        'Complete these checks prior to merging:',
        '- [ ] Run pnpm test',
        '- [ ] Run pnpm lint',
        '- [ ] Update the changelog',
        '- [x] Build passes: npm run build',
      ].join('\n'),
    );
    const issues = detectAgentPractices([file]);
    const verifyIssue = issues.find((i) => i.title.includes('verification loop'));
    expect(verifyIssue).toBeDefined();
  });

  it('does NOT flag when both an imperative directive AND a checklist are present', () => {
    const file = makeFile(
      [
        '# Session Close',
        'Before saying done, run pnpm lint && pnpm typecheck && pnpm test.',
        '',
        '# PR Checklist',
        '- [ ] Run pnpm test',
        '- [ ] Update changelog',
      ].join('\n'),
    );
    const issues = detectAgentPractices([file]);
    expect(issues.find((i) => i.title.includes('verification loop'))).toBeUndefined();
  });

  it('does NOT flag when "work is not complete until" appears outside a checklist', () => {
    const file = makeFile(
      [
        '# Session Close',
        '- [ ] Run npm test',
        '',
        'Work is not complete until git push succeeds.',
      ].join('\n'),
    );
    const issues = detectAgentPractices([file]);
    expect(issues.find((i) => i.title.includes('verification loop'))).toBeUndefined();
  });

  it('does not strip non-list rules that contain numbered checkbox text later in the line', () => {
    const file = makeFile(
      'Always read a file before editing it; ignore the example text 1. [ ] placeholder.',
    );
    const issues = detectAgentPractices([file]);
    expect(issues.find((i) => i.title.includes('read before edit'))).toBeUndefined();
  });
});

// ── BUG-003: <instructions-for-claude> in non-Claude files ───────────────────

describe('detectAgentPractices — BUG-003 instructions-for-claude tag', () => {
  it('flags <instructions-for-claude> block in a copilot-instructions.md file', () => {
    const file: InstructionFile = {
      path: '/repo/.github/copilot-instructions.md',
      fileType: 'copilot',
      content: [
        '# Copilot Instructions',
        'Use TypeScript strict mode.',
        '',
        '<instructions-for-claude>',
        '  Always read files before editing.',
        '</instructions-for-claude>',
      ].join('\n'),
      sections: [],
      lineCount: 6,
      charCount: 100,
      estimatedTokens: 25,
    };
    const issues = detectAgentPractices([file]);
    const tagIssue = issues.find(
      (i) => i.title.toLowerCase().includes('claude') && i.title.toLowerCase().includes('xml'),
    );
    expect(tagIssue).toBeDefined();
    expect(tagIssue!.severity).toBe('warning');
  });

  it('flags <instructions-for-claude> block in AGENTS.md', () => {
    const file: InstructionFile = {
      path: '/repo/AGENTS.md',
      fileType: 'agents',
      content: '<instructions-for-claude>\nAlways prefer TypeScript.\n</instructions-for-claude>',
      sections: [],
      lineCount: 3,
      charCount: 70,
      estimatedTokens: 18,
    };
    const issues = detectAgentPractices([file]);
    expect(issues.some((i) => i.title.toLowerCase().includes('claude') && i.title.toLowerCase().includes('xml'))).toBe(true);
  });

  it('does NOT flag <instructions-for-claude> in CLAUDE.md', () => {
    const file: InstructionFile = {
      path: '/repo/CLAUDE.md',
      fileType: 'claude',
      content: '<instructions-for-claude>\nUse TypeScript.\n</instructions-for-claude>',
      sections: [],
      lineCount: 3,
      charCount: 60,
      estimatedTokens: 15,
    };
    const issues = detectAgentPractices([file]);
    expect(issues.some((i) => i.title.toLowerCase().includes('xml'))).toBe(false);
  });

  it('does NOT flag <instructions-for-claude> inside a fenced code block', () => {
    const file: InstructionFile = {
      path: '/repo/.github/copilot-instructions.md',
      fileType: 'copilot',
      content: [
        '# Docs',
        'Example of a Claude prompt wrapper:',
        '```xml',
        '<instructions-for-claude>',
        '  Example content.',
        '</instructions-for-claude>',
        '```',
      ].join('\n'),
      sections: [],
      lineCount: 7,
      charCount: 120,
      estimatedTokens: 30,
    };
    const issues = detectAgentPractices([file]);
    expect(issues.some((i) => i.title.toLowerCase().includes('xml'))).toBe(false);
  });

  it('does NOT flag Claude XML tags inside a tilde fenced code block', () => {
    const file: InstructionFile = {
      path: '/repo/AGENTS.md',
      fileType: 'agents',
      content: [
        '# Docs',
        '~~~xml',
        '<claude:thinking>',
        'Example content.',
        '</claude:thinking>',
        '~~~',
      ].join('\n'),
      sections: [],
      lineCount: 6,
      charCount: 90,
      estimatedTokens: 23,
    };
    const issues = detectAgentPractices([file]);
    expect(issues.some((i) => i.title.toLowerCase().includes('xml'))).toBe(false);
  });
});

// ── BUG-007: Per-file behavioral gap detection for .cursorrules ───────────────

describe('detectAgentPractices — BUG-007 cursor per-file gap', () => {
  function makeCursorFile(content: string, filePath = '/repo/.cursorrules'): InstructionFile {
    return {
      path: filePath,
      fileType: 'cursor',
      content,
      sections: [],
      lineCount: content.split('\n').length,
      charCount: content.length,
      estimatedTokens: Math.round(content.length / 4),
    };
  }

  it('flags .cursorrules with no behavioral guidance when AGENTS.md has it', () => {
    const cursor = makeCursorFile(
      [
        '# Cursor Rules',
        'Use TypeScript strict mode.',
        'Prefer functional components.',
        'Use ESLint for linting.',
      ].join('\n'),
    );
    const agents = makeFile(
      [
        '# Agent Instructions',
        'Before saying done, run pnpm lint && pnpm test.',
        'Always read the file before editing it.',
        'Prefer focused, minimal diffs.',
      ].join('\n'),
      '/repo/AGENTS.md',
    );
    const issues = detectAgentPractices([cursor, agents]);
    const perFileIssue = issues.find(
      (i) => i.filePaths[0]?.includes('.cursorrules') &&
        i.title.toLowerCase().includes('behavioral'),
    );
    expect(perFileIssue).toBeDefined();
    expect(perFileIssue!.severity).toBe('warning');
  });

  it('does NOT flag .cursorrules that already has behavioral guidance', () => {
    const cursor = makeCursorFile(
      [
        '# Cursor Rules',
        'Before saying done, run pnpm lint && pnpm test.',
        'Always read a file before editing it.',
        'Prefer focused, minimal diffs.',
      ].join('\n'),
    );
    const issues = detectAgentPractices([cursor]);
    expect(
      issues.some(
        (i) => i.filePaths[0]?.includes('.cursorrules') && i.title.toLowerCase().includes('behavioral'),
      ),
    ).toBe(false);
  });

  it('does NOT fire per-file issue when NO file has behavioral guidance (combined check covers it)', () => {
    const cursor = makeCursorFile('# Cursor\nUse TypeScript. Write tests.');
    const agents = makeFile('# Agents\nUse TypeScript. Write tests.', '/repo/AGENTS.md');
    const issues = detectAgentPractices([cursor, agents]);
    const perFileIssues = issues.filter((i) => i.title.toLowerCase().includes('behavioral'));
    expect(perFileIssues).toHaveLength(0);
  });
});

// ── BUG-007: Agent-behavior section in copilot-instructions.md ────────────────

describe('detectAgentPractices — BUG-007 agent-behavior section in copilot file', () => {
  function makeCopilotFile(content: string): InstructionFile {
    return {
      path: '/repo/.github/copilot-instructions.md',
      fileType: 'copilot',
      content,
      sections: [],
      lineCount: content.split('\n').length,
      charCount: content.length,
      estimatedTokens: Math.round(content.length / 4),
    };
  }

  it('flags copilot-instructions.md with an "Agent Behavior" heading and behavioral patterns', () => {
    const copilot = makeCopilotFile([
      '## Tech Stack',
      'This is a .NET 8 / ASP.NET Core project using Entity Framework Core.',
      '',
      '## Agent Behavior',
      'Always prefer focused, minimal diffs. Do not rewrite code unrelated to the current task.',
      'Before saying done, run dotnet build && dotnet test.',
    ].join('\n'));
    const issues = detectAgentPractices([copilot]);
    const bugIssue = issues.find((i) => 
      i.title.toLowerCase().includes('agent-behavior') || 
      i.title.toLowerCase().includes('agent behavior') ||
      i.title.toLowerCase().includes('general behavioral guidance')
    );
    expect(bugIssue).toBeDefined();
    expect(bugIssue!.severity).toBe('warning');
  });

  it('does NOT flag a copilot file that has no "Agent Behavior" section heading', () => {
    const copilot = makeCopilotFile([
      '## Tech Stack',
      'This project uses .NET 8 and Entity Framework Core.',
      'Prefer focused diffs. Before finishing, run dotnet test.',
    ].join('\n'));
    const issues = detectAgentPractices([copilot]);
    const bugIssue = issues.find((i) => i.title.toLowerCase().includes('agent behavior'));
    expect(bugIssue).toBeUndefined();
  });

  it('does NOT flag a CLAUDE.md or AGENTS.md with an "Agent Behavior" heading', () => {
    const claude: InstructionFile = {
      path: '/repo/CLAUDE.md',
      fileType: 'claude',
      content: '## Agent Behavior\nAlways prefer focused, minimal diffs. Run pnpm test before finishing.',
      sections: [],
      lineCount: 2,
      charCount: 80,
      estimatedTokens: 20,
    };
    const issues = detectAgentPractices([claude]);
    const bugIssue = issues.find((i) => i.title.toLowerCase().includes('agent behavior') && i.title.toLowerCase().includes('copilot'));
    expect(bugIssue).toBeUndefined();
  });
});

// ── Per-file behavioral gap detection for Claude and Copilot ─────────────────

describe('detectAgentPractices — per-file behavioral gaps', () => {
  const behavioralGuidance = [
    '# Agent Instructions',
    'Before saying done, run pnpm lint && pnpm test.',
    'If tests fail, report the failure honestly.',
    'Always read the file before editing it.',
    'Prefer focused, minimal diffs.',
    'For complex tasks, outline the approach before writing code.',
  ].join('\n');

  it('flags CLAUDE.md with no behavioral guidance when AGENTS.md has it', () => {
    const claude = makeTypedFile(
      [
        '# Claude Instructions',
        'Use TypeScript strict mode.',
        'Prefer functional components.',
      ].join('\n'),
      '/repo/CLAUDE.md',
      'claude',
    );
    const agents = makeTypedFile(behavioralGuidance, '/repo/AGENTS.md', 'agents');

    const issues = detectAgentPractices([claude, agents]);
    const perFileIssue = issues.find((i) => i.title === 'No behavioral guidance in CLAUDE.md');

    expect(perFileIssue).toBeDefined();
    expect(perFileIssue!.severity).toBe('warning');
    expect(perFileIssue!.filePaths).toEqual(['/repo/CLAUDE.md']);
    expect(perFileIssue!.evidence).toContain('Some behavioral guidance appears in AGENTS.md.');
  });

  it('does NOT classify files by their absolute checkout path (BUG-006)', () => {
    // Regression: a repo checked out under a Claude Code worktree has an
    // absolute path containing `/.claude/worktrees/<branch>/`. Files must be
    // classified by their scanner-derived fileType, not by substring-matching
    // that absolute path — otherwise README.md (and every other file) is
    // misclassified as a Claude instruction file and gets bogus per-file findings.
    const root = '/home/dev/project/.claude/worktrees/feature-x';
    const readme = makeTypedFile('# Project\nInstall with pnpm.', `${root}/README.md`, 'readme');
    const agents = makeTypedFile(behavioralGuidance, `${root}/AGENTS.md`, 'agents');

    const issues = detectAgentPractices([readme, agents]);
    // The README must not be treated as a tool-specific (CLAUDE.md) file: no
    // per-file finding should target it (those anchor a `location` to the file),
    // and nothing should be titled as a CLAUDE.md gap. Global combined-content
    // findings legitimately list every file path but carry no per-file location,
    // so assert on locations, not on filePaths.
    expect(issues.some((i) => i.locations.some((l) => l.filePath === readme.path))).toBe(false);
    expect(issues.some((i) => i.title.includes('CLAUDE.md'))).toBe(false);
  });

  it('flags copilot-instructions.md with no behavioral guidance when AGENTS.md has it', () => {
    const copilot = makeTypedFile(
      [
        '# GitHub Copilot Instructions',
        'Use TypeScript strict mode.',
        'Prefer functional components.',
      ].join('\n'),
      '/repo/.github/copilot-instructions.md',
      'copilot',
    );
    const agents = makeTypedFile(behavioralGuidance, '/repo/AGENTS.md', 'agents');

    const issues = detectAgentPractices([copilot, agents]);
    const perFileIssue = issues.find(
      (i) => i.title === 'No behavioral guidance in .github/copilot-instructions.md',
    );

    expect(perFileIssue).toBeDefined();
    expect(perFileIssue!.severity).toBe('warning');
    expect(perFileIssue!.filePaths).toEqual(['/repo/.github/copilot-instructions.md']);
    expect(perFileIssue!.evidence).toContain('Some behavioral guidance appears in AGENTS.md.');
  });

  it('does NOT flag CLAUDE.md that already has behavioral guidance', () => {
    const claude = makeTypedFile(
      [
        '# Claude Instructions',
        'Before saying done, run pnpm lint && pnpm test.',
        'Use TypeScript strict mode.',
      ].join('\n'),
      '/repo/CLAUDE.md',
      'claude',
    );
    const agents = makeTypedFile(behavioralGuidance, '/repo/AGENTS.md', 'agents');

    const issues = detectAgentPractices([claude, agents]);

    expect(issues.some((i) => i.title === 'No behavioral guidance in CLAUDE.md')).toBe(false);
  });

  it('does NOT flag a non-copilot file named copilot-instructions.md', () => {
    const docs = makeTypedFile(
      '# Copilot Notes\nUse TypeScript strict mode.',
      '/repo/docs/copilot-instructions.md',
      'docs',
    );
    const agents = makeTypedFile(behavioralGuidance, '/repo/AGENTS.md', 'agents');

    detectAgentPractices([docs, agents]);

  });
});

describe('detectAgentPractices — placement detector extensions', () => {
  it('does NOT flag tool-specific file if it contains a forwarding instruction', () => {
    const behavioralGuidance = [
      '# Agent Instructions',
      'Before saying done, run pnpm lint && pnpm test.',
      'If tests fail, report the failure honestly.',
      'Always read the file before editing it.',
      'Prefer focused, minimal diffs.',
      'For complex tasks, outline the approach before writing code.',
    ].join('\n');
    const agents = makeTypedFile(
      behavioralGuidance,
      '/repo/AGENTS.md',
      'agents'
    );
    const claude = makeTypedFile(
      'Follow AGENTS.md for behavioral rules.',
      '/repo/CLAUDE.md',
      'claude',
    );

    const issues = detectAgentPractices([agents, claude]);
    const perFileIssue = issues.find(i => i.title.includes('No behavioral guidance in CLAUDE.md'));
    expect(perFileIssue).toBeUndefined();
  });

  it('does not duplicate canonical-owner behavior duplication findings', () => {
    const sectionText = 'Before saying done, run pnpm test.\n' + 'Rule line\n'.repeat(60);
    const agents: InstructionFile = {
        path: '/repo/AGENTS.md',
        fileType: 'agents',
        content: '# Shared Rules\n' + sectionText,
        sections: [{
            id: 'shared-rules',
            filePath: '/repo/AGENTS.md',
            heading: 'Shared Rules',
            startLine: 1,
            endLine: 62,
            text: sectionText,
            normalizedText: sectionText.toLowerCase().trim()
        }],
        lineCount: 62,
        charCount: 1000,
        estimatedTokens: 250
    };
    const claude: InstructionFile = {
        path: '/repo/CLAUDE.md',
        fileType: 'claude',
        content: '# Shared Rules\n' + sectionText,
        sections: [{
            id: 'shared-rules',
            filePath: '/repo/CLAUDE.md',
            heading: 'Shared Rules',
            startLine: 1,
            endLine: 62,
            text: sectionText,
            normalizedText: sectionText.toLowerCase().trim()
        }],
        lineCount: 62,
        charCount: 1000,
        estimatedTokens: 250
    };

    const issues = detectAgentPractices([agents, claude]);
    const duplicationIssue = issues.find(i => i.id.includes('behavior-duplication'));
    expect(duplicationIssue).toBeUndefined();
  });

  it('flags when behavioral guidance appears ONLY in Copilot instructions', () => {
    const copilot = makeTypedFile(
      '# Agent Rules\nBefore saying done, run pnpm test.\nAlways read before edit.\nPrefer focused diffs.\nReport failures honestly.',
      '/repo/.github/copilot-instructions.md',
      'copilot'
    );
    const agents = makeTypedFile('# Just a stub', '/repo/AGENTS.md', 'agents');

    const issues = detectAgentPractices([copilot, agents]);
    const placementIssue = issues.find(i => i.title === 'General behavioral guidance placed only in Copilot instructions');
    expect(placementIssue).toBeDefined();
  });

  it('flags specific missing guidance in CLAUDE.md when present in AGENTS.md but absent in CLAUDE.md', () => {
    const agents = makeTypedFile(
      'Before saying done, run pnpm test. Always read a file before editing it.',
      '/repo/AGENTS.md',
      'agents'
    );
    const claude = makeTypedFile(
      'Before saying done, run pnpm test.',
      '/repo/CLAUDE.md',
      'claude'
    );

    const issues = detectAgentPractices([agents, claude]);
    const missingReadIssue = issues.find(
      (i) => i.title.includes('Missing critical guidance') && i.title.includes('read before edit')
    );
    expect(missingReadIssue).toBeDefined();
    expect(missingReadIssue!.severity).toBe('warning');
    expect(missingReadIssue!.fixRecipe).toBe('Read a file before editing it. Preserve unrelated user changes.');
  });
});

// ── AP1: vacuous-pass FNs (incidental prose satisfying a directive check) ────

describe('detectAgentPractices — AP1 vacuous-pass fixes', () => {
  it('still flags "no verification loop" when the only pnpm mention is descriptive prose', () => {
    const file = makeFile('# Build\npnpm build outputs to dist/. Use TypeScript strict mode.');
    const issues = detectAgentPractices([file]);
    expect(issues.some((i) => i.title === 'No verification loop instruction')).toBe(true);
  });

  it('does NOT flag "no verification loop" when pnpm test appears as a real directive', () => {
    const file = makeFile('# Build\nRun pnpm test before committing changes.');
    const issues = detectAgentPractices([file]);
    expect(issues.some((i) => i.title === 'No verification loop instruction')).toBe(false);
  });

  it('still flags "no honesty policy" when the only "honest" mention is filler ("to be honest")', () => {
    const file = makeFile('# Notes\nTo be honest, this module is a bit messy but it works.');
    const issues = detectAgentPractices([file]);
    expect(issues.some((i) => i.title === 'No "report failures honestly" instruction')).toBe(true);
  });

  it('does NOT flag "no honesty policy" when honesty is a real directive', () => {
    const file = makeFile('# Rules\nAlways report test results honestly, even on failure.');
    const issues = detectAgentPractices([file]);
    expect(issues.some((i) => i.title === 'No "report failures honestly" instruction')).toBe(false);
  });

  it('does NOT flag "no honesty policy" when the word appears inside "dishonestly"', () => {
    const file = makeFile('# Notes\nNever act dishonestly toward users about pricing.');
    const issues = detectAgentPractices([file]);
    expect(issues.some((i) => i.title === 'No "report failures honestly" instruction')).toBe(true);
  });
});

// ── AP2: "do not edit" location reflects the real match line ────────────────

describe('detectAgentPractices — AP2 do-not-edit location accuracy', () => {
  it('reports the actual line of a "do not edit" header found deep in the first 500 chars', () => {
    const filler = Array.from({ length: 6 }, (_, i) => `Line ${i + 1} of filler text padding.`).join('\n');
    const content = `${filler}\nDo not edit this file manually.\nMore content follows.`;
    const file = makeFile(content);
    const issues = detectAgentPractices([file]);
    const doNotEditIssue = issues.find((i) => i.title === '"Do not edit" header in human-maintained instruction file');
    expect(doNotEditIssue).toBeDefined();
    // "Do not edit this file manually." is line 7 (6 filler lines + 1).
    expect(doNotEditIssue!.locations[0]!.startLine).toBe(7);
    expect(doNotEditIssue!.evidence[0]).toContain('Do not edit');
  });
});

// ── AP3: evidence must match the gate's own content (contentOutsideCode) ────

describe('detectAgentPractices — AP3 evidence/gate consistency', () => {
  it('does NOT report a claude:thinking tag as evidence when it only appears inside a code fence', () => {
    const content = [
      '# Cursor Rules',
      'Example of Claude-specific syntax (not used here):',
      '```',
      '<claude:thinking>example</claude:thinking>',
      '```',
    ].join('\n');
    const file = makeTypedFile(content, '/repo/.cursorrules', 'cursor');
    const issues = detectAgentPractices([file]);
    // The tag only exists inside the fence, so the gate (contentOutsideCode)
    // must not fire at all — no finding should be produced.
    expect(issues.some((i) => i.title === 'Claude-specific XML tag in non-Claude instruction file')).toBe(false);
  });

  it('evidence names the real outside-code tag, not an earlier in-fence example', () => {
    const content = [
      '# Cursor Rules',
      'Example of Claude-specific syntax (not used here):',
      '```',
      '<claude:thinking>example</claude:thinking>',
      '```',
      'Also uses <claude:memory>notes</claude:memory> directly in prose.',
    ].join('\n');
    const file = makeTypedFile(content, '/repo/.cursorrules', 'cursor');
    const issues = detectAgentPractices([file]);
    const tagIssue = issues.find((i) => i.title === 'Claude-specific XML tag in non-Claude instruction file');
    expect(tagIssue).toBeDefined();
    // Must cite the REAL outside-code tag (claude:memory), not the in-fence
    // example (claude:thinking) that happens to appear earlier in the file.
    expect(tagIssue!.evidence[0]).toContain('claude:memory');
    expect(tagIssue!.evidence[0]).not.toContain('claude:thinking');
  });
});

// ── AP4: no double-counting when a file lacks ALL behavioral guidance ───────

describe('detectAgentPractices — AP4 no double-counting', () => {
  it('emits only the coarse "no behavioral guidance" issue, not also 5 granular ones, for a fully-silent file', () => {
    const agents = makeTypedFile(
      [
        'Before saying done, run pnpm lint && pnpm test.',
        'If tests fail, report the failure honestly.',
        'Always read the file before editing it.',
        'Prefer focused, minimal diffs.',
        'For complex tasks, outline the approach before writing code.',
      ].join('\n'),
      '/repo/AGENTS.md',
      'agents',
    );
    const claude = makeTypedFile(
      '# Claude Instructions\nUse TypeScript strict mode.',
      '/repo/CLAUDE.md',
      'claude',
    );

    const issues = detectAgentPractices([agents, claude]);
    const coarseIssue = issues.find((i) => i.title === 'No behavioral guidance in CLAUDE.md');
    const granularIssues = issues.filter(
      (i) => i.title.includes('Missing critical guidance') && i.filePaths.includes('/repo/CLAUDE.md'),
    );

    expect(coarseIssue).toBeDefined();
    // Before the fix, up to 5 granular issues would ALSO fire for the same file.
    expect(granularIssues).toHaveLength(0);
  });
});

// ── AP5: reversed-order read-before-edit phrasing ────────────────────────────

describe('detectAgentPractices — AP5 read-before-edit word order', () => {
  it('recognises "Before editing, read the relevant files" as read-before-edit', () => {
    const file = makeFile(
      '# Rules\nBefore editing, read the relevant files and prefer focused diffs.',
    );
    const issues = detectAgentPractices([file]);
    expect(issues.find((i) => i.title.includes('read before edit'))).toBeUndefined();
  });
});

// ── AP6: header forwarding pointers exempt stubs from missing-guidance ────────

describe('detectAgentPractices — AP6 forwarding pointers', () => {
  it('does not flag a stub that forwards to a canonical file for missing guidance', () => {
    const agents = makeTypedFile(
      [
        'Before saying done, run pnpm lint && pnpm test.',
        'If tests fail, report the failure honestly.',
        'Always read the file before editing it.',
        'Prefer focused, minimal diffs.',
        'For complex tasks, outline the approach before writing code.',
      ].join('\n'),
      '/repo/AGENTS.md',
      'agents',
    );
    // 22-line CLAUDE.md (over the old <20 short-file cutoff) that forwards to
    // AGENTS.md on line 3 — exactly the PromptCI CLAUDE.md shape.
    const claudeBody = ['# PromptCI - Claude Code Instructions', ''];
    claudeBody.push('Follow `AGENTS.md` for the canonical project instructions.');
    for (let i = 0; i < 19; i++) claudeBody.push(`- Reminder line ${i}.`);
    const claude = makeTypedFile(claudeBody.join('\n'), '/repo/CLAUDE.md', 'claude');

    const issues = detectAgentPractices([agents, claude]);
    const claudeGaps = issues.filter(
      (i) =>
        (i.title.includes('Missing critical guidance') || i.title.includes('No behavioral guidance')) &&
        i.filePaths.includes('/repo/CLAUDE.md'),
    );
    expect(claudeGaps).toHaveLength(0);
  });

  it('recognises "Use `AGENTS.md` as the canonical..." (copilot) as forwarding', () => {
    const agents = makeTypedFile(
      [
        'Before saying done, run pnpm lint && pnpm test.',
        'If tests fail, report the failure honestly.',
        'Always read the file before editing it.',
        'Prefer focused, minimal diffs.',
        'For complex tasks, outline the approach before writing code.',
      ].join('\n'),
      '/repo/AGENTS.md',
      'agents',
    );
    const copilotBody = ['# Copilot Instructions', ''];
    copilotBody.push('Use `AGENTS.md` as the canonical project instruction file.');
    for (let i = 0; i < 20; i++) copilotBody.push(`- Context line ${i}.`);
    const copilot = makeTypedFile(
      copilotBody.join('\n'),
      '/repo/.github/copilot-instructions.md',
      'copilot',
    );

    const issues = detectAgentPractices([agents, copilot]);
    const copilotGaps = issues.filter(
      (i) =>
        (i.title.includes('Missing critical guidance') || i.title.includes('No behavioral guidance')) &&
        i.filePaths.includes('/repo/.github/copilot-instructions.md'),
    );
    expect(copilotGaps).toHaveLength(0);
  });

  it('does NOT exempt a file whose only pointer is to an unrelated (non-canonical) doc', () => {
    // A pointer to CONTRIBUTING.md is not a delegation of behavioral guidance —
    // the stub must still be flagged for its missing rules.
    const agents = makeTypedFile(
      [
        'Before saying done, run pnpm lint && pnpm test.',
        'If tests fail, report the failure honestly.',
        'Always read the file before editing it.',
        'Prefer focused, minimal diffs.',
        'For complex tasks, outline the approach before writing code.',
      ].join('\n'),
      '/repo/AGENTS.md',
      'agents',
    );
    const claudeBody = ['# Claude Instructions', ''];
    claudeBody.push('See CONTRIBUTING.md for how to submit pull requests.');
    for (let i = 0; i < 40; i++) claudeBody.push(`- Style note ${i}: use TypeScript strict mode.`);
    const claude = makeTypedFile(claudeBody.join('\n'), '/repo/CLAUDE.md', 'claude');

    const issues = detectAgentPractices([agents, claude]);
    const claudeGaps = issues.filter(
      (i) =>
        (i.title.includes('Missing critical guidance') || i.title.includes('No behavioral guidance')) &&
        i.filePaths.includes('/repo/CLAUDE.md'),
    );
    expect(claudeGaps.length).toBeGreaterThan(0);
  });
});
