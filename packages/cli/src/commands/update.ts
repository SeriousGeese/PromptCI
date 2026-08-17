/**
 * `promptci update` — pull latest, rebuild, and re-link the CLI globally.
 *
 * First run:
 *   promptci update --source C:\git\SeriousGeese\PromptCI
 *
 * Subsequent runs (source dir remembered):
 *   promptci update
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { readGlobalConfig, writeGlobalConfig } from '../global-config.js';

/**
 * pnpm's global-bin-dir can be misconfigured (not in PATH) while pnpm itself
 * is installed in a different directory that IS in PATH. Detect and self-repair.
 */
function repairPnpmGlobalBinDir(): void {
  let configuredDir: string;
  try {
    configuredDir = execSync('pnpm config get global-bin-dir', { stdio: 'pipe' }).toString().trim();
  } catch {
    return; // can't diagnose, let pnpm fail naturally
  }

  const pathEntries = (process.env.PATH ?? '').split(path.delimiter);
  const normalize = (p: string) => p.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  const configuredNorm = normalize(configuredDir);
  if (pathEntries.some(e => normalize(e) === configuredNorm)) return;

  // global-bin-dir is not in PATH — find where pnpm itself lives (it must be in PATH)
  let pnpmBin: string;
  try {
    const raw = execSync(process.platform === 'win32' ? 'where pnpm' : 'which pnpm', { stdio: 'pipe' })
      .toString().trim().split(/\r?\n/)[0]!.trim();
    pnpmBin = path.dirname(raw);
  } catch {
    return; // can't find pnpm, let the link step fail with the original error
  }

  try {
    execSync(`pnpm config set global-bin-dir "${pnpmBin}"`, { stdio: 'pipe' });
    console.log(`  note: repaired pnpm global-bin-dir → ${pnpmBin}`);
  } catch {
    // non-fatal — the link step will surface the real error if it still fails
  }
}

export async function runUpdate(opts: { source?: string }): Promise<void> {
  const config = await readGlobalConfig();

  let sourceDir = opts.source
    ? path.resolve(opts.source)
    : config.sourceDir
      ? path.resolve(config.sourceDir)
      : null;

  if (!sourceDir) {
    console.error(
      [
        'PromptCI source directory not configured.',
        '',
        'Set it once with:',
        '  promptci update --source <path-to-PromptCI-repo>',
        '',
        'Example:',
        '  promptci update --source C:\\git\\SeriousGeese\\PromptCI',
      ].join('\n'),
    );
    process.exit(1);
  }

  // Validate it looks like the right repo
  try {
    await fs.access(path.join(sourceDir, 'pnpm-workspace.yaml'));
  } catch {
    console.error(
      `Directory does not look like the PromptCI repo (missing pnpm-workspace.yaml):\n  ${sourceDir}`,
    );
    process.exit(1);
  }

  // Persist source dir if it's new or changed
  if (sourceDir !== config.sourceDir) {
    await writeGlobalConfig({ ...config, sourceDir });
    console.log(`Saved source directory: ${sourceDir}\n`);
  }

  const cliDir = path.join(sourceDir, 'packages', 'cli');

  repairPnpmGlobalBinDir();

  const steps: Array<{ label: string; cmd: string; cwd: string }> = [
    { label: 'git pull',              cmd: 'git pull origin main', cwd: sourceDir },
    { label: 'pnpm install',          cmd: 'pnpm install',          cwd: sourceDir },
    { label: 'pnpm build',            cmd: 'pnpm build',            cwd: sourceDir },
    { label: 'pnpm link --global',    cmd: 'pnpm link --global',    cwd: cliDir    },
  ];

  console.log(`Updating PromptCI from ${sourceDir}\n`);

  for (const step of steps) {
    process.stdout.write(`  ${step.label} ... `);
    try {
      execSync(step.cmd, { cwd: step.cwd, stdio: 'pipe' });
      console.log('done');
    } catch (err) {
      console.log('FAILED');
      // Show the underlying error output
      const execErr = err as { stderr?: Buffer };
      const msg = err instanceof Error && 'stderr' in err
        ? execErr.stderr?.toString().trim()
        : String(err);
      if (msg) console.error(`\n${msg}\n`);
      console.error(`Update failed at: ${step.label}`);
      process.exit(1);
    }
  }

  console.log('\n✔  PromptCI updated successfully.');
}
