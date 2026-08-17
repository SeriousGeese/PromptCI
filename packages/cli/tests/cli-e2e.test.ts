/**
 * End-to-end tests that invoke the compiled CLI binary via child_process.
 *
 * These tests exercise the Commander argument-parsing layer that the
 * runScan() unit tests skip. They require packages/cli/dist/cli.cjs to exist;
 * if it doesn't, a build is triggered automatically.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync, execSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, '../dist/cli.cjs');
const FIXTURES = path.resolve(__dirname, '../../../examples');
const CONFLICTS_FIXTURE = path.join(FIXTURES, 'fixture-conflicts');
const BASIC_FIXTURE = path.join(FIXTURES, 'fixture-basic');
const PROJECT_ROOT = path.resolve(__dirname, '../../..');

beforeAll(() => {
  // The CLI package is named @promptci/cli — the old `--filter promptci`
  // matched nothing, pnpm exited 0 without building, and every test below then
  // failed on a missing dist/cli.cjs.
  execSync('pnpm --filter @promptci/core build && pnpm --filter @promptci/cli build', {
    cwd: PROJECT_ROOT,
    stdio: 'pipe',
  });
});

function cli(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    cwd: PROJECT_ROOT,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

// ── version / help ────────────────────────────────────────────────────────────

describe('CLI meta commands', () => {
  it('--version prints version and exits 0', () => {
    const { status, stdout } = cli(['--version']);
    expect(status).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('--help exits 0 and mentions scan and init', () => {
    const { status, stdout } = cli(['--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('scan');
    expect(stdout).toContain('init');
    expect(stdout).toContain('context');
  });

  it('scan --help exits 0', () => {
    const { status, stdout } = cli(['scan', '--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('--fail-on');
  });

  it('context analyze --help exits 0', () => {
    const { status, stdout } = cli(['context', 'analyze', '--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('--json');
  });
});

// ── --fail-on ─────────────────────────────────────────────────────────────────

describe('scan --fail-on (CLI layer)', () => {
  it('exits 1 when --fail-on high and a high issue is present', () => {
    // fixture-conflicts reliably produces at least one "high" conflict issue
    const { status, stderr } = cli(['scan', '--path', CONFLICTS_FIXTURE, '--fail-on', 'high']);
    expect(status).toBe(1);
    expect(stderr).toContain('Failed:');
    expect(stderr).toContain('"high"');
  });

  it('exits 0 when --fail-on critical and no critical issues are present', () => {
    // fixture-conflicts has high/warning/info but no critical
    const { status } = cli(['scan', '--path', CONFLICTS_FIXTURE, '--fail-on', 'critical']);
    expect(status).toBe(0);
  });

  it('exits 1 when --fail-on warning and warning-level issues are present', () => {
    // fixture-conflicts has a warning (duplicate)
    const { status } = cli(['scan', '--path', CONFLICTS_FIXTURE, '--fail-on', 'warning']);
    expect(status).toBe(1);
  });

  it('exits 0 when --fail-on high and only info/warning issues exist', () => {
    // fixture-basic produces only one info issue (vague guidance) — no high
    const { status } = cli(['scan', '--path', BASIC_FIXTURE, '--fail-on', 'high']);
    expect(status).toBe(0);
  });

  it('exits 1 with error message for invalid --fail-on value', () => {
    const { status, stderr } = cli(['scan', '--path', BASIC_FIXTURE, '--fail-on', 'blocker']);
    expect(status).toBe(1);
    expect(stderr).toContain('invalid');
  });
});

// ── basic scan behaviour ──────────────────────────────────────────────────────

describe('scan basic CLI behaviour', () => {
  it('--json outputs valid JSON to stdout with correct schema version', () => {
    const { status, stdout } = cli(['scan', '--path', BASIC_FIXTURE, '--json']);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as { schemaVersion: string; filesScanned: unknown[] };
    expect(parsed.schemaVersion).toBe('0.1');
    expect(Array.isArray(parsed.filesScanned)).toBe(true);
  });

  it('JSON output uses repo-relative paths for filesScanned', () => {
    const { stdout } = cli(['scan', '--path', BASIC_FIXTURE, '--json']);
    const parsed = JSON.parse(stdout) as { repoPath: string; filesScanned: { path: string }[] };
    // repoPath is absolute; filesScanned paths are relative
    expect(path.isAbsolute(parsed.repoPath)).toBe(true);
    for (const f of parsed.filesScanned) {
      expect(path.isAbsolute(f.path)).toBe(false);
    }
  });

  it('exits non-zero when scanning a non-existent path', () => {
    const { status, stderr } = cli(['scan', '--path', '/no/such/dir/xyzzy']);
    expect(status).toBe(1);
    expect(stderr).toContain('Error');
  });
});
