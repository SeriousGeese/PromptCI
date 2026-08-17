import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { loadConfig } from '../config.js';
import { readAuthConfig } from '../auth-config.js';

export type DoctorOptions = {
  scanPath?: string;
};

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
  const isNodeOk = major >= 20;

  // 2. Global executable check
  let cliVersionStr = '';
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
  let configMsg = '';
  let apiUrl = 'http://localhost:3000';
  const configPath = path.join(resolvedPath, '.promptci', 'config.json');
  try {
    await fs.access(configPath);
    try {
      const config = await loadConfig(resolvedPath);
      configMsg = 'Valid configuration file found';
      if (config.apiUrl) {
        apiUrl = config.apiUrl;
      }
    } catch (err: unknown) {
      configOk = false;
      configMsg = `Invalid configuration: ${err instanceof Error ? err.message : String(err)}`;
    }
  } catch {
    configMsg = 'No configuration file found (using default rules)';
  }

  // 4. Gitignore ignore check
  let gitignoreOk = false;
  let gitignoreMsg = '';
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
      gitignoreOk = true;
      gitignoreMsg = '.promptci/ is ignored in .gitignore';
    } else {
      gitignoreMsg = '.promptci/ is not ignored in .gitignore';
    }
  } catch {
    gitignoreMsg = 'No .gitignore file found in target path';
  }

  // 5. LLM Keys check
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const hasKeys = !!openaiKey || !!anthropicKey;

  // 6. Auth status check
  const authConfig = await readAuthConfig();
  const now = Math.floor(Date.now() / 1000);
  const hasToken = !!authConfig.access_token && (!authConfig.expires_at || authConfig.expires_at > now);

  // 7. Dashboard connection check
  let dashboardConnected = false;
  let dashboardMessage = '';
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

  console.log('PromptCI System Diagnostics (Doctor)');
  console.log('--------------------------------------------------');

  // Print results
  if (isNodeOk) {
    console.log(`\x1b[32m[✓]\x1b[0m Node.js version >= 20 (${process.version})`);
  } else {
    console.log(`\x1b[31m[✗]\x1b[0m Node.js version is too old (${process.version}). Upgrade to Node 20+`);
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

  if (gitignoreOk) {
    console.log(`\x1b[32m[✓]\x1b[0m Gitignore protection: ${gitignoreMsg}`);
  } else {
    console.log(`\x1b[31m[✗]\x1b[0m Gitignore protection: ${gitignoreMsg}`);
    criticalFailure = true;
  }

  if (hasKeys) {
    const keysUsed = [openaiKey ? 'OpenAI' : '', anthropicKey ? 'Anthropic' : ''].filter(Boolean).join(', ');
    console.log(`\x1b[32m[✓]\x1b[0m LLM API Keys: Configured (${keysUsed})`);
  } else if (hasToken) {
    console.log(`\x1b[36m[i]\x1b[0m LLM API Keys: Local keys not configured (LLM features will use the dashboard server-side API)`);
  } else {
    console.log(`\x1b[33m[!]\x1b[0m LLM API Keys: Neither OPENAI_API_KEY nor ANTHROPIC_API_KEY is configured (explain/fix LLM features disabled)`);
  }

  if (hasToken) {
    console.log(`\x1b[32m[✓]\x1b[0m Dashboard Authentication: Authenticated`);
  } else {
    console.log(`\x1b[33m[!]\x1b[0m Dashboard Authentication: Not authenticated (run promptci login to set up)`);
  }

  if (dashboardConnected) {
    console.log(`\x1b[32m[✓]\x1b[0m Dashboard connection: ${dashboardMessage}`);
  } else {
    console.log(`\x1b[33m[!]\x1b[0m Dashboard connection: ${dashboardMessage}`);
  }

  console.log('--------------------------------------------------');
  if (criticalFailure) {
    console.error('\x1b[31mDiagnostics failed: Critical configuration issues detected.\x1b[0m');
    process.exit(1);
  } else {
    console.log('\x1b[32mDiagnostics passed: Local setup is healthy!\x1b[0m');
  }
}
