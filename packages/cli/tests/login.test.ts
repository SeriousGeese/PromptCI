import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runLogin } from '../src/commands/login.js';
import * as config from '../src/config.js';
import * as globalConfig from '../src/global-config.js';
import * as authConfig from '../src/auth-config.js';
import { exec } from 'node:child_process';

vi.mock('../src/config.js');
vi.mock('../src/global-config.js');
vi.mock('../src/auth-config.js');
vi.mock('node:child_process');

vi.mock('node:util', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    promisify: (fn: unknown) => {
      if (fn && typeof fn === 'function' && fn.name === 'exec') {
        return (cmd: string) => {
          return new Promise((resolve, reject) => {
            (fn as (cmd: string, cb: (err: Error | null, stdout: string, stderr: string) => void) => void)(
              cmd,
              (err: Error | null, stdout: string, stderr: string) => {
                if (err) reject(err);
                else resolve({ stdout, stderr });
              }
            );
          });
        };
      }
      return (original.promisify as (fn: unknown) => unknown)(fn);
    }
  };
});

function mockExecSuccess() {
  vi.mocked(exec).mockImplementation(((cmd: string, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    cb(null, '', '');
    return {} as unknown as ReturnType<typeof exec>;
  }) as unknown as typeof exec);
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

describe('runLogin', () => {
  let mockConsoleLog: ReturnType<typeof vi.spyOn>;
  let mockConsoleError: ReturnType<typeof vi.spyOn>;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(config.loadConfig).mockResolvedValue({});
    // A URL must be configured somewhere — there is no built-in default any
    // more (BUG-4). These tests stand in for a self-hosted dashboard.
    vi.mocked(globalConfig.readGlobalConfig).mockResolvedValue({ apiUrl: 'http://localhost:3000' });
    vi.mocked(globalConfig.writeGlobalConfig).mockResolvedValue(undefined as unknown as void);
    vi.mocked(authConfig.writeAuthConfig).mockResolvedValue(undefined);
    vi.mocked(authConfig.getJwtExpiry).mockReturnValue(null);
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    mockExecSuccess();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('starts a device login, shows the code and verify URL, then completes on authorization', async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({ deviceCode: 'secret-device-code', userCode: 'WQ3K-7XPT', expiresIn: 600, interval: 2 }),
      )
      .mockResolvedValueOnce(jsonResponse({ error: 'authorization_pending' }, false, 400))
      .mockResolvedValueOnce(jsonResponse({ accessToken: 'eyAccessToken', refreshToken: 'refresh123' }));

    const promise = runLogin({});

    // init call resolves as a microtask before the first sleep()
    await vi.advanceTimersByTimeAsync(0);
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining('WQ3K-7XPT'),
    );
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining('URL: http://localhost:3000/auth/device?user_code=WQ3K-7XPT'),
    );

    // first poll -> authorization_pending, keep polling
    await vi.advanceTimersByTimeAsync(2000);
    // second poll -> success
    await vi.advanceTimersByTimeAsync(2000);

    await promise;

    expect(mockFetch).toHaveBeenNthCalledWith(1, 'http://localhost:3000/api/cli/device/init', { method: 'POST' });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/cli/device/token',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ deviceCode: 'secret-device-code' }),
      }),
    );
    expect(authConfig.writeAuthConfig).toHaveBeenCalledWith(
      expect.objectContaining({ access_token: 'eyAccessToken', refresh_token: 'refresh123' }),
    );
    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('Logged in'));
  });

  it('respects the --url option and persists it in global config', async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({ deviceCode: 'secret-device-code', userCode: 'AAAA-BBBB', expiresIn: 600, interval: 2 }),
      )
      .mockResolvedValueOnce(jsonResponse({ accessToken: 'eyAccessToken', refreshToken: 'refresh123' }));

    const promise = runLogin({ url: 'https://promptci.dev/' });
    await vi.advanceTimersByTimeAsync(0);

    expect(globalConfig.writeGlobalConfig).toHaveBeenCalledWith(
      expect.objectContaining({ apiUrl: 'https://promptci.dev' }),
    );
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining('URL: https://promptci.dev/auth/device?user_code=AAAA-BBBB'),
    );

    await vi.advanceTimersByTimeAsync(2000);
    await promise;
  });

  it('respects process.env.PROMPTCI_API_URL', async () => {
    process.env.PROMPTCI_API_URL = 'https://env.promptci.dev';
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({ deviceCode: 'secret-device-code', userCode: 'CCCC-DDDD', expiresIn: 600, interval: 2 }),
      )
      .mockResolvedValueOnce(jsonResponse({ accessToken: 'eyAccessToken', refreshToken: 'refresh123' }));

    try {
      const promise = runLogin({});
      await vi.advanceTimersByTimeAsync(0);
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining('URL: https://env.promptci.dev/auth/device?user_code=CCCC-DDDD'),
      );
      await vi.advanceTimersByTimeAsync(2000);
      await promise;
    } finally {
      delete process.env.PROMPTCI_API_URL;
    }
  });

  it('handles browser open failures gracefully', async () => {
    vi.mocked(exec).mockImplementation(((cmd: string, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      cb(new Error('xdg-open failed'), '', '');
      return {} as unknown as ReturnType<typeof exec>;
    }) as unknown as typeof exec);
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({ deviceCode: 'secret-device-code', userCode: 'EEEE-FFFF', expiresIn: 600, interval: 2 }),
      )
      .mockResolvedValueOnce(jsonResponse({ accessToken: 'eyAccessToken', refreshToken: 'refresh123' }));

    const promise = runLogin({});
    await vi.advanceTimersByTimeAsync(0);

    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining('Could not open a browser automatically'),
    );

    await vi.advanceTimersByTimeAsync(2000);
    await promise;
  });

  // BUG-4: login used to fall back to http://localhost:3000, so a user who
  // installed the CLI from npm got connection-refused against their own machine.
  it('exits with an error when no dashboard URL is configured anywhere', async () => {
    vi.mocked(globalConfig.readGlobalConfig).mockResolvedValue({});

    await runLogin({});

    expect(process.exitCode).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('no dashboard URL configured'),
    );
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('PROMPTCI_API_URL'));
    process.exitCode = 0;
  });

  it('rejects a --url that is not an absolute http(s) URL', async () => {
    await runLogin({ url: 'promptci.dev' });

    expect(process.exitCode).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('Invalid dashboard URL'));
    process.exitCode = 0;
  });

  it('reads apiUrl from the project config when no flag or env is set', async () => {
    vi.mocked(globalConfig.readGlobalConfig).mockResolvedValue({});
    vi.mocked(config.loadConfig).mockResolvedValue({ apiUrl: 'https://project.promptci.test' });
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({ deviceCode: 'secret-device-code', userCode: 'IIII-JJJJ', expiresIn: 600, interval: 2 }),
      )
      .mockResolvedValueOnce(jsonResponse({ accessToken: 'eyAccessToken', refreshToken: 'refresh123' }));

    const promise = runLogin({});
    await vi.advanceTimersByTimeAsync(0);

    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      'https://project.promptci.test/api/cli/device/init',
      { method: 'POST' },
    );

    await vi.advanceTimersByTimeAsync(2000);
    await promise;
  });

  it('exits with an error if the init request fails', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, false, 500));

    await runLogin({});

    expect(process.exitCode).toBe(1);
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('could not start login'));
    process.exitCode = 0;
  });

  it('exits with an error when the token endpoint reports access_denied', async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({ deviceCode: 'secret-device-code', userCode: 'GGGG-HHHH', expiresIn: 600, interval: 2 }),
      )
      .mockResolvedValueOnce(jsonResponse({ error: 'access_denied' }, false, 400));

    const promise = runLogin({});
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(process.exitCode).toBe(1);
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('access_denied'));
    process.exitCode = 0;
  });
});
