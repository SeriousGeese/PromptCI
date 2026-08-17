import { readAuthConfig, writeAuthConfig } from '../auth-config.js';
import { SUPABASE_URL } from '../constants.js';

type RefreshResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
};

/**
 * Returns a valid access token, transparently refreshing it if it expires
 * within the next 5 minutes. Throws if the user is not logged in or the
 * session cannot be recovered.
 */
export async function ensureFreshToken(): Promise<string> {
  const config = await readAuthConfig();

  if (!config.access_token) {
    throw new Error('Not logged in. Run: promptci login');
  }

  const fiveMinutesFromNow = Math.floor(Date.now() / 1000) + 5 * 60;
  const expiresAt = config.expires_at ?? 0;

  // Token is still fresh enough
  if (expiresAt > fiveMinutesFromNow) {
    return config.access_token;
  }

  if (!config.refresh_token) {
    throw new Error('Session expired. Run: promptci login');
  }

  const supabaseUrl = resolveSupabaseUrl(config.access_token);
  const endpoint = `${supabaseUrl}/auth/v1/token?grant_type=refresh_token`;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: config.refresh_token }),
    });
  } catch {
    throw new Error('Session expired. Run: promptci login');
  }

  if (!response.ok) {
    throw new Error('Session expired. Run: promptci login');
  }

  const data = (await response.json()) as RefreshResponse;

  const newExpiresAt = Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600);
  await writeAuthConfig({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: newExpiresAt,
  });

  return data.access_token;
}

/**
 * Determine the Supabase project URL from:
 * 1. SUPABASE_URL build constant / env var
 * 2. The `iss` claim in the stored JWT (e.g. "https://xxx.supabase.co/auth/v1")
 */
function resolveSupabaseUrl(accessToken: string): string {
  if (SUPABASE_URL) return SUPABASE_URL.replace(/\/$/, '');

  try {
    const [, payload] = accessToken.split('.');
    if (!payload) throw new Error('bad jwt');
    const decoded = Buffer.from(payload, 'base64url').toString('utf-8');
    const parsed = JSON.parse(decoded) as { iss?: string };
    if (parsed.iss) {
      // iss is "https://<ref>.supabase.co/auth/v1" — strip the path
      return parsed.iss.replace(/\/auth\/v1\/?$/, '');
    }
  } catch {
    // fall through
  }

  throw new Error(
    'Could not determine Supabase URL. Set the SUPABASE_URL environment variable.',
  );
}
