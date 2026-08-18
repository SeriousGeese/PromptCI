/**
 * Best-effort "a newer promptci is on npm" notice.
 *
 * Deliberately lightweight, and the opposite of the old `update` command: it
 * never touches the user's install. It probes the npm registry at most once a
 * day with a short timeout and stays silent in CI, in non-interactive
 * pipelines (either stdio stream redirected), and whenever NO_UPDATE_NOTIFIER
 * or PROMPTCI_NO_UPDATE_NOTIFIER is set. Every failure — offline, slow
 * registry, malformed response, corrupt cache — is swallowed; checking for a
 * new version must never be why a command fails.
 *
 * The probe cache lives in its own file (~/.promptci/update-check.json), NOT
 * in global.json: the probe holds its snapshot across a network await, and
 * sharing a read-modify-write window with the config that login/upload write
 * (apiUrl) would let a slow probe clobber a concurrent login.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

const REGISTRY_URL = 'https://registry.npmjs.org/@promptci/cli/latest';
const CACHE_FILE = path.join(os.homedir(), '.promptci', 'update-check.json');
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day
const FETCH_TIMEOUT_MS = 2000;

/** True if version `a` is strictly newer than `b` (numeric core, then a stable beats its own prerelease). */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => {
    const [core = '', ...pre] = v.trim().replace(/^v/, '').split('-');
    return { nums: core.split('.').map((n) => parseInt(n, 10) || 0), pre: pre.length > 0 };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
    const na = pa.nums[i] ?? 0;
    const nb = pb.nums[i] ?? 0;
    if (na !== nb) return na > nb;
  }
  // Same numeric core: the stable release is newer than any of its prereleases
  // (semver: 0.2.0-beta.1 < 0.2.0). Ordering between two prereleases is not
  // attempted — the registry's `latest` tag only ever serves stable versions.
  return !pa.pre && pb.pre;
}

function suppressed(): boolean {
  return (
    // The notice targets stderr, but stay out of pipelines entirely: a
    // redirected stdout (scan --json | jq) or stderr (2>errors.log) both mean
    // the output is being captured by tooling, not read by a human.
    !process.stdout.isTTY ||
    !process.stderr.isTTY ||
    process.env.CI !== undefined ||
    process.env.NO_UPDATE_NOTIFIER !== undefined ||
    process.env.PROMPTCI_NO_UPDATE_NOTIFIER !== undefined
  );
}

type UpdateCheckCache = {
  /** Epoch ms of the last registry probe, whether it succeeded or failed. */
  checkedAt: number;
  /** Last version actually seen on npm's `latest` dist-tag; absent until a probe succeeds. */
  latest?: string;
};

/** Parse the cache file defensively: a hand-edited or corrupt cache must read as "no cache". */
async function readCache(now: number): Promise<UpdateCheckCache | null> {
  try {
    const raw = JSON.parse(await fs.readFile(CACHE_FILE, 'utf-8')) as Partial<UpdateCheckCache>;
    if (typeof raw.checkedAt !== 'number' || !Number.isFinite(raw.checkedAt)) return null;
    if (raw.checkedAt > now) return null; // clock skew / edited future timestamp: treat as stale
    if (raw.latest !== undefined && typeof raw.latest !== 'string') return null;
    return { checkedAt: raw.checkedAt, latest: raw.latest };
  } catch {
    return null;
  }
}

async function writeCache(cache: UpdateCheckCache): Promise<void> {
  await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
}

async function fetchLatest(): Promise<string | null> {
  try {
    // Plain GET — the /latest version endpoint rejects the abbreviated
    // packument media type with a 406, so no Accept header here.
    const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  }
}

/**
 * Resolve to a one-line "newer version available" message, or null when there
 * is nothing to say. Never rejects. The registry is probed at most once per
 * {@link CHECK_INTERVAL_MS}; between probes the last-seen version is served
 * from the cache file, so the common case is a cheap file read with no
 * network at all. The caller decides when to print — see cli.ts, which
 * overlaps this with the command and prints after the command's own output.
 */
export async function getNewVersionNotice(currentVersion: string): Promise<string | null> {
  if (suppressed()) return null;

  try {
    const now = Date.now();
    const cache = await readCache(now);
    let latest = cache?.latest;

    if (!cache || now - cache.checkedAt > CHECK_INTERVAL_MS) {
      // Record the attempt whether or not it succeeded, so a flaky registry
      // can't turn this into a probe on every invocation. On failure keep the
      // last version actually seen — never fabricate one.
      latest = (await fetchLatest()) ?? latest;
      await writeCache({ checkedAt: now, latest });
    }

    if (latest && isNewer(latest, currentVersion)) {
      return (
        `\nA new version of promptci is available: ${currentVersion} → ${latest}\n` +
        `Update with: npm install -g @promptci/cli\n`
      );
    }
    return null;
  } catch {
    // A version notice must never interfere with the command the user actually ran.
    return null;
  }
}
