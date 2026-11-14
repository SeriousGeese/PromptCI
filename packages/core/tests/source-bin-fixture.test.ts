/**
 * #161: a tracked `bin/` holding a hand-written entry script is source, not
 * build output. The security pack must not report it as an unignored build
 * directory, and so must not propose adding `bin/` to .gitignore.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../src/scan.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, '../../../examples/fixture-source-bin');

describe('fixture-source-bin (#161)', () => {
  it('reports no unignored build directory for a source bin/', async () => {
    expect(fs.existsSync(path.join(FIXTURE, 'bin', 'cli.mjs'))).toBe(true);
    const report = await scan({ repoPath: FIXTURE });
    expect(report.issues.find((i) => i.id === 'security-pack-unignored-dirs')).toBeUndefined();
  });

  it('reports the same bin/ once a .NET project file sits next to it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-dotnet-bin-'));
    try {
      fs.cpSync(FIXTURE, root, { recursive: true });
      fs.writeFileSync(path.join(root, 'App.csproj'), '<Project Sdk="Microsoft.NET.Sdk" />\n');
      const report = await scan({ repoPath: root });
      const issue = report.issues.find((i) => i.id === 'security-pack-unignored-dirs');
      expect(issue?.evidence).toEqual(['Directory "bin" exists but is not ignored in .gitignore.']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
