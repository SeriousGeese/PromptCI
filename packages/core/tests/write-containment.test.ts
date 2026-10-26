/**
 * pcic-2b6.14: the write-side mirror of the symlink read policy. A `.promptci`
 * directory (or report file) committed as a link that leaves the repo must not
 * redirect what the scanner writes. A linked DIRECTORY (a junction on Windows,
 * which needs no privilege) exercises the same real-path check as a linked
 * file, so these run on every platform; the dangling-file-link case needs a
 * file symlink and skips where the OS refuses.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeTargetWithinRoot } from '../src/path-containment.js';
import { scan } from '../src/scan.js';
import { writeReport } from '../src/report.js';
import { canSymlink, makeTempRepo, trySymlink, writeFile } from './ai-config-helpers.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = makeTempRepo(prefix);
  dirs.push(dir);
  return dir;
}

/** A repo whose `.promptci` is a link to an outside directory. */
function repoWithEscapingPromptci(): { repo: string; outside: string } {
  const outside = temp('promptci-write-outside-');
  const repo = temp('promptci-write-repo-');
  writeFile(repo, 'AGENTS.md', '# Agents\n\nRun the tests before you push.\n');
  fs.symlinkSync(outside, path.join(repo, '.promptci'), 'junction');
  return { repo, outside };
}

describe('writeTargetWithinRoot', () => {
  it('allows a normal path inside the root, existing or not', () => {
    const repo = temp('promptci-write-ok-');
    writeFile(repo, '.promptci/baseline.json', '[]');
    expect(writeTargetWithinRoot(repo, path.join(repo, '.promptci', 'baseline.json'))).toBe(true);
    expect(writeTargetWithinRoot(repo, path.join(repo, 'new', 'deep', 'file.json'))).toBe(true);
  });

  it('allows an explicit path outside the root', () => {
    const repo = temp('promptci-write-root-');
    const elsewhere = temp('promptci-write-elsewhere-');
    expect(writeTargetWithinRoot(repo, path.join(elsewhere, 'report.md'))).toBe(true);
  });

  it('refuses a path that reaches outside through a linked directory, existing or not', () => {
    const { repo } = repoWithEscapingPromptci();
    expect(writeTargetWithinRoot(repo, path.join(repo, '.promptci'))).toBe(false);
    expect(writeTargetWithinRoot(repo, path.join(repo, '.promptci', 'latest.md'))).toBe(false);
    expect(writeTargetWithinRoot(repo, path.join(repo, '.promptci', 'history', 'x', 'report.json'))).toBe(false);
  });

  it.skipIf(!canSymlink)('refuses a dangling file link whose target a write would create outside', () => {
    const outside = temp('promptci-write-dangling-');
    const repo = temp('promptci-write-dangling-repo-');
    expect(trySymlink(path.join(outside, 'created-by-write.md'), path.join(repo, 'latest.md'))).toBe(true);
    expect(writeTargetWithinRoot(repo, path.join(repo, 'latest.md'))).toBe(false);
  });
});

describe('writeReport', () => {
  it('refuses to write through a .promptci link that leaves the repo', async () => {
    const { repo, outside } = repoWithEscapingPromptci();
    const report = await scan({ repoPath: repo });
    await expect(writeReport(report)).rejects.toThrow(/resolves outside the repository/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('still writes into a normal .promptci, and to an explicit path outside the repo', async () => {
    const repo = temp('promptci-write-normal-');
    writeFile(repo, 'AGENTS.md', '# Agents\n\nRun the tests before you push.\n');
    const report = await scan({ repoPath: repo });
    const written = await writeReport(report);
    expect(fs.existsSync(written.mdPath)).toBe(true);
    const elsewhere = temp('promptci-write-explicit-');
    const custom = await writeReport(report, { mdPath: path.join(elsewhere, 'out.md'), jsonPath: path.join(elsewhere, 'out.json') });
    expect(fs.existsSync(custom.jsonPath)).toBe(true);
  });
});
