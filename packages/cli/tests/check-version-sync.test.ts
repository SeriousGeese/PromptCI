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
import { spawn, spawnSync } from 'node:child_process';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
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

  // pcic-1ik0.19: the 0.4.2 publish run reported FAILED although both packages
  // had published, because the final check waited on the `latest` dist-tag.
  describe('--registry with --tag', () => {
    async function withRegistry(
      exactMissesBeforeServing: number,
      body: (url: string, hits: { exact: number; latest: number }) => Promise<void>,
    ): Promise<void> {
      const hits = { exact: 0, latest: 0 };
      const server = http.createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        if (req.url?.endsWith('/latest')) {
          hits.latest++;
          res.end(JSON.stringify({ version: '1.2.2' })); // the dist-tag has not moved
        } else if (req.url?.endsWith('/1.2.3')) {
          hits.exact++;
          if (hits.exact <= exactMissesBeforeServing * 2) {
            res.statusCode = 404;
            res.end('{}');
          } else {
            res.end(JSON.stringify({ version: '1.2.3' }));
          }
        } else {
          res.statusCode = 404;
          res.end('{}');
        }
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const { port } = server.address() as AddressInfo;
        await body(`http://127.0.0.1:${port}`, hits);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    }

    function runAsync(cwd: string, registry: string, extraEnv: Record<string, string>): Promise<{ status: number; stderr: string }> {
      return new Promise((resolve) => {
        const child = spawn('node', [path.join(cwd, 'scripts', 'check-version-sync.mjs'), '--registry', '--tag', '1.2.3'], {
          env: { ...process.env, PROMPTCI_REGISTRY_URL: registry, PROMPTCI_PROPAGATION_DELAY_MS: '10', ...extraEnv },
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => (stderr += String(chunk)));
        child.on('close', (code) => resolve({ status: code ?? 1, stderr }));
      });
    }

    it('passes once the exact version is served, although the latest dist-tag still lags', async () => {
      const dir = makeWorkspace('1.2.3', '1.2.3');
      await withRegistry(3, async (url, hits) => {
        const result = await runAsync(dir, url, { PROMPTCI_PROPAGATION_ATTEMPTS: '10' });
        expect(result.stderr).toContain('npm agrees at 1.2.3');
        expect(result.status).toBe(0);
        expect(hits.latest).toBe(0);
      });
    });

    it('fails when the exact version never appears', async () => {
      const dir = makeWorkspace('1.2.3', '1.2.3');
      await withRegistry(1000, async (url) => {
        const result = await runAsync(dir, url, { PROMPTCI_PROPAGATION_ATTEMPTS: '3' });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('after 3 attempts');
      });
    });
  });

  it('checks the real repo (packages/cli and packages/core currently agree)', () => {
    const result = run(REPO_ROOT);
    expect(result.status).toBe(0);
  });
});
