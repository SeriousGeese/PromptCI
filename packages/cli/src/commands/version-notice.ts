/**
 * Best-effort "a newer promptci is on npm" notice.
 *
 * Deliberately lightweight, and the opposite of the old `update` command: it
 * never touches the user's install. It prints only to stderr (so `--json`
 * stdout stays clean), probes the npm registry at most once a day with a short
 * timeout, and stays silent in CI, in non-interactive pipelines, and whenever
 * NO_UPDATE_NOTIFIER / PROMPTCI_NO_UPDATE_NOTIFIER is set. Every failure —
 * offline, slow registry, malformed response — is swallowed; checking for a new
 * version must never be why a scan fails.
 */

import { readGlobalConfig, writeGlobalConfig } from '../global-config.js';

const REGISTRY_URL = 'https://registry.npmjs.org/@promptci/cli/latest';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day
const FETCH_TIMEOUT_MS = 2000;

/** True if dotted-numeric version `a` is strictly newer than `b`. Prereleases are ignored. */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) =>
    v.trim().replace(/^v/, '').split('-')[0]!.split('.').map((n) => parseInt(n, 10) || 0);
  const [a0 = 0, a1 = 0, a2 = 0] = parse(a);
  const [b0 = 0, b1 = 0, b2 = 0] = parse(b);
  if (a0 !== b0) return a0 > b0;
  if (a1 !== b1) return a1 > b1;
  return a2 > b2;
}

function suppressed(): boolean {
  return (
    !process.stdout.isTTY ||
    process.env.CI !== undefined ||
    process.env.NO_UPDATE_NOTIFIER !== undefined ||
    process.env.PROMPTCI_NO_UPDATE_NOTIFIER !== undefined
  );
}

async function fetchLatest(): Promise<string | null> {
  try {
    const res = await fetch(REGISTRY_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  }
}

/**
 * Print a one-line notice to stderr if npm's `latest` is newer than what's
 * running. The registry is probed at most once per {@link CHECK_INTERVAL_MS};
 * between probes the last-seen version is served from the global config cache,
 * so the common case is a cheap file read with no network at all.
 */
export async function notifyOnNewVersion(currentVersion: string): Promise<void> {
  if (suppressed()) return;

  try {
    const config = await readGlobalConfig();
    const now = Date.now();
    let latest = config.updateCheck?.latest;
    const lastCheckedAt = config.updateCheck?.checkedAt ?? 0;

    if (now - lastCheckedAt > CHECK_INTERVAL_MS) {
      const fetched = await fetchLatest();
      // Record the attempt whether or not it succeeded, so a flaky registry
      // can't turn this into a probe on every invocation. Keep the last known
      // version on failure.
      latest = fetched ?? latest;
      await writeGlobalConfig({
        ...config,
        updateCheck: { checkedAt: now, latest: latest ?? currentVersion },
      });
    }

    if (latest && isNewer(latest, currentVersion)) {
      process.stderr.write(
        `\nA new version of promptci is available: ${currentVersion} → ${latest}\n` +
          `Update with: npm install -g @promptci/cli\n\n`,
      );
    }
  } catch {
    // A version notice must never interfere with the command the user actually ran.
  }
}
