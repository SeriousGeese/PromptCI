import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isNewer, notifyOnNewVersion } from '../src/commands/version-notice.js';
import * as globalConfig from '../src/global-config.js';

vi.mock('../src/global-config.js');

const DAY_MS = 24 * 60 * 60 * 1000;

describe('isNewer', () => {
  it('compares dotted numeric versions field by field', () => {
    expect(isNewer('1.0.0', '0.9.9')).toBe(true);
    expect(isNewer('0.1.0', '0.0.9')).toBe(true);
    expect(isNewer('0.0.2', '0.0.1')).toBe(true);
    expect(isNewer('0.0.1', '0.0.1')).toBe(false);
    expect(isNewer('0.0.1', '0.0.2')).toBe(false);
    expect(isNewer('1.2.0', '1.10.0')).toBe(false); // numeric, not lexicographic
  });

  it('ignores a leading v and prerelease suffixes', () => {
    expect(isNewer('v1.2.3', '1.2.2')).toBe(true);
    expect(isNewer('1.2.3-beta.1', '1.2.3-beta.0')).toBe(false); // suffix stripped -> equal
  });
});

describe('notifyOnNewVersion', () => {
  let stderrOutput: string;
  const savedEnv: Record<string, string | undefined> = {};
  const savedIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    stderrOutput = '';
    vi.clearAllMocks(); // module mocks retain call history across tests otherwise

    // Force the interactive, non-CI baseline; individual tests flip these back.
    for (const key of ['CI', 'NO_UPDATE_NOTIFIER', 'PROMPTCI_NO_UPDATE_NOTIFIER']) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.stdout.isTTY = true;

    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrOutput += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    });
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000_000_000);

    vi.mocked(globalConfig.readGlobalConfig).mockResolvedValue({});
    vi.mocked(globalConfig.writeGlobalConfig).mockResolvedValue(undefined as unknown as void);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.stdout.isTTY = savedIsTTY;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('prints a notice from cache without hitting the network when the cache is fresh', async () => {
    const now = Date.now();
    vi.mocked(globalConfig.readGlobalConfig).mockResolvedValue({
      updateCheck: { checkedAt: now - 1000, latest: '0.1.0' },
    });
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    await notifyOnNewVersion('0.0.1');

    expect(mockFetch).not.toHaveBeenCalled();
    expect(stderrOutput).toContain('0.0.1 → 0.1.0');
    expect(stderrOutput).toContain('npm install -g @promptci/cli');
  });

  it('probes the registry when the cache is stale and caches the result', async () => {
    const now = Date.now();
    vi.mocked(globalConfig.readGlobalConfig).mockResolvedValue({
      updateCheck: { checkedAt: now - DAY_MS - 1, latest: '0.0.1' },
    });
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: '0.2.0' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await notifyOnNewVersion('0.0.1');

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(globalConfig.writeGlobalConfig).toHaveBeenCalledWith(
      expect.objectContaining({ updateCheck: { checkedAt: now, latest: '0.2.0' } }),
    );
    expect(stderrOutput).toContain('0.0.1 → 0.2.0');
  });

  it('records the probe attempt even when the fetch fails, and stays silent', async () => {
    const now = Date.now();
    const mockFetch = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', mockFetch);

    await notifyOnNewVersion('0.0.1');

    // checkedAt is advanced so we don't re-probe every invocation; latest falls
    // back to the current version since nothing better is known.
    expect(globalConfig.writeGlobalConfig).toHaveBeenCalledWith(
      expect.objectContaining({ updateCheck: { checkedAt: now, latest: '0.0.1' } }),
    );
    expect(stderrOutput).toBe('');
  });

  it('says nothing when the running version is already current', async () => {
    const now = Date.now();
    vi.mocked(globalConfig.readGlobalConfig).mockResolvedValue({
      updateCheck: { checkedAt: now - 1000, latest: '0.0.1' },
    });
    vi.stubGlobal('fetch', vi.fn());

    await notifyOnNewVersion('0.0.1');

    expect(stderrOutput).toBe('');
  });

  it('is suppressed in CI without reading config or the network', async () => {
    process.env.CI = 'true';
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    await notifyOnNewVersion('0.0.1');

    expect(globalConfig.readGlobalConfig).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(stderrOutput).toBe('');
  });

  it('is suppressed when stdout is not a TTY (piped/redirected)', async () => {
    process.stdout.isTTY = false;
    vi.mocked(globalConfig.readGlobalConfig).mockResolvedValue({
      updateCheck: { checkedAt: Date.now() - 1000, latest: '9.9.9' },
    });

    await notifyOnNewVersion('0.0.1');

    expect(stderrOutput).toBe('');
  });

  it('is suppressed when NO_UPDATE_NOTIFIER is set', async () => {
    process.env.NO_UPDATE_NOTIFIER = '1';
    vi.mocked(globalConfig.readGlobalConfig).mockResolvedValue({
      updateCheck: { checkedAt: Date.now() - 1000, latest: '9.9.9' },
    });

    await notifyOnNewVersion('0.0.1');

    expect(stderrOutput).toBe('');
  });
});
