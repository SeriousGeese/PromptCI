/**
 * Resolution of the PromptCI dashboard API URL.
 *
 * BUG-4: `login`, `upload`, `doctor` and every config `init` wrote each kept
 * their own `http://localhost:3000` fallback. The hosted dashboard has no
 * public domain yet, so a user who installed `@promptci/cli` from npm and ran
 * `promptci login` got connection-refused against their own machine with no
 * hint that a URL was ever required.
 *
 * There is deliberately no built-in default. When the dashboard is hosted,
 * set `DEFAULT_API_URL` below and it flows to every caller at once.
 */

import { loadConfig } from './config.js';
import { readGlobalConfig } from './global-config.js';

export const API_URL_ENV = 'PROMPTCI_API_URL';

/**
 * Production dashboard endpoint. `undefined` until the hosted dashboard has a
 * domain — the CLI asks for an explicit URL rather than guessing localhost.
 */
export const DEFAULT_API_URL: string | undefined = undefined;

/** Where a resolved URL came from, for diagnostics. */
export type ApiUrlSource = 'flag' | 'env' | 'project-config' | 'global-config' | 'default';

export type ResolvedApiUrl = {
  url: string;
  source: ApiUrlSource;
};

export type ApiUrlInputs = {
  /** Value of an explicit `--url` flag. */
  flag?: string;
  /** Directory whose `.promptci/config.json` may carry an `apiUrl`. */
  scanPath?: string;
  /** Override for `process.env` (tests). */
  env?: Record<string, string | undefined>;
};

/** Instructions printed whenever no URL could be resolved. */
export const API_URL_HELP =
  'PromptCI has no hosted dashboard endpoint yet, so the dashboard URL must be given explicitly.\n' +
  `Pass --url <url>, or set ${API_URL_ENV}, or add "apiUrl" to .promptci/config.json.`;

function normalize(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * Rejects values that are not absolute http(s) URLs. A bare host or a typo'd
 * scheme would otherwise surface much later as an opaque fetch failure.
 */
export function assertUsableApiUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid dashboard URL "${url}": must be an absolute URL, e.g. https://promptci.example.com`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid dashboard URL "${url}": only http and https are supported.`);
  }
}

/**
 * Resolves the dashboard URL in precedence order:
 * `--url` > `PROMPTCI_API_URL` > project config > global config > built-in default.
 *
 * Returns `undefined` when nothing is configured — callers decide whether that
 * is fatal (`login`, `upload`) or simply means "skip the dashboard" (`doctor`).
 */
export async function resolveApiUrl(inputs: ApiUrlInputs = {}): Promise<ResolvedApiUrl | undefined> {
  const env = inputs.env ?? process.env;

  if (inputs.flag) {
    return { url: normalize(inputs.flag), source: 'flag' };
  }

  const fromEnv = env[API_URL_ENV];
  if (fromEnv) {
    return { url: normalize(fromEnv), source: 'env' };
  }

  if (inputs.scanPath !== undefined) {
    let projectApiUrl: string | undefined;
    try {
      projectApiUrl = (await loadConfig(inputs.scanPath)).apiUrl;
    } catch {
      // A malformed config is reported by the command that loads it for real.
    }
    if (projectApiUrl) {
      return { url: normalize(projectApiUrl), source: 'project-config' };
    }
  }

  const globalApiUrl = (await readGlobalConfig()).apiUrl;
  if (globalApiUrl) {
    return { url: normalize(globalApiUrl), source: 'global-config' };
  }

  if (DEFAULT_API_URL) {
    return { url: normalize(DEFAULT_API_URL), source: 'default' };
  }

  return undefined;
}
