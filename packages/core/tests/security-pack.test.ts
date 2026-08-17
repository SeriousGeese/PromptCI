import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import { detectSecurityPack } from '../src/security-pack.js';
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

describe('detectSecurityPack', () => {
  it('returns no issues for empty input', () => {
    expect(detectSecurityPack({ ...mockContext, files: [] })).toEqual([]);
  });

  describe('Secret Safeguard', () => {
    it('flags missing secret safeguard when .env exists', () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(true); // .env
      const context = {
        ...mockContext,
        files: [makeFile('# Rules\nUse TypeScript.')],
      };
      const issues = detectSecurityPack(context);
      expect(issues.some(i => i.title.includes('secret safeguard'))).toBe(true);
    });

    it('does NOT flag when secret safeguard is present', () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(true); // .env
      const context = {
        ...mockContext,
        files: [makeFile('# Rules\nNever print or commit secrets.')],
      };
      const issues = detectSecurityPack(context);
      expect(issues.some(i => i.title.includes('secret safeguard'))).toBe(false);
    });
  });

  describe('Supabase Safeguard', () => {
    it('flags missing supabase safeguard when supabase/migrations exists', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: string) => 
        p.replace(/\\/g, '/').includes('supabase/migrations')
      );
      const context = {
        ...mockContext,
        files: [makeFile('# Rules\nUse TypeScript.')],
      };
      const issues = detectSecurityPack(context);
      expect(issues.some(i => i.title.includes('Supabase service role'))).toBe(true);
    });

    it('does NOT flag when supabase safeguard is present', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: string) => 
        p.replace(/\\/g, '/').includes('supabase/migrations')
      );
      const context = {
        ...mockContext,
        files: [makeFile('# Rules\nSupabase service role key must stay server-side.')],
      };
      const issues = detectSecurityPack(context);
      expect(issues.some(i => i.title.includes('Supabase service role'))).toBe(false);
    });

    it('flags missing supabase safeguard from parsed @supabase dependency facts', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const context = {
        ...mockContext,
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
      vi.mocked(fs.existsSync).mockImplementation((p: string) => 
        p.replace(/\\/g, '/').includes('.promptci')
      );
      const context = {
        ...mockContext,
        files: [makeFile('# Rules\nUse TypeScript.')],
      };
      const issues = detectSecurityPack(context);
      expect(issues.some(i => i.title.includes('.promptci/ reports'))).toBe(true);
    });

    it('does NOT flag when .promptci/ safeguard is present', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: string) => 
        p.replace(/\\/g, '/').includes('.promptci')
      );
      const context = {
        ...mockContext,
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
      vi.mocked(fs.existsSync).mockImplementation((p: string) => {
        const normalized = p.replace(/\\/g, '/');
        if (normalized.endsWith('.gitignore')) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
        const normalized = String(p).replace(/\\/g, '/');
        if (normalized.endsWith('.gitignore')) return 'node_modules/';
        return '';
      });

      const context = {
        ...mockContext,
        files: [makeFile('# Rules\nUse TypeScript.')],
      };
      const issues = detectSecurityPack(context);
      expect(issues.some(i => i.id === 'security-pack-no-promptci-gitignore')).toBe(true);
    });

    it('does not flag when .promptci/ is ignored in .gitignore', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: string) => {
        const normalized = p.replace(/\\/g, '/');
        if (normalized.endsWith('.gitignore')) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
        const normalized = String(p).replace(/\\/g, '/');
        if (normalized.endsWith('.gitignore')) return '.promptci/\nnode_modules/';
        return '';
      });

      const context = {
        ...mockContext,
        files: [makeFile('# Rules\nUse TypeScript.')],
      };
      const issues = detectSecurityPack(context);
      expect(issues.some(i => i.id === 'security-pack-no-promptci-gitignore')).toBe(false);
    });

    it('flags unignored build/coverage directories', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: string) => {
        const normalized = p.replace(/\\/g, '/');
        if (normalized.endsWith('.gitignore')) return true;
        if (normalized.endsWith('/coverage') || normalized.endsWith('/dist')) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
        const normalized = String(p).replace(/\\/g, '/');
        if (normalized.endsWith('.gitignore')) return 'node_modules/\n.promptci/';
        return '';
      });
      vi.mocked(fs.statSync).mockImplementation(() => {
        return { isDirectory: () => true } as unknown as fs.Stats;
      });

      const context = {
        ...mockContext,
        files: [makeFile('# Rules\nUse TypeScript.')],
      };
      const issues = detectSecurityPack(context);
      const unignoredIssue = issues.find(i => i.id === 'security-pack-unignored-dirs');
      expect(unignoredIssue).toBeDefined();
      expect(unignoredIssue?.evidence.some(e => e.includes('coverage'))).toBe(true);
      expect(unignoredIssue?.evidence.some(e => e.includes('dist'))).toBe(true);
    });

    it('flags broad include pattern scanning generated directories', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: string) => {
        const normalized = p.replace(/\\/g, '/');
        if (normalized.endsWith('.gitignore')) return true;
        if (normalized.endsWith('.promptci/config.json')) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
        const normalized = String(p).replace(/\\/g, '/');
        if (normalized.endsWith('.gitignore')) return '.promptci/';
        if (normalized.endsWith('.promptci/config.json')) {
          return JSON.stringify({ include: ['**/*'] });
        }
        return '';
      });

      const context = {
        ...mockContext,
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
      vi.mocked(fs.existsSync).mockImplementation((p: string) => {
        const normalized = p.replace(/\\/g, '/');
        return normalized.endsWith('.gitignore');
      });
      vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
        const normalized = String(p).replace(/\\/g, '/');
        if (normalized.endsWith('.gitignore')) return '!.promptci/\nnode_modules/';
        return '';
      });

      const context = { ...mockContext, files: [makeFile('# Rules\nUse TypeScript.')] };
      const issues = detectSecurityPack(context);
      expect(issues.some((i) => i.id === 'security-pack-no-promptci-gitignore')).toBe(true);
    });

    it('does NOT let "distribution.md" satisfy the "dist" unignored-dir check', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: string) => {
        const normalized = p.replace(/\\/g, '/');
        if (normalized.endsWith('.gitignore')) return true;
        if (normalized.endsWith('/dist')) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
        const normalized = String(p).replace(/\\/g, '/');
        if (normalized.endsWith('.gitignore')) return '.promptci/\ndistribution.md';
        return '';
      });
      vi.mocked(fs.statSync).mockImplementation(() => ({ isDirectory: () => true } as unknown as fs.Stats));

      const context = { ...mockContext, files: [makeFile('# Rules\nUse TypeScript.')] };
      const issues = detectSecurityPack(context);
      const unignoredIssue = issues.find((i) => i.id === 'security-pack-unignored-dirs');
      expect(unignoredIssue).toBeDefined();
      expect(unignoredIssue?.evidence.some((e) => e.includes('"dist"'))).toBe(true);
    });

    it('does NOT let "builds-notes/" satisfy the "build" unignored-dir check', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: string) => {
        const normalized = p.replace(/\\/g, '/');
        if (normalized.endsWith('.gitignore')) return true;
        if (normalized.endsWith('/build')) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
        const normalized = String(p).replace(/\\/g, '/');
        if (normalized.endsWith('.gitignore')) return '.promptci/\nbuilds-notes/';
        return '';
      });
      vi.mocked(fs.statSync).mockImplementation(() => ({ isDirectory: () => true } as unknown as fs.Stats));

      const context = { ...mockContext, files: [makeFile('# Rules\nUse TypeScript.')] };
      const issues = detectSecurityPack(context);
      const unignoredIssue = issues.find((i) => i.id === 'security-pack-unignored-dirs');
      expect(unignoredIssue).toBeDefined();
      expect(unignoredIssue?.evidence.some((e) => e.includes('"build"'))).toBe(true);
    });

    it('still recognizes a genuine exact "dist" gitignore entry as ignoring it', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: string) => {
        const normalized = p.replace(/\\/g, '/');
        if (normalized.endsWith('.gitignore')) return true;
        if (normalized.endsWith('/dist')) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
        const normalized = String(p).replace(/\\/g, '/');
        if (normalized.endsWith('.gitignore')) return '.promptci/\ndist/';
        return '';
      });
      vi.mocked(fs.statSync).mockImplementation(() => ({ isDirectory: () => true } as unknown as fs.Stats));

      const context = { ...mockContext, files: [makeFile('# Rules\nUse TypeScript.')] };
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
