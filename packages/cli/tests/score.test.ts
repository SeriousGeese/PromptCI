import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { spawnSync, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PromptCiIssue, ScanReport } from '@promptci/core';
import {
  DASHBOARD_POINTER,
  TOP_FINDINGS_COUNT,
  formatScoreTeaser,
  runScore,
  selectTopFindings,
} from '../src/commands/score.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, '../dist/cli.cjs');
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const EXAMPLES = path.join(PROJECT_ROOT, 'examples');
const CONFLICTS_FIXTURE = path.join(EXAMPLES, 'fixture-conflicts');
const CLEAN_FIXTURE = path.join(EXAMPLES, 'fixture-clean');
const EMPTY_FIXTURE = path.join(EXAMPLES, 'fixture-no-instructions');

function issue(overrides: Partial<PromptCiIssue> & { id: string }): PromptCiIssue {
  return {
    severity: 'warning',
    category: 'vague_guidance',
    title: `Title ${overrides.id}`,
    summary: 'summary',
    filePaths: ['CLAUDE.md'],
    locations: [{ filePath: 'CLAUDE.md', startLine: 4 }],
    evidence: [],
    recommendation: `Fix ${overrides.id}`,
    confidence: 0.5,
    ...overrides,
  };
}

function report(issues: PromptCiIssue[], overrides: Partial<ScanReport> = {}): ScanReport {
  return {
    schemaVersion: '0.1',
    generatedAt: '2026-01-01T00:00:00.000Z',
    repoPath: '/repo',
    projectType: 'unknown',
    healthScore: 72,
    filesScanned: [{ path: '/repo/CLAUDE.md' } as ScanReport['filesScanned'][number]],
    issues,
    topFixes: [],
    ...overrides,
  };
}

/** Copy a fixture somewhere disposable so a stray write can be detected, not committed. */
function copyFixture(src: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-score-'));
  fs.cpSync(src, dir, { recursive: true });
  return dir;
}

function snapshot(dir: string): string[] {
  return (fs.readdirSync(dir, { recursive: true, withFileTypes: true }) as fs.Dirent[])
    .map((e) => path.join(e.parentPath, e.name))
    .sort();
}

describe('selectTopFindings', () => {
  it('orders by confidence, then severity, then id, and returns exactly 3', () => {
    const top = selectTopFindings([
      issue({ id: 'e', confidence: 0.6, severity: 'critical' }),
      issue({ id: 'a', confidence: 0.9, severity: 'info' }),
      issue({ id: 'b', confidence: 0.9, severity: 'high' }),
      issue({ id: 'd', confidence: 0.9, severity: 'high' }),
      issue({ id: 'c', confidence: 0.7, severity: 'warning' }),
    ]);
    expect(top.map((i) => i.id)).toEqual(['b', 'd', 'a']);
    expect(top).toHaveLength(TOP_FINDINGS_COUNT);
  });

  it('does not mutate its input and returns fewer when there are fewer issues', () => {
    const input = [issue({ id: 'x', confidence: 0.1 }), issue({ id: 'y', confidence: 0.9 })];
    const top = selectTopFindings(input);
    expect(top.map((i) => i.id)).toEqual(['y', 'x']);
    expect(input.map((i) => i.id)).toEqual(['x', 'y']);
  });
});

describe('formatScoreTeaser', () => {
  it('prints one score line, exactly three numbered findings, and the pointer', () => {
    const out = formatScoreTeaser(
      report([
        issue({ id: '1', confidence: 0.9, severity: 'high' }),
        issue({ id: '2', confidence: 0.8 }),
        issue({ id: '3', confidence: 0.7 }),
        issue({ id: '4', confidence: 0.6 }),
        issue({ id: '5', confidence: 0.5 }),
      ]),
    );
    expect(out.match(/health: /g)).toHaveLength(1);
    expect(out).toContain('PromptCI instruction health: 72/100 (Fair)');
    expect(out).toContain('Top 3 findings by confidence (of 5):');
    expect(out).toContain('1. [high] Title 1 (CLAUDE.md:4)');
    expect(out).toContain('3. [warning] Title 3');
    expect(out).not.toMatch(/^\s+4\. /m);
    expect(out).toContain('Fix: Fix 1');
    expect(out).toContain(DASHBOARD_POINTER);
  });

  it('keeps the dashboard pointer plain: no tracking params, one line', () => {
    expect(DASHBOARD_POINTER).not.toMatch(/[?&](utm_|ref=|source=)/);
    expect(DASHBOARD_POINTER).not.toContain('\n');
    expect(DASHBOARD_POINTER).not.toMatch(/login|sign ?up|upload/i);
  });

  it('handles a clean scan and an empty repo', () => {
    expect(formatScoreTeaser(report([], { healthScore: 100 }))).toContain('No findings');
    expect(formatScoreTeaser(report([], { filesScanned: [] }))).toContain('nothing to score');
  });

  it('strips terminal control characters from scanned text and truncates long fixes', () => {
    const out = formatScoreTeaser(
      report([issue({ id: 'z', title: 'Bad\u001b[31m title', recommendation: 'x'.repeat(500) })]),
    );
    expect(out).not.toContain('\u001b');
    const fixLine = out.split('\n').find((l) => l.includes('Fix: '))!;
    expect(fixLine.length).toBeLessThan(200);
    expect(fixLine.endsWith('…')).toBe(true);
  });
});

describe('runScore (in-process): no network, no writes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('prints the teaser without touching the network or the scanned directory', async () => {
    const dir = copyFixture(CONFLICTS_FIXTURE);
    const before = snapshot(dir);

    const boom = (what: string) => () => {
      throw new Error(`network access attempted: ${what}`);
    };
    vi.stubGlobal('fetch', boom('fetch'));
    const spies = [
      vi.spyOn(http, 'request').mockImplementation(boom('http.request')),
      vi.spyOn(http, 'get').mockImplementation(boom('http.get')),
      vi.spyOn(https, 'request').mockImplementation(boom('https.request')),
      vi.spyOn(https, 'get').mockImplementation(boom('https.get')),
      vi.spyOn(net, 'connect').mockImplementation(boom('net.connect')),
      vi.spyOn(net, 'createConnection').mockImplementation(boom('net.createConnection')),
    ];
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    try {
      await runScore({ scanPath: dir });
      const printed = write.mock.calls.map((c) => String(c[0])).join('');
      expect(printed).toMatch(/instruction health: \d+\/100/);
      expect(printed).toContain('Top 3 findings');
      spies.forEach((s) => expect(s).not.toHaveBeenCalled());
      expect(snapshot(dir)).toEqual(before);
    } finally {
      write.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The in-process test cannot see fs writes made through Node's ESM facades, so
// the authoritative check runs the compiled binary under a preload that
// patches the real fs/net/http/dns/fetch entry points and reports any call.
// It also fakes a TTY and an empty HOME so the once-a-day npm probe WOULD fire
// if `score` did not opt out, and uses `scan` as a positive control.
const GUARD_SOURCE = `
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const dns = require('node:dns');
const report = (what) => {
  process.stderr.write('GUARD VIOLATION: ' + what + '\\n');
  throw new Error('GUARD VIOLATION: ' + what);
};
const block = (obj, names, label) => {
  for (const n of names) {
    if (typeof obj[n] === 'function') obj[n] = () => report(label + '.' + n);
  }
};
const WRITES = ['writeFile', 'appendFile', 'mkdir', 'rename', 'copyFile', 'cp', 'rm', 'rmdir', 'unlink', 'truncate', 'symlink', 'link'];
block(fs, [...WRITES, ...WRITES.map((n) => n + 'Sync'), 'createWriteStream', 'writeSync', 'mkdtemp', 'mkdtempSync'], 'fs');
block(fs.promises, [...WRITES, 'mkdtemp'], 'fs.promises');
const realOpen = fs.promises.open;
fs.promises.open = (p, flags, ...r) => (flags && /[wa+]/.test(String(flags)) ? report('fs.promises.open ' + flags) : realOpen(p, flags, ...r));
block(http, ['request', 'get'], 'http');
block(https, ['request', 'get'], 'https');
block(net, ['connect', 'createConnection'], 'net');
block(dns, ['lookup', 'resolve'], 'dns');
block(dns.promises, ['lookup', 'resolve'], 'dns.promises');
globalThis.fetch = () => report('fetch');
process.stdout.isTTY = true;
process.stderr.isTTY = true;
`;

describe('promptci score (compiled binary): zero network, zero writes', () => {
  let scratch: string;
  let guardPath: string;
  let home: string;

  beforeAll(() => {
    if (!fs.existsSync(CLI_PATH)) {
      execSync('pnpm --filter @promptci/core build && pnpm --filter @promptci/cli build', {
        cwd: PROJECT_ROOT,
        stdio: 'pipe',
      });
    }
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-guard-'));
    guardPath = path.join(scratch, 'offline-guard.cjs');
    fs.writeFileSync(guardPath, GUARD_SOURCE);
    home = path.join(scratch, 'home');
    fs.mkdirSync(home);
    return () => fs.rmSync(scratch, { recursive: true, force: true });
  });

  function run(args: string[], cwd: string) {
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.CI;
    delete env.NO_UPDATE_NOTIFIER;
    delete env.PROMPTCI_NO_UPDATE_NOTIFIER;
    const r = spawnSync('node', ['--require', guardPath, CLI_PATH, ...args], {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  it('bare invocation prints the score and 3 findings, exits 0, touches nothing', () => {
    const dir = copyFixture(CONFLICTS_FIXTURE);
    try {
      const before = snapshot(dir);
      const { status, stdout, stderr } = run([], dir);
      expect(stderr).not.toContain('GUARD VIOLATION');
      expect(status).toBe(0);
      expect(stdout).toMatch(/^PromptCI instruction health: \d+\/100 \(.+\)$/m);
      expect(stdout).toContain('Top 3 findings by confidence (of ');
      expect(stdout.match(/^ {2}\d\. \[/gm)).toHaveLength(3);
      expect(stdout).toContain(DASHBOARD_POINTER);
      expect(snapshot(dir)).toEqual(before);
      expect(fs.existsSync(path.join(dir, '.promptci'))).toBe(false);
      expect(fs.readdirSync(home)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('`score --path` behaves the same and gives the same score as `scan`', () => {
    const dir = copyFixture(CONFLICTS_FIXTURE);
    try {
      const teaser = run(['score', '--path', dir], PROJECT_ROOT);
      expect(teaser.stderr).not.toContain('GUARD VIOLATION');
      expect(teaser.status).toBe(0);
      const score = /(\d+)\/100/.exec(teaser.stdout)![1];
      const json = spawnSync('node', [CLI_PATH, 'scan', '--path', dir, '--json'], {
        encoding: 'utf8',
        env: { ...process.env, CI: '1' },
      });
      expect((JSON.parse(json.stdout) as { healthScore: number }).healthScore).toBe(Number(score));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 0 with a clear message when there are no instruction files', () => {
    const { status, stdout, stderr } = run(['score', '--path', EMPTY_FIXTURE], PROJECT_ROOT);
    expect(stderr).not.toContain('GUARD VIOLATION');
    expect(status).toBe(0);
    expect(stdout).toContain('nothing to score');
  });

  it('exits 1 for a path that does not exist', () => {
    const { status, stderr } = run(['score', '--path', path.join(scratch, 'nope')], PROJECT_ROOT);
    expect(status).toBe(1);
    expect(stderr).toContain('path does not exist');
  });

  it('positive control: the guard does trip on `scan` (report writes + update probe)', () => {
    const dir = copyFixture(CLEAN_FIXTURE);
    try {
      const { stderr } = run(['scan', '--path', dir], PROJECT_ROOT);
      expect(stderr).toContain('GUARD VIOLATION');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
