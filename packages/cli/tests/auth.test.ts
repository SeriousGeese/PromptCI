import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runAuth } from '../src/commands/auth.js';
import type { AuthSubcommand } from '../src/commands/auth.js';
import * as authConfig from '../src/auth-config.js';

vi.mock('../src/auth-config.js');

describe('runAuth', () => {
  let exitCode: number | undefined;
  let stdoutOutput: string;
  let stderrOutput: string;

  beforeEach(() => {
    exitCode = undefined;
    stdoutOutput = '';
    stderrOutput = '';

    vi.spyOn(process, 'exit').mockImplementation((code?: number | string) => {
      exitCode = typeof code === 'number' ? code : 0;
      throw new Error(`process.exit(${code})`);
    });

    vi.spyOn(console, 'log').mockImplementation((...msg) => {
      stdoutOutput += msg.join(' ') + '\n';
    });

    vi.spyOn(console, 'error').mockImplementation((...msg) => {
      stderrOutput += msg.join(' ') + '\n';
    });

    vi.spyOn(console, 'warn').mockImplementation((...msg) => {
      stderrOutput += msg.join(' ') + '\n';
    });

    vi.mocked(authConfig.writeAuthConfig).mockResolvedValue(undefined);
    vi.mocked(authConfig.getJwtExpiry).mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('set-token subcommand', () => {
    it('stores a legacy JWT token via writeAuthConfig', async () => {
      // 'ey...' is not valid base64-JSON, so it goes through the legacy JWT path
      await runAuth('set-token', ['eySampleToken']);

      expect(authConfig.writeAuthConfig).toHaveBeenCalledWith(
        expect.objectContaining({ access_token: 'eySampleToken' }),
      );
      expect(stdoutOutput).toContain('Token stored');
    });

    it('warns and stores when token does not look like a valid token', async () => {
      await runAuth('set-token', ['invalidToken']);

      expect(authConfig.writeAuthConfig).toHaveBeenCalledWith(
        expect.objectContaining({ access_token: 'invalidToken' }),
      );
      expect(stderrOutput).toContain('Warning: this does not look like a valid token');
    });

    it('decodes and stores a base64-JSON CLI token', async () => {
      const blob = Buffer.from(
        JSON.stringify({ access_token: 'eyAccessToken', refresh_token: 'refresh123' }),
      ).toString('base64');

      await runAuth('set-token', [blob]);

      expect(authConfig.writeAuthConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          access_token: 'eyAccessToken',
          refresh_token: 'refresh123',
        }),
      );
      expect(stdoutOutput).toContain('Token stored');
    });

    it('fails when token argument is missing', async () => {
      await expect(runAuth('set-token', [])).rejects.toThrow('process.exit(1)');
      expect(exitCode).toBe(1);
      expect(stderrOutput).toContain('Error: token argument is required');
    });
  });

  describe('status subcommand', () => {
    it('shows authenticated status when token is set', async () => {
      vi.mocked(authConfig.readAuthConfig).mockResolvedValue({
        access_token: 'eySampleStoredTokenHere',
      });

      await runAuth('status', []);

      expect(stdoutOutput).toContain('Authenticated — token is set');
      expect(stdoutOutput).toContain('eySampleStoredTokenH');
    });

    it('shows unauthenticated status when no token is set', async () => {
      vi.mocked(authConfig.readAuthConfig).mockResolvedValue({});

      await runAuth('status', []);

      expect(stdoutOutput).toContain('Not authenticated');
    });

    it('shows auto-refresh enabled when refresh_token is present', async () => {
      vi.mocked(authConfig.readAuthConfig).mockResolvedValue({
        access_token: 'eyToken',
        refresh_token: 'refreshToken',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      });

      await runAuth('status', []);

      expect(stdoutOutput).toContain('Auto-refresh: enabled');
    });
  });

  describe('logout subcommand', () => {
    it('clears token successfully', async () => {
      vi.mocked(authConfig.clearAuthToken).mockResolvedValue(undefined);

      await runAuth('logout', []);

      expect(authConfig.clearAuthToken).toHaveBeenCalled();
      expect(stdoutOutput).toContain('Token cleared');
    });
  });

  describe('unknown subcommand', () => {
    it('fails with process.exit(1)', async () => {
      await expect(runAuth('unknown' as unknown as AuthSubcommand, [])).rejects.toThrow('process.exit(1)');
      expect(exitCode).toBe(1);
      expect(stderrOutput).toContain('Unknown auth subcommand');
    });
  });
});
