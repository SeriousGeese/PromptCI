import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import { detectSecurityPack } from '../src/security-pack.js';
import { emptyAiConfigFiles } from '../src/ai-config.js';
import type { InstructionFile } from '../src/types.js';
import type { RepoContext } from '../src/repo-context.js';
import { RepoTree } from '../src/repo-tree.js';

vi.mock('node:fs');

/**
 * pcic-e6xa: every existence signal the security pack reads (`.env`,
 * `supabase/migrations`, `.promptci`, a build directory) and every file it
 * reads (`.gitignore`, `.promptci/config.json`) now goes through the scan's
 * tree rather than `fs.existsSync`/`fs.readFileSync` directly. These tests
 * state the repository as a path -> content map and hand it over as a complete
 * `knownPaths` inventory (pcic-csf): the fixture IS what the detector sees, and
 * a path ending in `/` is a directory with nothing readable in it.
 */
function repo(files: Record<string, string>): RepoTree {
  const knownPaths = Object.keys(files).map((rel) => (rel.endsWith('/') ? rel + '.keep' : rel));
  vi.mocked(fs.readFileSync).mockImplementation((target: unknown) => {
    // `/repo` resolves to `C:/repo` on Windows, so match the root by suffix.
    const rel = String(target).replace(/\\/g, '/').replace(/^.*\/repo\//, '');
    return files[rel] ?? '';
  });
  return new RepoTree('/repo', { knownPaths, knownPathsComplete: true });
}

function makeFile(content: string, filePath = '/repo/CLAUDE.md'): InstructionFile {
  return {
    path: filePath,
    fileType: 'claude',
    content,
    sections: [],
    lineCount: content.split('\n').length,
    charCount: content.length,
    estimatedTokens: Math.round(content.length / 4),
  };
}

const mockContext: RepoContext = {
  repoRoot: '/repo',
  files: [],
  projectType: 'typescript',
  manifests: {},
  packageJson: {
    packageManagerName: 'pnpm',
    scripts: {},
    dependencies: {},
    devDependencies: {},
    peerDependencies: {},
    lockfiles: [],
  },
  workflows: { files: [], commands: [] },
  aiConfig: emptyAiConfigFiles(),
  metrics: {
    estimatedInstructionTokens: 0,
    instructionFileCount: 0,
    largestInstructionFiles: [],
  },
};

describe('detectSecurityPack', () => {
  it('returns no issues for empty input', () => {
    expect(detectSecurityPack({ ...mockContext, files: [] })).toEqual([]);
  });

  describe('Secret Safeguard', () => {
    it('flags missing secret safeguard when .env exists', () => {
      const context = {
        ...mockContext,
        tree: repo({ '.env': '' }),
        files: [makeFile('# Rules\nUse TypeScript.')],
      };
      const issues = detectSecurityPack(context);
      expect(issues.some(i => i.title.includes('secret safeguard'))).toBe(true);
    });

    it('does NOT flag when secret safeguard is present', () => {
      const context = {
        ...mockContext,
        tree: repo({ '.env': '' }),
        files: [makeFile('# Rules\nNever print or commit secrets.')],
      };
      const issues = detectSecurityPack(context);
      expect(issues.some(i => i.title.includes('secret safeguard'))).toBe(false);
    });
  });

  describe('Supabase Safeguard', () => {
    it('flags missing supabase safeguard when supabase/migrations exists', () => {
      const context = {
        ...mockContext,
        tree: repo({ 'supabase/migrations/0001_init.sql': '' }),
        files: [makeFile('# Rules\nUse TypeScript.')],
      };
      const issues = detectSecurityPack(context);
      expect(issues.some(i => i.title.includes('Supabase service role'))).toBe(true);
    });

    it('does NOT flag when supabase safeguard is present', () => {
      const context = {
        ...mockContext,
        tree: repo({ 'supabase/migrations/0001_init.sql': '' }),
        files: [makeFile('# Rules\nSupabase service role key must stay server-side.')],
      };
      const issues = detectSecurityPack(context);
      expect(issues.some(i => i.title.includes('Supabase service role'))).toBe(false);
    });

    it('flags missing supabase safeguard from parsed @supabase dependency facts', () => {
      const context = {
        ...mockContext,
        tree: repo({}),
        files: [makeFile('# Rules\nUse TypeScript.')],
        packageJson: {
          ...mockContext.packageJson,
          dependencies: { '@supabase/supabase-js': '^2.0.0' },
        },
      };
      const issues = detectSecurityPack(context);
      expect(issues.some(i => i.title.includes('Supabase service role'))).toBe(true);
    });
  });

  describe('Upload Safeguard', () => {
    it('flags missing upload boundary docs when upload feature detected', () => {
      const context = {
        ...mockContext,
        files: [
          makeFile('# Rules\nUse TypeScript.', '/repo/apps/web/src/app/api/upload/route.ts')
        ],
      };
      const issues = detectSecurityPack(context);
      expect(issues.some(i => i.title.includes('data boundary documentation'))).toBe(true);
    });

    it('does NOT flag when upload boundary docs are present', () => {
      const context = {
        ...mockContext,
        files: [
          makeFile('# Rules\nValidate user uploaded files.', '/repo/apps/web/src/app/api/upload/route.ts')
        ],
      };
      const issues = detectSecurityPack(context);
      expect(issues.some(i => i.title.includes('data boundary documentation'))).toBe(false);
    });
  });

  describe('.promptci/ Safeguard', () => {
    it('flags missing .promptci/ safeguard when folder exists', () => {
      const context = {
        ...mockContext,
        tree: repo({ '.promptci/': '' }),
        files: [makeFile('# Rules\nUse TypeScript.')],
      };
      const issues = detectSecurityPack(context);
      expect(issues.some(i => i.title.includes('.promptci/ reports'))).toBe(true);
    });

    it('does NOT flag when .promptci/ safeguard is present', () => {
      const context = {
        ...mockContext,
        tree: repo({ '.promptci/': '' }),
        files: [makeFile('# Rules\nDo not commit .promptci reports.')],
      };
      const issues = detectSecurityPack(context);
      expect(issues.some(i => i.title.includes('.promptci/ reports'))).toBe(false);
    });
  });

  describe('Destructive Commands', () => {
    it('flags rm -rf without safety language', () => {
      const context = {
        ...mockContext,
        files: [makeFile('# Clean\nRun rm -rf dist/ to clean.')],
      };
      const issues = detectSecurityPack(context);
      expect(issues.some(i => i.title.includes('rm -rf'))).toBe(true);
    });

    it('does NOT flag rm -rf with safety language', () => {
      const context = {
        ...mockContext,
        files: [makeFile('# Clean\nAsk before running rm -rf dist/ to clean.')],
      };
      const issues = detectSecurityPack(context);
      expect(issues.some(i => i.title.includes('rm -rf'))).toBe(false);
    });

    it('does not treat dangerouslySetInnerHTML as destructive-command safety language', () => {
      const context = {
        ...mockContext,
        files: [makeFile('# Clean\nRun rm -rf node_modules.\nNever use dangerouslySetInnerHTML.')],
      };
      const issues = detectSecurityPack(context);
      expect(issues.some(i => i.title.includes('rm -rf'))).toBe(true);
    });

    it('flags git push --force without safety language', () => {
      const context = {
        ...mockContext,
        files: [makeFile('# Push\nUse git push --force to update.')],
      };
      const issues = detectSecurityPack(context);
      expect(issues.some(i => i.title.includes('git push --force'))).toBe(true);
    });
  });

  describe('Cost 9 Hygiene Checks', () => {
    it('flags missing .promptci/ in .gitignore', () => {
      const context = {
        ...mockContext,
        tree: repo({ '.gitignore': 'node_modules/' }),
        files: [makeFile('# Rules\nUse TypeScript.')],
      };
      const issues = detectSecurityPack(context);
      expect(issues.some(i => i.id === 'security-pack-no-promptci-gitignore')).toBe(true);
    });

    it('does not flag when .promptci/ is ignored in .gitignore', () => {
      const context = {
        ...mockContext,
        tree: repo({ '.gitignore': '.promptci/\nnode_modules/' }),
        files: [makeFile('# Rules\nUse TypeScript.')],
      };
      const issues = detectSecurityPack(context);
      expect(issues.some(i => i.id === 'security-pack-no-promptci-gitignore')).toBe(false);
    });

    // BUG-7: the recommended pattern carves out baseline.json so the CI
    // ratchet (--baseline / --fail-on-new) can still read it.
    it('accepts the baseline-preserving .promptci/* carve-out', () => {
      const context = {
        ...mockContext,
        tree: repo({ '.gitignore': '**/.promptci/*\n!**/.promptci/baseline.json\n!**/.promptci/config.json\nnode_modules/' }),
        files: [makeFile('# Rules\nUse TypeScript.')],
      };
      const issues = detectSecurityPack(context);
      expect(issues.some(i => i.id === 'security-pack-no-promptci-gitignore')).toBe(false);
    });

    it('recommends carving out baseline.json rather than ignoring .promptci wholesale', () => {
      const context = {
        ...mockContext,
        tree: repo({ '.gitignore': 'node_modules/' }),
        files: [makeFile('# Rules\nUse TypeScript.')],
      };
      const issue = detectSecurityPack(context).find(
        i => i.id === 'security-pack-no-promptci-gitignore',
      );
      expect(issue).toBeDefined();
      expect(issue!.recommendation).toContain('!**/.promptci/baseline.json');
      expect(issue!.fixRecipe).toContain('**/.promptci/*');
      expect(issue!.fixRecipe).toContain('!**/.promptci/baseline.json');
    });

    it('flags unignored build/coverage directories', () => {
      const context = {
        ...mockContext,
        tree: repo({ '.gitignore': 'node_modules/\n.promptci/', 'coverage/': '', 'dist/': '' }),
        files: [makeFile('# Rules\nUse TypeScript.')],
      };
      const issues = detectSecurityPack(context);
      const unignoredIssue = issues.find(i => i.id === 'security-pack-unignored-dirs');
      expect(unignoredIssue).toBeDefined();
      expect(unignoredIssue?.evidence.some(e => e.includes('coverage'))).toBe(true);
      expect(unignoredIssue?.evidence.some(e => e.includes('dist'))).toBe(true);
    });

    it('flags broad include pattern scanning generated directories', () => {
      const context = {
        ...mockContext,
        tree: repo({ '.gitignore': '.promptci/', '.promptci/config.json': JSON.stringify({ include: ['**/*'] }) }),
        files: [
          makeFile('# Scanned file', '/repo/coverage/index.html'),
          makeFile('# Scanned file', '/repo/dist/bundle.md'),
          makeFile('# Scanned file', '/repo/CLAUDE.md'),
        ],
      };
      const issues = detectSecurityPack(context);
      const broadIssue = issues.find(i => i.id === 'security-pack-broad-include');
      expect(broadIssue).toBeDefined();
      expect(broadIssue?.evidence.some(e => e.includes('coverage/index.html'))).toBe(true);
      expect(broadIssue?.evidence.some(e => e.includes('dist/bundle.md'))).toBe(false);
    });

    it('flags instructions telling agents to inspect generated reports before source docs', () => {
      const context = {
        ...mockContext,
        files: [
          makeFile('# Rule\nInspect the .promptci/ report before modifying source code.', '/repo/CLAUDE.md'),
        ],
      };
      const issues = detectSecurityPack(context);
      // SP1/B3: id is now per-file (prefixed, not a bare constant) so two
      // files with this issue don't collide on one id.
      expect(issues.some(i => i.id.startsWith('security-pack-inspect-reports-first-'))).toBe(true);
    });

    it('SP1/B3: emits a distinct id for each of two files matching the inspect-reports pattern', () => {
      const context = {
        ...mockContext,
        files: [
          makeFile('# Rule\nInspect the .promptci/ report before modifying source code.', '/repo/CLAUDE.md'),
          makeFile('# Rule\nRead the .promptci/ report before touching any source code.', '/repo/AGENTS.md'),
        ],
      };
      const issues = detectSecurityPack(context);
      const matches = issues.filter((i) => i.id.startsWith('security-pack-inspect-reports-first-'));
      expect(matches).toHaveLength(2);
      expect(matches[0]!.id).not.toBe(matches[1]!.id);
    });
  });

  describe('SP2: rm -rf without trailing whitespace', () => {
    it('flags "rm -rf" at the end of a sentence (no trailing whitespace)', () => {
      const context = {
        ...mockContext,
        files: [makeFile('# Clean\nNever run rm -rf.')],
      };
      const issues = detectSecurityPack(context);
      expect(issues.some((i) => i.title.includes('rm -rf'))).toBe(true);
    });

    it('flags backticked "`rm -rf`" (end of span, no trailing whitespace)', () => {
      const context = {
        ...mockContext,
        files: [makeFile('# Clean\nDo not run `rm -rf` on this directory')],
      };
      const issues = detectSecurityPack(context);
      expect(issues.some((i) => i.title.includes('rm -rf'))).toBe(true);
    });

    it('flags the equivalent flag order "rm -fr"', () => {
      const context = {
        ...mockContext,
        files: [makeFile('# Clean\nRun rm -fr dist/ to clean.')],
      };
      const issues = detectSecurityPack(context);
      expect(issues.some((i) => i.title.includes('rm -rf'))).toBe(true);
    });
  });

  describe('SP3: .gitignore substring-matching fixes', () => {
    it('does NOT treat a negation line ("!.promptci/") as ignoring .promptci', () => {
      const context = { ...mockContext, tree: repo({ '.gitignore': '!.promptci/\nnode_modules/' }), files: [makeFile('# Rules\nUse TypeScript.')] };
      const issues = detectSecurityPack(context);
      expect(issues.some((i) => i.id === 'security-pack-no-promptci-gitignore')).toBe(true);
    });

    it('does NOT let "distribution.md" satisfy the "dist" unignored-dir check', () => {
      const context = { ...mockContext, tree: repo({ '.gitignore': '.promptci/\ndistribution.md', 'dist/': '' }), files: [makeFile('# Rules\nUse TypeScript.')] };
      const issues = detectSecurityPack(context);
      const unignoredIssue = issues.find((i) => i.id === 'security-pack-unignored-dirs');
      expect(unignoredIssue).toBeDefined();
      expect(unignoredIssue?.evidence.some((e) => e.includes('"dist"'))).toBe(true);
    });

    it('does NOT let "builds-notes/" satisfy the "build" unignored-dir check', () => {
      const context = { ...mockContext, tree: repo({ '.gitignore': '.promptci/\nbuilds-notes/', 'build/': '' }), files: [makeFile('# Rules\nUse TypeScript.')] };
      const issues = detectSecurityPack(context);
      const unignoredIssue = issues.find((i) => i.id === 'security-pack-unignored-dirs');
      expect(unignoredIssue).toBeDefined();
      expect(unignoredIssue?.evidence.some((e) => e.includes('"build"'))).toBe(true);
    });

    // #161: in a 43-repository corpus `bin` fired on 5 repositories, every time
    // for one hand-written, tracked entry script. These are those five shapes.
    const unignored = (files: Record<string, string>) =>
      detectSecurityPack({ ...mockContext, tree: repo({ '.gitignore': '.promptci/', ...files }), files: [makeFile('# Rules')] })
        .find((i) => i.id === 'security-pack-unignored-dirs');

    it.each([
      ['a CLI entry point', { 'package.json': '{"name":"x"}', 'bin/cli.mjs': '#!/usr/bin/env node' }],
      ['the target of package.json "bin"', { 'package.json': '{"name":"x","bin":"bin/mcp-read-website.js"}', 'bin/mcp-read-website.js': '' }],
      ['an extensionless CLI script', { 'package.json': '{"name":"s3p"}', 'bin/s3p': '#!/usr/bin/env node' }],
      ['a shell entry point with no manifest', { 'bin/locca': '#!/bin/sh' }],
      ['the WordPress test installer', { 'composer.json': '{}', 'bin/install-wp-tests.sh': '#!/usr/bin/env bash' }],
    ])('does NOT report a source bin/ holding %s', (_label, files) => {
      expect(unignored(files)).toBeUndefined();
    });

    it('still reports bin/ and obj/ next to a .NET project file', () => {
      const issue = unignored({ 'App.csproj': '<Project />', 'bin/': '', 'obj/': '' });
      expect(issue?.evidence).toEqual([
        'Directory "bin" exists but is not ignored in .gitignore.',
        'Directory "obj" exists but is not ignored in .gitignore.',
      ]);
    });

    it('still reports bin/ next to a Gradle or Maven build, but not obj/', () => {
      for (const build of ['build.gradle', 'build.gradle.kts', 'pom.xml']) {
        const issue = unignored({ [build]: '', 'bin/': '', 'obj/': '' });
        expect(issue?.evidence, build).toEqual(['Directory "bin" exists but is not ignored in .gitignore.']);
      }
    });

    it.each([
      ['a pom.xml', { 'pom.xml': '<project/>' }],
      ['a .csproj', { 'App.csproj': '<Project />' }],
      ['Directory.Build.props', { 'Directory.Build.props': '<Project />' }],
    ])('does NOT report a bin/ that package.json names as a bin target, even beside %s', (_label, marker) => {
      expect(unignored({ ...marker, 'package.json': '{"bin":{"x":"./bin/cli.js"}}', 'bin/cli': 'binary-looking' })).toBeUndefined();
      expect(unignored({ ...marker, 'package.json': '{"bin":"bin/x"}', 'bin/x': 'MZ' })).toBeUndefined();
    });

    it.each([
      ['a shebang script', { 'bin/tool': '#!/usr/bin/env node\nconsole.log(1)' }],
      ['a script extension', { 'bin/build.sh': 'echo hi' }],
      ['a Node entry point', { 'bin/cli.js': 'require("./x")' }],
    ])('does NOT report a bin/ holding %s beside a .NET or JVM build file', (_label, files) => {
      for (const marker of ['pom.xml', 'Directory.Build.props']) {
        expect(unignored({ [marker]: '<x/>', ...files }), marker).toBeUndefined();
      }
    });

    it('still reports a bin/ of build output (subdirectories, .dll) beside a .NET project file', () => {
      const issue = unignored({ 'App.csproj': '<Project />', 'bin/Debug/net8.0/App.dll': 'MZ', 'bin/App.pdb': 'x' });
      expect(issue?.evidence).toEqual(['Directory "bin" exists but is not ignored in .gitignore.']);
      expect(issue?.autoApplySafe).toBe(true);
    });

    it('reports dist/ beside a source bin/ and proposes ignoring only dist/', () => {
      const issue = unignored({ 'package.json': '{"name":"x","bin":"bin/cli.mjs"}', 'bin/cli.mjs': '', 'dist/': '' });
      expect(issue?.evidence).toEqual(['Directory "dist" exists but is not ignored in .gitignore.']);
      expect(issue?.fixRecipe).toBe('echo "dist/" >> .gitignore');
    });

    it('still recognizes a genuine exact "dist" gitignore entry as ignoring it', () => {
      const context = { ...mockContext, tree: repo({ '.gitignore': '.promptci/\ndist/', 'dist/': '' }), files: [makeFile('# Rules\nUse TypeScript.')] };
      const issues = detectSecurityPack(context);
      const unignoredIssue = issues.find((i) => i.id === 'security-pack-unignored-dirs');
      expect(unignoredIssue?.evidence.some((e) => e.includes('"dist"'))).toBeFalsy();
    });
  });

  describe('SP4: upload-feature path detection on Windows-style paths', () => {
    it('flags missing upload boundary docs when the path uses backslashes', () => {
      const context = {
        ...mockContext,
        files: [
          makeFile('# Rules\nUse TypeScript.', 'C:\\repo\\apps\\web\\src\\app\\api\\upload\\route.ts'),
        ],
      };
      const issues = detectSecurityPack(context);
      expect(issues.some((i) => i.title.includes('data boundary documentation'))).toBe(true);
    });
  });
});
