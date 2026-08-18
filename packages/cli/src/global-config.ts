/**
 * Global CLI config stored in ~/.promptci/global.json
 * (separate from per-project .promptci/config.json and auth.json)
 *
 * Currently stores:
 *   apiUrl      — default dashboard API URL for login/upload.
 *   updateCheck — cached result of the daily "newer version on npm?" probe.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

const GLOBAL_DIR = path.join(os.homedir(), '.promptci');
const GLOBAL_FILE = path.join(GLOBAL_DIR, 'global.json');

export type GlobalConfig = {
  /** Default API URL used by login/upload when no --url flag or project config is set. */
  apiUrl?: string;
  /** Cache for the lightweight new-version notice (see commands/version-notice.ts). */
  updateCheck?: {
    /** Epoch ms of the last registry probe, whether it succeeded or failed. */
    checkedAt: number;
    /** Last version seen on npm's `latest` dist-tag. */
    latest: string;
  };
};

export async function readGlobalConfig(): Promise<GlobalConfig> {
  try {
    const raw = await fs.readFile(GLOBAL_FILE, 'utf-8');
    return JSON.parse(raw) as GlobalConfig;
  } catch {
    return {};
  }
}

export async function writeGlobalConfig(data: GlobalConfig): Promise<void> {
  await fs.mkdir(GLOBAL_DIR, { recursive: true });
  await fs.writeFile(GLOBAL_FILE, JSON.stringify(data, null, 2), 'utf-8');
}
