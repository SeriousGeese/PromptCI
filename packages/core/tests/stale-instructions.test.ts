/**
 * Tests for the stale-instructions detector, including BUG-013 fix.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { detectStaleInstructions } from '../src/stale-instructions.js';
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
  return {
    path: filePath,
    fileType: 'claude',
    content,
    sections: [makeSection(content, filePath)],
    lineCount: content.split('\n').length,
    charCount: content.length,
    estimatedTokens: Math.round(content.length / 4),
  };
}

/**
 * BUG-14: fixtures whose subject is "stale relative to now" are computed from
 * the clock, not written as literals — otherwise they assert the very rot the
 * detector was fixed to avoid.
 */
const THIS_YEAR = new Date().getFullYear();
const yearsAgo = (n: number): number => THIS_YEAR - n;

// ── Baseline behaviour ───────────────────────────────────────────────────────

describe('detectStaleInstructions — baseline', () => {
  it('returns no issues for empty input', () => {
    expect(detectStaleInstructions([])).toEqual([]);
  });

  it('flags a section with a stale year reference', () => {
    const file = makeFile(
      `## Known Issues\nThe category model was scoped for Q2 ${yearsAgo(4)} but deprioritized.`,
    );
    const issues = detectStaleInstructions([file]);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].category).toBe('stale_instruction');
    expect(issues[0].severity).toBe('warning');
  });

  it('flags a two-year-old TODO as potentially stale', () => {
    const year = yearsAgo(2);
    const file = makeFile(`## TODO\nTODO ${year}: migrate to the new auth flow.`);
    const issues = detectStaleInstructions([file]);
    expect(issues.some((i) => i.evidence.some((e) => e.includes(String(year))))).toBe(true);
  });

  it('flags a WORKAROUND cleanup keyword', () => {
    const file = makeFile(
      '## Known Issues\nWORKAROUND: added a retry loop for the JWKS refresh task (added 2023-07-14).',
    );
    const issues = detectStaleInstructions([file]);
    expect(issues.some((i) => i.evidence.some((e) => /workaround/i.test(e)))).toBe(true);
  });

  it('flags an old Vue 2 reference in a historical note', () => {
    const file = makeFile(
      '## Deprecated\nVue 2 support was dropped in DashKit v2.0 (released June 2022).',
    );
    const issues = detectStaleInstructions([file]);
    expect(issues.length).toBeGreaterThan(0);
  });
});

// ── BUG-013: Do NOT flag old-version mentions in negation context ─────────────

describe('detectStaleInstructions — BUG-013 negation context filter', () => {
  it('does NOT flag "Do not add Vue 2 compat" as stale', () => {
    const file = makeFile(
      [
        '## Vue Version Notes',
        'The project targets Vue 3.4+ exclusively.',
        'Do not add `@vue/composition-api` for Vue 2 compatibility.',
        'Do not add Vue 2 specific lifecycle hooks.',
      ].join('\n'),
    );
    const issues = detectStaleInstructions([file]);
    // The "Vue 2" mention here is a current rule ("don't use Vue 2"), not stale content
    expect(issues.every((i) => !i.evidence.some((e) => /vue 2/i.test(e) && /old version/i.test(e)))).toBe(true);
  });

  it('does NOT flag "avoid Vue 2 patterns" as stale', () => {
    const file = makeFile(
      '## Conventions\nAvoid Vue 2 patterns like Options API when writing new components.',
    );
    const issues = detectStaleInstructions([file]);
    const staleVue = issues.find((i) =>
      i.evidence.some((e) => /vue 2/i.test(e) && /old version/i.test(e)),
    );
    expect(staleVue).toBeUndefined();
  });

  it('does NOT flag "never use React 16 features" as stale', () => {
    const file = makeFile(
      '## React Policy\nNever use React 16 class component patterns. Always use functional components.',
    );
    const issues = detectStaleInstructions([file]);
    const staleReact = issues.find((i) =>
      i.evidence.some((e) => /react 16/i.test(e) && /old version/i.test(e)),
    );
    expect(staleReact).toBeUndefined();
  });

  it('DOES flag a genuine historical note about Vue 2 being removed', () => {
    const file = makeFile(
      '## Deprecated\nVue 2 support was dropped entirely in DashKit v2.0 (released June 2022). ' +
      'Migrate any remaining Vue 2 components before the v3.0 release.',
    );
    const issues = detectStaleInstructions([file]);
    // "Vue 2" in a historical context without negation language IS stale
    expect(issues.length).toBeGreaterThan(0);
  });

  it('DOES flag "legacy_balancer.rs was replaced March 2023" as stale', () => {
    const file = makeFile(
      '## Deprecated\n' +
      'The `legacy_balancer.rs` module was replaced by the weighted least-connections balancer (March 2023). ' +
      'It is kept for reference and will be deleted before the 2.0 release.',
    );
    const issues = detectStaleInstructions([file]);
    expect(issues.length).toBeGreaterThan(0);
  });

  it('does NOT flag "dropped Vue 2 support" as a stale old-version reference', () => {
    const file = makeFile(
      '## Version Notes\nWe dropped Vue 2 support in version 3.0. All new code must target Vue 3.4+.',
    );
    const issues = detectStaleInstructions([file]);
    // "dropped" is a negation context — the Vue 2 mention is explanatory, not instructional
    const staleVue = issues.find((i) =>
      i.evidence.some((e) => /old version/i.test(e) && /vue 2/i.test(e)),
    );
    expect(staleVue).toBeUndefined();
  });
});

// ── ST1: multi-line dated TODO/FIXME markers in HTML comments ────────────────

describe('detectStaleInstructions — ST1 multi-line HTML comment dated markers', () => {
  it('flags a dated TODO split across lines inside an HTML comment', () => {
    const file = makeFile(
      ['## Notes', '<!-- TODO', '(2022-03-10): migrate NextAuth callbacks -->'].join('\n'),
    );
    const issues = detectStaleInstructions([file]);
    expect(issues.some((i) => i.evidence.some((e) => /dated todo/i.test(e)))).toBe(true);
  });

  it('flags a dated TODO whose preceding text contains a bare ">" character', () => {
    const file = makeFile(
      '## Notes\n<!-- if retries > 3 TODO (2022-01-01): remove -->',
    );
    const issues = detectStaleInstructions([file]);
    expect(issues.some((i) => i.evidence.some((e) => /dated todo/i.test(e)))).toBe(true);
  });

  it('does NOT flag a current-year dated TODO inside an HTML comment', () => {
    const file = makeFile(
      `## Notes\n<!-- TODO (${THIS_YEAR}-07-01): remove after Q3 launch -->`,
    );
    const issues = detectStaleInstructions([file]);
    expect(issues.some((i) => i.evidence.some((e) => /dated todo/i.test(e)))).toBe(false);
  });
});

// ── ST2: "v"-prefixed version aliases ─────────────────────────────────────────

describe('detectStaleInstructions — ST2 "v"-prefixed version aliases', () => {
  it('flags "Node v12" as an old version reference', () => {
    const file = makeFile('## Runtime\nWe still target Node v12 for legacy builds.');
    const issues = detectStaleInstructions([file]);
    expect(issues.some((i) => i.evidence.some((e) => /old version/i.test(e) && /node/i.test(e)))).toBe(true);
  });

  it('flags "React v16" as an old version reference', () => {
    const file = makeFile('## Frontend\nThis app is still on React v16 and needs an upgrade.');
    const issues = detectStaleInstructions([file]);
    expect(issues.some((i) => i.evidence.some((e) => /old version/i.test(e) && /react/i.test(e)))).toBe(true);
  });

  it('flags standalone ".NET 5" as an old version reference', () => {
    const file = makeFile('## Runtime\nThis service still targets .NET 5 for deployment.');
    const issues = detectStaleInstructions([file]);
    expect(issues.some((i) => i.evidence.some((e) => /old version/i.test(e) && /\.net 5/i.test(e)))).toBe(true);
  });

  it('flags "Angular v8" as an old version reference', () => {
    const file = makeFile('## Frontend\nThe legacy admin panel is built on Angular v8.');
    const issues = detectStaleInstructions([file]);
    expect(issues.some((i) => i.evidence.some((e) => /old version/i.test(e) && /angular/i.test(e)))).toBe(true);
  });

  it('still flags the bare-number form without "v"', () => {
    const file = makeFile('## Runtime\nWe still target Node 12 for legacy builds.');
    const issues = detectStaleInstructions([file]);
    expect(issues.some((i) => i.evidence.some((e) => /old version/i.test(e) && /node/i.test(e)))).toBe(true);
  });
});

// ── ST3: fence-style mismatch (~~~ blocks, unclosed fences) ──────────────────

describe('detectStaleInstructions — ST3 fence-style stripping', () => {
  it('flags deprecated tool mentions after a colon', () => {
    const file = makeFile('## Legacy\nDeprecated: Unity workflow for asset imports.');
    const issues = detectStaleInstructions([file]);
    expect(
      issues.some((i) => i.evidence.some((e) => /deprecated/i.test(e) && /unity/i.test(e))),
    ).toBe(true);
  });

  it('flags deprecated tool mentions inside backticks', () => {
    const file = makeFile('## Legacy\nThe deprecated `webpack` config is kept only for migration notes.');
    const issues = detectStaleInstructions([file]);
    expect(
      issues.some((i) => i.evidence.some((e) => /deprecated/i.test(e) && /webpack/i.test(e))),
    ).toBe(true);
  });

  it('does NOT flag a stale year inside a ~~~ fenced block', () => {
    const file = makeFile(
      ['## Changelog Example', '~~~', 'Released in 2021. Still valid in 2022.', '~~~'].join('\n'),
    );
    const issues = detectStaleInstructions([file]);
    expect(issues).toHaveLength(0);
  });

  it('does NOT flag cleanup keywords inside a fenced block', () => {
    const file = makeFile(
      ['## Example', '```bash', '# workaround for CI quirk', '```'].join('\n'),
    );
    const issues = detectStaleInstructions([file]);
    expect(issues).toHaveLength(0);
  });

  it('does NOT flag deprecated mentions inside a fenced block', () => {
    const file = makeFile(
      ['## Example', '```text', 'Deprecated: Unity 2019 workflow', '```'].join('\n'),
    );
    const issues = detectStaleInstructions([file]);
    expect(issues).toHaveLength(0);
  });

  it('does NOT flag dated HTML TODO comments inside a fenced block', () => {
    const file = makeFile(
      ['## Example', '```markdown', '<!-- TODO (2022-03-10): example marker -->', '```'].join('\n'),
    );
    const issues = detectStaleInstructions([file]);
    expect(issues).toHaveLength(0);
  });

  it('still flags a stale year in real prose alongside a ~~~ example', () => {
    const file = makeFile(
      [
        '## Notes',
        'This module was scoped for 2022 and never revisited.',
        '~~~',
        'Example: released 2019.',
        '~~~',
      ].join('\n'),
    );
    const issues = detectStaleInstructions([file]);
    expect(issues.length).toBeGreaterThan(0);
  });

  it('treats an unclosed ``` fence as swallowing the remainder of the section', () => {
    // No closing fence — everything after the opener is code, not prose, and
    // must not be scanned for stale years.
    const file = makeFile(
      ['## Example', '```', 'Config pinned in 2021.', 'Still pinned in 2022.'].join('\n'),
    );
    const issues = detectStaleInstructions([file]);
    expect(issues).toHaveLength(0);
  });
});

// ── ST4: negation context spanning a hard-wrapped line ───────────────────────

describe('detectStaleInstructions — ST4 negation context across a line wrap', () => {
  it('does NOT flag "Do not\\nadd Vue 2 compatibility shims."', () => {
    const file = makeFile(
      '## Vue Version Notes\nDo not\nadd Vue 2 compatibility shims.',
    );
    const issues = detectStaleInstructions([file]);
    const staleVue = issues.find((i) =>
      i.evidence.some((e) => /old version/i.test(e) && /vue 2/i.test(e)),
    );
    expect(staleVue).toBeUndefined();
  });

  it('still flags a Vue 2 mention when negation is in an earlier, separate paragraph', () => {
    const file = makeFile(
      [
        '## Vue Version Notes',
        'Do not add unrelated legacy shims here.',
        '',
        'Use Vue 2 for the legacy admin migration path only.',
      ].join('\n'),
    );
    const issues = detectStaleInstructions([file]);
    const staleVue = issues.find((i) =>
      i.evidence.some((e) => /old version/i.test(e) && /vue 2/i.test(e)),
    );
    expect(staleVue).toBeDefined();
  });
});

// ── BUG-14: the stale-year window rolls with the calendar ────────────────────

describe('detectStaleInstructions — stale-year window is derived from the clock', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function yearsFlagged(issues: ReturnType<typeof detectStaleInstructions>): string {
    return issues.flatMap((i) => i.evidence).find((e) => e.startsWith('Year reference(s)')) ?? '';
  }

  it('flags last year but not the current year, in any calendar year', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2031-06-15T00:00:00Z'));

    const file = makeFile('## Rules\nUse the 2030 toolchain. The 2031 toolchain is not ready.');
    const evidence = yearsFlagged(detectStaleInstructions([file]));

    expect(evidence).toContain('2030');
    expect(evidence).not.toContain('2031');
  });

  it('ignores years older than the rolling window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2031-06-15T00:00:00Z'));

    // Window in 2031 is 2024–2030; 2011 predates it and reads as a deliberate
    // historical reference rather than an instruction that rotted.
    const file = makeFile('## History\nThe project charter dates to 2011.', '/repo/AGENTS.md');
    const evidence = yearsFlagged(detectStaleInstructions([file]));

    expect(evidence).toBe('');
  });

  it('flags a dated HTML-comment TODO relative to the current year', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2031-06-15T00:00:00Z'));

    const stale = makeFile('## Notes\n<!-- TODO (2029-03-10): drop the shim -->');
    const notYet = makeFile('## Notes\n<!-- TODO (2031-03-10): drop the shim -->');

    expect(detectStaleInstructions([stale]).length).toBeGreaterThan(0);
    expect(
      detectStaleInstructions([notYet]).flatMap((i) => i.evidence).some((e) => e.includes('TODO')),
    ).toBe(false);
  });
});
