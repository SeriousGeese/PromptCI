/**
 * Tests for the Command Validity Detector.
 *
 * Covers spec acceptance criteria:
 *  - Missing package script is flagged (npm, pnpm, yarn)
 *  - Existing package script is not flagged
 *  - Missing shell/python/node script path is flagged
 *  - Direct ./script.sh invocation is checked
 *  - Placeholder commands are skipped
 *  - Multi-command line with && validates each supported segment
 *  - Commands in fenced code blocks are extracted
 *  - Inline backtick commands are extracted
 *  - Prose "run pnpm test" is extracted
 *  - No false positives when package.json has no scripts (silent)
 *  - Per-finding IDs are unique (no ID collisions)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectCommandValidity } from '../src/command-validity.js';
import type { RepoContext } from '../src/repo-context.js';
import type { InstructionFile } from '../src/types.js';
import type { Mock } from 'vitest';
import * as fs from 'node:fs';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
}));

const mockExists = (fs.existsSync as Mock);
const mockReadFile = (fs.readFileSync as Mock);
const mockReaddir = (fs.readdirSync as Mock);

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no files exist (safest default for file-reference checks)
  mockExists.mockReturnValue(false);
  mockReadFile.mockImplementation(() => {
    throw new Error('not found');
  });
  mockReaddir.mockReturnValue([]);
});

function makeContext(
  files: InstructionFile[],
  scripts: Record<string, string> = {},
): RepoContext {
  return {
    repoRoot: '/repo',
    files,
    projectType: 'typescript',
    manifests: {},
    packageJson: {
      packageManagerName: 'pnpm',
      scripts,
      dependencies: {},
      devDependencies: {},
      peerDependencies: {},
      lockfiles: [],
    },
    workflows: { files: [], commands: [] },
    metrics: {
      estimatedInstructionTokens: 0,
      instructionFileCount: files.length,
      largestInstructionFiles: [],
    },
  };
}

function makeFile(content: string, filePath = '/repo/AGENTS.md'): InstructionFile {
  return {
    path: filePath,
    fileType: 'agents',
    content,
    sections: [],
    lineCount: content.split('\n').length,
    charCount: content.length,
    estimatedTokens: Math.ceil(content.length / 4),
  };
}

// ── Package manager script validation ─────────────────────────────────────────

describe('detectCommandValidity — package scripts', () => {
  it('flags missing npm script referenced in a code block', () => {
    const content = '```bash\nnpm run build\nnpm run non-existent\n```';
    const context = makeContext([makeFile(content)], { build: 'tsc' });
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.summary).toContain('"non-existent"');
  });

  it('does NOT flag an existing npm script', () => {
    const content = '```bash\nnpm run build\n```';
    const context = makeContext([makeFile(content)], { build: 'tsc' });
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(0);
  });

  it('flags missing pnpm script in inline backtick', () => {
    const content = 'Run `pnpm invalid-script` to proceed.';
    const context = makeContext([makeFile(content)], { test: 'vitest' });
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.summary).toContain('"invalid-script"');
  });

  it('does NOT flag an existing pnpm script', () => {
    const content = 'Run `pnpm test` to verify.';
    const context = makeContext([makeFile(content)], { test: 'vitest' });
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(0);
  });

  it('flags missing yarn script', () => {
    const content = 'Use `yarn missing-script` to run.';
    const context = makeContext([makeFile(content)], { test: 'jest' });
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.summary).toContain('"missing-script"');
  });

  it('does NOT flag pnpm built-in subcommands (install, add, exec…)', () => {
    const content = '```sh\npnpm install\npnpm add react\npnpm exec tsc\n```';
    const context = makeContext([makeFile(content)], {});
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(0);
  });

  it('validates the script after pnpm -r instead of treating -r as value-taking', () => {
    const content = '```sh\npnpm -r missing-build\n```';
    const context = makeContext([makeFile(content)], { build: 'vite build' });
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.summary).toContain('"missing-build"');
  });

  it('does NOT flag a pnpm filtered workspace script that exists in the target package', () => {
    mockReaddir.mockImplementation((dir: unknown) => {
      const normalized = String(dir).replace(/\\/g, '/');
      if (normalized.endsWith('/apps')) return [{ name: 'web', isDirectory: () => true }];
      return [];
    });
    mockReadFile.mockImplementation((filePath: unknown) => {
      const normalized = String(filePath).replace(/\\/g, '/');
      if (normalized.endsWith('/apps/web/package.json')) {
        return JSON.stringify({ name: '@scope/web', scripts: { build: 'next build' } });
      }
      throw new Error('not found');
    });
    const content = '```sh\npnpm --filter @scope/web build\n```';
    const context = makeContext([makeFile(content)], { test: 'vitest' });
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(0);
  });

  it('does NOT flag any script when package.json has no scripts loaded', () => {
    // When no package.json was found, scripts is empty — should not produce noise
    const content = 'Run `pnpm run anything` to proceed.';
    const context = makeContext([makeFile(content)], {}); // empty scripts = no package.json loaded
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(0);
  });

  it('produces unique IDs for different failing commands', () => {
    const content = '```bash\npnpm run missing-a\npnpm run missing-b\n```';
    const context = makeContext([makeFile(content)], { test: 'vitest' });
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(2);
    expect(issues[0]!.id).not.toBe(issues[1]!.id);
  });
});

// ── CV6: `cd <subdir> && pnpm <script>` resolves against the subdir manifest ──

describe('detectCommandValidity — cd-established working directory', () => {
  const withAppsWebScripts = (scripts: Record<string, string>) => {
    mockReadFile.mockImplementation((filePath: unknown) => {
      const normalized = String(filePath).replace(/\\/g, '/');
      if (normalized.endsWith('/apps/web/package.json')) {
        return JSON.stringify({ name: '@promptci/web', scripts });
      }
      throw new Error('not found');
    });
  };

  it('does NOT flag `cd apps/web && pnpm test:e2e` when apps/web defines test:e2e', () => {
    withAppsWebScripts({ 'test:e2e': 'playwright test', 'test:e2e:ui': 'playwright test --ui' });
    const content = '```bash\ncd apps/web && pnpm test:e2e\ncd apps/web && pnpm test:e2e:ui\n```';
    // Root scripts do NOT contain test:e2e — the fix must look in apps/web.
    const context = makeContext([makeFile(content)], { test: 'vitest', build: 'tsc' });
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(0);
  });

  it('still flags a script genuinely missing from the cd-target package', () => {
    withAppsWebScripts({ 'test:e2e': 'playwright test' });
    const content = '```bash\ncd apps/web && pnpm nope:missing\n```';
    const context = makeContext([makeFile(content)], { test: 'vitest' });
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.summary).toContain('apps/web/package.json');
  });

  it('stays silent when the cd-target package.json cannot be read', () => {
    // No apps/web/package.json on disk — we cannot verify, so we must not guess.
    const content = '```bash\ncd apps/web && pnpm whatever\n```';
    const context = makeContext([makeFile(content)], { test: 'vitest' });
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(0);
  });

  it('does not let a standalone `cd` bleed into a later root-script line', () => {
    // Regression: `cd apps/web && pnpm exec ...` earlier in the block must NOT
    // cause the later standalone `pnpm build:web` (a ROOT script) to resolve
    // against apps/web. Each line is an independent example run from root.
    withAppsWebScripts({ 'test:e2e': 'playwright test' });
    const content = [
      '```bash',
      'cd apps/web && pnpm exec playwright install chromium',
      '',
      'pnpm build:web',
      'cd apps/web && pnpm test:e2e',
      '```',
    ].join('\n');
    const context = makeContext([makeFile(content)], { 'build:web': 'next build', test: 'vitest' });
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(0);
  });

  it('flags `cd apps/web && pnpm build` when build exists only at the ROOT', () => {
    // pnpm does not search parent dirs — a same-named root script must NOT mask
    // a script genuinely missing from the cd-target's own manifest.
    withAppsWebScripts({ dev: 'next dev', start: 'next start' });
    const content = '```bash\ncd apps/web && pnpm build\n```';
    // Root `build` exists but builds something else; apps/web has no `build`.
    const context = makeContext([makeFile(content)], { build: 'tsc -p packages/cli' });
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.summary).toContain('apps/web/package.json');
  });

  it('flags a bare `pnpm test:e2e` (no cd) missing from the root manifest', () => {
    const content = '```bash\npnpm test:e2e\n```';
    const context = makeContext([makeFile(content)], { test: 'vitest' });
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.summary).toContain('does not appear in package.json scripts');
  });

  it('resolves an inline-backtick `cd apps/web && pnpm test:e2e`', () => {
    withAppsWebScripts({ 'test:e2e': 'playwright test' });
    const content = 'Run `cd apps/web && pnpm test:e2e` to run the e2e suite.';
    const context = makeContext([makeFile(content)], { test: 'vitest' });
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(0);
  });
});

// ── CV7: slash-joined shorthand `pnpm lint/typecheck/test/build` ──────────────

describe('detectCommandValidity — slash-joined script shorthand', () => {
  it('does NOT flag `pnpm lint/typecheck/test/build` when each part exists', () => {
    const content = 'Run `pnpm lint/typecheck/test/build` bare as a pass/fail gate.';
    const context = makeContext([makeFile(content)], {
      lint: 'eslint', typecheck: 'tsc --noEmit', build: 'tsc',
      // `test` is a pnpm builtin, so it need not be in scripts.
    });
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(0);
  });

  it('flags the specific missing part of a slash-joined shorthand', () => {
    const content = 'Run `pnpm lint/bogus` before pushing.';
    const context = makeContext([makeFile(content)], { lint: 'eslint' });
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.summary).toContain('"bogus"');
  });
});

// ── File-reference validation ─────────────────────────────────────────────────

describe('detectCommandValidity — file references', () => {
  it('flags missing file in node command', () => {
    mockExists.mockReturnValue(false);
    const content = 'Run `node scripts/migrate.js`';
    const context = makeContext([makeFile(content)]);
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.summary).toContain('scripts/migrate.js');
  });

  it('does NOT flag node command when file exists', () => {
    mockExists.mockReturnValue(true);
    const content = 'Run `node scripts/migrate.js`';
    const context = makeContext([makeFile(content)]);
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(0);
  });

  it('flags missing bash script path', () => {
    mockExists.mockReturnValue(false);
    const content = 'Run `bash scripts/setup.sh`';
    const context = makeContext([makeFile(content)]);
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.summary).toContain('scripts/setup.sh');
  });

  it('flags missing python script path', () => {
    mockExists.mockReturnValue(false);
    const content = '```bash\npython scripts/generate.py\n```';
    const context = makeContext([makeFile(content)]);
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.summary).toContain('scripts/generate.py');
  });

  it('flags missing direct ./script.sh invocation', () => {
    mockExists.mockReturnValue(false);
    const content = 'Run `./scripts/bootstrap.sh` to set up.';
    const context = makeContext([makeFile(content)]);
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.summary).toContain('./scripts/bootstrap.sh');
  });

  it('does NOT flag when ./script.sh exists', () => {
    mockExists.mockReturnValue(true);
    const content = 'Run `./scripts/bootstrap.sh` to set up.';
    const context = makeContext([makeFile(content)]);
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(0);
  });

  it('flags missing docker compose file', () => {
    mockExists.mockImplementation((p: unknown) =>
      !String(p).endsWith('docker-compose.prod.yml'),
    );
    const content = '`docker compose -f docker-compose.prod.yml up`';
    const context = makeContext([makeFile(content)]);
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.summary).toContain('docker-compose.prod.yml');
  });
});

// ── && multi-command splitting ────────────────────────────────────────────────

describe('detectCommandValidity — && multi-command splitting', () => {
  it('validates each segment of a && joined command', () => {
    // "pnpm run lint && pnpm run missing" — lint exists, missing does not
    const content = '`pnpm run lint && pnpm run missing-step`';
    const context = makeContext([makeFile(content)], { lint: 'eslint .' });
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.summary).toContain('"missing-step"');
  });

  it('flags both segments when both have missing scripts', () => {
    const content = '`pnpm run a-missing && pnpm run b-missing`';
    const context = makeContext([makeFile(content)], { test: 'vitest' });
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(2);
  });

  it('validates each line in a multi-line fenced block', () => {
    const content = '```sh\npnpm run lint\npnpm run missing-check\n```';
    const context = makeContext([makeFile(content)], { lint: 'eslint .' });
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.summary).toContain('"missing-check"');
  });

  it('uses correct line numbers for each command in a code block', () => {
    const content = '```bash\n# build it\npnpm build\n\n# test it\npnpm test-missing\n```';
    const context = makeContext([makeFile(content)], { build: 'tsc' });
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(1);
    // "pnpm test-missing" is on line 6 (1-indexed, after fence + comment + build + blank + comment)
    expect(issues[0]!.locations[0]!.startLine).toBeGreaterThan(4);
  });

  it('ignores shell comments inside fenced command blocks', () => {
    const content = '```bash\n# pnpm old-deploy was removed in v2\npnpm build\n```';
    const context = makeContext([makeFile(content)], { build: 'vite build' });
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(0);
  });
});

// ── Placeholder skipping ──────────────────────────────────────────────────────

describe('detectCommandValidity — placeholder skipping', () => {
  it('skips commands with <angle-bracket> placeholders', () => {
    const content = 'Run `npm run <script-name>` to execute.';
    const context = makeContext([makeFile(content)], {});
    expect(detectCommandValidity(context)).toHaveLength(0);
  });

  it('skips commands with {curly-brace} placeholders', () => {
    const content = 'Run `node {file}.js` to execute.';
    const context = makeContext([makeFile(content)], {});
    expect(detectCommandValidity(context)).toHaveLength(0);
  });

  it('skips commands with ... placeholders', () => {
    const content = 'Run `pnpm run ...` to execute.';
    const context = makeContext([makeFile(content)], {});
    expect(detectCommandValidity(context)).toHaveLength(0);
  });
});

// ── Prose extraction ──────────────────────────────────────────────────────────

describe('detectCommandValidity — prose extraction', () => {
  it('extracts and validates from prose "run pnpm X" pattern', () => {
    const content = 'To start, run pnpm start-missing now.';
    // Provide a non-empty scripts map so the "no package.json" guard does not fire
    const context = makeContext([makeFile(content)], { test: 'vitest' });
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.summary).toContain('"start-missing"');
  });

  it('preserves file extensions in prose commands before trailing punctuation', () => {
    mockExists.mockImplementation((p: unknown) => String(p).replace(/\\/g, '/').endsWith('scripts/setup.js'));
    const content = 'Before developing, run node scripts/setup.js.';
    const context = makeContext([makeFile(content)]);
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(0);
  });

  it('stops prose command extraction at sentence boundaries', () => {
    const content = 'Run pnpm test. Then commit your work.';
    const context = makeContext([makeFile(content)], { test: 'vitest' });
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(0);
  });
});

// ── Deduplication ─────────────────────────────────────────────────────────────

describe('detectCommandValidity — deduplication', () => {
  it('does not emit duplicate findings for the same command appearing twice in a file', () => {
    const content = 'Run `pnpm run missing-cmd` first, then `pnpm run missing-cmd` again.';
    const context = makeContext([makeFile(content)], { test: 'vitest' });
    const issues = detectCommandValidity(context);
    // Same command in same file → only one finding
    expect(issues).toHaveLength(1);
  });

  it('emits separate findings for the same missing command in two different files', () => {
    const content = 'Run `pnpm run missing-cmd` to proceed.';
    const fileA = makeFile(content, '/repo/AGENTS.md');
    const fileB = makeFile(content, '/repo/CLAUDE.md');
    const context = makeContext([fileA, fileB], { test: 'vitest' });
    const issues = detectCommandValidity(context);
    // Different files → dedupeKey differs → two findings
    expect(issues).toHaveLength(2);
    const paths = issues.map(i => i.filePaths[0]);
    expect(paths).toContain('/repo/AGENTS.md');
    expect(paths).toContain('/repo/CLAUDE.md');
  });
});

// ── yarn run <script> syntax ───────────────────────────────────────────────────

describe('detectCommandValidity — yarn run <script>', () => {
  it('flags missing script with yarn run <script> syntax', () => {
    const content = 'Run `yarn run custom-deploy` to deploy.';
    const context = makeContext([makeFile(content)], { test: 'jest' });
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.summary).toContain('"custom-deploy"');
  });

  it('does NOT flag yarn run <script> when the script exists', () => {
    const content = 'Run `yarn run build` to compile.';
    const context = makeContext([makeFile(content)], { build: 'webpack' });
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(0);
  });
});

// ── dotnet test target validation ─────────────────────────────────────────────

describe('detectCommandValidity — dotnet test targets', () => {
  it('flags a dotnet test target with wrong extension (.dll) even when file exists', () => {
    mockExists.mockReturnValue(true);
    const content = '`dotnet test MyTests.dll`';
    const context = makeContext([makeFile(content)]);
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.summary).toContain('.sln, .csproj, or .fsproj');
  });

  it('does NOT flag dotnet test with an existing .csproj target', () => {
    mockExists.mockReturnValue(true);
    const content = '`dotnet test MyProject.csproj`';
    const context = makeContext([makeFile(content)]);
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(0);
  });

  it('does NOT flag dotnet test with an existing .fsproj target', () => {
    mockExists.mockReturnValue(true);
    const content = '`dotnet test MyProject.fsproj`';
    const context = makeContext([makeFile(content)]);
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(0);
  });

  it('flags dotnet test with a missing .sln target', () => {
    mockExists.mockReturnValue(false);
    const content = '`dotnet test MySolution.sln`';
    const context = makeContext([makeFile(content)]);
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.summary).toContain('does not appear to exist');
    expect(issues[0]!.summary).toContain('MySolution.sln');
  });

  it('does NOT flag dotnet test when target has no file extension (not a file path)', () => {
    // isLikelyFilePath returns false for a bare word with no extension or separator
    mockExists.mockReturnValue(false);
    const content = '`dotnet test MyTestsFolder`';
    const context = makeContext([makeFile(content)]);
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(0);
  });
});

// ── tsx file reference validation ─────────────────────────────────────────────

describe('detectCommandValidity — tsx file references', () => {
  it('flags a missing file referenced by tsx', () => {
    mockExists.mockReturnValue(false);
    const content = 'Run `tsx src/generate.ts`';
    const context = makeContext([makeFile(content)]);
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.summary).toContain('src/generate.ts');
  });

  it('does NOT flag tsx when the file exists', () => {
    mockExists.mockReturnValue(true);
    const content = 'Run `tsx src/generate.ts`';
    const context = makeContext([makeFile(content)]);
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(0);
  });
});

// ── CV1: fence-state inversion on non-shell code blocks ───────────────────────

describe('detectCommandValidity — CV1 fence-state inversion', () => {
  it('does not invert block state after a ```json fence and still validates the following ```bash block', () => {
    mockExists.mockReturnValue(false);
    const content = [
      '```json',
      '{ "a": 1 }',
      '```',
      'Run `node scripts/missing.js` after.',
      '```bash',
      'pnpm not-a-script',
      '```',
    ].join('\n');
    const context = makeContext([makeFile(content)], { build: 'tsc' });
    const issues = detectCommandValidity(context);
    const summaries = issues.map((i) => i.summary);
    expect(summaries.some((s) => s.includes('scripts/missing.js'))).toBe(true);
    expect(summaries.some((s) => s.includes('not-a-script'))).toBe(true);
  });

  it('does not scan a ```json block for commands even though it is now correctly tracked', () => {
    mockExists.mockReturnValue(false);
    const content = ['```json', '{ "scripts": { "pnpm run fake": true } }', '```'].join('\n');
    const context = makeContext([makeFile(content)], { build: 'tsc' });
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(0);
  });

  it('still scans a pandoc-attribute fence (```{.bash}) as shell', () => {
    // The historical opener regex classified on the info string's leading
    // [a-zA-Z0-9_-] run, so `{.bash}` read as a bare (shell) fence. The shared
    // scanner reports the full info string; classification must not change.
    const content = ['```{.bash}', 'pnpm not-a-script', '```'].join('\n');
    const context = makeContext([makeFile(content)], { build: 'tsc' });
    const issues = detectCommandValidity(context);
    expect(issues.some((i) => i.summary.includes('not-a-script'))).toBe(true);
  });

  it('still skips a non-shell fence whose info string has trailing punctuation (```json,)', () => {
    const content = ['```json,', '{ "scripts": { "pnpm run fake": true } }', '```'].join('\n');
    const context = makeContext([makeFile(content)], { build: 'tsc' });
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(0);
  });
});

// ── CV2: line-number shift from leading blank lines in a fenced block ────────

describe('detectCommandValidity — CV2 line-number shift', () => {
  it('reports the correct line number when the fenced block has a leading blank line', () => {
    const content = ['```bash', '', 'pnpm bogus', '```'].join('\n');
    const context = makeContext([makeFile(content)], { build: 'tsc' });
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(1);
    // line 1: ```bash, line 2: blank, line 3: pnpm bogus, line 4: ```
    expect(issues[0]!.locations[0]!.startLine).toBe(3);
  });
});

// ── CV3: pnpm/yarn CLI flags mistaken for the script name ────────────────────

describe('detectCommandValidity — CV3 flags mistaken for script names', () => {
  it('does NOT flag `pnpm --filter @scope/pkg test` (--filter is a flag, not a script)', () => {
    const content = 'Run `pnpm --filter @promptci/core test` before committing.';
    const context = makeContext([makeFile(content)], {});
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(0);
  });

  it('does NOT flag `pnpm -r build` (-r is a flag, build is the real script)', () => {
    const content = 'Run `pnpm -r build` to build all workspaces.';
    const context = makeContext([makeFile(content)], { build: 'tsc' });
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(0);
  });

  it('does NOT flag `yarn --cwd app build` (--cwd takes a value, build is the real script)', () => {
    const content = 'Run `yarn --cwd app build` to build the app workspace.';
    const context = makeContext([makeFile(content)], { build: 'webpack' });
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(0);
  });

  it('does NOT flag `yarn workspace app build` as a missing script named "workspace"', () => {
    const content = 'Run `yarn workspace app build` to build the app workspace.';
    const context = makeContext([makeFile(content)], { build: 'webpack' });
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(0);
  });

  it('still flags a genuinely missing script after a flag', () => {
    const content = 'Run `pnpm --filter @promptci/core missing-script` before committing.';
    const context = makeContext([makeFile(content)], { build: 'tsc' });
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.summary).toContain('"missing-script"');
  });
});

// ── CV4: `;` and `||` command separators are not split ───────────────────────

describe('detectCommandValidity — CV4 semicolon/or separators', () => {
  it('validates both sides of a `;`-joined command', () => {
    const content = 'Run `pnpm lint; pnpm bogus` before pushing.';
    const context = makeContext([makeFile(content)], { lint: 'eslint .' });
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.summary).toContain('"bogus"');
    // The first segment must not be misread as a single "lint;" script name.
    expect(issues.some((i) => i.summary.includes('lint;'))).toBe(false);
  });

  it('validates both sides of a `||`-joined command', () => {
    const content = 'Run `pnpm run lint || pnpm run bogus` before pushing.';
    const context = makeContext([makeFile(content)], { lint: 'eslint .' });
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.summary).toContain('"bogus"');
  });
});

// ── CV5: flag VALUES matched as file paths ───────────────────────────────────

describe('detectCommandValidity — CV5 flag value mistaken for file path', () => {
  it('validates the real script target, not a --loader flag value', () => {
    mockExists.mockImplementation((p: unknown) => String(p).replace(/\\/g, '/').endsWith('src/x.ts'));
    const content = 'Run `node --loader ts-node/esm src/x.ts` to start.';
    const context = makeContext([makeFile(content)]);
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(0);
  });

  it('still flags a missing real script target after a --loader flag', () => {
    mockExists.mockReturnValue(false);
    const content = 'Run `node --loader ts-node/esm src/missing.ts` to start.';
    const context = makeContext([makeFile(content)]);
    const issues = detectCommandValidity(context);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.summary).toContain('src/missing.ts');
    expect(issues[0]!.summary).not.toContain('ts-node/esm');
  });
});
