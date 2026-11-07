#!/usr/bin/env node
// Guards the gap between a merged release PR and a pushed tag.
//
// action.yml pins `cli_version` (the @promptci/cli the composite action
// installs), and packages/cli/tests/action-yml.test.ts forces that pin to be
// bumped in the same PR as the package version. That PR therefore merges with
// a pin that does not exist on npm yet — publishing only happens when someone
// pushes the matching `vX.Y.Z` tag and approves the Publish run. If the tag is
// never pushed, every consumer of `SeriousGeese/PromptCI@main` installs a
// version npm has never heard of, and nothing in CI notices: ci.yml's checks
// are all local, and publish.yml only runs for tags. (v0.2.0 sat unpublished
// for twelve days this way, 2026-10-26 → 2026-11-07.)
//
// This script asks the registry whether the pinned version exists. It is NOT a
// pull_request check: the release PR itself must be red-free with an
// unpublished pin, or the release flow deadlocks. It runs post-merge on a
// schedule (see .github/workflows/action-pin-published.yml) and fails loudly.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = '@promptci/cli';

/** The `default:` of action.yml's `cli_version` input. Same shape the
 *  action-yml test asserts on, so the two cannot disagree about where the
 *  pin lives. */
export function readActionPin(actionYml) {
  const match = /cli_version:[\s\S]*?default:\s*'([^']+)'/.exec(actionYml);
  if (!match) {
    throw new Error('action.yml has no cli_version input with a quoted default');
  }
  return match[1];
}

/** true if `name@version` exists on the public registry, false on a clean 404.
 *  Any other response is thrown so a registry outage reads as "unknown", not
 *  as "unpublished". */
export async function isPublished(name, version, fetchImpl = fetch) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  const res = await fetchImpl(url);
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`registry lookup for ${name}@${version} failed: ${res.status} ${res.statusText}`);
  return true;
}

async function withRetry(fn, attempts = 4, delayMs = 15_000) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

async function main() {
  const actionYml = fs.readFileSync(path.join(repoRoot, 'action.yml'), 'utf8');
  const pin = readActionPin(actionYml);
  const published = await withRetry(() => isPublished(PACKAGE, pin));

  if (published) {
    console.error(`check-action-pin-published: action.yml pins ${PACKAGE}@${pin}, which npm serves.`);
    return;
  }

  console.error(
    `check-action-pin-published: action.yml pins ${PACKAGE}@${pin} but npm has no such version ` +
      `(https://www.npmjs.com/package/${PACKAGE}?activeTab=versions).\n` +
      `Every consumer of SeriousGeese/PromptCI@main is broken until it is published. ` +
      `If the release PR has merged, the tag was never pushed:\n` +
      `  git tag v${pin} <release merge commit> && git push origin v${pin}\n` +
      `then approve the Publish run on the \`release\` environment ` +
      `(see .claude/skills/promptci-release/references/publish-release.md).`,
  );
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error(`check-action-pin-published: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
