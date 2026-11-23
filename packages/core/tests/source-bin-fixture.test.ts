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

  it('still clean when bin/ holds only scripts in subdirectories and non-script source (#206)', async () => {
    const root = copyFixture();
    try {
      fs.rmSync(path.join(root, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture-source-bin","private":true}\n');
      fs.mkdirSync(path.join(root, 'bin', 'linux'), { recursive: true });
      fs.writeFileSync(path.join(root, 'bin', 'linux', 'start.sh'), '#!/bin/sh\nexec java -jar app.jar\n');
      fs.writeFileSync(path.join(root, 'bin', 'tool.groovy'), 'println "hi"\n');
      fs.writeFileSync(path.join(root, 'bin', 'setup'), 'mvn -q install\n');
      expect(await unignored(root)).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fixture-source-bin-nested: a nested launcher and a Groovy script beside pom.xml are source (#206)', async () => {
    const nested = path.resolve(__dirname, '../../../examples/fixture-source-bin-nested');
    for (const marker of ['pom.xml', 'bin/linux/start.sh', 'bin/tool.groovy']) {
      expect(fs.existsSync(path.join(nested, marker)), marker).toBe(true);
    }
    expect(await unignored(nested)).toBeUndefined();
  });

  it('does not report bin/ when the caller says its file inventory is partial (PR #210 review)', async () => {
    // A hosted scan that listed only bin/widgets.jar cannot know what else is
    // in bin/, so it must not propose ignoring it.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-partial-bin-'));
    try {
      fs.writeFileSync(path.join(root, 'pom.xml'), '<project/>\n');
      fs.writeFileSync(path.join(root, '.gitignore'), 'target/\n.promptci/\n');
      fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Agents\n\nRun `mvn -q verify` before you push.\n');
      fs.mkdirSync(path.join(root, 'bin'));
      fs.writeFileSync(path.join(root, 'bin', 'widgets.jar'), 'PK');
      const knownPaths = ['pom.xml', '.gitignore', 'AGENTS.md', 'bin/widgets.jar'];
      const partial = (await scan({ repoPath: root, knownPaths, knownPathsComplete: false })).issues
        .find((i) => i.id === 'security-pack-unignored-dirs');
      expect(partial).toBeUndefined();
      // The same listing, declared complete, is plain build output.
      const complete = (await scan({ repoPath: root, knownPaths, knownPathsComplete: true })).issues
        .find((i) => i.id === 'security-pack-unignored-dirs');
      expect(complete?.evidence).toEqual([
        'Directory "bin" exists but is not ignored in .gitignore; it holds 1 tracked file(s), so ignoring it does not untrack them.',
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('still reports dist and obj under a partial inventory, but never as auto-applicable (pcic-1ik0.19)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-partial-family-'));
    try {
      fs.writeFileSync(path.join(root, 'App.csproj'), '<Project/>\n');
      fs.writeFileSync(path.join(root, '.gitignore'), '.promptci/\n');
      fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Agents\n\nRun `dotnet build` before you push.\n');
      fs.mkdirSync(path.join(root, 'obj'));
      fs.writeFileSync(path.join(root, 'obj', 'project.assets.json'), '{}');
      fs.mkdirSync(path.join(root, 'dist'));
      fs.writeFileSync(path.join(root, 'dist', 'app.js'), '1;');
      const knownPaths = ['App.csproj', '.gitignore', 'AGENTS.md', 'obj/project.assets.json', 'dist/app.js'];
      const partial = (await scan({ repoPath: root, knownPaths, knownPathsComplete: false })).issues
        .find((i) => i.id === 'security-pack-unignored-dirs');
      expect(partial?.evidence).toEqual([
        'Directory "dist" exists but is not ignored in .gitignore.',
        'Directory "obj" exists but is not ignored in .gitignore.',
      ]);
      expect(partial?.autoApplySafe).toBe(false);
      // The same listing, declared complete, says the files are tracked, so it is never auto-applicable either (#212).
      const complete = (await scan({ repoPath: root, knownPaths, knownPathsComplete: true })).issues
        .find((i) => i.id === 'security-pack-unignored-dirs');
      expect(complete?.autoApplySafe).toBe(false);
      expect(complete?.evidence).toEqual([
        'Directory "dist" exists but is not ignored in .gitignore; it holds 1 tracked file(s), so ignoring it does not untrack them.',
        'Directory "obj" exists but is not ignored in .gitignore; it holds 1 tracked file(s), so ignoring it does not untrack them.',
      ]);
      expect(complete?.recommendation).toContain('git rm -r --cached dist obj');
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
      // pcic-1ik0.22: reported, but a local scan cannot tell this from a committed tool, so no one-click fix.
      expect(issue?.autoApplySafe).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
