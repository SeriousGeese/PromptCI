import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import { runFrameworkPacks } from '../src/framework-packs.js';
import type { InstructionFile } from '../src/types.js';
import type { RepoContext } from '../src/repo-context.js';

vi.mock('node:fs');

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
  metrics: {
    estimatedInstructionTokens: 0,
    instructionFileCount: 0,
    largestInstructionFiles: [],
  },
};

describe('Framework Packs', () => {
  describe('Next.js Pack', () => {
    it('flags missing App Router guidance when app/ exists', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: string) => 
        p.replace(/\\/g, '/') === '/repo/app'
      );
      const context: RepoContext = {
        ...mockContext,
        packageJson: { ...mockContext.packageJson, dependencies: { 'next': '14.0.0' } },
        files: [makeFile('# Rules\nUse TypeScript.')],
      };
      const issues = runFrameworkPacks(context);
      expect(issues.some(i => i.id === 'nextjs-missing-app-router-guidance')).toBe(true);
    });

    it('flags missing App Router guidance for an apps/web Next.js app', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: string) => {
        const normalized = p.replace(/\\/g, '/');
        return normalized.includes('/repo/apps/web/next.config.ts') ||
          normalized.includes('/repo/apps/web/src/app');
      });
      const context: RepoContext = {
        ...mockContext,
        files: [makeFile('# Rules\nUse TypeScript.')],
      };
      const issues = runFrameworkPacks(context);
      expect(issues.some(i => i.id === 'nextjs-missing-app-router-guidance')).toBe(true);
    });

    it('flags stale Pages Router guidance when only app/ exists', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: string) => 
        p.replace(/\\/g, '/') === '/repo/app'
      );
      const context: RepoContext = {
        ...mockContext,
        packageJson: { ...mockContext.packageJson, dependencies: { 'next': '14.0.0' } },
        files: [makeFile('# Rules\nUse getStaticProps for data fetching.')],
      };
      const issues = runFrameworkPacks(context);
      expect(issues.some(i => i.id === 'nextjs-stale-pages-router-guidance')).toBe(true);
    });

    it('does not flag when guidance is present', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: string) => 
        p.replace(/\\/g, '/') === '/repo/app'
      );
      const context: RepoContext = {
        ...mockContext,
        packageJson: { ...mockContext.packageJson, dependencies: { 'next': '14.0.0' } },
        files: [makeFile('# Rules\nUse App Router and Server Components.')],
      };
      const issues = runFrameworkPacks(context);
      expect(issues.some(i => i.id.startsWith('nextjs'))).toBe(false);
    });
  });

  describe('Python Pack', () => {
    it('flags missing pytest guidance when pytest in deps', () => {
      const context: RepoContext = {
        ...mockContext,
        manifests: { pyproject: 'dependencies = ["pytest"]' },
        files: [makeFile('# Rules\nUse Python.')],
      };
      const issues = runFrameworkPacks(context);
      expect(issues.some(i => i.id === 'python-missing-pytest-guidance')).toBe(true);
    });

    it('flags multiple environment managers', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: string) => 
        p.replace(/\\/g, '/').includes('Pipfile') || p.replace(/\\/g, '/').includes('environment.yml')
      );
      const context: RepoContext = {
        ...mockContext,
        files: [],
      };
      const issues = runFrameworkPacks(context);
      const envIssue = issues.find(i => i.id === 'python-multiple-env-managers');
      expect(envIssue).toBeDefined();
      const normalizedPaths = envIssue!.filePaths.map((p) => p.replace(/\\/g, '/'));
      expect(normalizedPaths).toContain('/repo/Pipfile');
      expect(normalizedPaths).toContain('/repo/environment.yml');
    });

    it('does not flag when pytest guidance is present', () => {
      const context: RepoContext = {
        ...mockContext,
        manifests: { pyproject: 'dependencies = ["pytest"]' },
        files: [makeFile('# Rules\nRun tests with pytest.')],
      };
      const issues = runFrameworkPacks(context);
      expect(issues.some(i => i.id === 'python-missing-pytest-guidance')).toBe(false);
    });
  });

  describe('Unity Pack', () => {
    it('flags missing Unity guidance when assets exist', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: string) => 
        p.replace(/\\/g, '/').includes('/repo/Assets') || p.replace(/\\/g, '/').includes('ProjectVersion.txt')
      );
      const context: RepoContext = {
        ...mockContext,
        projectType: 'unity',
        files: [makeFile('# Rules\nUse C#.')],
      };
      const issues = runFrameworkPacks(context);
      expect(issues.some(i => i.id === 'unity-missing-monobehaviour-guidance')).toBe(true);
      expect(issues.some(i => i.id === 'unity-missing-serialization-guidance')).toBe(true);
      expect(issues.some(i => i.id === 'unity-missing-test-guidance')).toBe(true);
    });

    it('flags missing MonoBehaviour lifecycle guidance for a bare MonoBehaviour mention', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: string) =>
        p.replace(/\\/g, '/').includes('/repo/Assets') || p.replace(/\\/g, '/').includes('ProjectVersion.txt')
      );
      const context: RepoContext = {
        ...mockContext,
        projectType: 'unity',
        files: [makeFile('# Rules\nMonoBehaviour components exist. Use [SerializeField]. Run Unity Test Runner.')],
      };
      const issues = runFrameworkPacks(context);
      expect(issues.some(i => i.id === 'unity-missing-monobehaviour-guidance')).toBe(true);
    });

    it('does not flag when Unity guidance is present', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: string) =>
        p.replace(/\\/g, '/').includes('/repo/Assets') || p.replace(/\\/g, '/').includes('ProjectVersion.txt')
      );
      const context: RepoContext = {
        ...mockContext,
        projectType: 'unity',
        files: [makeFile('# Rules\nAvoid empty Update in MonoBehaviour. Expose via SerializeField. Test in Play Mode.')],
      };
      const issues = runFrameworkPacks(context);
      expect(issues.some(i => i.id.startsWith('unity'))).toBe(false);
    });

    it('FW2: still flags missing serialization guidance when the only Unity signal is a bare "prefab" mention', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: string) =>
        p.replace(/\\/g, '/').includes('/repo/Assets') || p.replace(/\\/g, '/').includes('ProjectVersion.txt')
      );
      const context: RepoContext = {
        ...mockContext,
        projectType: 'unity',
        files: [makeFile('# Rules\nWe use prefabs for reusable UI components.')],
      };
      const issues = runFrameworkPacks(context);
      // Old bug: the bare word "prefab" both enabled the Unity pack AND
      // satisfied the serialization-guidance check with the SAME match, so
      // this warning could never fire when "prefab" was the only signal.
      expect(issues.some(i => i.id === 'unity-missing-serialization-guidance')).toBe(true);
    });

    it('FW2: does NOT flag serialization guidance when real prefab-safety guidance is present', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: string) =>
        p.replace(/\\/g, '/').includes('/repo/Assets') || p.replace(/\\/g, '/').includes('ProjectVersion.txt')
      );
      const context: RepoContext = {
        ...mockContext,
        projectType: 'unity',
        files: [makeFile('# Rules\nFollow prefab safety rules: never edit .meta files manually.')],
      };
      const issues = runFrameworkPacks(context);
      expect(issues.some(i => i.id === 'unity-missing-serialization-guidance')).toBe(false);
    });
  });

  describe('.NET Pack', () => {
    it('flags missing validation commands and obsolete framework refs', () => {
      vi.mocked(fs.readdirSync).mockImplementation(() => ['MyProj.csproj'] as unknown as string[]);
      vi.mocked(fs.readFileSync).mockImplementation(() => '<TargetFramework>net8.0</TargetFramework>');
      const context: RepoContext = {
        ...mockContext,
        projectType: 'dotnet',
        files: [makeFile('# Rules\nTarget netcoreapp3.1 API version.')],
      };
      const issues = runFrameworkPacks(context);
      expect(issues.some(i => i.id === 'dotnet-missing-validation-commands')).toBe(true);
      expect(issues.some(i => i.id === 'dotnet-obsolete-framework-reference')).toBe(true);
    });

    it('does not flag when dotnet commands and current framework version are correct', () => {
      vi.mocked(fs.readdirSync).mockImplementation(() => ['MyProj.csproj'] as unknown as string[]);
      vi.mocked(fs.readFileSync).mockImplementation(() => '<TargetFramework>net8.0</TargetFramework>');
      const context: RepoContext = {
        ...mockContext,
        projectType: 'dotnet',
        files: [makeFile('# Rules\nTarget net8.0 as framework. Before finishing run dotnet build && dotnet test.')],
      };
      const issues = runFrameworkPacks(context);
      expect(issues.some(i => i.id.startsWith('dotnet'))).toBe(false);
    });

    it('flags obsolete framework refs for a net10.0 project', () => {
      vi.mocked(fs.readdirSync).mockImplementation(() => ['MyProj.csproj'] as unknown as string[]);
      vi.mocked(fs.readFileSync).mockImplementation(() => '<TargetFramework>net10.0</TargetFramework>');
      const context: RepoContext = {
        ...mockContext,
        projectType: 'dotnet',
        files: [makeFile('# Rules\nTarget netcoreapp3.1 API version. Run dotnet build && dotnet test.')],
      };
      const issues = runFrameworkPacks(context);
      expect(issues.some(i => i.id === 'dotnet-obsolete-framework-reference')).toBe(true);
    });
  });

  describe('Go Pack', () => {
    it('flags missing Go testing commands when go.mod exists', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: string) => 
        p.replace(/\\/g, '/').includes('go.mod')
      );
      const context: RepoContext = {
        ...mockContext,
        files: [makeFile('# Rules\nWrite Go code.')],
      };
      const issues = runFrameworkPacks(context);
      expect(issues.some(i => i.id === 'go-missing-testing-commands')).toBe(true);
    });

    it('does not treat cargo test as go test', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: string) =>
        p.replace(/\\/g, '/').includes('go.mod')
      );
      const context: RepoContext = {
        ...mockContext,
        files: [makeFile('# Rules\nRun cargo test before merging.')],
      };
      const issues = runFrameworkPacks(context);
      expect(issues.some(i => i.id === 'go-missing-testing-commands')).toBe(true);
    });

    it('does not flag when go test is in instructions', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: string) =>
        p.replace(/\\/g, '/').includes('go.mod')
      );
      const context: RepoContext = {
        ...mockContext,
        files: [makeFile('# Rules\nRun go test ./... before merge.')],
      };
      const issues = runFrameworkPacks(context);
      expect(issues.some(i => i.id.startsWith('go'))).toBe(false);
    });

    it('FW1: does NOT enable the Go pack for prose like "let\'s go build something" with no go.mod', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false); // no go.mod anywhere
      const context: RepoContext = {
        ...mockContext,
        files: [makeFile("# Rules\nOkay, let's go build something great today!")],
      };
      const issues = runFrameworkPacks(context);
      // Old bug: `\bgo\s+(build|test|run|get|mod)\b` matched "go build" inside
      // this sentence, enabling the whole Go pack in a non-Go repo.
      expect(issues.some(i => i.id.startsWith('go'))).toBe(false);
    });

    it('FW1: still enables the Go pack for a backtick-quoted go command with no go.mod detected', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false); // go.mod not found on disk
      const context: RepoContext = {
        ...mockContext,
        files: [makeFile('# Rules\nRun `go build ./...` to compile.')],
      };
      const issues = runFrameworkPacks(context);
      // "go build" is backtick-quoted (a command context), so it should still
      // count as a real Go signal and enable the pack.
      expect(issues.some(i => i.id === 'go-missing-testing-commands')).toBe(true);
    });
  });

  describe('Rust Pack', () => {
    it('flags missing cargo verification and rust version mismatch', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: string) => 
        p.replace(/\\/g, '/').includes('Cargo.toml')
      );
      vi.mocked(fs.readFileSync).mockImplementation(() => 'rust-version = "1.75"');
      const context: RepoContext = {
        ...mockContext,
        files: [makeFile('# Rules\nRust 1.70 is standard.')],
      };
      const issues = runFrameworkPacks(context);
      expect(issues.some(i => i.id === 'rust-missing-verification-commands')).toBe(true);
      expect(issues.some(i => i.id === 'rust-version-mismatch')).toBe(true);
    });

    it('does not flag when cargo commands and MSRV are aligned', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: string) => 
        p.replace(/\\/g, '/').includes('Cargo.toml')
      );
      vi.mocked(fs.readFileSync).mockImplementation(() => 'rust-version = "1.75"');
      const context: RepoContext = {
        ...mockContext,
        files: [makeFile('# Rules\nRust 1.75 is the MSRV. Run cargo clippy && cargo test.')],
      };
      const issues = runFrameworkPacks(context);
      expect(issues.some(i => i.id.startsWith('rust'))).toBe(false);
    });

    it('does not flag semver patch differences when major.minor MSRV matches', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: string) =>
        p.replace(/\\/g, '/').includes('Cargo.toml')
      );
      vi.mocked(fs.readFileSync).mockImplementation(() => 'rust-version = "1.82.0"');
      const context: RepoContext = {
        ...mockContext,
        files: [makeFile('# Rules\nRust 1.82 is the MSRV. Run cargo clippy && cargo test.')],
      };
      const issues = runFrameworkPacks(context);
      expect(issues.some(i => i.id === 'rust-version-mismatch')).toBe(false);
    });
  });
});
