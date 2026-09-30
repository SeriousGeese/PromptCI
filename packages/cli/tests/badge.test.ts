import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runBadge } from '../src/commands/badge.js';

describe('promptci badge', () => {
  let tmpDir: string;
  let stdout: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'promptci-badge-test-'));
    stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function readBadge(rel: string): Promise<unknown> {
    return JSON.parse(await fs.readFile(path.join(tmpDir, rel), 'utf-8'));
  }

  it('scans and writes .promptci/health-badge.json by default', async () => {
    const result = await runBadge({ scanPath: tmpDir });
    expect(result.outputPath).toBe(path.join(tmpDir, '.promptci', 'health-badge.json'));
    const badge = await readBadge('.promptci/health-badge.json');
    expect(badge).toEqual({
      schemaVersion: 1,
      label: 'instruction health',
      message: `${result.score}/100`,
      color: result.badge.color,
    });
    // Only the badge is written — a badge run is not a scan run.
    await expect(fs.access(path.join(tmpDir, '.promptci', 'report.json'))).rejects.toThrow();
    expect(stdout).toContain('img.shields.io/endpoint?url=');
    expect(stdout).toContain('!**/.promptci/health-badge.json');
  });

  it('reads the score from an existing report with --report, and honors --output/--label', async () => {
    await fs.mkdir(path.join(tmpDir, '.promptci'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.promptci', 'report.json'), JSON.stringify({ healthScore: 64 }));

    const result = await runBadge({
      scanPath: tmpDir,
      report: '.promptci/report.json',
      output: 'badges/promptci.json',
      label: 'agent docs',
    });

    expect(result.score).toBe(64);
    expect(await readBadge('badges/promptci.json')).toEqual({
      schemaVersion: 1,
      label: 'agent docs',
      message: '64/100',
      color: 'orange',
    });
    // Not under .promptci/, so no gitignore exception hint.
    expect(stdout).not.toContain('!**/');
  });

  it('points the README URL at the repo-root-relative path when --path is a nested package', async () => {
    await fs.mkdir(path.join(tmpDir, '.git'), { recursive: true });
    const pkg = path.join(tmpDir, 'packages', 'app');
    await fs.mkdir(pkg, { recursive: true });
    await fs.writeFile(path.join(pkg, 'report.json'), JSON.stringify({ healthScore: 91 }));

    await runBadge({ scanPath: pkg, report: 'report.json', label: 'x]y' });

    expect(stdout).toContain('Wrote .promptci/health-badge.json');
    expect(stdout).toContain('%2Fpackages%2Fapp%2F.promptci%2Fhealth-badge.json');
    expect(stdout).toContain('[![x\\]y]');
    expect(stdout).toContain('!**/.promptci/health-badge.json');
  });

  it('writes a trailing newline and stable two-space JSON', async () => {
    await fs.writeFile(path.join(tmpDir, 'report.json'), JSON.stringify({ healthScore: 100 }));
    await runBadge({ scanPath: tmpDir, report: 'report.json' });
    const raw = await fs.readFile(path.join(tmpDir, '.promptci', 'health-badge.json'), 'utf-8');
    expect(raw).toBe(
      '{\n  "schemaVersion": 1,\n  "label": "instruction health",\n  "message": "100/100",\n  "color": "brightgreen"\n}\n',
    );
  });

  it('rejects a missing, malformed, or score-less report', async () => {
    await expect(runBadge({ scanPath: tmpDir, report: 'nope.json' })).rejects.toThrow(/not found/);

    await fs.writeFile(path.join(tmpDir, 'bad.json'), '{not json');
    await expect(runBadge({ scanPath: tmpDir, report: 'bad.json' })).rejects.toThrow(/not valid JSON/);

    await fs.writeFile(path.join(tmpDir, 'noscore.json'), JSON.stringify({ issues: [] }));
    await expect(runBadge({ scanPath: tmpDir, report: 'noscore.json' })).rejects.toThrow(/healthScore/);
  });

  it('rejects a scan path that is not a directory', async () => {
    await expect(runBadge({ scanPath: path.join(tmpDir, 'missing') })).rejects.toThrow(/does not exist/);
  });
});
