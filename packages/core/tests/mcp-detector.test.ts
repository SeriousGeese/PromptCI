import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import { detectMcpTooling } from '../src/mcp-detector.js';
import type { InstructionFile } from '../src/types.js';
import type { RepoContext } from '../src/repo-context.js';

vi.mock('node:fs');

function makeFile(content: string, path = '/repo/CLAUDE.md'): InstructionFile {
  return {
    path,
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
    estimatedInstructionTokens: 200,
    instructionFileCount: 1,
    largestInstructionFiles: [],
  },
};

describe('detectMcpTooling', () => {
  it('flags read all docs when docs folder exists', () => {
    vi.mocked(fs.existsSync).mockImplementation((p: string) => {
      const normalized = p.replace(/\\/g, '/');
      if (normalized.endsWith('/docs') || normalized.endsWith('/doc')) return true;
      return false;
    });

    const context: RepoContext = {
      ...mockContext,
      files: [makeFile('# Rules\nRead all docs before starting work.')],
    };
    const issues = detectMcpTooling(context);
    expect(issues.some(i => i.id.startsWith('mcp-tooling-expensive-read-all-docs'))).toBe(true);
  });

  it('does not flag read all docs when no docs folder exists', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const context: RepoContext = {
      ...mockContext,
      files: [makeFile('# Rules\nRead all docs before starting work.')],
    };
    const issues = detectMcpTooling(context);
    expect(issues.length).toBe(0);
  });

  it('flags always include all schema files when database dir exists', () => {
    vi.mocked(fs.existsSync).mockImplementation((p: string) => {
      const normalized = p.replace(/\\/g, '/');
      if (normalized.endsWith('/supabase')) return true;
      return false;
    });

    const context: RepoContext = {
      ...mockContext,
      files: [makeFile('# Rules\nAlways include all schema files in queries.')],
    };
    const issues = detectMcpTooling(context);
    expect(issues.some(i => i.id.startsWith('mcp-tooling-expensive-always-include-all-schema-files'))).toBe(true);
  });

  it('does not flag targeted retrieval instructions', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    const context: RepoContext = {
      ...mockContext,
      files: [makeFile('# Rules\nUse rg to find relevant files first.')],
    };
    const issues = detectMcpTooling(context);
    expect(issues.length).toBe(0);
  });

  it('customizes codebase reading warnings when in a monorepo', () => {
    vi.mocked(fs.existsSync).mockImplementation((p: string) => {
      const normalized = p.replace(/\\/g, '/');
      if (normalized.endsWith('/packages') || normalized.endsWith('/pnpm-workspace.yaml')) return true;
      return false;
    });

    const context: RepoContext = {
      ...mockContext,
      files: [makeFile('# Rules\nLoad the entire codebase before editing.')],
    };
    const issues = detectMcpTooling(context);
    const issue = issues.find(i => i.id.startsWith('mcp-tooling-expensive-load-the-entire-codebase'));
    expect(issue).toBeDefined();
    expect(issue?.recommendation).toContain('monorepo');
    expect(issue?.fixRecipe).toContain('directory listing MCP');
  });

  it('customizes codebase reading warnings when an MCP config exists', () => {
    vi.mocked(fs.existsSync).mockImplementation((p: string) => {
      const normalized = p.replace(/\\/g, '/');
      if (normalized.endsWith('/mcp-config.json')) return true;
      return false;
    });

    const context: RepoContext = {
      ...mockContext,
      files: [makeFile('# Rules\nLoad the entire codebase.')],
    };
    const issues = detectMcpTooling(context);
    const issue = issues.find(i => i.id.startsWith('mcp-tooling-expensive-load-the-entire-codebase'));
    expect(issue).toBeDefined();
    expect(issue?.recommendation).toContain('configured MCP server tools');
  });

  it('customizes schema warnings when an MCP config exists', () => {
    vi.mocked(fs.existsSync).mockImplementation((p: string) => {
      const normalized = p.replace(/\\/g, '/');
      if (normalized.endsWith('/supabase') || normalized.endsWith('/mcp-config.json')) return true;
      return false;
    });

    const context: RepoContext = {
      ...mockContext,
      files: [makeFile('# Rules\nAlways include all schema files in queries.')],
    };
    const issues = detectMcpTooling(context);
    const issue = issues.find(i => i.id.startsWith('mcp-tooling-expensive-always-include-all-schema-files'));
    expect(issue).toBeDefined();
    expect(issue?.recommendation).toContain('database MCP server');
  });
});

// ── Empty files guard ─────────────────────────────────────────────────────────

describe('detectMcpTooling — empty files', () => {
  it('returns empty array when context has no files', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const context: RepoContext = { ...mockContext, files: [] };
    expect(detectMcpTooling(context)).toEqual([]);
  });
});

// ── Package.json Supabase DB signal ───────────────────────────────────────────

describe('detectMcpTooling — package.json Supabase signal', () => {
  it('detects hasDbDir from @supabase/supabase-js in a package.json context file', () => {
    // No supabase/prisma/db directory on disk — DB signal comes from package.json content
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const packageJsonFile: InstructionFile = {
      path: '/repo/package.json',
      fileType: 'unknown',
      content: '{"dependencies":{"@supabase/supabase-js":"^2.0.0"}}',
      sections: [],
      lineCount: 1,
      charCount: 50,
      estimatedTokens: 13,
    };

    const context: RepoContext = {
      ...mockContext,
      files: [
        packageJsonFile,
        makeFile('# Rules\nAlways include all schema files in queries.'),
      ],
    };
    const issues = detectMcpTooling(context);
    expect(issues.some(i => i.id.startsWith('mcp-tooling-expensive-always-include-all-schema-files'))).toBe(true);
  });
});

// ── schema.prisma hasSchemas customization ────────────────────────────────────

describe('detectMcpTooling — schema.prisma customization', () => {
  it('detects hasDbDir from parsed package.json dependencies when package.json is not scanned', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const context: RepoContext = {
      ...mockContext,
      files: [
        makeFile('# Rules\nAlways include all schema files in queries.'),
      ],
      packageJson: {
        ...mockContext.packageJson,
        dependencies: {
          '@supabase/supabase-js': '^2.0.0',
        },
      },
    };
    const issues = detectMcpTooling(context);
    expect(issues.some(i => i.id.startsWith('mcp-tooling-expensive-always-include-all-schema-files'))).toBe(true);
  });

  it('uses on-demand recommendation when schema.prisma is present in context files (no MCP config)', () => {
    vi.mocked(fs.existsSync).mockImplementation((p: string) => {
      const normalized = p.replace(/\\/g, '/');
      // supabase dir exists (hasDbDir), no MCP config, no schema.graphql/openapi/swagger on disk
      if (normalized.endsWith('/supabase')) return true;
      return false;
    });

    const schemaPrismaFile: InstructionFile = {
      path: '/repo/prisma/schema.prisma',
      fileType: 'unknown',
      content: 'model User { id Int @id }',
      sections: [],
      lineCount: 1,
      charCount: 24,
      estimatedTokens: 6,
    };

    const context: RepoContext = {
      ...mockContext,
      files: [
        schemaPrismaFile,
        makeFile('# Rules\nAlways include all schema files in queries.'),
      ],
    };
    const issues = detectMcpTooling(context);
    const issue = issues.find(i => i.id.startsWith('mcp-tooling-expensive-always-include-all-schema-files'));
    expect(issue).toBeDefined();
    expect(issue?.recommendation).toContain('on-demand');
    expect(issue?.fixRecipe).toContain('on-demand');
  });
});

// ── All expensive patterns ────────────────────────────────────────────────────

describe('detectMcpTooling — all expensive patterns', () => {
  it('flags "paste the full logs" pattern', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const context: RepoContext = {
      ...mockContext,
      files: [makeFile('# Debugging\nIf a command fails, paste the full logs into the chat.')],
    };
    const issues = detectMcpTooling(context);
    expect(issues.some(i => i.id.startsWith('mcp-tooling-expensive-paste-the-full-logs'))).toBe(true);
  });

  it('flags "read every file" pattern', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const context: RepoContext = {
      ...mockContext,
      files: [makeFile('# Setup\nBefore making changes, read every file in the src directory.')],
    };
    const issues = detectMcpTooling(context);
    expect(issues.some(i => i.id.startsWith('mcp-tooling-expensive-read-every-file'))).toBe(true);
  });

  it('customizes "read every file" warning in a monorepo', () => {
    vi.mocked(fs.existsSync).mockImplementation((p: string) => {
      const normalized = p.replace(/\\/g, '/');
      if (normalized.endsWith('/packages') || normalized.endsWith('/apps')) return true;
      return false;
    });
    const context: RepoContext = {
      ...mockContext,
      files: [makeFile('# Setup\nBefore editing, read every file in the repo.')],
    };
    const issues = detectMcpTooling(context);
    const issue = issues.find(i => i.id.startsWith('mcp-tooling-expensive-read-every-file'));
    expect(issue).toBeDefined();
    expect(issue?.recommendation).toContain('monorepo');
    expect(issue?.fixRecipe).toContain('directory listing MCP');
  });

  it('flags "load the entire codebase" pattern', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const context: RepoContext = {
      ...mockContext,
      files: [makeFile('# Setup\nLoad the entire codebase before starting any task.')],
    };
    const issues = detectMcpTooling(context);
    expect(issues.some(i => i.id.startsWith('mcp-tooling-expensive-load-the-entire-codebase'))).toBe(true);
  });

  // ── B4: id must not collide across two files of the same fileType ─────────

  it('B4: emits a distinct id for two different "claude"-fileType files with the same expensive pattern', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const context: RepoContext = {
      ...mockContext,
      files: [
        makeFile('# Setup\nLoad the entire codebase before starting any task.', '/repo/CLAUDE.md'),
        makeFile('# Notes\nLoad the entire codebase before any refactor.', '/repo/.claude/notes.md'),
      ],
    };
    const issues = detectMcpTooling(context);
    const matches = issues.filter((i) => i.id.startsWith('mcp-tooling-expensive-load-the-entire-codebase'));
    expect(matches).toHaveLength(2);
    expect(matches[0]!.id).not.toBe(matches[1]!.id);
  });
});

// BUG-20: report readers were shown the detector's own regex source as the
// justification for a finding.
describe('detectMcpTooling — evidence formatting', () => {
  it('quotes the offending instruction text instead of the regex source', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const file = makeFile('# Rules\nBefore answering, load the entire codebase into context.\n');
    const issues = detectMcpTooling({ ...mockContext, files: [file] });

    expect(issues.length).toBeGreaterThan(0);
    const evidence = issues[0].evidence[0];
    expect(evidence).toContain('load the entire codebase');
    expect(evidence).not.toContain('Matched pattern:');
    expect(evidence).not.toMatch(/\[bsdw]|\(\?:/);
  });
});
