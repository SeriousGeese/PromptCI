import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { loadConfig } from '../config.js';
import { readAuthConfig } from '../auth-config.js';
import { API_URL_ENV, resolveApiUrl } from '../api-url.js';

export type DoctorOptions = {
  scanPath?: string;
};

/**
 * Must match `engines.node` in packages/cli/package.json — doctor previously
 * green-lit Node 20/21, which pnpm then refuses to install under.
 * `doctor.test.ts` asserts the two stay in sync.
 */
export const MIN_NODE_MAJOR = 22;

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function runDoctor(options: DoctorOptions): Promise<void> {
  const rawPath = options.scanPath ?? process.cwd();
  const resolvedPath = path.resolve(rawPath);

  // Validate scanPath path is directory
  try {
    const stat = await fs.stat(resolvedPath);
    if (!stat.isDirectory()) {
      console.error(`Error: "${resolvedPath}" is not a directory.`);
      process.exit(1);
    }
  } catch {
    console.error(`Error: path does not exist: "${resolvedPath}"`);
    process.exit(1);
  }

  let criticalFailure = false;

  // 1. Node.js version check
  const major = parseInt(process.versions.node.split('.')[0], 10);
  const isNodeOk = major >= MIN_NODE_MAJOR;

  // 2. Global executable check
  let cliVersionStr: string;
  let cliLinked = false;
  try {
    const out = execSync('promptci --version', { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
    cliVersionStr = out;
    cliLinked = true;
  } catch {
    cliVersionStr = 'Not linked globally (run pnpm link -g or npm link -g if desired)';
  }

  // 3. Config schema validation
  let configOk = true;
  let configMsg: string;
  const configPath = path.join(resolvedPath, '.promptci', 'config.json');
  try {
    await fs.access(configPath);
    try {
      await loadConfig(resolvedPath);
      configMsg = 'Valid configuration file found';
    } catch (err: unknown) {
      configOk = false;
      configMsg = `Invalid configuration: ${err instanceof Error ? err.message : String(err)}`;
    }
  } catch {
    configMsg = 'No configuration file found (using default rules)';
  }

  // 4. Gitignore ignore check.
  // Three outcomes, only one of which is a real misconfiguration:
  //   - not a git repo         → skip; there is nothing to ignore
  //   - git repo, no .gitignore → advisory; `promptci init` offers to add one
  //   - .gitignore without the rule → failure; reports would be committed
  type GitignoreState = 'ok' | 'missing-rule' | 'no-gitignore' | 'not-a-repo';
  let gitignoreState: GitignoreState;
  let gitignoreMsg: string;
  const isGitRepo = await pathExists(path.join(resolvedPath, '.git'));
  const gitignorePath = path.join(resolvedPath, '.gitignore');
  try {
    const content = await fs.readFile(gitignorePath, 'utf-8');
    const lines = content.split(/\r?\n/);
    const hasIgnore = lines.some(l => {
      const clean = l.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '');
      return (
        clean === '.promptci' ||
        clean.startsWith('.promptci/') ||
        clean.endsWith('/.promptci') ||
        clean.includes('/.promptci/')
      );
    });
    if (hasIgnore) {
      gitignoreState = 'ok';
      gitignoreMsg = '.promptci/ is ignored in .gitignore';
    } else {
      gitignoreState = 'missing-rule';
      gitignoreMsg = '.promptci/ is not ignored in .gitignore';
    }
  } catch {
    if (isGitRepo) {
      gitignoreState = 'no-gitignore';
      gitignoreMsg = 'No .gitignore file found (run "promptci init" to add the .promptci/ rules)';
    } else {
      gitignoreState = 'not-a-repo';
      gitignoreMsg = 'Not a git repository — .promptci/ ignore check skipped';
    }
  }

  // 5. LLM Keys check
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const hasKeys = !!openaiKey || !!anthropicKey;

  // 6. Auth status check
  const authConfig = await readAuthConfig();
  const now = Math.floor(Date.now() / 1000);
  const hasToken = !!authConfig.access_token && (!authConfig.expires_at || authConfig.expires_at > now);

  // 7. Dashboard connection check.
  // Only reached when a URL is actually configured — doctor used to fetch
  // localhost:3000/api/health on every run, including for the majority of
  // users who never touch the dashboard.
  const resolvedApiUrl = await resolveApiUrl({ scanPath: resolvedPath });
  let dashboardConnected = false;
  const dashboardConfigured = resolvedApiUrl !== undefined;
  let dashboardMessage =
    `No dashboard URL configured — skipped (set ${API_URL_ENV} or "apiUrl" in .promptci/config.json to check it)`;

  if (resolvedApiUrl) {
    const apiUrl = resolvedApiUrl.url;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      const res = await globalThis.fetch(`${apiUrl}/api/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (res.ok) {
        dashboardConnected = true;
        dashboardMessage = `Connected to dashboard at ${apiUrl}`;
      } else {
        dashboardMessage = `Dashboard at ${apiUrl} returned status ${res.status}`;
      }
    } catch (err) {
      dashboardMessage = `Could not connect to ${apiUrl}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  console.log('PromptCI System Diagnostics (Doctor)');
  console.log('--------------------------------------------------');

  // Print results
  if (isNodeOk) {
    console.log(`\x1b[32m[✓]\x1b[0m Node.js version >= ${MIN_NODE_MAJOR} (${process.version})`);
  } else {
    console.log(
      `\x1b[31m[✗]\x1b[0m Node.js version is too old (${process.version}). ` +
        `Upgrade to Node ${MIN_NODE_MAJOR}+`,
    );
    criticalFailure = true;
  }

  if (cliLinked) {
    console.log(`\x1b[32m[✓]\x1b[0m Global CLI executable is linked (${cliVersionStr})`);
  } else {
    console.log(`\x1b[33m[!]\x1b[0m Global CLI executable: ${cliVersionStr}`);
  }

  if (configOk) {
    console.log(`\x1b[32m[✓]\x1b[0m Config file schema: ${configMsg}`);
  } else {
    console.log(`\x1b[31m[✗]\x1b[0m Config file schema: ${configMsg}`);
    criticalFailure = true;
  }

  if (gitignoreState === 'ok') {
    console.log(`\x1b[32m[✓]\x1b[0m Gitignore protection: ${gitignoreMsg}`);
  } else if (gitignoreState === 'missing-rule') {
    console.log(`\x1b[31m[✗]\x1b[0m Gitignore protection: ${gitignoreMsg}`);
    criticalFailure = true;
  } else if (gitignoreState === 'no-gitignore') {
    console.log(`\x1b[33m[!]\x1b[0m Gitignore protection: ${gitignoreMsg}`);
  } else {
    console.log(`\x1b[36m[i]\x1b[0m Gitignore protection: ${gitignoreMsg}`);
  }

  // `fix --llm` and `explain` call the model provider directly from this
  // process, so a dashboard login is no substitute for a local key.
  if (hasKeys) {
    const keysUsed = [openaiKey ? 'OpenAI' : '', anthropicKey ? 'Anthropic' : ''].filter(Boolean).join(', ');
    console.log(`\x1b[32m[✓]\x1b[0m LLM API Keys: Configured (${keysUsed})`);
  } else {
    console.log(`\x1b[33m[!]\x1b[0m LLM API Keys: Neither OPENAI_API_KEY nor ANTHROPIC_API_KEY is configured (explain/fix --llm run locally and are disabled without one)`);
  }

  if (hasToken) {
    console.log(`\x1b[32m[✓]\x1b[0m Dashboard Authentication: Authenticated`);
  } else {
    console.log(`\x1b[33m[!]\x1b[0m Dashboard Authentication: Not authenticated (run promptci login to set up)`);
  }

  if (dashboardConnected) {
    console.log(`\x1b[32m[✓]\x1b[0m Dashboard connection: ${dashboardMessage}`);
  } else if (dashboardConfigured) {
    console.log(`\x1b[33m[!]\x1b[0m Dashboard connection: ${dashboardMessage}`);
  } else {
    console.log(`\x1b[36m[i]\x1b[0m Dashboard connection: ${dashboardMessage}`);
  }

  console.log('--------------------------------------------------');
  if (criticalFailure) {
    console.error('\x1b[31mDiagnostics failed: Critical configuration issues detected.\x1b[0m');
    process.exit(1);
  } else {
    console.log('\x1b[32mDiagnostics passed: Local setup is healthy!\x1b[0m');
  }
}
