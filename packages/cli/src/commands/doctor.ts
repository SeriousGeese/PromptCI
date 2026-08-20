import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { loadConfig } from '../config.js';

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

  // 2. Report the RUNNING CLI version — the one executing this doctor command.
  // esbuild inlines this package.json at build time (same single source of truth
  // as `promptci --version`), so it is the true version regardless of what a
  // globally-linked `promptci` on PATH resolves to. The old code shelled out to
  // `promptci --version`, which reported the GLOBAL link's version — misleading
  // whenever you run a locally-built or `npx`'d CLI that differs from the global.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const runningVersion = (require('../../package.json') as { version: string }).version;

  // Then note how any globally-linked `promptci` relates to this build.
  //   null  → not linked; true → linked and matching; false → linked but different.
  let globalLinkMatches: boolean | null;
  let globalLinkedVersion = '';
  try {
    globalLinkedVersion = execSync('promptci --version', {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    globalLinkMatches = globalLinkedVersion === runningVersion;
  } catch {
    globalLinkMatches = null;
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

  console.log(`\x1b[32m[✓]\x1b[0m PromptCI CLI version (running): ${runningVersion}`);
  if (globalLinkMatches === true) {
    console.log(`\x1b[32m[✓]\x1b[0m Global \`promptci\` is linked and matches (${globalLinkedVersion})`);
  } else if (globalLinkMatches === false) {
    console.log(
      `\x1b[33m[!]\x1b[0m Global \`promptci\` on PATH is a different version (${globalLinkedVersion}); ` +
        `it will not match this build`,
    );
  } else {
    console.log(
      `\x1b[33m[!]\x1b[0m Global \`promptci\` is not linked (run npm link -g or pnpm link -g if desired)`,
    );
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

  console.log('--------------------------------------------------');
  if (criticalFailure) {
    console.error('\x1b[31mDiagnostics failed: Critical configuration issues detected.\x1b[0m');
    process.exit(1);
  } else {
    console.log('\x1b[32mDiagnostics passed: Local setup is healthy!\x1b[0m');
  }
}
