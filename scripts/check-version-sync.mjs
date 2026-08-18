#!/usr/bin/env node
// Guards the drift issue from GH issue #5: @promptci/core is bundled into
// @promptci/cli's dist/cli.cjs as a frozen esbuild snapshot (core is a
// devDependency of cli, not a runtime one), so nothing on npm's side ties the
// two packages together. If they publish out of lockstep, installing
// @promptci/cli can silently ship a stale bundled core (or the standalone
// @promptci/core package can move ahead of what any released cli bundles).
//
// Local mode (no flags) compares the two workspace package.json versions —
// fast, no network, safe to run on every CI push/PR. `--tag <version>`
// additionally checks that against a release tag before publishing.
// `--registry` additionally fetches what npm currently has live for each
// package and confirms the published versions agree — this is what actually
// catches drift after a real-world publish (e.g. core published but cli's
// publish step then failed).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function readWorkspaceVersion(repoRootDir, pkgRelPath) {
  const full = path.join(repoRootDir, pkgRelPath);
  const pkg = JSON.parse(fs.readFileSync(full, 'utf8'));
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new Error(`${pkgRelPath} has no "version" field`);
  }
  return pkg.version;
}

async function fetchPublishedVersion(name, attempts = 5, delayMs = 10_000) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(`https://registry.npmjs.org/${name}/latest`);
      if (!res.ok) {
        throw new Error(`registry lookup for ${name} failed: ${res.status} ${res.statusText}`);
      }
      const body = await res.json();
      if (typeof body.version !== 'string' || body.version.length === 0) {
        throw new Error(`registry response for ${name} has no version field`);
      }
      return body.version;
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastErr;
}

async function main() {
  const registryMode = process.argv.includes('--registry');
  const tagArgIndex = process.argv.indexOf('--tag');
  const tagVersion = tagArgIndex !== -1 ? process.argv[tagArgIndex + 1] : undefined;

  const cliVersion = readWorkspaceVersion(repoRoot, path.join('packages', 'cli', 'package.json'));
  const coreVersion = readWorkspaceVersion(repoRoot, path.join('packages', 'core', 'package.json'));

  if (cliVersion !== coreVersion) {
    console.error(
      `check-version-sync: packages/cli is at ${cliVersion} but packages/core is at ` +
        `${coreVersion}. @promptci/core is bundled into cli.cjs as a frozen snapshot, so the ` +
        'two packages must publish at the same version. Bump both together.',
    );
    process.exitCode = 1;
    return;
  }

  if (tagVersion !== undefined && tagVersion !== cliVersion) {
    console.error(
      `check-version-sync: tag "${tagVersion}" does not match the workspace version ` +
        `(${cliVersion}). Update packages/cli/package.json and packages/core/package.json to ` +
        `${tagVersion} before tagging.`,
    );
    process.exitCode = 1;
    return;
  }

  console.error(`check-version-sync: packages/cli and packages/core agree at ${cliVersion}.`);

  if (!registryMode) return;

  const [publishedCli, publishedCore] = await Promise.all([
    fetchPublishedVersion('@promptci/cli'),
    fetchPublishedVersion('@promptci/core'),
  ]);

  if (publishedCli !== publishedCore) {
    console.error(
      `check-version-sync: npm has @promptci/cli@${publishedCli} but ` +
        `@promptci/core@${publishedCore} — the published packages have drifted.`,
    );
    process.exitCode = 1;
    return;
  }

  if (tagVersion !== undefined && publishedCli !== tagVersion) {
    console.error(
      `check-version-sync: npm shows ${publishedCli} for both packages, but this run expected ` +
        `${tagVersion}. The publish may not have propagated yet, or it did not actually publish ` +
        'the new version.',
    );
    process.exitCode = 1;
    return;
  }

  console.error(`check-version-sync: npm agrees at ${publishedCli}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error(`check-version-sync: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
