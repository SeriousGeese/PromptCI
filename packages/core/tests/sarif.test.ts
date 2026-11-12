/**
 * Tests for SARIF 2.1.0 report generation (pcic-aq2f).
 *
 * Covers:
 *  - A fixture with several findings validates against the vendored 2.1.0 schema
 *  - Severity -> SARIF level mapping for every IssueSeverity
 *  - A finding with no line (whole-file, locations-less)
 *  - A finding with no location AT ALL falls back to the primary instruction file
 *  - A suppressed finding carries a `suppressions` entry
 *  - A multi-location finding produces multiple SARIF locations
 *  - partialFingerprints are stable across two independent runs, and get a
 *    distinct `:N` suffix when two findings in the same run would otherwise
 *    collide
 *  - Paths are repo-relative, percent-encoded POSIX URIs even for a Windows
 *    repo root, odd characters, or a path that climbs outside the repo
 *  - startLine < 1 never produces a region
 *  - Empty message text falls back to the issue's title
 *  - Sorting is locale-independent (ordinal)
 */

import * as path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import Ajv from 'ajv-draft-04';
import addFormats from 'ajv-formats';
import type { ValidateFunction } from 'ajv-draft-04';
import { generateSarifReport } from '../src/sarif.js';
import type { InstructionFile, IssueSeverity, PromptCiIssue, ScanReport } from '../src/types.js';

function makeFile(overrides: Partial<InstructionFile> = {}): InstructionFile {
  return {
    path: '/repo/CLAUDE.md',
    fileType: 'claude',
    content: '',
    sections: [],
    lineCount: 1,
    charCount: 0,
    estimatedTokens: 0,
    ...overrides,
  };
}

const SCHEMA_PATH = path.join(__dirname, 'fixtures', 'sarif-schema', 'sarif-schema-2.1.0.json');

// Minimal shape of the parsed output — just enough to assert on, not a
// general-purpose SARIF type.
type ParsedSarifLog = {
  version: string;
  runs: Array<{
    tool: {
      driver: {
        name: string;
        version: string;
        rules: Array<{ id: string; name: string; helpUri: string }>;
      };
    };
    results: Array<{
      ruleId: string;
      ruleIndex: number;
      level: string;
      partialFingerprints: Record<string, string>;
      suppressions?: Array<{ kind: string; justification: string }>;
      locations: Array<{
        physicalLocation: {
          artifactLocation: { uri: string };
          region?: { startLine: number; endLine?: number };
        };
      }>;
    }>;
  }>;
};

function makeIssue(overrides: Partial<PromptCiIssue> = {}): PromptCiIssue {
  return {
    id: 'test-id',
    severity: 'warning',
    category: 'duplicate',
    title: 'Test Issue',
    summary: 'This section looks similar to another one.',
    filePaths: ['/repo/CLAUDE.md'],
    locations: [{ filePath: '/repo/CLAUDE.md', startLine: 10, endLine: 12 }],
    evidence: ['evidence line'],
    recommendation: 'Consider consolidating the two sections.',
    confidence: 0.9,
    ...overrides,
  };
}

function makeReport(overrides: Partial<ScanReport> = {}): ScanReport {
  return {
    schemaVersion: '0.1',
    generatedAt: '2026-01-01T00:00:00.000Z',
    repoPath: '/repo',
    projectType: 'typescript',
    healthScore: 90,
    filesScanned: [],
    issues: [makeIssue()],
    topFixes: [],
    ...overrides,
  };
}

let validate: ValidateFunction;

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const schema = require(SCHEMA_PATH);
  // strict:false — the schema declares keywords ajv-draft-04 doesn't need
  // strict mode for; `logger: false` keeps noise out of test output.
  // ajv-formats registers "uri"/"uri-reference"/"date-time" etc. so the
  // schema's format keyword is actually CHECKED, not merely accepted as an
  // unknown-and-ignored string (pcic-aq2f #4) — an artifactLocation.uri with
  // an unescaped space or '#' would otherwise pass schema validation despite
  // being an invalid uri-reference.
  const ajv = new Ajv({ strict: false, allowUnionTypes: true, logger: false });
  addFormats(ajv);
  validate = ajv.compile(schema);
});

function parseSarif(report: ScanReport, toolVersion = '1.2.3'): ParsedSarifLog {
  return JSON.parse(generateSarifReport(report, toolVersion)) as ParsedSarifLog;
}

describe('generateSarifReport', () => {
  it('produces a log that validates against the vendored SARIF 2.1.0 schema', () => {
    const report = makeReport({
      issues: [
        makeIssue({ id: 'i1', severity: 'critical', category: 'security' }),
        makeIssue({ id: 'i2', severity: 'high', category: 'conflict' }),
        makeIssue({ id: 'i3', severity: 'warning', category: 'duplicate' }),
        makeIssue({ id: 'i4', severity: 'info', category: 'vague_guidance', locations: [] }),
      ],
      suppressedIssues: [makeIssue({ id: 'i5', category: 'context_bloat' })],
    });
    const sarif = parseSarif(report);
    const valid = validate(sarif);
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it('is valid even with no issues at all', () => {
    const sarif = parseSarif(makeReport({ issues: [] }));
    expect(validate(sarif)).toBe(true);
  });

  // ── severity -> level mapping ────────────────────────────────────────────

  it.each<[IssueSeverity, string]>([
    ['critical', 'error'],
    ['high', 'error'],
    ['warning', 'warning'],
    ['info', 'note'],
  ])('maps %s severity to SARIF level %s', (severity, level) => {
    const report = makeReport({ issues: [makeIssue({ severity })] });
    const sarif = parseSarif(report);
    expect(sarif.runs[0].results[0].level).toBe(level);
  });

  // ── locations ─────────────────────────────────────────────────────────────

  it('omits region for a finding with no line information', () => {
    const report = makeReport({
      issues: [makeIssue({ locations: [], filePaths: ['/repo/CLAUDE.md'] })],
    });
    const sarif = parseSarif(report);
    const loc = sarif.runs[0].results[0].locations[0];
    expect(loc.physicalLocation.artifactLocation.uri).toBe('CLAUDE.md');
    expect(loc.physicalLocation.region).toBeUndefined();
    expect(validate(sarif)).toBe(true);
  });

  it('drops a region with startLine < 1 rather than inventing line 1', () => {
    const report = makeReport({
      issues: [makeIssue({ locations: [{ filePath: '/repo/CLAUDE.md', startLine: 0 }] })],
    });
    const sarif = parseSarif(report);
    expect(sarif.runs[0].results[0].locations[0].physicalLocation.region).toBeUndefined();
  });

  it('falls back to the primary instruction file when a finding has no location and no filePaths', () => {
    const report = makeReport({
      filesScanned: [makeFile({ path: '/repo/README.md', fileType: 'readme' }), makeFile({ path: '/repo/AGENTS.md', fileType: 'agents' })],
      issues: [makeIssue({ locations: [], filePaths: [] })],
    });
    const sarif = parseSarif(report);
    const result = sarif.runs[0].results[0];
    expect(result.locations).toHaveLength(1);
    expect(result.locations[0].physicalLocation.artifactLocation.uri).toBe('AGENTS.md');
    expect(result.locations[0].physicalLocation.region).toBeUndefined();
    expect(result.message.text).toContain('AGENTS.md');
    expect(validate(sarif)).toBe(true);
  });

  it('prefers whichever of AGENTS.md/CLAUDE.md was scanned first over other instruction files', () => {
    const report = makeReport({
      filesScanned: [
        makeFile({ path: '/repo/README.md', fileType: 'readme' }),
        makeFile({ path: '/repo/CLAUDE.md', fileType: 'claude' }),
        makeFile({ path: '/repo/AGENTS.md', fileType: 'agents' }),
      ],
      issues: [makeIssue({ locations: [], filePaths: [] })],
    });
    const sarif = parseSarif(report);
    expect(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri).toBe('CLAUDE.md');
  });

  it('falls back to the first scanned instruction file when neither AGENTS.md nor CLAUDE.md was scanned', () => {
    const report = makeReport({
      filesScanned: [makeFile({ path: '/repo/README.md', fileType: 'readme' }), makeFile({ path: '/repo/.cursorrules', fileType: 'cursor' })],
      issues: [makeIssue({ locations: [], filePaths: [] })],
    });
    const sarif = parseSarif(report);
    expect(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri).toBe('.cursorrules');
  });

  it('keeps an empty locations array, documented, when nothing at all was scanned', () => {
    const report = makeReport({
      filesScanned: [],
      issues: [makeIssue({ locations: [], filePaths: [] })],
    });
    const sarif = parseSarif(report);
    expect(sarif.runs[0].results[0].locations).toEqual([]);
  });

  it('produces one SARIF location per finding location for a multi-location finding', () => {
    const report = makeReport({
      issues: [
        makeIssue({
          locations: [
            { filePath: '/repo/CLAUDE.md', startLine: 1, endLine: 2 },
            { filePath: '/repo/AGENTS.md', startLine: 5 },
          ],
          filePaths: ['/repo/CLAUDE.md', '/repo/AGENTS.md'],
        }),
      ],
    });
    const sarif = parseSarif(report);
    const locations = sarif.runs[0].results[0].locations;
    expect(locations).toHaveLength(2);
    expect(locations[0].physicalLocation.artifactLocation.uri).toBe('CLAUDE.md');
    expect(locations[0].physicalLocation.region).toEqual({ startLine: 1, endLine: 2 });
    expect(locations[1].physicalLocation.artifactLocation.uri).toBe('AGENTS.md');
    expect(locations[1].physicalLocation.region).toEqual({ startLine: 5 });
    expect(validate(sarif)).toBe(true);
  });

  // ── suppressions ──────────────────────────────────────────────────────────

  it('marks a suppressed finding with a SARIF suppressions entry rather than omitting it', () => {
    const report = makeReport({
      issues: [],
      suppressedIssues: [makeIssue({ id: 'suppressed-1' })],
    });
    const sarif = parseSarif(report);
    expect(sarif.runs[0].results).toHaveLength(1);
    expect(sarif.runs[0].results[0].suppressions).toEqual([
      { kind: 'external', justification: expect.stringContaining('promptci-ignore') },
    ]);
    expect(validate(sarif)).toBe(true);
  });

  it('does not add a suppressions entry to an active (non-suppressed) finding', () => {
    const sarif = parseSarif(makeReport());
    expect(sarif.runs[0].results[0].suppressions).toBeUndefined();
  });

  // ── rules / ruleId ────────────────────────────────────────────────────────

  it('uses the issue category as ruleId and lists a matching rule', () => {
    const sarif = parseSarif(makeReport({ issues: [makeIssue({ category: 'security' })] }));
    const result = sarif.runs[0].results[0];
    expect(result.ruleId).toBe('security');
    const rule = sarif.runs[0].tool.driver.rules[result.ruleIndex];
    expect(rule.id).toBe('security');
    expect(rule.name).toBeTruthy();
    expect(rule.helpUri).toMatch(/^https:\/\//);
  });

  it('includes tool name and the given version', () => {
    const sarif = parseSarif(makeReport(), '9.9.9');
    expect(sarif.runs[0].tool.driver.name).toBe('PromptCI');
    expect(sarif.runs[0].tool.driver.version).toBe('9.9.9');
  });

  // ── fingerprints ──────────────────────────────────────────────────────────

  it('produces stable partialFingerprints across two independent runs', () => {
    const issueA = makeIssue({ id: 'run-a-id' });
    const issueB = makeIssue({ id: 'run-b-id' }); // same category/title/filePaths/evidence
    const sarifA = parseSarif(makeReport({ issues: [issueA] }));
    const sarifB = parseSarif(makeReport({ issues: [issueB] }));
    expect(sarifA.runs[0].results[0].partialFingerprints['promptci/v1']).toBe(
      sarifB.runs[0].results[0].partialFingerprints['promptci/v1'],
    );
  });

  it('gives different fingerprints to findings with different evidence', () => {
    const sarif = parseSarif(
      makeReport({
        issues: [
          makeIssue({ id: 'a', evidence: ['one'] }),
          makeIssue({ id: 'b', evidence: ['two'] }),
        ],
      }),
    );
    const [first, second] = sarif.runs[0].results;
    expect(first.partialFingerprints['promptci/v1']).not.toBe(second.partialFingerprints['promptci/v1']);
  });

  it('suffixes identical within-run fingerprints with a distinct occurrence number', () => {
    // Same category/title/filePaths/evidence (the fingerprint's own inputs),
    // different line numbers only — the raw fingerprint collides.
    const sarif = parseSarif(
      makeReport({
        issues: [
          makeIssue({ id: 'first', locations: [{ filePath: '/repo/CLAUDE.md', startLine: 1 }] }),
          makeIssue({ id: 'second', locations: [{ filePath: '/repo/CLAUDE.md', startLine: 50 }] }),
        ],
      }),
    );
    const [a, b] = sarif.runs[0].results;
    const fpA = a.partialFingerprints['promptci/v1'];
    const fpB = b.partialFingerprints['promptci/v1'];
    expect(fpA).not.toBe(fpB);
    expect(fpA.replace(/:\d+$/, '')).toBe(fpB.replace(/:\d+$/, ''));
    expect(fpA.endsWith(':0')).toBe(true);
    expect(fpB.endsWith(':1')).toBe(true);
  });

  // ── message text ──────────────────────────────────────────────────────────

  it('falls back to the title when summary is empty', () => {
    const sarif = parseSarif(makeReport({ issues: [makeIssue({ summary: '  ', recommendation: '', title: 'Fallback title' })] }));
    expect(sarif.runs[0].results[0].message.text).toBe('Fallback title');
  });

  // ── path handling ─────────────────────────────────────────────────────────
  //
  // pcic-aq2f: `ScanReport.repoPath`/finding paths carry whatever SHAPE the
  // machine that ran the scan produced (POSIX or Windows), independent of
  // the shape of the machine running THIS code (e.g. a repo scanned on
  // Windows, SARIF-generated — or tested — on Linux CI). Every case below
  // runs for both shapes explicitly so a regression in the win32/posix
  // selection (toRelativeUri's isWindowsShapedPath) fails on every platform,
  // not only the one it happens to match.

  const PATH_SHAPES = [
    {
      label: 'POSIX',
      repoRoot: '/repo',
      join: (...segments: string[]) => `/repo/${segments.join('/')}`,
      outside: '/outside/CLAUDE.md',
    },
    {
      label: 'Windows',
      repoRoot: 'C:\\git\\repo',
      join: (...segments: string[]) => `C:\\git\\repo\\${segments.join('\\')}`,
      outside: 'C:\\git\\CLAUDE.md',
    },
  ];

  describe.each(PATH_SHAPES)('path shape: $label', ({ repoRoot, join, outside }) => {
    it('produces a repo-relative, forward-slash URI for a normal nested path', () => {
      const filePath = join('sub', 'CLAUDE.md');
      const report = makeReport({
        repoPath: repoRoot,
        issues: [makeIssue({ filePaths: [filePath], locations: [{ filePath, startLine: 3 }] })],
      });
      const sarif = parseSarif(report);
      expect(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri).toBe('sub/CLAUDE.md');
    });

    it('does not treat a directory literally named "..hidden" as outside the repo', () => {
      const filePath = join('..hidden', 'x.md');
      const report = makeReport({
        repoPath: repoRoot,
        issues: [makeIssue({ filePaths: [filePath], locations: [{ filePath, startLine: 1 }] })],
      });
      const sarif = parseSarif(report);
      expect(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri).toBe('..hidden/x.md');
    });

    it('drops a location that resolves outside the repo root', () => {
      const report = makeReport({
        repoPath: repoRoot,
        issues: [makeIssue({ filePaths: [outside], locations: [{ filePath: outside, startLine: 1 }] })],
      });
      const sarif = parseSarif(report);
      // No filesScanned to fall back to -> empty, not a location pointing outside the repo.
      expect(sarif.runs[0].results[0].locations).toEqual([]);
      expect(validate(sarif)).toBe(true);
    });

    it('extracts the right basename for the no-location fallback (primaryInstructionFile)', () => {
      const agentsPath = join('AGENTS.md');
      const report = makeReport({
        repoPath: repoRoot,
        filesScanned: [makeFile({ path: agentsPath, fileType: 'agents' })],
        issues: [makeIssue({ locations: [], filePaths: [] })],
      });
      const sarif = parseSarif(report);
      const result = sarif.runs[0].results[0];
      expect(result.locations[0].physicalLocation.artifactLocation.uri).toBe('AGENTS.md');
      expect(result.message.text).toContain('AGENTS.md');
    });
  });

  it('percent-encodes path segments containing spaces, #, %, and non-ASCII characters', () => {
    const oddPath = '/repo/docs dir/a#b%20c/café/AGENTS.md';
    const report = makeReport({
      issues: [makeIssue({ filePaths: [oddPath], locations: [{ filePath: oddPath, startLine: 1 }] })],
    });
    const sarif = parseSarif(report);
    const uri = sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri;
    expect(uri).toBe('docs%20dir/a%23b%2520c/caf%C3%A9/AGENTS.md');
    expect(validate(sarif)).toBe(true);
  });

  // ── determinism ───────────────────────────────────────────────────────────

  it('is deterministic: identical reports produce byte-identical SARIF', () => {
    const report = makeReport({
      issues: [
        makeIssue({ id: 'z', category: 'security' }),
        makeIssue({ id: 'a', category: 'duplicate' }),
      ],
    });
    expect(generateSarifReport(report, '1.0.0')).toBe(generateSarifReport(report, '1.0.0'));
  });

  it('sorts rules and results ordinally regardless of category name case/characters', () => {
    // 'ai_config' vs 'custom' vs 'security': ordinal (code-unit) order is
    // stable and locale-independent, unlike String.prototype.localeCompare.
    const report = makeReport({
      issues: [
        makeIssue({ id: 'r1', category: 'security' }),
        makeIssue({ id: 'r2', category: 'ai_config' }),
        makeIssue({ id: 'r3', category: 'custom' }),
      ],
    });
    const sarif = parseSarif(report);
    expect(sarif.runs[0].tool.driver.rules.map((r) => r.id)).toEqual(['ai_config', 'custom', 'security']);
  });
});
