import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock ensure-fresh-token before importing upload so the ESM mock is hoisted
vi.mock('../src/lib/ensure-fresh-token.js', () => ({
  ensureFreshToken: vi.fn(async () => 'test-jwt-token'),
}));

import { runUpload } from '../src/commands/upload.js';
import * as freshToken from '../src/lib/ensure-fresh-token.js';
import * as globalConfig from '../src/global-config.js';

// Isolate from the developer's real ~/.promptci/global.json, which would
// otherwise supply an apiUrl and mask the "no URL configured" path.
vi.mock('../src/global-config.js');

const SAMPLE_REPORT = {
  schemaVersion: '0.1',
  generatedAt: '2024-01-01T00:00:00.000Z',
  repoPath: '/repos/TestRepo',
  projectType: 'typescript',
  healthScore: 85,
  filesScanned: [
    { path: 'CLAUDE.md', fileType: 'claude', content: '# test', sections: [], lineCount: 1, charCount: 6, estimatedTokens: 2 },
  ],
  issues: [],
  topFixes: [],
};

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'promptci-upload-test-'));
}

async function writeReport(dir: string, data: unknown) {
  await fs.mkdir(path.join(dir, '.promptci'), { recursive: true });
  await fs.writeFile(
    path.join(dir, '.promptci', 'report.json'),
    JSON.stringify(data),
    'utf-8',
  );
}

describe('runUpload', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    vi.spyOn(process, 'exit').mockImplementation((code?: number | string) => {
      throw new Error(`process.exit(${code ?? 0})`);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Reset to default: authenticated with a valid token
    vi.mocked(freshToken.ensureFreshToken).mockResolvedValue('test-jwt-token');
    vi.mocked(globalConfig.readGlobalConfig).mockResolvedValue({});
    vi.mocked(globalConfig.writeGlobalConfig).mockResolvedValue(undefined as unknown as void);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.PROMPTCI_API_URL;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('exits 1 when report.json does not exist', async () => {
    await expect(runUpload({ uploadPath: tmpDir })).rejects.toThrow('process.exit(1)');
    const [msg] = vi.mocked(console.error).mock.calls[0] as [string];
    expect(msg).toMatch(/no report found/i);
  });

  it('exits 1 when report.json contains invalid JSON', async () => {
    await fs.mkdir(path.join(tmpDir, '.promptci'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.promptci', 'report.json'), 'not json', 'utf-8');
    await expect(runUpload({ uploadPath: tmpDir })).rejects.toThrow('process.exit(1)');
  });

  it('uploads successfully and prints the report URL', async () => {
    await writeReport(tmpDir, SAMPLE_REPORT);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ scanId: 'abc-123', url: 'http://localhost:3000/scans/abc-123' }),
      }),
    );

    await runUpload({ uploadPath: tmpDir, url: 'http://localhost:3000' });

    const logs = vi.mocked(console.log).mock.calls.flat().join(' ');
    expect(logs).toContain('abc-123');
    expect(logs).toContain('/scans/');
  });

  it('POSTs to /api/upload on the configured host', async () => {
    await writeReport(tmpDir, SAMPLE_REPORT);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ scanId: 'x', url: 'http://custom:4000/scans/x' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await runUpload({ uploadPath: tmpDir, url: 'http://custom:4000' });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://custom:4000/api/upload',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('includes Authorization Bearer header', async () => {
    await writeReport(tmpDir, SAMPLE_REPORT);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ scanId: 'x', url: 'http://localhost:3000/scans/x' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await runUpload({ uploadPath: tmpDir, url: 'http://localhost:3000' });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-jwt-token',
        }),
      }),
    );
  });

  it('uses PROMPTCI_API_URL env var when no --url flag is given', async () => {
    await writeReport(tmpDir, SAMPLE_REPORT);
    process.env.PROMPTCI_API_URL = 'http://env-server:9000';
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ scanId: 'y', url: 'http://env-server:9000/scans/y' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await runUpload({ uploadPath: tmpDir });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://env-server:9000/api/upload',
      expect.anything(),
    );
  });

  // BUG-4: upload used to fall back to http://localhost:3000, so a user with no
  // dashboard silently POSTed at their own machine and got connection-refused.
  it('exits 1 when no dashboard URL is configured anywhere', async () => {
    await writeReport(tmpDir, SAMPLE_REPORT);
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    await expect(runUpload({ uploadPath: tmpDir })).rejects.toThrow('process.exit(1)');

    expect(mockFetch).not.toHaveBeenCalled();
    const errMsg = vi.mocked(console.error).mock.calls.flat().join(' ');
    expect(errMsg).toContain('no dashboard URL configured');
    expect(errMsg).toContain('PROMPTCI_API_URL');
  });

  it('exits 1 when the configured URL is not an absolute http(s) URL', async () => {
    await writeReport(tmpDir, SAMPLE_REPORT);
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    await expect(runUpload({ uploadPath: tmpDir, url: 'not-a-url' })).rejects.toThrow(
      'process.exit(1)',
    );

    expect(mockFetch).not.toHaveBeenCalled();
    const errMsg = vi.mocked(console.error).mock.calls.flat().join(' ');
    expect(errMsg).toContain('Invalid dashboard URL');
  });

  it('reads apiUrl from .promptci/config.json when no flag or env is set', async () => {
    await writeReport(tmpDir, SAMPLE_REPORT);
    await fs.writeFile(
      path.join(tmpDir, '.promptci', 'config.json'),
      JSON.stringify({ apiUrl: 'http://project-server:8080' }),
      'utf-8',
    );
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ scanId: 'p', url: 'http://project-server:8080/scans/p' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await runUpload({ uploadPath: tmpDir });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://project-server:8080/api/upload',
      expect.anything(),
    );
  });

  it('exits 1 on non-200 response', async () => {
    await writeReport(tmpDir, SAMPLE_REPORT);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      }),
    );

    await expect(runUpload({ uploadPath: tmpDir, url: 'http://localhost:3000' })).rejects.toThrow(
      'process.exit(1)',
    );
    const errMsg = vi.mocked(console.error).mock.calls.flat().join(' ');
    expect(errMsg).toMatch(/500/);
  });

  it('exits 1 on network failure', async () => {
    await writeReport(tmpDir, SAMPLE_REPORT);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('ECONNREFUSED')),
    );

    await expect(runUpload({ uploadPath: tmpDir, url: 'http://localhost:3000' })).rejects.toThrow(
      'process.exit(1)',
    );
    const errMsg = vi.mocked(console.error).mock.calls.flat().join(' ');
    expect(errMsg).toContain('ECONNREFUSED');
  });

  it('strips trailing slash from url', async () => {
    await writeReport(tmpDir, SAMPLE_REPORT);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ scanId: 'z', url: 'http://localhost:3000/scans/z' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await runUpload({ uploadPath: tmpDir, url: 'http://localhost:3000/' });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/upload',
      expect.anything(),
    );
  });

  it('exits 1 when not logged in', async () => {
    vi.mocked(freshToken.ensureFreshToken).mockRejectedValueOnce(
      new Error('Not logged in. Run: promptci login'),
    );
    await writeReport(tmpDir, SAMPLE_REPORT);

    await expect(
      runUpload({ uploadPath: tmpDir, url: 'http://localhost:3000' }),
    ).rejects.toThrow('process.exit(1)');
    const errMsg = vi.mocked(console.error).mock.calls.flat().join(' ');
    expect(errMsg).toContain('Not logged in');
  });
});
