/**
 * Tests for SARIF 2.1.0 report generation (pcic-aq2f).
 *
 * Covers:
 *  - A fixture with several findings validates against the vendored 2.1.0 schema
 *  - Severity -> SARIF level mapping for every IssueSeverity
 *  - A finding with no line (whole-file, locations-less)
 *  - A suppressed finding carries a `suppressions` entry
 *  - A multi-location finding produces multiple SARIF locations
 *  - partialFingerprints are stable across two independent runs
 *  - Paths are repo-relative POSIX even when the repo root is a Windows path
 */

import * as path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import Ajv from 'ajv-draft-04';
import type { ValidateFunction } from 'ajv-draft-04';
import { generateSarifReport } from '../src/sarif.js';
import type { IssueSeverity, PromptCiIssue, ScanReport } from '../src/types.js';

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
  // strict:false — the schema itself declares formats ("uri", "date-time")
  // ajv-draft-04 doesn't ship a format plugin for; we only need structural
  // validation, not format checking, and `logger: false` keeps the
  // "unknown format ... ignored" warnings out of test output.
  const ajv = new Ajv({ strict: false, allowUnionTypes: true, logger: false });
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

  // ── path handling ─────────────────────────────────────────────────────────

  it('produces repo-relative, forward-slash URIs even for a Windows repo root', () => {
    const report = makeReport({
      repoPath: 'C:\\git\\repo',
      issues: [
        makeIssue({
          filePaths: ['C:\\git\\repo\\sub\\CLAUDE.md'],
          locations: [{ filePath: 'C:\\git\\repo\\sub\\CLAUDE.md', startLine: 3 }],
        }),
      ],
    });
    const sarif = parseSarif(report);
    const uri = sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri;
    expect(uri).toBe('sub/CLAUDE.md');
  });

  it('is deterministic: identical reports produce byte-identical SARIF', () => {
    const report = makeReport({
      issues: [
        makeIssue({ id: 'z', category: 'security' }),
        makeIssue({ id: 'a', category: 'duplicate' }),
      ],
    });
    expect(generateSarifReport(report, '1.0.0')).toBe(generateSarifReport(report, '1.0.0'));
  });
});
