/**
 * Tests for the markdown and JSON report generators (Phase 7).
 */

import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  generateMarkdownReport,
  generateJsonReport,
  writeReport,
  readHistoryIndex,
  archiveExistingReport,
  computeTrend,
} from '../src/report.js';
import type { InstructionFile, PromptCiIssue, ScanReport, ScanReportJson } from '../src/types.js';
import { computeFingerprint, createBaseline } from '../src/baseline.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeIssue(overrides: Partial<PromptCiIssue> = {}): PromptCiIssue {
  return {
    id: 'test-issue-aabbcc112233',
    severity: 'high',
    category: 'duplicate',
    title: 'Test Issue',
    summary: 'This is a test issue.',
    filePaths: ['/repo/CLAUDE.md'],
    locations: [{ filePath: '/repo/CLAUDE.md', startLine: 1, endLine: 10 }],
    evidence: ['Evidence line 1'],
    recommendation: 'Fix this thing.',
    confidence: 0.9,
    ...overrides,
  };
}

function makeFile(overrides: Partial<InstructionFile> = {}): InstructionFile {
  return {
    path: '/repo/CLAUDE.md',
    fileType: 'claude',
    content: '# Instructions\n\nDo stuff.',
    sections: [],
    lineCount: 3,
    charCount: 25,
    estimatedTokens: 6,
    ...overrides,
  };
}

function makeReport(overrides: Partial<ScanReport> = {}): ScanReport {
  return {
    schemaVersion: '0.1',
    generatedAt: '2026-05-31T00:00:00.000Z',
    repoPath: '/repo',
    projectType: 'typescript',
    healthScore: 75,
    filesScanned: [],
    issues: [],
    topFixes: [],
    ...overrides,
  };
}

// ── generateMarkdownReport ────────────────────────────────────────────────────

describe('generateMarkdownReport', () => {
  it('includes the health score near the top', () => {
    const md = generateMarkdownReport(makeReport({ healthScore: 82 }));
    expect(md).toContain('82/100');
    // Score should appear before the Issues section
    const scoreIdx = md.indexOf('82/100');
    const issuesIdx = md.indexOf('## Issues');
    expect(scoreIdx).toBeLessThan(issuesIdx);
  });

  it('includes top fixes near the top, before Issues', () => {
    const report = makeReport({
      topFixes: [{ title: 'Fix A', reason: 'Because.', suggestedAction: 'Do this.' }],
    });
    const md = generateMarkdownReport(report);
    expect(md).toContain('Fix A');
    expect(md).toContain('Because.');
    expect(md).toContain('Do this.');
    const fixesIdx = md.indexOf('## Top Fixes');
    const issuesIdx = md.indexOf('## Issues');
    expect(fixesIdx).toBeLessThan(issuesIdx);
  });

  it('renders a health score of 100 with a full bar', () => {
    const md = generateMarkdownReport(makeReport({ healthScore: 100 }));
    expect(md).toContain('100/100');
    expect(md).toContain('██████████');
  });

  it('renders a health score of 0 with an empty bar', () => {
    const md = generateMarkdownReport(makeReport({ healthScore: 0 }));
    expect(md).toContain('0/100');
    expect(md).toContain('░░░░░░░░░░');
  });

  it('shows "No issues found" when issue list is empty', () => {
    const md = generateMarkdownReport(makeReport({ issues: [] }));
    expect(md).toContain('No issues found');
  });

  it('renders issue title, summary, and recommendation', () => {
    const issue = makeIssue({ title: 'My Issue', summary: 'Here is why.', recommendation: 'Do X.' });
    const md = generateMarkdownReport(makeReport({ issues: [issue] }));
    expect(md).toContain('My Issue');
    expect(md).toContain('Here is why.');
    expect(md).toContain('Do X.');
  });

  it('renders copyable fix recipe when present', () => {
    const issue = makeIssue({
      title: 'My Issue',
      recommendation: 'Do X.',
      fixRecipe: 'This is the recipe to add.',
    });
    const md = generateMarkdownReport(makeReport({ issues: [issue] }));
    expect(md).toContain('**Suggested text to add:**');
    expect(md).toContain('This is the recipe to add.');
  });

  it('renders file paths for an issue (relative to repo root)', () => {
    const issue = makeIssue({ filePaths: ['/repo/AGENTS.md'] });
    const md = generateMarkdownReport(makeReport({ repoPath: '/repo', issues: [issue] }));
    // Relative to repo root, /repo/AGENTS.md → AGENTS.md
    expect(md).toContain('AGENTS.md');
    expect(md).not.toContain('`/repo/AGENTS.md`');
  });

  it('renders locations with line numbers when present', () => {
    const issue = makeIssue({
      locations: [{ filePath: '/repo/CLAUDE.md', startLine: 5, endLine: 20 }],
    });
    const md = generateMarkdownReport(makeReport({ issues: [issue] }));
    expect(md).toContain('L5');
    expect(md).toContain('L20');
  });

  it('includes severity labels', () => {
    const issue = makeIssue({ severity: 'critical' });
    const md = generateMarkdownReport(makeReport({ issues: [issue] }));
    expect(md).toContain('CRITICAL');
  });

  it('includes metadata (project type, repo path, generated at)', () => {
    const md = generateMarkdownReport(
      makeReport({ repoPath: '/myrepo', projectType: 'nextjs', generatedAt: '2026-05-31T00:00:00.000Z' }),
    );
    expect(md).toContain('/myrepo');
    expect(md).toContain('nextjs');
    expect(md).toContain('2026-05-31T00:00:00.000Z');
  });

  it('includes a files scanned section when files are present', () => {
    const file = makeFile({ path: '/repo/CLAUDE.md', fileType: 'claude', lineCount: 42 });
    const md = generateMarkdownReport(makeReport({ repoPath: '/repo', filesScanned: [file] }));
    expect(md).toContain('## Files Scanned');
    // Relative path: /repo/CLAUDE.md → CLAUDE.md
    expect(md).toContain('CLAUDE.md');
    expect(md).toContain('claude');
    expect(md).toContain('42 lines');
  });

  it('omits the files scanned section when no files were scanned', () => {
    const md = generateMarkdownReport(makeReport({ filesScanned: [] }));
    expect(md).not.toContain('## Files Scanned');
  });

  it('includes a heuristic disclaimer note', () => {
    const md = generateMarkdownReport(makeReport());
    expect(md.toLowerCase()).toContain('heuristic');
    expect(md.toLowerCase()).toContain('review');
  });

  it('produces valid output for a completely empty scan (no files, no issues)', () => {
    const report = makeReport({ filesScanned: [], issues: [], topFixes: [], healthScore: 100 });
    const md = generateMarkdownReport(report);
    expect(md).toContain('# PromptCI Health Report');
    expect(md).toContain('100/100');
    expect(md).toContain('No issues found');
    expect(md).not.toContain('## Top Fixes');
    expect(md).not.toContain('## Files Scanned');
  });

  it('is deterministic for the same input', () => {
    const report = makeReport({ issues: [makeIssue()], filesScanned: [makeFile()] });
    expect(generateMarkdownReport(report)).toBe(generateMarkdownReport(report));
  });

  it('snapshot: full report with one issue and one fix', () => {
    const report = makeReport({
      healthScore: 72,
      filesScanned: [makeFile()],
      issues: [
        makeIssue({
          id: 'dup-aabbccdd',
          severity: 'high',
          title: 'Duplicate Instructions',
          summary: 'These sections appear highly similar.',
          recommendation: 'Merge or remove one copy.',
          confidence: 0.85,
        }),
      ],
      topFixes: [
        {
          title: 'Duplicate Instructions',
          reason: 'These sections appear highly similar.',
          suggestedAction: 'Merge or remove one copy.',
        },
      ],
    });
    expect(generateMarkdownReport(report)).toMatchSnapshot();
  });

  it('snapshot: empty scan', () => {
    const report = makeReport({ healthScore: 100, filesScanned: [], issues: [], topFixes: [] });
    expect(generateMarkdownReport(report)).toMatchSnapshot();
  });
});

// ── generateJsonReport ────────────────────────────────────────────────────────

describe('generateJsonReport', () => {
  it('produces valid JSON', () => {
    const report = makeReport();
    expect(() => JSON.parse(generateJsonReport(report))).not.toThrow();
  });

  it('includes healthScore at the top level', () => {
    const parsed = JSON.parse(generateJsonReport(makeReport({ healthScore: 55 })));
    expect(parsed.healthScore).toBe(55);
  });

  it('includes topFixes', () => {
    const report = makeReport({
      topFixes: [{ title: 'Fix A', reason: 'Reason.', suggestedAction: 'Action.' }],
    });
    const parsed = JSON.parse(generateJsonReport(report));
    expect(parsed.topFixes).toHaveLength(1);
    expect(parsed.topFixes[0].title).toBe('Fix A');
  });

  it('includes issues array', () => {
    const report = makeReport({ issues: [makeIssue()] });
    const parsed = JSON.parse(generateJsonReport(report));
    expect(Array.isArray(parsed.issues)).toBe(true);
    expect(parsed.issues).toHaveLength(1);
  });

  it('includes schemaVersion "0.1"', () => {
    const parsed = JSON.parse(generateJsonReport(makeReport()));
    expect(parsed.schemaVersion).toBe('0.1');
  });

  it('includes all required top-level fields', () => {
    const parsed = JSON.parse(generateJsonReport(makeReport()));
    expect(parsed).toHaveProperty('schemaVersion');
    expect(parsed).toHaveProperty('generatedAt');
    expect(parsed).toHaveProperty('repoPath');
    expect(parsed).toHaveProperty('projectType');
    expect(parsed).toHaveProperty('healthScore');
    expect(parsed).toHaveProperty('topFixes');
    expect(parsed).toHaveProperty('issues');
    expect(parsed).toHaveProperty('filesScanned');
  });

  it('filesScanned entries contain expected fields and omit section content', () => {
    const report = makeReport({ filesScanned: [makeFile()] });
    const parsed = JSON.parse(generateJsonReport(report));
    expect(parsed.filesScanned).toHaveLength(1);
    const f = parsed.filesScanned[0];
    expect(f).toHaveProperty('path');
    expect(f).toHaveProperty('fileType');
    expect(f).toHaveProperty('lineCount');
    expect(f).toHaveProperty('charCount');
    expect(f).toHaveProperty('estimatedTokens');
    expect(f).not.toHaveProperty('content');
    expect(f).not.toHaveProperty('sections');
  });

  it('filesScanned paths are repo-relative in JSON output', () => {
    // makeFile has path '/repo/CLAUDE.md', makeReport has repoPath '/repo'
    const report = makeReport({ filesScanned: [makeFile()] });
    const parsed = JSON.parse(generateJsonReport(report));
    expect(parsed.repoPath).toBe('/repo'); // anchor stays absolute
    expect(parsed.filesScanned[0].path).toBe('CLAUDE.md'); // relative
  });

  it('issue filePaths and location filePaths are repo-relative in JSON output', () => {
    const issue = makeIssue({
      filePaths: ['/repo/CLAUDE.md'],
      locations: [{ filePath: '/repo/CLAUDE.md', startLine: 1, endLine: 5 }],
    });
    const report = makeReport({ issues: [issue] });
    const parsed = JSON.parse(generateJsonReport(report));
    expect(parsed.issues[0].filePaths[0]).toBe('CLAUDE.md');
    expect(parsed.issues[0].locations[0].filePath).toBe('CLAUDE.md');
  });

  it('issues entries contain all PromptCiIssue fields', () => {
    const issue = makeIssue();
    const parsed = JSON.parse(generateJsonReport(makeReport({ issues: [issue] })));
    const i = parsed.issues[0];
    expect(i).toHaveProperty('id');
    expect(i).toHaveProperty('severity');
    expect(i).toHaveProperty('category');
    expect(i).toHaveProperty('title');
    expect(i).toHaveProperty('summary');
    expect(i).toHaveProperty('filePaths');
    expect(i).toHaveProperty('locations');
    expect(i).toHaveProperty('evidence');
    expect(i).toHaveProperty('recommendation');
    expect(i).toHaveProperty('confidence');
  });

  it('produces empty arrays for an empty scan', () => {
    const parsed = JSON.parse(generateJsonReport(makeReport()));
    expect(parsed.issues).toEqual([]);
    expect(parsed.topFixes).toEqual([]);
    expect(parsed.filesScanned).toEqual([]);
  });

  it('pretty-prints by default', () => {
    const json = generateJsonReport(makeReport());
    expect(json).toContain('\n');
  });

  it('produces compact JSON when pretty=false', () => {
    const json = generateJsonReport(makeReport(), false);
    expect(json).not.toContain('\n');
  });

  it('is deterministic across calls', () => {
    const report = makeReport({ issues: [makeIssue()] });
    expect(generateJsonReport(report)).toBe(generateJsonReport(report));
  });

  // ── R1: the parsed JSON conforms to the ScanReportJson type, not ScanReport ──

  it('R1: the compact filesScanned shape type-checks as ScanReportJson', () => {
    const report = makeReport({ filesScanned: [makeFile()] });
    const parsed: ScanReportJson = JSON.parse(generateJsonReport(report));
    // Only fields declared on CompactFileSummary are guaranteed — this is a
    // compile-time check as much as a runtime one: if ScanReportJson drifted
    // to require `content`/`sections` again, this assignment would no
    // longer type-check.
    expect(parsed.filesScanned[0]!.path).toBe('CLAUDE.md');
  });
});

// ── writeReport ───────────────────────────────────────────────────────────────

describe('writeReport', () => {
  it('writes both files to the default .promptci/ directory', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'promptci-report-'));
    try {
      const report = makeReport({ repoPath: tmp });
      const result = await writeReport(report);

      expect(result.mdPath).toBe(path.join(tmp, '.promptci', 'latest.md'));
      expect(result.jsonPath).toBe(path.join(tmp, '.promptci', 'report.json'));

      const md = await fs.readFile(result.mdPath, 'utf8');
      const json = await fs.readFile(result.jsonPath, 'utf8');

      expect(md).toContain('# PromptCI Health Report');
      expect(JSON.parse(json).schemaVersion).toBe('0.1');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('creates the output directory if it does not exist', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'promptci-report-'));
    try {
      const report = makeReport({ repoPath: tmp });
      await writeReport(report);
      const stat = await fs.stat(path.join(tmp, '.promptci'));
      expect(stat.isDirectory()).toBe(true);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('respects custom output paths via options', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'promptci-report-'));
    try {
      const report = makeReport({ repoPath: tmp });
      const customMd = path.join(tmp, 'custom', 'out.md');
      const customJson = path.join(tmp, 'custom', 'out.json');
      const result = await writeReport(report, { mdPath: customMd, jsonPath: customJson });

      expect(result.mdPath).toBe(customMd);
      expect(result.jsonPath).toBe(customJson);

      const md = await fs.readFile(customMd, 'utf8');
      expect(md).toContain('# PromptCI Health Report');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('markdown and JSON content match what generators produce', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'promptci-report-'));
    try {
      const report = makeReport({ repoPath: tmp, issues: [makeIssue()], filesScanned: [makeFile()] });
      const result = await writeReport(report);

      const md = await fs.readFile(result.mdPath, 'utf8');
      const json = await fs.readFile(result.jsonPath, 'utf8');

      const { generateMarkdownReport: genMd, generateJsonReport: genJson } = await import(
        '../src/report.js'
      );
      expect(md).toBe(genMd(report));
      expect(json).toBe(genJson(report));
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('returns archivedEntry: null on the very first scan (no previous report)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'promptci-report-'));
    try {
      const report = makeReport({ repoPath: tmp });
      const result = await writeReport(report);
      // Nothing to archive yet — no previous report.json existed
      expect(result.archivedEntry).toBeNull();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('archives the previous report on the second scan', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'promptci-report-'));
    try {
      // First scan
      const report1 = makeReport({ repoPath: tmp, healthScore: 80, generatedAt: '2026-01-01T10:00:00.000Z' });
      await writeReport(report1);

      // Second scan — should archive the first
      const report2 = makeReport({ repoPath: tmp, healthScore: 72, generatedAt: '2026-01-02T10:00:00.000Z' });
      const result2 = await writeReport(report2);

      expect(result2.archivedEntry).not.toBeNull();
      expect(result2.archivedEntry!.healthScore).toBe(80);
      expect(result2.archivedEntry!.generatedAt).toBe('2026-01-01T10:00:00.000Z');

      // The archived files should exist on disk
      const archiveMd = path.join(tmp, result2.archivedEntry!.archiveMdPath);
      const archiveJson = path.join(tmp, result2.archivedEntry!.archiveJsonPath);
      await expect(fs.access(archiveMd)).resolves.toBeUndefined();
      await expect(fs.access(archiveJson)).resolves.toBeUndefined();

      // latest.md and report.json should now reflect the second scan
      const latest = await fs.readFile(result2.mdPath, 'utf8');
      expect(latest).toContain('72/100');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('accumulates entries in history index.json across multiple scans', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'promptci-report-'));
    try {
      for (let i = 0; i < 3; i++) {
        const report = makeReport({
          repoPath: tmp,
          healthScore: 50 + i * 10,
          generatedAt: `2026-01-0${i + 1}T10:00:00.000Z`,
        });
        await writeReport(report);
      }

      // After 3 scans, the index should have 2 entries (scans 1 and 2 archived)
      const index = await readHistoryIndex(tmp);
      expect(index).toHaveLength(2);
      expect(index[0].healthScore).toBe(50);
      expect(index[1].healthScore).toBe(60);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('captures issue counts correctly in the archived entry', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'promptci-report-'));
    try {
      const report1 = makeReport({
        repoPath: tmp,
        healthScore: 60,
        generatedAt: '2026-01-01T10:00:00.000Z',
        issues: [
          makeIssue({ severity: 'high' }),
          makeIssue({ severity: 'warning' }),
          makeIssue({ severity: 'warning' }),
          makeIssue({ severity: 'info' }),
        ],
      });
      await writeReport(report1);

      const report2 = makeReport({ repoPath: tmp, generatedAt: '2026-01-02T10:00:00.000Z' });
      const result = await writeReport(report2);

      expect(result.archivedEntry!.issueCount.high).toBe(1);
      expect(result.archivedEntry!.issueCount.warning).toBe(2);
      expect(result.archivedEntry!.issueCount.info).toBe(1);
      expect(result.archivedEntry!.issueCount.critical).toBe(0);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('skips archiving when custom mdPath/jsonPath are provided', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'promptci-report-'));
    try {
      // Write a "previous" report at the default location first
      const report1 = makeReport({ repoPath: tmp, generatedAt: '2026-01-01T10:00:00.000Z' });
      await writeReport(report1);

      // Write to custom paths — archiving should be skipped
      const report2 = makeReport({ repoPath: tmp, generatedAt: '2026-01-02T10:00:00.000Z' });
      const customMd = path.join(tmp, 'custom.md');
      const customJson = path.join(tmp, 'custom.json');
      const result = await writeReport(report2, { mdPath: customMd, jsonPath: customJson });

      expect(result.archivedEntry).toBeNull();
      // History index should still be empty (nothing was archived)
      const index = await readHistoryIndex(tmp);
      expect(index).toHaveLength(0);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

// ── readHistoryIndex ──────────────────────────────────────────────────────────

describe('readHistoryIndex', () => {
  it('returns an empty array when no history exists', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'promptci-hist-'));
    try {
      const index = await readHistoryIndex(tmp);
      expect(index).toEqual([]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('returns an empty array when the index file is corrupt JSON', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'promptci-hist-'));
    try {
      const indexDir = path.join(tmp, '.promptci', 'history');
      await fs.mkdir(indexDir, { recursive: true });
      await fs.writeFile(path.join(indexDir, 'index.json'), 'not-valid-json', 'utf8');
      const index = await readHistoryIndex(tmp);
      expect(index).toEqual([]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

// ── archiveExistingReport ─────────────────────────────────────────────────────

describe('archiveExistingReport', () => {
  it('returns null when no previous report.json exists', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'promptci-archive-'));
    try {
      const result = await archiveExistingReport(
        tmp,
        path.join(tmp, '.promptci', 'latest.md'),
        path.join(tmp, '.promptci', 'report.json'),
      );
      expect(result).toBeNull();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('returns null when report.json is corrupt', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'promptci-archive-'));
    try {
      const promptciDir = path.join(tmp, '.promptci');
      await fs.mkdir(promptciDir, { recursive: true });
      await fs.writeFile(path.join(promptciDir, 'report.json'), '{bad json', 'utf8');
      const result = await archiveExistingReport(
        tmp,
        path.join(promptciDir, 'latest.md'),
        path.join(promptciDir, 'report.json'),
      );
      expect(result).toBeNull();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('writes the history index atomically and leaves no .tmp behind (BUG-005)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'promptci-archive-'));
    try {
      const promptciDir = path.join(tmp, '.promptci');
      await fs.mkdir(promptciDir, { recursive: true });
      await fs.writeFile(
        path.join(promptciDir, 'report.json'),
        JSON.stringify({ generatedAt: '2026-01-02T03:04:05.678Z', healthScore: 91, issues: [{ severity: 'warning' }] }),
        'utf8',
      );
      await fs.writeFile(path.join(promptciDir, 'latest.md'), '# old report\n', 'utf8');

      const entry = await archiveExistingReport(
        tmp,
        path.join(promptciDir, 'latest.md'),
        path.join(promptciDir, 'report.json'),
      );
      expect(entry).not.toBeNull();

      // The index parses (never a half-written file) and holds the entry.
      const index = await readHistoryIndex(tmp);
      expect(index).toHaveLength(1);
      expect(index[0]!.healthScore).toBe(91);

      // No temp file is left dangling next to the committed index.
      const historyDir = path.join(promptciDir, 'history');
      const leftovers = await fs.readdir(historyDir);
      expect(leftovers.some((f) => f.endsWith('.tmp'))).toBe(false);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('Trend Insights', () => {
  it('handles first scan with no trend gracefully', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'promptci-trend-'));
    try {
      const report = makeReport({ repoPath: tmp, healthScore: 90 });
      const result = await writeReport(report);
      expect(report.trend).toBeUndefined();
      const md = await fs.readFile(result.mdPath, 'utf-8');
      expect(md).toContain('First scan — no trend data available yet.');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('computes positive score delta and new/resolved issues on subsequent scans', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'promptci-trend-'));
    try {
      // First scan: 1 issue
      const issue1 = makeIssue({ id: 'issue-1', severity: 'warning', category: 'duplicate' });
      const report1 = makeReport({ repoPath: tmp, healthScore: 80, issues: [issue1] });
      await writeReport(report1);

      // Second scan: resolved issue-1, added issue-2
      const issue2 = makeIssue({ id: 'issue-2', severity: 'warning', category: 'conflict' });
      const report2 = makeReport({ repoPath: tmp, healthScore: 85, issues: [issue2] });
      await writeReport(report2);

      expect(report2.trend).toBeDefined();
      expect(report2.trend!.scoreDelta).toBe(5);
      expect(report2.trend!.newIssuesCount).toBe(1);
      expect(report2.trend!.resolvedIssuesCount).toBe(1);
      expect(report2.trend!.newIssueIds).toHaveLength(1);
      expect(report2.trend!.newIssueIds[0]).toMatch(/^[0-9a-f]{64}$/);
      expect(report2.trend!.resolvedIssueIds).toHaveLength(1);
      expect(report2.trend!.resolvedIssueIds[0]).toMatch(/^[0-9a-f]{64}$/);
      expect(report2.trend!.categoryDeltas['duplicate']).toBe(-1);
      expect(report2.trend!.categoryDeltas['conflict']).toBe(1);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('computes correct streak of scans without high/critical issues', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'promptci-trend-'));
    try {
      // Scan 1: clean (streak = 1)
      const report1 = makeReport({ repoPath: tmp, healthScore: 100, issues: [], generatedAt: '2026-01-01T10:00:00.000Z' });
      await writeReport(report1);

      // Scan 2: clean (streak = 2)
      const report2 = makeReport({ repoPath: tmp, healthScore: 100, issues: [], generatedAt: '2026-01-02T10:00:00.000Z' });
      await writeReport(report2);

      expect(report2.trend).toBeDefined();
      expect(report2.trend!.streak).toBe(2);

      // Scan 3: has a high issue (streak = 0)
      const highIssue = makeIssue({ id: 'issue-3', severity: 'high' });
      const report3 = makeReport({ repoPath: tmp, healthScore: 90, issues: [highIssue], generatedAt: '2026-01-03T10:00:00.000Z' });
      await writeReport(report3);

      expect(report3.trend).toBeDefined();
      expect(report3.trend!.streak).toBe(0);

      // Scan 4: clean again (streak = 1, since last run had a high issue)
      const report4 = makeReport({ repoPath: tmp, healthScore: 100, issues: [], generatedAt: '2026-01-04T10:00:00.000Z' });
      await writeReport(report4);

      expect(report4.trend).toBeDefined();
      expect(report4.trend!.streak).toBe(1);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('handles corrupt/invalid JSON in previous report file gracefully', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'promptci-trend-'));
    try {
      const promptciDir = path.join(tmp, '.promptci');
      await fs.mkdir(promptciDir, { recursive: true });
      await fs.writeFile(path.join(promptciDir, 'report.json'), '{invalid json', 'utf8');

      const report = makeReport({ repoPath: tmp, healthScore: 90 });
      await expect(writeReport(report)).resolves.toBeDefined();
      expect(report.trend).toBeUndefined();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

// ── computeTrend — R2: duplicate-id resilience ────────────────────────────────

describe('computeTrend — R2 duplicate-id resilience', () => {
  it('does not treat the same issue as new/resolved when only the absolute-root-derived id changed', async () => {
    const repoPath = path.join(os.tmpdir(), 'promptci-trend-portable-root');
    const report = makeReport({
      repoPath,
      issues: [
        makeIssue({
          id: 'duplicate-newmachine',
          severity: 'warning',
          category: 'duplicate',
          title: 'Repeated guidance',
          filePaths: [path.join(repoPath, 'CLAUDE.md')],
        }),
      ],
    });
    const previousReport = {
      issues: [
        {
          id: 'duplicate-oldmachine',
          severity: 'warning',
          category: 'duplicate',
          title: 'Repeated guidance',
          filePaths: ['CLAUDE.md'],
          evidence: ['Evidence line 1'],
        },
      ],
    };

    const trend = await computeTrend(report, previousReport, []);
    expect(trend).not.toBeNull();
    expect(trend!.newIssuesCount).toBe(0);
    expect(trend!.resolvedIssuesCount).toBe(0);
  });

  it('counts the same finding once even when it appears twice (duplicate defense)', async () => {
    // The original R2 case: a detector bug emits one finding twice. Under
    // content-based identity the two copies share a fingerprint and collapse —
    // regardless of whether the duplicate copies share an id.
    const report = makeReport({
      issues: [
        makeIssue({ id: 'dup-id', title: 'Finding A' }),
        makeIssue({ id: 'dup-id', title: 'Finding A' }),
        makeIssue({ id: 'unique-id' }),
      ],
    });
    const previousReport = { issues: [] };
    const trend = await computeTrend(report, previousReport, []);
    expect(trend).not.toBeNull();
    expect(trend!.newIssuesCount).toBe(2);
    expect(trend!.newIssueIds).toHaveLength(2);
    expect(trend!.newIssueIds.every((id) => /^[0-9a-f]{64}$/.test(id))).toBe(true);
  });

  it('counts DISTINCT findings separately even when a detector bug gives them one id', async () => {
    // Identity is what the finding says, not its id — the baseline counts both
    // of these (their fingerprints differ), so the trend must too. The old
    // raw-id pre-dedup silently dropped Finding B here.
    const report = makeReport({
      issues: [
        makeIssue({ id: 'dup-id', title: 'Finding A' }),
        makeIssue({ id: 'dup-id', title: 'Finding B' }),
      ],
    });
    const trend = await computeTrend(report, { issues: [] }, []);
    expect(trend).not.toBeNull();
    expect(trend!.newIssuesCount).toBe(2);
  });

  it('counts a RESOLVED finding once even when it appeared twice in the previous report', async () => {
    const report = makeReport({ issues: [] });
    const previousReport = {
      issues: [
        { id: 'dup-id', category: 'duplicate', severity: 'high', title: 'Finding A', filePaths: ['CLAUDE.md'], evidence: ['Evidence line 1'] },
        { id: 'dup-id', category: 'duplicate', severity: 'high', title: 'Finding A', filePaths: ['CLAUDE.md'], evidence: ['Evidence line 1'] },
        { id: 'unique-id', category: 'duplicate', severity: 'warning', title: 'Test Issue', filePaths: ['CLAUDE.md'], evidence: ['Evidence line 1'] },
      ],
    };
    const trend = await computeTrend(report, previousReport, []);
    expect(trend).not.toBeNull();
    expect(trend!.resolvedIssuesCount).toBe(2);
    expect(trend!.resolvedIssueIds).toHaveLength(2);
    expect(trend!.resolvedIssueIds.every((id) => /^[0-9a-f]{64}$/.test(id))).toBe(true);
  });

  it('still reports correct counts with no duplicate ids present (baseline behavior unaffected)', async () => {
    const report = makeReport({
      // Distinct findings, not just distinct ids — identity is computed from
      // what the finding says, so two issues differing only by id are one.
      issues: [makeIssue({ id: 'a', title: 'Finding A' }), makeIssue({ id: 'b' })],
    });
    const previousReport = {
      issues: [{ id: 'b', category: 'duplicate', severity: 'high', title: 'Test Issue', filePaths: ['CLAUDE.md'], evidence: ['Evidence line 1'] }],
    };
    const trend = await computeTrend(report, previousReport, []);
    expect(trend).not.toBeNull();
    expect(trend!.newIssuesCount).toBe(1);
    expect(trend!.newIssueIds).toHaveLength(1);
    expect(trend!.newIssueIds[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(trend!.resolvedIssuesCount).toBe(0);
  });
});

// ── Issue identity: the trend and the baseline agree ─────────────────────────

describe('computeTrend — issue identity matches the baseline', () => {
  it('does not report a severity bump as one resolved plus one new issue', async () => {
    // The finding is unchanged; only its severity rose. The baseline calls
    // that one issue that worsened, and the trend used to disagree because it
    // hashed severity into its own key.
    const report = makeReport({ issues: [makeIssue({ id: 'x', severity: 'critical' })] });
    const previousReport = {
      issues: [
        {
          id: 'x',
          category: 'duplicate',
          severity: 'warning',
          title: 'Test Issue',
          filePaths: ['CLAUDE.md'],
          evidence: ['Evidence line 1'],
        },
      ],
    };

    const trend = await computeTrend(report, previousReport, []);
    expect(trend).not.toBeNull();
    expect(trend!.newIssuesCount).toBe(0);
    expect(trend!.resolvedIssuesCount).toBe(0);
  });

  it('keys the trend by the same fingerprint the baseline stores', async () => {
    const issue = makeIssue({ id: 'x', filePaths: ['CLAUDE.md'] });
    const report = makeReport({ issues: [issue] });
    const trend = await computeTrend(report, { issues: [] }, []);

    expect(trend!.newIssueIds).toEqual([computeFingerprint(issue, report.repoPath)]);
    // …and that value is exactly what a baseline built from the same scan holds.
    expect(createBaseline([issue], report.repoPath).map((e) => e.fingerprint)).toEqual(
      trend!.newIssueIds,
    );
  });
});
