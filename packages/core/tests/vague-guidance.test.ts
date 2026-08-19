/**
 * Tests for the vague-guidance detector, including BUG-006 and BUG-010 fixes.
 */

import { describe, it, expect } from 'vitest';
import { detectVagueGuidance } from '../src/vague-guidance.js';
import type { InstructionFile, InstructionSection } from '../src/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSection(text: string, filePath = '/repo/CLAUDE.md', startLine = 1): InstructionSection {
  return {
    id: `${filePath}:${startLine}`,
    filePath,
    heading: 'Section',
    startLine,
    endLine: startLine + text.split('\n').length - 1,
    text,
    normalizedText: text.toLowerCase().trim(),
  };
}

function makeFile(content: string, filePath = '/repo/CLAUDE.md'): InstructionFile {
  const lines = content.split('\n');
  return {
    path: filePath,
    fileType: 'claude',
    content,
    sections: [makeSection(content, filePath)],
    lineCount: lines.length,
    charCount: content.length,
    estimatedTokens: Math.round(content.length / 4),
  };
}

// ── Existing behaviour ───────────────────────────────────────────────────────

describe('detectVagueGuidance — baseline', () => {
  it('returns no issues for empty input', () => {
    expect(detectVagueGuidance([])).toEqual([]);
  });

  it('flags "write clean code"', () => {
    const file = makeFile('# Style\nWrite clean code and keep it simple for everyone.');
    expect(detectVagueGuidance([file]).length).toBeGreaterThan(0);
  });

  it('flags "production-ready"', () => {
    const file = makeFile('# Style\nWrite clean, production-ready code at all times.');
    const issues = detectVagueGuidance([file]);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].summary).toMatch(/production-ready/i);
  });

  it('flags "best practices"', () => {
    const file = makeFile('# Style\nFollow best practices for TypeScript and React at all times.');
    expect(detectVagueGuidance([file]).length).toBeGreaterThan(0);
  });
});

// ── BUG-006: New vague keywords ───────────────────────────────────────────────

describe('detectVagueGuidance — BUG-006 new keywords', () => {
  it('flags "solid principles"', () => {
    const file = makeFile(
      '# Coding Standards\nMake it maintainable and follow SOLID principles throughout.',
    );
    const issues = detectVagueGuidance([file]);
    expect(issues.length).toBeGreaterThan(0);
    const phrases = issues[0].summary.toLowerCase();
    expect(phrases).toMatch(/solid principles/i);
  });

  it('flags "self-documenting"', () => {
    const file = makeFile(
      '# Coding Standards\nGood code is self-documenting. Avoid unnecessary comments.',
    );
    const issues = detectVagueGuidance([file]);
    expect(issues.some((i) => i.summary.toLowerCase().includes('self-documenting'))).toBe(true);
  });

  it('flags "make it maintainable"', () => {
    const file = makeFile(
      '# Guidelines\nMake it maintainable. Use dependency injection wherever possible.',
    );
    const issues = detectVagueGuidance([file]);
    expect(issues.some((i) => i.summary.toLowerCase().includes('maintainable'))).toBe(true);
  });

  it('emits one issue per section even with multiple vague phrases', () => {
    const file = makeFile(
      '# Standards\nMake it maintainable and follow SOLID principles. Good code is self-documenting.',
    );
    const issues = detectVagueGuidance([file]);
    // All three phrases are in the same section — should produce one issue
    expect(issues).toHaveLength(1);
  });
});

// ── BUG-010: "idiomatic" FP fix ───────────────────────────────────────────────

describe('detectVagueGuidance — BUG-010 idiomatic scoping', () => {
  it('does NOT flag "more idiomatic in Next.js page/layout files"', () => {
    const file = makeFile(
      '# Exports\n' +
      'Default exports are more idiomatic in Next.js page/layout files. ' +
      'Named exports are fine for utilities.',
    );
    const issues = detectVagueGuidance([file]);
    // "idiomatic" as a contextual qualifier should not fire
    expect(issues.every((i) => !i.summary.toLowerCase().includes('idiomatic'))).toBe(true);
  });

  it('DOES flag "write idiomatic code"', () => {
    const file = makeFile(
      '# Style\nWrite idiomatic code that follows language conventions.',
    );
    const issues = detectVagueGuidance([file]);
    expect(issues.some((i) => i.summary.toLowerCase().includes('idiomatic'))).toBe(true);
  });

  it('DOES flag "write clean, idiomatic code"', () => {
    const file = makeFile(
      '# Style\nWrite clean, idiomatic code that is easy to read and maintain.',
    );
    const issues = detectVagueGuidance([file]);
    expect(issues.some((i) => i.summary.toLowerCase().includes('idiomatic'))).toBe(true);
  });
});

// ── BUG-003: Subjective UI/UX language ───────────────────────────────────────

describe('detectVagueGuidance — BUG-003 UI/UX vague phrases', () => {
  it('flags "UI looks polished and professional"', () => {
    const file = makeFile(
      '## Component Guidelines\n' +
      'Ensure UI looks polished and professional. Make all interactions feel smooth and native.',
    );
    const issues = detectVagueGuidance([file]);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].category).toBe('vague_guidance');
  });

  it('flags "feel smooth and native"', () => {
    const file = makeFile(
      '## UX Rules\nMake all interactions feel smooth and native to the platform.',
    );
    expect(detectVagueGuidance([file]).length).toBeGreaterThan(0);
  });

  it('flags "accessible and usable"', () => {
    // Keep line short so it stays under MAX_LINE_LENGTH_TO_FLAG (120 chars)
    const file = makeFile(
      '## Accessibility\nComponents should be accessible and usable. Provide good defaults.',
    );
    const issues = detectVagueGuidance([file]);
    expect(issues.length).toBeGreaterThan(0);
  });

  it('flags "provide good defaults"', () => {
    const file = makeFile('## API Design\nProvide good defaults for all configuration options.');
    expect(detectVagueGuidance([file]).length).toBeGreaterThan(0);
  });

  it('flags "great user experience"', () => {
    const file = makeFile('## Goals\nThe app should deliver a great user experience across all platforms.');
    expect(detectVagueGuidance([file]).length).toBeGreaterThan(0);
  });

  it('does NOT flag specific accessibility rules with WCAG criteria', () => {
    // A line long enough to have real specifics should not be flagged
    const file = makeFile(
      '## Accessibility\n' +
      'All interactive elements must meet WCAG 2.1 AA: ' +
      'minimum 4.5:1 contrast ratio, focus-visible outline of 2px, ' +
      'aria-label on icon-only buttons, keyboard-navigable with Tab and Enter.',
    );
    // The line length exceeds MAX_LINE_LENGTH_TO_FLAG (120) so it should be skipped
    const issues = detectVagueGuidance([file]);
    expect(issues).toHaveLength(0);
  });
});

// ── BUG-004 (eval): Language-paradigm platitudes — regression test ────────────
// These phrases were caught by a previous scanner version but stopped being
// detected after the BUG-010 fix narrowed the "idiomatic" trigger.

describe('detectVagueGuidance — BUG-004 language-paradigm platitudes (regression)', () => {
  it('flags "Follow functional programming principles and write idiomatic Elixir code"', () => {
    // Regression: previously caught, broke in BUG-010 fix. The phrase
    // "idiomatic code" does not match "idiomatic Elixir code" (language name between).
    // Fixed by adding "write idiomatic" and "functional programming principles".
    const file = makeFile(
      '## Elixir Conventions\n' +
      'Follow functional programming principles and write idiomatic Elixir code.',
    );
    const issues = detectVagueGuidance([file]);
    expect(issues.length).toBeGreaterThan(0);
    const summary = issues[0].summary.toLowerCase();
    expect(
      summary.includes('functional programming') || summary.includes('write idiomatic'),
    ).toBe(true);
  });

  it('flags "write idiomatic Rust code"', () => {
    const file = makeFile('## Rust Style\nWrite idiomatic Rust code following community conventions.');
    expect(detectVagueGuidance([file]).length).toBeGreaterThan(0);
  });

  it('flags "functional programming principles" standalone', () => {
    const file = makeFile('## Design\nAlways apply functional programming principles to keep code pure.');
    const issues = detectVagueGuidance([file]);
    expect(issues.some((i) => i.summary.toLowerCase().includes('functional programming'))).toBe(true);
  });

  it('still does NOT flag "more idiomatic in Next.js page/layout files" (BUG-010 guard)', () => {
    const file = makeFile(
      '# Exports\nDefault exports are more idiomatic in Next.js page/layout files.',
    );
    const issues = detectVagueGuidance([file]);
    expect(issues.every((i) => !i.summary.toLowerCase().includes('idiomatic'))).toBe(true);
  });
});

// ── V1: phrase hard-wrapped across lines ──────────────────────────────────────

describe('detectVagueGuidance — V1 wrapped phrase across lines', () => {
  it('flags "production ready" when hard-wrapped across two lines', () => {
    const file = makeFile('## Guidelines\nMake it production\nready before merging.');
    const issues = detectVagueGuidance([file]);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].summary.toLowerCase()).toMatch(/production ready/);
  });

  it('does NOT join lines separated by a blank line', () => {
    // "production" and "ready" on either side of a blank line are separate
    // paragraphs, not a hard-wrap — should not be joined into a false match.
    const file = makeFile('## Guidelines\nWe value production.\n\nGet ready to ship daily.');
    const issues = detectVagueGuidance([file]);
    expect(issues.every((i) => !i.summary.toLowerCase().includes('production ready'))).toBe(true);
  });
});

// ── V2: no-hyphen phrase variants ─────────────────────────────────────────────

describe('detectVagueGuidance — V2 no-hyphen variants', () => {
  it('flags "user friendly" (no hyphen) even though only "user-friendly" is enumerated', () => {
    const file = makeFile('## API Design\nThe CLI must be user friendly for new contributors.');
    const issues = detectVagueGuidance([file]);
    expect(issues.some((i) => i.summary.toLowerCase().includes('user friendly'))).toBe(true);
  });

  it('still flags the hyphenated "user-friendly" form', () => {
    const file = makeFile('## API Design\nThe CLI must be user-friendly for new contributors.');
    const issues = detectVagueGuidance([file]);
    expect(issues.some((i) => i.summary.toLowerCase().includes('user-friendly'))).toBe(true);
  });
});

// ── V3: word-boundary matching (no substring false positives) ────────────────

describe('detectVagueGuidance — V3 word-boundary matching', () => {
  it('does NOT flag "must be carefully reviewed by QA" as "be careful"', () => {
    const file = makeFile('## Review\nAll changes must be carefully reviewed by QA before release.');
    const issues = detectVagueGuidance([file]);
    expect(issues.every((i) => !i.summary.toLowerCase().includes('be careful'))).toBe(true);
  });

  it('does NOT flag "write cleanup scripts for temp files" as "write clean"', () => {
    const file = makeFile('## Housekeeping\nWrite cleanup scripts for temp files after each run.');
    const issues = detectVagueGuidance([file]);
    expect(issues.every((i) => !i.summary.toLowerCase().includes('write clean'))).toBe(true);
  });

  it('still flags the real phrase "be careful" as a whole word', () => {
    const file = makeFile('## Review\nBe careful when editing shared config files.');
    const issues = detectVagueGuidance([file]);
    expect(issues.some((i) => i.summary.toLowerCase().includes('be careful'))).toBe(true);
  });
});

// ── V4: fenced examples should not count as real guidance ────────────────────

describe('detectVagueGuidance — V4 code-fence stripping', () => {
  it('does NOT flag a vague phrase quoted inside a fenced example', () => {
    const file = makeFile(
      [
        '## Anti-patterns',
        '',
        'Avoid instructions like this:',
        '```',
        'Write clean code and use best practices.',
        '```',
      ].join('\n'),
    );
    const issues = detectVagueGuidance([file]);
    expect(issues).toHaveLength(0);
  });

  it('still flags the same phrase when it appears as real prose guidance', () => {
    const file = makeFile('## Style\nWrite clean code and use best practices at all times.');
    const issues = detectVagueGuidance([file]);
    expect(issues.length).toBeGreaterThan(0);
  });

  it('does NOT flag a vague phrase quoted inside a ~~~ fenced example', () => {
    const file = makeFile(
      ['## Anti-patterns', '', '~~~', 'Keep it simple and be careful.', '~~~'].join('\n'),
    );
    const issues = detectVagueGuidance([file]);
    expect(issues).toHaveLength(0);
  });
});

// ── FEAT-004: severity tiers + config override ───────────────────────────────

describe('detectVagueGuidance — FEAT-004 severity tiers', () => {
  it('emits high-signal platitudes at warning 0.80', () => {
    const file = makeFile('## Style\nWrite clean code and follow best practices at all times.');
    const issues = detectVagueGuidance([file]);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].confidence).toBe(0.8);
  });

  it('treats "SOLID principles", "clean architecture", "be careful" as warning', () => {
    for (const phrase of [
      'Follow SOLID principles when structuring modules.',
      'Use clean architecture for every service.',
      'Be careful when editing shared config files.',
    ]) {
      const issues = detectVagueGuidance([makeFile(`## Rules\n${phrase}`)]);
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe('warning');
    }
  });

  it('emits soft style/UX phrases at info 0.75', () => {
    const file = makeFile('## Goals\nThe app should deliver a great user experience for everyone.');
    const issues = detectVagueGuidance([file]);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('info');
    expect(issues[0].confidence).toBe(0.75);
  });

  it('escalates a mixed section to warning when any high-signal phrase is present', () => {
    // "great user experience" (soft) + "best practices" (high-signal) → warning.
    const file = makeFile(
      '## Goals\nDeliver a great user experience and follow best practices everywhere.',
    );
    const issues = detectVagueGuidance([file]);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].confidence).toBe(0.8);
  });
});

describe('detectVagueGuidance — FEAT-004 severityOverride config', () => {
  it('forces a soft finding up to warning when overridden to "warning"', () => {
    const file = makeFile('## Goals\nThe app should deliver a great user experience for everyone.');
    const issues = detectVagueGuidance([file], { severityOverride: 'warning' });
    expect(issues[0].severity).toBe('warning');
    // Confidence still reflects the soft tier — only severity is overridden.
    expect(issues[0].confidence).toBe(0.75);
  });

  it('forces a high-signal finding down to info when overridden to "info"', () => {
    const file = makeFile('## Style\nWrite clean code and follow best practices at all times.');
    const issues = detectVagueGuidance([file], { severityOverride: 'info' });
    expect(issues[0].severity).toBe('info');
    expect(issues[0].confidence).toBe(0.8);
  });

  it('uses the tiered default when no override is given', () => {
    const file = makeFile('## Style\nWrite clean code everywhere.');
    expect(detectVagueGuidance([file])[0].severity).toBe('warning');
    expect(detectVagueGuidance([file], {})[0].severity).toBe('warning');
  });
});
