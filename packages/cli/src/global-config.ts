/**
 * Global CLI config stored in ~/.promptci/global.json
 * (separate from per-project .promptci/config.json and auth.json)
 *
 * Currently stores:
 *   apiUrl — default dashboard API URL for login/upload.
 *
 * The new-version probe cache deliberately lives in its own file
 * (see commands/version-notice.ts), not here: the probe holds its config
 * snapshot across a network await, and sharing this file's read-modify-write
 * window would let a slow probe clobber a concurrent login's apiUrl.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

const GLOBAL_DIR = path.join(os.homedir(), '.promptci');
const GLOBAL_FILE = path.join(GLOBAL_DIR, 'global.json');

export type GlobalConfig = {
  /** Default API URL used by login/upload when no --url flag or project config is set. */
  apiUrl?: string;
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
