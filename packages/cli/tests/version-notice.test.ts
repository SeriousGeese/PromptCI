import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isNewer, getNewVersionNotice } from '../src/commands/version-notice.js';
import * as fs from 'node:fs/promises';

vi.mock('node:fs/promises');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_000_000_000_000;

/** Make readFile serve the given update-check cache object. */
function mockCache(cache: unknown): void {
  vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(cache));
}

describe('isNewer', () => {
  it('compares dotted numeric versions field by field', () => {
    expect(isNewer('1.0.0', '0.9.9')).toBe(true);
    expect(isNewer('0.1.0', '0.0.9')).toBe(true);
    expect(isNewer('0.0.2', '0.0.1')).toBe(true);
    expect(isNewer('0.0.1', '0.0.1')).toBe(false);
    expect(isNewer('0.0.1', '0.0.2')).toBe(false);
    expect(isNewer('1.2.0', '1.10.0')).toBe(false); // numeric, not lexicographic
    expect(isNewer('1.2.3.5', '1.2.3.4')).toBe(true); // fields beyond the third still compared
  });

  it('ignores a leading v', () => {
    expect(isNewer('v1.2.3', '1.2.2')).toBe(true);
  });

  it('treats a stable release as newer than its own prerelease', () => {
    expect(isNewer('0.2.0', '0.2.0-beta.1')).toBe(true); // semver: 0.2.0-beta.1 < 0.2.0
    expect(isNewer('0.2.0-beta.1', '0.2.0')).toBe(false);
    expect(isNewer('1.2.3-beta.1', '1.2.3-beta.0')).toBe(false); // prerelease ordering not attempted
  });
});

describe('getNewVersionNotice', () => {
  beforeEach(() => {
    vi.clearAllMocks(); // module mocks retain call history across tests otherwise

    // Force the interactive, non-CI baseline; individual tests flip these back.
    vi.stubEnv('CI', undefined);
    vi.stubEnv('NO_UPDATE_NOTIFIER', undefined);
    vi.stubEnv('PROMPTCI_NO_UPDATE_NOTIFIER', undefined);
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });

    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    vi.mocked(fs.readFile).mockRejectedValue(new Error('no cache file'));
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns the notice from cache without hitting the network when the cache is fresh', async () => {
    mockCache({ checkedAt: NOW - 1000, latest: '0.1.0' });
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const message = await getNewVersionNotice('0.0.1');

    expect(mockFetch).not.toHaveBeenCalled();
    expect(message).toContain('0.0.1 → 0.1.0');
    expect(message).toContain('npm install -g @promptci/cli');
  });

  it('probes the registry when the cache is stale and caches the result', async () => {
    mockCache({ checkedAt: NOW - DAY_MS - 1, latest: '0.0.1' });
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: '0.2.0' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const message = await getNewVersionNotice('0.0.1');

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(vi.mocked(fs.writeFile).mock.calls[0]?.[1]).toBe(
      JSON.stringify({ checkedAt: NOW, latest: '0.2.0' }, null, 2),
    );
    expect(message).toContain('0.0.1 → 0.2.0');
  });

  it('sends no Accept header to the registry (the /latest endpoint 406s on the packument media type)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: '0.2.0' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await getNewVersionNotice('0.0.1');

    const [url, init] = mockFetch.mock.calls[0] as [string, { headers?: unknown }];
    expect(url).toBe('https://registry.npmjs.org/@promptci/cli/latest');
    expect(init.headers).toBeUndefined();
  });

  it('records a failed probe without fabricating a latest version, and stays silent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    const message = await getNewVersionNotice('0.0.1');

    // checkedAt advances so a flaky registry is not re-probed every run, but
    // no `latest` is invented — the cache only ever holds real registry data.
    expect(vi.mocked(fs.writeFile).mock.calls[0]?.[1]).toBe(
      JSON.stringify({ checkedAt: NOW }, null, 2),
    );
    expect(message).toBeNull();
  });

  it('keeps the last-seen version when a later probe fails', async () => {
    mockCache({ checkedAt: NOW - DAY_MS - 1, latest: '0.3.0' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));

    const message = await getNewVersionNotice('0.0.1');

    expect(vi.mocked(fs.writeFile).mock.calls[0]?.[1]).toBe(
      JSON.stringify({ checkedAt: NOW, latest: '0.3.0' }, null, 2),
    );
    expect(message).toContain('0.0.1 → 0.3.0');
  });

  it('treats a corrupt or hand-edited cache as missing and re-probes', async () => {
    mockCache({ checkedAt: 'not-a-number', latest: '9.9.9' });
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: '0.2.0' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const message = await getNewVersionNotice('0.0.1');

    expect(mockFetch).toHaveBeenCalledOnce(); // NaN staleness math would have skipped the probe forever
    expect(message).toContain('0.0.1 → 0.2.0');
  });

  it('treats a future checkedAt (clock skew / edit) as stale rather than suppressing forever', async () => {
    mockCache({ checkedAt: NOW + DAY_MS * 365, latest: '9.9.9' });
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: '0.0.1' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await getNewVersionNotice('0.0.1');

    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('returns null when the running version is already current', async () => {
    mockCache({ checkedAt: NOW - 1000, latest: '0.0.1' });
    vi.stubGlobal('fetch', vi.fn());

    expect(await getNewVersionNotice('0.0.1')).toBeNull();
  });

  it('is suppressed in CI without touching the cache or the network', async () => {
    vi.stubEnv('CI', 'true');
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    expect(await getNewVersionNotice('0.0.1')).toBeNull();
    expect(fs.readFile).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('is suppressed when stdout is not a TTY (piped output)', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
    mockCache({ checkedAt: NOW - 1000, latest: '9.9.9' });

    expect(await getNewVersionNotice('0.0.1')).toBeNull();
  });

  it('is suppressed when stderr is not a TTY (2>captured.log)', async () => {
    Object.defineProperty(process.stderr, 'isTTY', { value: undefined, configurable: true });
    mockCache({ checkedAt: NOW - 1000, latest: '9.9.9' });

    expect(await getNewVersionNotice('0.0.1')).toBeNull();
  });

  it('is suppressed when NO_UPDATE_NOTIFIER is set', async () => {
    vi.stubEnv('NO_UPDATE_NOTIFIER', '1');
    mockCache({ checkedAt: NOW - 1000, latest: '9.9.9' });

    expect(await getNewVersionNotice('0.0.1')).toBeNull();
  });

  it('never rejects, even when the cache write fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: '0.2.0' }),
    }));
    vi.mocked(fs.writeFile).mockRejectedValue(new Error('EACCES'));

    await expect(getNewVersionNotice('0.0.1')).resolves.toBeNull();
  });
});
