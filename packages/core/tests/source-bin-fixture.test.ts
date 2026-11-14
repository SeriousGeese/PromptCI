/**
 * #161: a tracked `bin/` holding a hand-written entry script is source, not
 * build output. The security pack must not report it as an unignored build
 * directory, and so must not propose adding `bin/` to .gitignore, even when
 * a .NET or JVM build file sits at the root as well.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../src/scan.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, '../../../examples/fixture-source-bin');

const unignored = async (repoPath: string) =>
  (await scan({ repoPath })).issues.find((i) => i.id === 'security-pack-unignored-dirs');

function copyFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-source-bin-'));
  fs.cpSync(FIXTURE, root, { recursive: true });
  return root;
}

describe('fixture-source-bin (#161)', () => {
  it('reports no unignored build directory for a source bin/ beside pom.xml and Directory.Build.props', async () => {
    for (const marker of ['pom.xml', 'Directory.Build.props', 'bin/cli.mjs', 'bin/fixture-tool']) {
      expect(fs.existsSync(path.join(FIXTURE, marker)), marker).toBe(true);
    }
    expect(await unignored(FIXTURE)).toBeUndefined();
  });

  it('still clean with only the extensionless shebang script left (no package.json bin target)', async () => {
    const root = copyFixture();
    try {
      fs.rmSync(path.join(root, 'bin', 'cli.mjs'));
      fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture-source-bin","private":true}\n');
      expect(await unignored(root)).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports bin/ once it holds only .NET build output', async () => {
    const root = copyFixture();
    try {
      fs.rmSync(path.join(root, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture-source-bin","private":true}\n');
      fs.mkdirSync(path.join(root, 'bin', 'Debug'), { recursive: true });
      fs.writeFileSync(path.join(root, 'bin', 'Debug', 'App.dll'), 'MZ');
      const issue = await unignored(root);
      expect(issue?.evidence).toEqual(['Directory "bin" exists but is not ignored in .gitignore.']);
      expect(issue?.autoApplySafe).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
