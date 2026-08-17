import { loadConfig } from '../config.js';
import { readGlobalConfig, writeGlobalConfig } from '../global-config.js';
import { writeAuthConfig, getJwtExpiry } from '../auth-config.js';

const DEFAULT_APP_URL = 'http://localhost:3000';
const MIN_POLL_TIMEOUT_MS = 60_000;

type DeviceInitResponse = {
  deviceCode: string;
  userCode: string;
  expiresIn: number;
  interval: number;
};

type DeviceTokenSuccess = {
  accessToken: string;
  refreshToken: string;
};

type DeviceTokenError = {
  error: string;
};

/**
 * Logs in via a device-authorization flow: the CLI asks the server for a
 * secret device code (kept in this process only — never sent to a browser or
 * embedded in a URL) plus a short user code, opens the browser to a consent
 * page bound to that user code, and polls until the user explicitly
 * authorizes it there.
 */
export async function runLogin(options: { url?: string }): Promise<void> {
  let config: { apiUrl?: string } = {};
  try {
    config = await loadConfig(process.cwd());
  } catch {
    config = {};
  }

  const globalConfig = await readGlobalConfig();

  // Priority: --url flag > PROMPTCI_API_URL env > project config > global config > localhost
  const baseUrl = (
    options.url ??
    process.env.PROMPTCI_API_URL ??
    config.apiUrl ??
    globalConfig.apiUrl ??
    DEFAULT_APP_URL
  ).replace(/\/$/, '');

  // Persist an explicitly-provided URL so future commands don't need --url
  if (options.url) {
    await writeGlobalConfig({ ...globalConfig, apiUrl: baseUrl });
  }

  console.log('Starting CLI login...');

  let init: DeviceInitResponse;
  try {
    const res = await fetch(`${baseUrl}/api/cli/device/init`, { method: 'POST' });
    if (!res.ok) {
      console.error(`Error: could not start login (HTTP ${res.status}).`);
      process.exitCode = 1;
      return;
    }
    init = (await res.json()) as DeviceInitResponse;
  } catch (err) {
    console.error(
      `Error: could not reach ${baseUrl}. ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
    return;
  }

  const verifyUrl = `${baseUrl}/auth/device?user_code=${encodeURIComponent(init.userCode)}`;

  console.log(`\nConfirm this code matches what's shown in your browser: ${init.userCode}\n`);
  console.log('Opening your browser to authenticate...');
  console.log(`URL: ${verifyUrl}\n`);

  const opened = await tryOpenBrowser(verifyUrl);
  if (!opened) {
    console.log('Could not open a browser automatically. Open the URL above manually.\n');
  }

  console.log('Waiting for you to authorize this login in the browser...');

  const deadline = Date.now() + Math.max(init.expiresIn * 1000, MIN_POLL_TIMEOUT_MS);
  const intervalMs = Math.max(init.interval, 0) * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/api/cli/device/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceCode: init.deviceCode }),
      });
    } catch {
      continue; // transient network error — keep polling
    }

    if (res.ok) {
      const tokens = (await res.json()) as DeviceTokenSuccess;
      const expires_at =
        getJwtExpiry(tokens.accessToken) ?? Math.floor(Date.now() / 1000) + 3600;
      await writeAuthConfig({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expires_at,
      });
      console.log('\n✓ Logged in and token stored in ~/.promptci/auth.json');
      console.log('You can now run: promptci upload\n');
      return;
    }

    const body = (await res.json().catch(() => ({}))) as Partial<DeviceTokenError>;
    if (body.error === 'authorization_pending') {
      continue;
    }

    console.error(`\nLogin failed: ${body.error ?? `HTTP ${res.status}`}`);
    process.exitCode = 1;
    return;
  }

  console.error('\nLogin timed out waiting for browser authorization. Run `promptci login` again.');
  process.exitCode = 1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryOpenBrowser(url: string): Promise<boolean> {
  const { exec } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execAsync = promisify(exec);

  const platform = process.platform;
  let cmd: string;

  if (platform === 'win32') {
    cmd = `start "" "${url}"`;
  } else if (platform === 'darwin') {
    cmd = `open "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }

  try {
    await execAsync(cmd);
    return true;
  } catch {
    return false;
  }
}
