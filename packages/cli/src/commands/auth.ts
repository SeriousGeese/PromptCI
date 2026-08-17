import {
  clearAuthToken,
  writeAuthConfig,
  readAuthConfig,
  getJwtExpiry,
} from '../auth-config.js';

export type AuthSubcommand = 'set-token' | 'status' | 'logout';

/**
 * `promptci auth set-token <token>` — store the CLI token (new base64-JSON or legacy JWT)
 * `promptci auth status`             — show current auth state
 * `promptci auth logout`             — clear stored token
 */
export async function runAuth(
  sub: AuthSubcommand,
  args: string[],
): Promise<void> {
  switch (sub) {
    case 'set-token': {
      const value = args[0];
      if (!value) {
        console.error('Error: token argument is required.');
        console.error('Usage: promptci auth set-token <token>');
        process.exit(1);
      }

      const decoded = tryDecodeCliToken(value);
      if (decoded) {
        // New format: base64-encoded JSON blob with access_token + refresh_token
        const expires_at =
          getJwtExpiry(decoded.access_token) ??
          Math.floor(Date.now() / 1000) + 3600;
        await writeAuthConfig({
          access_token: decoded.access_token,
          refresh_token: decoded.refresh_token,
          expires_at,
        });
        console.log('✓ Token stored in ~/.promptci/auth.json');
        console.log('You can now run: promptci upload');
      } else if (value.startsWith('ey')) {
        // Legacy plain JWT
        const expires_at =
          getJwtExpiry(value) ?? Math.floor(Date.now() / 1000) + 3600;
        await writeAuthConfig({ access_token: value, expires_at });
        console.log('✓ Token stored in ~/.promptci/auth.json');
        console.log(
          'Note: this token expires in ~1 hour. Run `promptci login` again once it expires.',
        );
        console.log('You can now run: promptci upload');
      } else {
        console.warn(
          'Warning: this does not look like a valid token. Make sure you copied the full token.',
        );
        await writeAuthConfig({ access_token: value });
        console.log('✓ Token stored in ~/.promptci/auth.json');
        console.log('You can now run: promptci upload');
      }
      break;
    }

    case 'status': {
      const config = await readAuthConfig();
      const token = config.access_token;
      if (token) {
        console.log('✓ Authenticated — token is set.');
        console.log(`  Token starts with: ${token.slice(0, 20)}...`);
        if (config.refresh_token) {
          console.log('  Auto-refresh: enabled (does not expire)');
        } else if (config.expires_at) {
          const expiresIn = config.expires_at - Math.floor(Date.now() / 1000);
          if (expiresIn > 0) {
            console.log(`  Expires in: ${Math.round(expiresIn / 60)} minutes`);
          } else {
            console.log('  Token has expired. Run: promptci login');
          }
        }
      } else {
        console.log('✗ Not authenticated.');
        console.log('  Run: promptci login');
      }
      break;
    }

    case 'logout': {
      await clearAuthToken();
      console.log('✓ Token cleared. You are now signed out.');
      break;
    }

    default: {
      console.error(`Unknown auth subcommand: ${sub as string}`);
      console.error('Available: set-token, status, logout');
      process.exit(1);
    }
  }
}

/** Try to decode a base64-encoded JSON CLI token. Returns null if not that format. */
function tryDecodeCliToken(
  value: string,
): { access_token: string; refresh_token: string } | null {
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf-8');
    const parsed = JSON.parse(decoded) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>)['access_token'] === 'string' &&
      typeof (parsed as Record<string, unknown>)['refresh_token'] === 'string'
    ) {
      return parsed as { access_token: string; refresh_token: string };
    }
  } catch {
    // not base64 JSON — fall through
  }
  return null;
}

