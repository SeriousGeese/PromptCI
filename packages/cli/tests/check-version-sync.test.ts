/**
 * Tests scripts/check-version-sync.mjs — the guard against @promptci/cli and
 * @promptci/core publishing out of lockstep (issue #5). core is bundled into
 * cli.cjs as a frozen esbuild snapshot, so nothing on npm's side ties the two
 * packages' versions together; this script is what does.
 *
 * The script computes its own repo root from import.meta.url, so these tests
 * build disposable fixture workspaces under a temp dir rather than mutating
 * the real packages/cli and packages/core package.json files.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/check-version-sync.mjs');
const REPO_ROOT = path.resolve(__dirname, '../../..');

const tempDirs: string[] = [];

function makeWorkspace(cliVersion: string, coreVersion: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-version-sync-'));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'packages', 'cli'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'packages', 'core'), { recursive: true });
  fs.copyFileSync(SCRIPT_PATH, path.join(dir, 'scripts', 'check-version-sync.mjs'));
  fs.writeFileSync(
    path.join(dir, 'packages', 'cli', 'package.json'),
    JSON.stringify({ name: '@promptci/cli', version: cliVersion }),
  );
  fs.writeFileSync(
    path.join(dir, 'packages', 'core', 'package.json'),
    JSON.stringify({ name: '@promptci/core', version: coreVersion }),
  );
  return dir;
}

function run(cwd: string, args: string[] = []): { status: number; stderr: string } {
  const result = spawnSync('node', [path.join(cwd, 'scripts', 'check-version-sync.mjs'), ...args], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  return { status: result.status ?? 1, stderr: result.stderr ?? '' };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('check-version-sync script', () => {
  it('exits 0 when cli and core agree', () => {
    const dir = makeWorkspace('1.2.3', '1.2.3');
    const result = run(dir);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('agree at 1.2.3');
  });

  it('exits non-zero when cli and core versions differ', () => {
    const dir = makeWorkspace('1.2.3', '1.2.4');
    const result = run(dir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('packages/cli is at 1.2.3');
    expect(result.stderr).toContain('packages/core is at 1.2.4');
  });

  it('exits 0 when --tag matches the agreeing versions', () => {
    const dir = makeWorkspace('1.2.3', '1.2.3');
    const result = run(dir, ['--tag', '1.2.3']);
    expect(result.status).toBe(0);
  });

  it('exits non-zero when --tag does not match the workspace version', () => {
    const dir = makeWorkspace('1.2.3', '1.2.3');
    const result = run(dir, ['--tag', '9.9.9']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not match the workspace version');
  });

  it('checks the real repo (packages/cli and packages/core currently agree)', () => {
    const result = run(REPO_ROOT);
    expect(result.status).toBe(0);
  });
});
