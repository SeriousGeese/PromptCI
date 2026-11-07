/**
 * Tests scripts/check-action-pin-published.mjs — the post-merge guard that
 * fails while action.yml pins a @promptci/cli version npm does not serve
 * (a release PR merged, tag never pushed). The registry call is injected so
 * these tests make no network requests; the real lookup runs only from
 * .github/workflows/action-pin-published.yml.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — plain .mjs module without type declarations
import { readActionPin, isPublished } from '../../../scripts/check-action-pin-published.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function fakeFetch(status: number, statusText = ''): typeof fetch {
  return (async () => ({ status, ok: status >= 200 && status < 300, statusText })) as unknown as typeof fetch;
}

describe('check-action-pin-published script', () => {
  it('reads the cli_version default from the real action.yml, agreeing with the action-yml test', () => {
    const actionYml = fs.readFileSync(path.join(repoRoot, 'action.yml'), 'utf-8');
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'packages', 'cli', 'package.json'), 'utf-8'),
    ) as { version: string };
    expect(readActionPin(actionYml)).toBe(pkg.version);
  });

  it('reads the pin from a minimal fixture and ignores other inputs', () => {
    const yml = [
      'inputs:',
      '  path:',
      "    default: '.'",
      '  cli_version:',
      '    description: pinned',
      "    default: '1.2.3'",
      '  other:',
      "    default: 'x'",
    ].join('\n');
    expect(readActionPin(yml)).toBe('1.2.3');
  });

  it('throws when action.yml has no cli_version default', () => {
    expect(() => readActionPin("inputs:\n  path:\n    default: '.'\n")).toThrow(/cli_version/);
  });

  it('reports published on 200 and unpublished on 404', async () => {
    await expect(isPublished('@promptci/cli', '1.2.3', fakeFetch(200))).resolves.toBe(true);
    await expect(isPublished('@promptci/cli', '1.2.3', fakeFetch(404))).resolves.toBe(false);
  });

  it('throws on any other registry response, so an outage is not read as unpublished', async () => {
    await expect(isPublished('@promptci/cli', '1.2.3', fakeFetch(503, 'Service Unavailable'))).rejects.toThrow(
      /503/,
    );
  });

  it('asks the registry for the scoped name URL-encoded', async () => {
    let seen = '';
    const spy = (async (url: string) => {
      seen = url;
      return { status: 200, ok: true, statusText: 'OK' };
    }) as unknown as typeof fetch;
    await isPublished('@promptci/cli', '1.2.3', spy);
    expect(seen).toBe('https://registry.npmjs.org/%40promptci%2Fcli/1.2.3');
  });
});
