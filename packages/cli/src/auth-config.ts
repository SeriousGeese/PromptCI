/**
 * Global auth token store for the PromptCI CLI.
 *
 * Tokens are stored in ~/.promptci/auth.json (outside any repo's .promptci/ dir)
 * so the credential doesn't accidentally get committed.
 *
 * Security: the file is chmod 600 on creation so only the owning user can read it
 * (POSIX). On Windows, chmod is a no-op, so we additionally strip inherited ACL
 * entries and grant access only to the current user via `icacls` (best-effort,
 * same as the POSIX chmod call — failures are swallowed rather than fatal).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const AUTH_DIR = path.join(os.homedir(), '.promptci');
const AUTH_FILE = path.join(AUTH_DIR, 'auth.json');

export type AuthConfig = {
  access_token?: string;
  refresh_token?: string;
  /** Unix timestamp (seconds) when the access_token expires. */
  expires_at?: number;
};

export async function readAuthConfig(): Promise<AuthConfig> {
  try {
    const raw = await fs.readFile(AUTH_FILE, 'utf-8');
    return JSON.parse(raw) as AuthConfig;
  } catch {
    return {};
  }
}

export async function writeAuthConfig(data: AuthConfig): Promise<void> {
  await fs.mkdir(AUTH_DIR, { recursive: true });
  await fs.writeFile(AUTH_FILE, JSON.stringify(data, null, 2), 'utf-8');
  // Restrict permissions on Unix-like systems (no-op on Windows)
  try {
    await fs.chmod(AUTH_FILE, 0o600);
  } catch {
    // Windows — ignore
  }
  if (process.platform === 'win32') {
    await restrictWindowsAcl(AUTH_FILE);
  }
}

/**
 * Best-effort Windows ACL hardening: chmod 600 is a no-op on Windows, so
 * without this the auth file inherits default ACLs and is readable by any
 * process/user with access to the profile. Strips inherited entries and
 * grants full control only to the current user, mirroring what chmod 600
 * does on POSIX. Failures (e.g. `icacls` unavailable) are swallowed — this
 * is defense-in-depth, not a correctness requirement.
 */
async function restrictWindowsAcl(filePath: string): Promise<void> {
  try {
    const username = os.userInfo().username;
    await execFileAsync('icacls', [
      filePath,
      '/inheritance:r',
      '/grant:r',
      `${username}:F`,
    ]);
  } catch {
    // icacls missing/failed — ignore, same as the chmod no-op above.
  }
}

/** Read the stored access token, or null if not set. */
export async function getAuthToken(): Promise<string | null> {
  const config = await readAuthConfig();
  return config.access_token ?? null;
}

/** Persist a plain access token (legacy — no refresh token). */
export async function setAuthToken(token: string): Promise<void> {
  const existing = await readAuthConfig();
  const expires_at =
    getJwtExpiry(token) ?? Math.floor(Date.now() / 1000) + 3600;
  await writeAuthConfig({ ...existing, access_token: token, expires_at });
}

/** Remove all stored credentials. */
export async function clearAuthToken(): Promise<void> {
  await writeAuthConfig({});
}

/** Parse the `exp` claim from a JWT without verifying signature. */
export function getJwtExpiry(token: string): number | null {
  try {
    const [, payload] = token.split('.');
    if (!payload) return null;
    const decoded = Buffer.from(payload, 'base64url').toString('utf-8');
    const parsed = JSON.parse(decoded) as { exp?: number };
    return typeof parsed.exp === 'number' ? parsed.exp : null;
  } catch {
    return null;
  }
}
