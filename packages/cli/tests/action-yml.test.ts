import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The composite action installs a PINNED @promptci/cli (issue #24): an
 * unpinned `npx @promptci/cli` resolves to whatever is newest when each
 * consumer's job runs, so a release could turn their pipeline red with no
 * change on their side.
 *
 * The pin's failure mode is drift — a release that bumps the package but not
 * the action ships an action stuck on the previous CLI. These tests hold the
 * two together, and hold the pin itself in place.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const actionYml = fs.readFileSync(path.join(repoRoot, 'action.yml'), 'utf-8');

function cliVersionDefault(): string {
  const block = /cli_version:[\s\S]*?default:\s*'([^']+)'/.exec(actionYml);
  expect(block, 'action.yml should declare a cli_version input with a default').not.toBeNull();
  return block![1]!;
}

describe('action.yml CLI pin', () => {
  it('pins cli_version to the published CLI package version', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'packages', 'cli', 'package.json'), 'utf-8'),
    ) as { version: string };

    expect(cliVersionDefault()).toBe(pkg.version);
  });

  it('never installs the CLI without a version specifier', () => {
    // The package spec is built once, from the input; a bare
    // `npx @promptci/cli` on any invocation line is the bug being guarded
    // against. Comment lines are excluded — they discuss the unpinned form.
    const invocations = actionYml
      .split('\n')
      .map(l => l.trim())
      .filter(l => !l.startsWith('#') && l.includes('npx '));

    expect(invocations.length).toBeGreaterThan(0);
    for (const line of invocations) {
      expect(line).toContain('"$CLI"');
    }
    expect(actionYml).toContain('@promptci/cli@${PROMPTCI_CLI_VERSION}');
  });
});
