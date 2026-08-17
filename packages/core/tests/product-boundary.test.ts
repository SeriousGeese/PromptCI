/**
 * Tests for the Product-Boundary Drift Detector.
 *
 * Covers all spec acceptance criteria:
 *  - Filesystem evidence correctly triggers findings
 *  - Dependency-based evidence (package.json) also triggers findings
 *  - Repo WITHOUT the feature does NOT flag "do not add X yet" guidance
 *  - "Do not add another web app" does NOT flag (non-stale phrasing)
 *  - One finding per capability×file (not one per pattern)
 *  - Evidence shows the actual matched phrase, not regex source
 *  - All six capabilities: web app, Supabase, database, dashboard, upload, Playwright
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import { detectProductBoundary } from '../src/product-boundary.js';
import type { InstructionFile } from '../src/types.js';
import { parsePackageJsonFacts, type RepoContext } from '../src/repo-context.js';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

const MOCK_METRICS = {
  estimatedInstructionTokens: 0,
  instructionFileCount: 0,
  largestInstructionFiles: [],
};

function makeFile(content: string, filePath = '/repo/AGENTS.md'): InstructionFile {
  return {
    path: filePath,
    fileType: 'agents',
    content,
    sections: [],
    lineCount: content.split('\n').length,
    charCount: content.length,
    estimatedTokens: Math.round(content.length / 4),
  };
}

function makeContext(
  files: InstructionFile[],
  packageJsonRaw?: string,
  repoRoot = '/repo',
): RepoContext {
  const packageJsonFacts = parsePackageJsonFacts(packageJsonRaw, []);
  return {
    repoRoot,
    files,
    projectType: 'unknown',
    manifests: packageJsonRaw ? { packageJson: packageJsonRaw } : {},
    packageJson: packageJsonFacts,
    workflows: { files: [], commands: [] },
    metrics: MOCK_METRICS,
  };
}

/** Helper: make existsSync return true for exactly the given suffix. */
function mockExists(...suffixes: string[]): void {
  vi.mocked(fs.existsSync).mockImplementation((p: unknown) => {
    const normalized = String(p).replace(/\\/g, '/');
    return suffixes.some((s) => normalized.endsWith(s));
  });
}

/** Helper: make existsSync always return false. */
function mockNoExists(): void {
  vi.mocked(fs.existsSync).mockReturnValue(false);
}

beforeEach(() => {
  vi.resetAllMocks();
});

// ── Web App capability ────────────────────────────────────────────────────────

describe('detectProductBoundary — Web App', () => {
  it('flags "no web app exists yet" when apps/web exists', () => {
    const file = makeFile('## Current Scope\nNo web app exists yet.\n');
    mockExists('apps/web');
    const issues = detectProductBoundary(makeContext([file]));
    const issue = issues.find((i) => i.title.includes('web app'));
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('high');
    expect(issue!.category).toBe('stale_instruction');
  });

  it('flags "do not add web app" when apps/web exists', () => {
    const file = makeFile('Do not add web app until further notice.');
    mockExists('apps/web');
    const issues = detectProductBoundary(makeContext([file]));
    expect(issues.find((i) => i.title.includes('web app'))).toBeDefined();
  });

  it('flags "no web app" when next.config.ts exists', () => {
    const file = makeFile('This is a CLI-only tool. No web app.');
    mockExists('next.config.ts');
    const issues = detectProductBoundary(makeContext([file]));
    expect(issues.find((i) => i.title.includes('web app'))).toBeDefined();
  });

  it('flags "no web app" when Next.js is in package.json dependencies', () => {
    const file = makeFile('No web app at this time.');
    mockNoExists();
    const packageJson = JSON.stringify({ dependencies: { next: '^15.0.0' } });
    const issues = detectProductBoundary(makeContext([file], packageJson));
    expect(issues.find((i) => i.title.includes('web app'))).toBeDefined();
  });

  it('does NOT flag when no web app evidence exists (filesystem or deps)', () => {
    // Spec: "Repo without web app and instruction says 'do not add web app yet' should NOT flag"
    const file = makeFile('Do not add web app yet — this is a CLI-only tool for now.');
    mockNoExists();
    const issues = detectProductBoundary(makeContext([file]));
    expect(issues.find((i) => i.title.includes('web app'))).toBeUndefined();
  });

  it('does NOT flag "Do not add another web app" — ambiguous phrasing without evidence', () => {
    // Spec: should not flag unless phrasing is clearly stale
    const file = makeFile('Do not add another web app to this monorepo without approval.');
    mockNoExists();
    const issues = detectProductBoundary(makeContext([file]));
    expect(issues.find((i) => i.title.includes('web app'))).toBeUndefined();
  });

  it('does NOT flag "no web app logic" — scoped noun phrase, not a boundary claim', () => {
    const file = makeFile('The scanner contains no web app logic; it is pure TypeScript.');
    mockExists('apps/web');
    const issues = detectProductBoundary(makeContext([file]));
    expect(issues.find((i) => i.title.includes('web app'))).toBeUndefined();
  });

  it('evidence shows the actual matched phrase, not regex source', () => {
    const file = makeFile('No web app exists yet.');
    mockExists('apps/web');
    const issues = detectProductBoundary(makeContext([file]));
    const issue = issues.find((i) => i.title.includes('web app'));
    expect(issue).toBeDefined();
    // Evidence must not contain raw regex metacharacters like \b or (?:
    const evidenceText = issue!.evidence.join(' ');
    expect(evidenceText).not.toContain('\\b');
    expect(evidenceText).not.toContain('(?:');
    // It should contain the actual matched text
    expect(evidenceText.toLowerCase()).toContain('no web app');
  });

  it('emits only one finding per file even if multiple patterns match', () => {
    // Both "no web app exists yet" and "no web app" could match — only one issue per file
    const file = makeFile('No web app exists yet. No web app has been added.');
    mockExists('apps/web');
    const issues = detectProductBoundary(makeContext([file]));
    const webAppIssues = issues.filter((i) => i.title.includes('web app'));
    expect(webAppIssues).toHaveLength(1);
  });
});

// ── Supabase capability ───────────────────────────────────────────────────────

describe('detectProductBoundary — Supabase', () => {
  it('flags "no Supabase" when supabase/migrations exists', () => {
    const file = makeFile('## Current State\nNo Supabase integration yet.\n');
    mockExists('supabase/migrations');
    const issues = detectProductBoundary(makeContext([file]));
    expect(issues.find((i) => i.title.includes('Supabase'))).toBeDefined();
  });

  it('flags "no Supabase" via @supabase/* package.json dependency', () => {
    const file = makeFile('No Supabase setup is included in this project.');
    mockNoExists();
    const packageJson = JSON.stringify({
      dependencies: { '@supabase/supabase-js': '^2.0.0' },
    });
    const issues = detectProductBoundary(makeContext([file], packageJson));
    const issue = issues.find((i) => i.title.includes('Supabase'));
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('high');
  });

  it('does NOT flag when no Supabase evidence exists', () => {
    const file = makeFile('No Supabase integration at this stage.');
    mockNoExists();
    const issues = detectProductBoundary(makeContext([file]));
    expect(issues.find((i) => i.title.includes('Supabase'))).toBeUndefined();
  });
});

// ── Database capability ───────────────────────────────────────────────────────

describe('detectProductBoundary — Database', () => {
  it('flags "no database" when supabase/migrations exists', () => {
    const file = makeFile('This project has no database.');
    mockExists('supabase/migrations');
    const issues = detectProductBoundary(makeContext([file]));
    expect(issues.find((i) => i.title.includes('database'))).toBeDefined();
  });

  it('flags "database pending" when prisma exists', () => {
    const file = makeFile('Database pending — do not use Prisma yet.');
    mockExists('prisma');
    const issues = detectProductBoundary(makeContext([file]));
    expect(issues.find((i) => i.title.includes('database'))).toBeDefined();
  });

  it('flags "no database" when drizzle-orm is in dependencies', () => {
    const file = makeFile('No database in this project yet.');
    mockNoExists();
    const packageJson = JSON.stringify({ dependencies: { 'drizzle-orm': '^0.30.0' } });
    const issues = detectProductBoundary(makeContext([file], packageJson));
    expect(issues.find((i) => i.title.includes('database'))).toBeDefined();
  });

  it('does NOT flag when no database evidence exists', () => {
    const file = makeFile('No database at this stage.');
    mockNoExists();
    const issues = detectProductBoundary(makeContext([file]));
    expect(issues.find((i) => i.title.includes('database'))).toBeUndefined();
  });
});

// ── Dashboard capability ──────────────────────────────────────────────────────

describe('detectProductBoundary — Dashboard', () => {
  it('flags "dashboard pending" when dashboard route directory exists', () => {
    const file = makeFile('Dashboard pending — the reporting UI has not been built yet.');
    mockExists('apps/web/src/app/dashboard');
    const issues = detectProductBoundary(makeContext([file]));
    expect(issues.find((i) => i.title.includes('dashboard'))).toBeDefined();
  });

  it('flags "no dashboard" when upload route exists', () => {
    const file = makeFile('No dashboard is included in this release.');
    mockExists('apps/web/src/app/api/upload/route.ts');
    const issues = detectProductBoundary(makeContext([file]));
    expect(issues.find((i) => i.title.includes('dashboard'))).toBeDefined();
  });

  it('flags "no dashboard" for standard single-app Next.js dashboard routes', () => {
    const file = makeFile('No dashboard exists yet.');
    mockExists('src/app/dashboard');
    const issues = detectProductBoundary(makeContext([file]));
    expect(issues.find((i) => i.title.includes('dashboard'))).toBeDefined();
  });

  it('does NOT flag when no dashboard evidence exists', () => {
    const file = makeFile('Dashboard pending — the UI has not started yet.');
    mockNoExists();
    const issues = detectProductBoundary(makeContext([file]));
    expect(issues.find((i) => i.title.includes('dashboard'))).toBeUndefined();
  });
});

// ── Upload API capability ─────────────────────────────────────────────────────

describe('detectProductBoundary — Upload API', () => {
  it('flags "upload not implemented" when route exists', () => {
    const file = makeFile('Upload not implemented — do not add upload endpoints.');
    mockExists('apps/web/src/app/api/upload/route.ts');
    const issues = detectProductBoundary(makeContext([file]));
    expect(issues.find((i) => i.title.includes('upload'))).toBeDefined();
  });

  it('flags "no upload route" when upload directory exists', () => {
    const file = makeFile('There is no upload route in this API.');
    mockExists('apps/web/src/app/api/upload');
    const issues = detectProductBoundary(makeContext([file]));
    expect(issues.find((i) => i.title.includes('upload'))).toBeDefined();
  });

  it('flags upload contradictions for standard single-app Next.js API routes', () => {
    const file = makeFile('Upload not implemented yet.');
    mockExists('src/app/api/upload/route.ts');
    const issues = detectProductBoundary(makeContext([file]));
    expect(issues.find((i) => i.title.includes('upload'))).toBeDefined();
  });

  it('does NOT flag when no upload evidence exists', () => {
    const file = makeFile('Upload not implemented yet.');
    mockNoExists();
    const issues = detectProductBoundary(makeContext([file]));
    expect(issues.find((i) => i.title.includes('upload'))).toBeUndefined();
  });
});

describe('detectProductBoundary — Auth', () => {
  it('does NOT treat @supabase/* dependency alone as evidence that auth exists', () => {
    const file = makeFile('Authentication not yet implemented.');
    mockNoExists();
    const packageJson = JSON.stringify({
      dependencies: { '@supabase/supabase-js': '^2.0.0' },
    });
    const issues = detectProductBoundary(makeContext([file], packageJson));
    expect(issues.find((i) => i.title.includes('auth'))).toBeUndefined();
  });

  it('flags auth contradictions for standard single-app Next.js auth routes', () => {
    const file = makeFile('Authentication not yet implemented.');
    mockExists('src/app/auth');
    const issues = detectProductBoundary(makeContext([file]));
    expect(issues.find((i) => i.title.includes('auth'))).toBeDefined();
  });
});

// ── Playwright / E2E capability ───────────────────────────────────────────────

describe('detectProductBoundary — Playwright/E2E', () => {
  it('flags "no Playwright" when playwright.config.ts exists', () => {
    const file = makeFile('We have no Playwright tests in this project.');
    mockExists('playwright.config.ts');
    const issues = detectProductBoundary(makeContext([file]));
    expect(issues.find((i) => i.title.includes('E2E'))).toBeDefined();
  });

  it('flags "no e2e tests" via @playwright/test dependency', () => {
    const file = makeFile('No e2e tests have been written yet.');
    mockNoExists();
    const packageJson = JSON.stringify({
      devDependencies: { '@playwright/test': '^1.45.0' },
    });
    const issues = detectProductBoundary(makeContext([file], packageJson));
    expect(issues.find((i) => i.title.includes('E2E'))).toBeDefined();
  });

  it('does NOT flag when no Playwright evidence exists', () => {
    const file = makeFile('No e2e tests have been set up.');
    mockNoExists();
    const issues = detectProductBoundary(makeContext([file]));
    expect(issues.find((i) => i.title.includes('E2E'))).toBeUndefined();
  });
});

// ── GitHub OAuth capability / PB1 scoped-prose fix ────────────────────────────

describe('detectProductBoundary — GitHub OAuth', () => {
  it('flags "no auth" as a stale boundary when auth routes exist', () => {
    const file = makeFile('There is no auth in this project.');
    mockExists('apps/web/src/app/auth');
    const issues = detectProductBoundary(makeContext([file]));
    expect(issues.find((i) => i.title.includes('auth'))).toBeDefined();
  });

  it('PB1: does NOT flag "no auth required for public endpoints" (scoped prose, not a boundary claim)', () => {
    const file = makeFile('No auth required for public endpoints like /health and /status.');
    mockExists('apps/web/src/app/auth');
    const issues = detectProductBoundary(makeContext([file]));
    expect(issues.find((i) => i.title.includes('auth'))).toBeUndefined();
  });

  it('PB1: does NOT flag "no authentication needed" (scoped prose variant)', () => {
    const file = makeFile('No authentication needed for the public marketing pages.');
    mockExists('apps/web/src/app/api/auth');
    const issues = detectProductBoundary(makeContext([file]));
    expect(issues.find((i) => i.title.includes('auth'))).toBeUndefined();
  });

  it('PB1: does NOT flag "no login required" scoped to a public demo', () => {
    const file = makeFile('No login required for the public demo.');
    mockExists('apps/web/src/app/auth');
    const issues = detectProductBoundary(makeContext([file]));
    expect(issues.find((i) => i.title.includes('auth'))).toBeUndefined();
  });

  it('PB1: still flags a genuine "no auth" claim in the same file as scoped prose elsewhere', () => {
    const file = makeFile(
      'No auth required for public endpoints. Aside from that, there is no auth in this app at all.',
    );
    mockExists('apps/web/src/app/auth');
    const issues = detectProductBoundary(makeContext([file]));
    expect(issues.find((i) => i.title.includes('auth'))).toBeDefined();
  });
});

// ── PB2: fenced examples must not trigger a stale-boundary finding ───────────

describe('detectProductBoundary — PB2 fence stripping', () => {
  it('does NOT flag a contradictory phrase quoted inside a fenced example', () => {
    const file = makeFile(
      [
        '## Old Wording (for reference)',
        'Previously this file said:',
        '```',
        'No web app exists yet.',
        '```',
        'That has since been updated below.',
      ].join('\n'),
    );
    mockExists('apps/web', 'next.config.ts');
    const issues = detectProductBoundary(makeContext([file]));
    expect(issues.find((i) => i.title.includes('web app'))).toBeUndefined();
  });

  it('does NOT flag a contradictory phrase quoted inside a ~~~ fenced example', () => {
    const file = makeFile(['~~~', 'No Supabase configured.', '~~~'].join('\n'));
    mockExists('supabase/migrations');
    const issues = detectProductBoundary(makeContext([file]));
    expect(issues.find((i) => i.title.includes('Supabase'))).toBeUndefined();
  });

  it('still flags the same phrase when it appears as real prose outside any fence', () => {
    const file = makeFile(
      ['```', 'Example: some unrelated code block.', '```', 'No web app exists yet.'].join('\n'),
    );
    mockExists('apps/web', 'next.config.ts');
    const issues = detectProductBoundary(makeContext([file]));
    expect(issues.find((i) => i.title.includes('web app'))).toBeDefined();
  });
});

// ── Cross-cutting: no false positives on clean content ────────────────────────

describe('detectProductBoundary — no false positives', () => {
  it('does not flag a file describing an existing feature positively', () => {
    const file = makeFile(
      'The web app lives in apps/web. The Supabase database is in supabase/migrations.',
    );
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const issues = detectProductBoundary(makeContext([file]));
    expect(issues).toHaveLength(0);
  });

  it('does not flag an empty instruction file', () => {
    const file = makeFile('');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const issues = detectProductBoundary(makeContext([file]));
    expect(issues).toHaveLength(0);
  });

  it('returns no issues when no capabilities are found (all paths absent, no relevant deps)', () => {
    const file = makeFile(
      'No web app. No Supabase. No database. No dashboard. Upload not implemented.',
    );
    mockNoExists();
    const issues = detectProductBoundary(makeContext([file]));
    expect(issues).toHaveLength(0);
  });
});
