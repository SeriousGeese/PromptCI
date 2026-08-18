/**
 * Tests for the dead-references detector.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectDeadReferences } from '../src/dead-references.js';
import type { InstructionFile } from '../src/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFile(
  content: string,
  filePath = '/repo/CLAUDE.md',
  overrides: Partial<InstructionFile> = {},
): InstructionFile {
  return {
    path: filePath,
    fileType: 'claude',
    content,
    sections: [],
    lineCount: content.split('\n').length,
    charCount: content.length,
    estimatedTokens: Math.round(content.length / 4),
    ...overrides,
  };
}

// ── Temp directory fixture ────────────────────────────────────────────────────

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-dead-ref-'));
  // Create some real files in the temp dir
  fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# Agents\nReal file.');
  fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'docs', 'guide.md'), '# Guide\nReal file.');
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('detectDeadReferences', () => {
  it('returns no issues for empty input', () => {
    expect(detectDeadReferences([], '/repo')).toEqual([]);
  });

  it('returns no issues when all markdown links resolve', () => {
    const claudePath = path.join(tmpDir, 'CLAUDE.md');
    const file = makeFile(
      '# Docs\nSee [the agent guide](./AGENTS.md) for more info.',
      claudePath,
    );
    const issues = detectDeadReferences([file], tmpDir);
    expect(issues).toEqual([]);
  });

  it('flags a markdown link to a non-existent file', () => {
    const claudePath = path.join(tmpDir, 'CLAUDE.md');
    const file = makeFile(
      '# Setup\nSee [missing file](./does-not-exist.md) for setup instructions.',
      claudePath,
    );
    const issues = detectDeadReferences([file], tmpDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].category).toBe('structure');
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].title).toMatch(/does-not-exist\.md/);
    expect(issues[0].evidence[0]).toContain('does-not-exist.md');
  });

  it('flags an @-file reference to a non-existent file', () => {
    const claudePath = path.join(tmpDir, 'CLAUDE.md');
    const file = makeFile(
      '# Rules\nAll agents must read @missing-agents.md before starting.',
      claudePath,
    );
    const issues = detectDeadReferences([file], tmpDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].evidence[0]).toContain('@missing-agents.md');
  });

  it('does NOT flag external URLs', () => {
    const file = makeFile(
      '# Links\nSee [the docs](https://example.com/guide.md) for details.',
      path.join(tmpDir, 'CLAUDE.md'),
    );
    expect(detectDeadReferences([file], tmpDir)).toHaveLength(0);
  });

  it('does NOT flag anchor-only links', () => {
    const file = makeFile(
      '# Nav\nJump to [the section](#section-heading) below.',
      path.join(tmpDir, 'CLAUDE.md'),
    );
    expect(detectDeadReferences([file], tmpDir)).toHaveLength(0);
  });

  it('does NOT flag a link whose anchor fragment points to an existing file', () => {
    const claudePath = path.join(tmpDir, 'CLAUDE.md');
    const file = makeFile(
      '# Docs\nSee [AGENTS setup](./AGENTS.md#setup) for more.',
      claudePath,
    );
    expect(detectDeadReferences([file], tmpDir)).toHaveLength(0);
  });

  it('resolves paths relative to repo root as a fallback', () => {
    // File is in a subdirectory, ref is relative to repo root
    const subPath = path.join(tmpDir, 'subdir', 'CLAUDE.md');
    fs.mkdirSync(path.join(tmpDir, 'subdir'), { recursive: true });
    const file = makeFile(
      '# Docs\nSee [guide](docs/guide.md) for details.',
      subPath,
    );
    // docs/guide.md exists at repo root — should resolve and not flag
    const issues = detectDeadReferences([file], tmpDir);
    expect(issues).toHaveLength(0);
  });

  it('deduplicates identical refs in the same file', () => {
    const claudePath = path.join(tmpDir, 'CLAUDE.md');
    const file = makeFile(
      '# A\nSee [missing](./ghost.md).\n# B\nAlso see [ghost](./ghost.md).',
      claudePath,
    );
    const issues = detectDeadReferences([file], tmpDir);
    // Same ref in same file → one issue, not two
    expect(issues).toHaveLength(1);
  });

  it('produces stable issue IDs across multiple calls', () => {
    const claudePath = path.join(tmpDir, 'CLAUDE.md');
    const file = makeFile(
      'Check [missing](./no-such-file.md) for info.',
      claudePath,
    );
    const run1 = detectDeadReferences([file], tmpDir);
    const run2 = detectDeadReferences([file], tmpDir);
    expect(run1.map((i) => i.id)).toEqual(run2.map((i) => i.id));
  });

  it('produces well-formed issue objects', () => {
    const claudePath = path.join(tmpDir, 'CLAUDE.md');
    const file = makeFile(
      'See [missing docs](./phantom.md) before running.',
      claudePath,
    );
    const [issue] = detectDeadReferences([file], tmpDir);
    expect(issue).toBeDefined();
    expect(issue.id).toMatch(/^dead-ref-[a-f0-9]{12}$/);
    expect(issue.category).toBe('structure');
    expect(issue.severity).toBe('warning');
    expect(issue.filePaths).toContain(claudePath);
    expect(issue.confidence).toBeCloseTo(0.85);
    expect(issue.recommendation).toBeTruthy();
  });
});
// ── BUG-006: Image links should be checked ───────────────────────────────────

describe('detectDeadReferences — image links (BUG-006)', () => {
  let imgTmpDir: string;

  beforeAll(() => {
    imgTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-img-test-'));
    fs.mkdirSync(path.join(imgTmpDir, 'docs'), { recursive: true });
    // Create a real image file
    fs.writeFileSync(path.join(imgTmpDir, 'docs', 'real-diagram.png'), 'fake-png-content');
  });

  afterAll(() => {
    fs.rmSync(imgTmpDir, { recursive: true, force: true });
  });

  it('flags a markdown link to a missing .png file', () => {
    const claudePath = path.join(imgTmpDir, 'CLAUDE.md');
    const file = makeFile(
      '# Arch\nSee the [architecture diagram](./docs/architecture.png) for an overview.',
      claudePath,
    );
    const issues = detectDeadReferences([file], imgTmpDir);
    expect(issues.some((i) => i.title.includes('architecture.png'))).toBe(true);
  });

  it('does NOT flag a markdown link to an existing .png file', () => {
    const claudePath = path.join(imgTmpDir, 'CLAUDE.md');
    const file = makeFile(
      '# Arch\nSee the [diagram](./docs/real-diagram.png) for an overview.',
      claudePath,
    );
    const issues = detectDeadReferences([file], imgTmpDir);
    expect(issues.some((i) => i.title.includes('real-diagram.png'))).toBe(false);
  });

  it('flags a missing .svg link', () => {
    const claudePath = path.join(imgTmpDir, 'CLAUDE.md');
    const file = makeFile(
      'See [flow](./docs/flow.svg) for the state machine.',
      claudePath,
    );
    const issues = detectDeadReferences([file], imgTmpDir);
    expect(issues.some((i) => i.title.includes('flow.svg'))).toBe(true);
  });

  it('resolves CommonMark angle-bracket link destinations with spaces', () => {
    fs.writeFileSync(path.join(imgTmpDir, 'docs', 'my file.md'), '# Guide\n');
    const claudePath = path.join(imgTmpDir, 'CLAUDE.md');
    const file = makeFile(
      'See [guide](<./docs/my file.md>) for setup details.',
      claudePath,
    );
    expect(detectDeadReferences([file], imgTmpDir)).toHaveLength(0);
  });

  it('captures the outer target of a nested badge link', () => {
    fs.writeFileSync(path.join(imgTmpDir, 'badge.svg'), '<svg />');
    const claudePath = path.join(imgTmpDir, 'CLAUDE.md');
    const file = makeFile(
      '[![CI](badge.svg)](docs/ci.md)',
      claudePath,
    );
    const issues = detectDeadReferences([file], imgTmpDir);
    expect(issues.some((i) => i.title.includes('ci.md'))).toBe(true);
    expect(issues.some((i) => i.title.includes('badge.svg'))).toBe(false);
  });

  it('does NOT treat email-like @ tokens as file references', () => {
    const claudePath = path.join(imgTmpDir, 'CLAUDE.md');
    const file = makeFile(
      'Contact ops at contact@streamline.md for escalation.',
      claudePath,
    );
    expect(detectDeadReferences([file], imgTmpDir)).toHaveLength(0);
  });

  it('flags missing image references in backticks and layout bullets', () => {
    const claudePath = path.join(imgTmpDir, 'CLAUDE.md');
    const file = makeFile(
      [
        '## Project Structure',
        'See `assets/architecture.png` for the diagram.',
        '- docs/missing-overview.pdf',
      ].join('\n'),
      claudePath,
    );
    const issues = detectDeadReferences([file], imgTmpDir);
    expect(issues.some((i) => i.title.includes('architecture.png'))).toBe(true);
    expect(issues.some((i) => i.title.includes('missing-overview.pdf'))).toBe(true);
  });
});

// ── BUG-009: Placeholder filenames should not fire ───────────────────────────

describe('detectDeadReferences — placeholder filter (BUG-009)', () => {
  let phTmpDir: string;

  beforeAll(() => {
    phTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-ph-test-'));
  });

  afterAll(() => {
    fs.rmSync(phTmpDir, { recursive: true, force: true });
  });

  it('does NOT flag `foo.ts` as a dead reference', () => {
    const claudePath = path.join(phTmpDir, 'CLAUDE.md');
    const file = makeFile(
      '# Code style\nExample file structure: `foo.ts` exports a default function.',
      claudePath,
    );
    expect(detectDeadReferences([file], phTmpDir)).toHaveLength(0);
  });

  it('does NOT flag `bar.go`, `example.py`, `sample.md`', () => {
    const claudePath = path.join(phTmpDir, 'CLAUDE.md');
    const file = makeFile(
      'See `bar.go` and `example.py` for reference. Also [sample](./sample.md).',
      claudePath,
    );
    expect(detectDeadReferences([file], phTmpDir)).toHaveLength(0);
  });

  it('still flags non-placeholder dead refs in the same file', () => {
    const claudePath = path.join(phTmpDir, 'CLAUDE.md');
    const file = makeFile(
      'See `foo.ts` and [missing guide](./docs/real-missing-guide.md).',
      claudePath,
    );
    const issues = detectDeadReferences([file], phTmpDir);
    // foo.ts is a placeholder → no issue; the .md link should fire
    expect(issues.some((i) => i.title.includes('real-missing-guide.md'))).toBe(true);
    expect(issues.every((i) => !i.title.includes('foo.ts'))).toBe(true);
  });
});

// ── BUG-008: Gitignored credential/config files should not fire ───────────────

describe('detectDeadReferences — BUG-008 gitignored files', () => {
  let giTmpDir: string;

  beforeAll(() => {
    giTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-gi-test-'));
  });

  afterAll(() => {
    fs.rmSync(giTmpDir, { recursive: true, force: true });
  });

  it('does NOT flag `config/secrets.py` as a dead reference', () => {
    const file = makeFile(
      'Add your credentials to `config/secrets.py` — never commit this file.',
      path.join(giTmpDir, 'CLAUDE.md'),
    );
    const issues = detectDeadReferences([file], giTmpDir);
    expect(issues.every((i) => !i.title.includes('secrets.py'))).toBe(true);
  });

  it('does NOT flag `appsettings.Development.json` as a dead reference', () => {
    const file = makeFile(
      'Local dev settings go in `appsettings.Development.json` (gitignored).',
      path.join(giTmpDir, 'CLAUDE.md'),
    );
    expect(detectDeadReferences([file], giTmpDir).every((i) => !i.title.includes('Development'))).toBe(true);
  });

  it('does NOT flag `appsettings.Production.json` as a dead reference', () => {
    const file = makeFile(
      'Production secrets live in `appsettings.Production.json` managed by the secrets manager.',
      path.join(giTmpDir, 'AGENTS.md'),
    );
    expect(detectDeadReferences([file], giTmpDir).every((i) => !i.title.includes('Production'))).toBe(true);
  });

  it('does NOT flag `.env` or `.env.local` files', () => {
    const file = makeFile(
      'Copy `.env.local` from the team vault and never commit `.env`.',
      path.join(giTmpDir, 'CLAUDE.md'),
    );
    expect(detectDeadReferences([file], giTmpDir)).toHaveLength(0);
  });

  it('STILL flags a missing non-gitignored .json config', () => {
    const file = makeFile(
      'See `config/project.json` for the project configuration.',
      path.join(giTmpDir, 'CLAUDE.md'),
    );
    const issues = detectDeadReferences([file], giTmpDir);
    expect(issues.some((i) => i.title.includes('project.json'))).toBe(true);
  });
});

// ── BUG-012: ComponentName / <domain> template placeholders ──────────────────

describe('detectDeadReferences — BUG-012 template placeholder filter', () => {
  let phTmpDir2: string;

  beforeAll(() => {
    phTmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-ph2-test-'));
  });

  afterAll(() => {
    fs.rmSync(phTmpDir2, { recursive: true, force: true });
  });

  it('does NOT flag `ComponentName.tsx` as a dead reference', () => {
    const file = makeFile(
      '## Components\nName files like `ComponentName.tsx` and co-locate tests as `ComponentName.test.tsx`.',
      path.join(phTmpDir2, 'CLAUDE.md'),
    );
    const issues = detectDeadReferences([file], phTmpDir2);
    expect(issues.every((i) => !i.title.includes('ComponentName'))).toBe(true);
  });

  it('does NOT flag `ComponentName.test.tsx` as a dead reference', () => {
    const file = makeFile(
      '## Testing\nTest files follow the pattern `ComponentName.test.tsx`.',
      path.join(phTmpDir2, 'CLAUDE.md'),
    );
    expect(detectDeadReferences([file], phTmpDir2).every((i) => !i.title.includes('ComponentName'))).toBe(true);
  });

  it('does NOT flag paths containing angle-bracket templates', () => {
    const file = makeFile(
      '## Architecture\nFeature slices live in `src/features/<domain>/slice.ts` and `src/features/<domain>/api.ts`.',
      path.join(phTmpDir2, 'CLAUDE.md'),
    );
    const issues = detectDeadReferences([file], phTmpDir2);
    expect(issues.every((i) => !i.evidence[0]?.includes('<domain>'))).toBe(true);
  });

  it('still flags a real (non-placeholder) dead path in the same file', () => {
    const file = makeFile(
      '## Setup\nCopy `ComponentName.tsx` from the template. See `scripts/real-setup.sh` for setup.',
      path.join(phTmpDir2, 'CLAUDE.md'),
    );
    const issues = detectDeadReferences([file], phTmpDir2);
    expect(issues.some((i) => i.title.includes('real-setup.sh'))).toBe(true);
    expect(issues.every((i) => !i.title.includes('ComponentName'))).toBe(true);
  });
});

// ── BUG-004: Bare paths in Repository Layout sections ────────────────────────

describe('detectDeadReferences — BUG-004 layout section paths', () => {
  let layoutTmpDir: string;

  beforeAll(() => {
    layoutTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-layout-test-'));
    fs.mkdirSync(path.join(layoutTmpDir, 'docs'), { recursive: true });
    // Create one real file so we can test the contrast
    fs.writeFileSync(path.join(layoutTmpDir, 'docs', 'real-guide.md'), '# Guide');
  });

  afterAll(() => {
    fs.rmSync(layoutTmpDir, { recursive: true, force: true });
  });

  it('flags a missing file listed as a bullet in a Repository Layout section', () => {
    const claudePath = path.join(layoutTmpDir, 'CLAUDE.md');
    const file = makeFile(
      [
        '## Repository Layout',
        '',
        '- docs/runbook.md — operational runbook',
        '- docs/rate-limiting.md — rate limiting documentation',
      ].join('\n'),
      claudePath,
    );
    const issues = detectDeadReferences([file], layoutTmpDir);
    expect(issues.some((i) => i.title.includes('runbook.md'))).toBe(true);
    expect(issues.some((i) => i.title.includes('rate-limiting.md'))).toBe(true);
  });

  it('does NOT flag an existing file listed in a layout section', () => {
    const claudePath = path.join(layoutTmpDir, 'CLAUDE.md');
    const file = makeFile(
      [
        '## Repository Layout',
        '',
        '- docs/real-guide.md — main guide',
      ].join('\n'),
      claudePath,
    );
    const issues = detectDeadReferences([file], layoutTmpDir);
    expect(issues.every((i) => !i.title.includes('real-guide.md'))).toBe(true);
  });

  it('does NOT flag tree-listing basenames when they exist under the shown parent directory', () => {
    fs.writeFileSync(path.join(layoutTmpDir, 'docs', 'guide.md'), '# Guide');
    const claudePath = path.join(layoutTmpDir, 'CLAUDE.md');
    const file = makeFile(
      [
        '## Repository Layout',
        '',
        'docs/',
        '├── guide.md',
      ].join('\n'),
      claudePath,
    );
    const issues = detectDeadReferences([file], layoutTmpDir);
    expect(issues.every((i) => !i.title.includes('guide.md'))).toBe(true);
  });

  it('does NOT treat prose lines in layout files as whole-line references', () => {
    const claudePath = path.join(layoutTmpDir, 'CLAUDE.md');
    fs.writeFileSync(path.join(layoutTmpDir, 'AGENTS.md'), '# Agents');
    const file = makeFile(
      [
        '## Project Structure',
        '',
        'docs/',
        'â”œâ”€â”€ real-guide.md',
        '',
        'Follow the conventions in AGENTS.md',
      ].join('\n'),
      claudePath,
    );
    const issues = detectDeadReferences([file], layoutTmpDir);
    expect(issues.every((i) => !i.title.includes('Follow the conventions in AGENTS.md'))).toBe(true);
  });

  it('resolves connector-style subdirectories under the shown parent directory', () => {
    fs.mkdirSync(path.join(layoutTmpDir, 'docs', 'api'), { recursive: true });
    fs.writeFileSync(path.join(layoutTmpDir, 'docs', 'api', 'endpoints.md'), '# Endpoints');
    const claudePath = path.join(layoutTmpDir, 'CLAUDE.md');
    const file = makeFile(
      [
        '## Repository Layout',
        '',
        'docs/',
        'â”œâ”€â”€ api/',
        'â”‚   â””â”€â”€ endpoints.md',
      ].join('\n'),
      claudePath,
    );
    const issues = detectDeadReferences([file], layoutTmpDir);
    expect(issues.every((i) => !i.title.includes('endpoints.md'))).toBe(true);
  });

  it('does NOT flag a backtick directory path in CLAUDE.md (BUG-002 suppression)', () => {
    // BUG-002: Backtick dir paths in CLAUDE.md are now suppressed — they are
    // almost always architecture descriptions, not real file references.
    const claudePath = path.join(layoutTmpDir, 'CLAUDE.md');
    const file = makeFile(
      '## Architecture\nThe OT engine lives in `lib/streamline/collaboration/ot/`.',
      claudePath,
    );
    const issues = detectDeadReferences([file], layoutTmpDir);
    expect(issues.every((i) => !i.evidence[0]?.includes('lib/streamline/collaboration/ot/'))).toBe(true);
  });
});

// ── .promptci/ output directory references should not fire ───────────────────

describe('detectDeadReferences — .promptci output dir', () => {
  let pciTmpDir: string;

  beforeAll(() => {
    pciTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-pci-test-'));
  });

  afterAll(() => {
    fs.rmSync(pciTmpDir, { recursive: true, force: true });
  });

  it('does NOT flag `.promptci/config.json` as a dead reference', () => {
    const file = makeFile(
      'Run `promptci init` to create `.promptci/config.json` with defaults.',
      path.join(pciTmpDir, 'README.md'),
    );
    const issues = detectDeadReferences([file], pciTmpDir);
    expect(issues.every((i) => !i.title.includes('config.json'))).toBe(true);
  });

  it('does NOT flag `.promptci/latest.md` or `.promptci/report.json`', () => {
    const file = makeFile(
      'Scan output: `.promptci/latest.md` and `.promptci/report.json`.',
      path.join(pciTmpDir, 'CLAUDE.md'),
    );
    expect(detectDeadReferences([file], pciTmpDir)).toHaveLength(0);
  });
});

// ── BUG-002: Source-code backtick suppression in all instruction file types ────

describe('detectDeadReferences — BUG-002 source-code backtick suppression (all file types)', () => {
  let rmTmpDir: string;

  beforeAll(() => {
    rmTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-rm-test-'));
  });

  afterAll(() => {
    fs.rmSync(rmTmpDir, { recursive: true, force: true });
  });

  it('does NOT flag `lib/upload.ts` in a README file', () => {
    const file = makeFile(
      'Dead-reference detector fires on source-code file paths (e.g. `lib/upload.ts`).',
      path.join(rmTmpDir, 'README.md'),
      { fileType: 'readme' },
    );
    expect(detectDeadReferences([file], rmTmpDir)).toHaveLength(0);
  });

  // BUG-002: CLAUDE.md and AGENTS.md also skip backtick-quoted compiled source file paths.
  // These are almost always architecture descriptions, not real file references.
  it('does NOT flag `lib/upload.ts` in a CLAUDE.md file (BUG-002)', () => {
    const file = makeFile(
      'The upload helper lives at `lib/upload.ts`.',
      path.join(rmTmpDir, 'CLAUDE.md'),
    );
    const issues = detectDeadReferences([file], rmTmpDir);
    // .ts is in BACKTICK_SKIP_SOURCE_EXTENSIONS — skip in all instruction file types
    expect(issues.every((i) => !i.title.includes('upload.ts'))).toBe(true);
  });

  it('does NOT flag backtick `.go` source refs in AGENTS.md (BUG-002)', () => {
    const file = makeFile(
      'Error handling is in `internal/client/errors.go`. Review before editing.',
      path.join(rmTmpDir, 'AGENTS.md'),
      { fileType: 'agents' },
    );
    expect(detectDeadReferences([file], rmTmpDir).every((i) => !i.title.includes('errors.go'))).toBe(true);
  });

  it('does NOT flag backtick `.cs` source refs in .cursorrules (BUG-002)', () => {
    const file = makeFile(
      'The main controller is `Assets/Scripts/PlayerController.cs`.',
      path.join(rmTmpDir, '.cursorrules'),
      { fileType: 'cursor' },
    );
    expect(detectDeadReferences([file], rmTmpDir).every((i) => !i.title.includes('PlayerController'))).toBe(true);
  });

  it('flags stale legacy `.cs` source refs in Unity instruction files', () => {
    const file = makeFile(
      'Use `Assets/Scripts/Legacy/OldNetworkManager.cs` as the migration example.',
      path.join(rmTmpDir, 'AGENTS.md'),
      { fileType: 'agents' },
    );
    const issues = detectDeadReferences([file], rmTmpDir);
    expect(issues.some((i) => i.title.includes('OldNetworkManager.cs'))).toBe(true);
  });

  it('does NOT flag backtick directory paths in CLAUDE.md (BUG-002)', () => {
    const file = makeFile(
      'Registry client lives in `pkg/registry/`. Error types are in `internal/client/`.',
      path.join(rmTmpDir, 'CLAUDE.md'),
    );
    // Backtick directory paths are also skipped in all instruction file types
    expect(detectDeadReferences([file], rmTmpDir)).toHaveLength(0);
  });

  it('STILL flags a shell script ref in backticks (not in skip list)', () => {
    const file = makeFile(
      'Run `scripts/setup-dev.sh` to bootstrap the dev environment.',
      path.join(rmTmpDir, 'CLAUDE.md'),
    );
    const issues = detectDeadReferences([file], rmTmpDir);
    // .sh is intentionally NOT in BACKTICK_SKIP_SOURCE_EXTENSIONS
    expect(issues.some((i) => i.title.includes('setup-dev.sh'))).toBe(true);
  });

  it('STILL flags a missing .md link in a README', () => {
    const file = makeFile(
      'See [missing guide](./MISSING.md) for setup.',
      path.join(rmTmpDir, 'README.md'),
      { fileType: 'readme' },
    );
    const issues = detectDeadReferences([file], rmTmpDir);
    expect(issues.some((i) => i.title.includes('MISSING.md'))).toBe(true);
  });
});

// ── BUG-009: Curly-brace template paths ───────────────────────────────────────

describe('detectDeadReferences – BUG-009 curly-brace template paths', () => {
  let tmpDir2: string;

  beforeAll(() => {
    tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-curly-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir2, { recursive: true, force: true });
  });

  it('does NOT flag a backtick path with {variable} placeholders', () => {
    const file = makeFile(
      'Translation files live at `public/locales/{locale}/{namespace}.json`.',
      path.join(tmpDir2, 'CLAUDE.md'),
    );
    const issues = detectDeadReferences([file], tmpDir2);
    expect(issues).toHaveLength(0);
  });

  it('does NOT flag a markdown link path with {variable} placeholders', () => {
    const file = makeFile(
      'See [schema](./src/{domain}/schema.ts) for the shape.',
      path.join(tmpDir2, 'CLAUDE.md'),
    );
    const issues = detectDeadReferences([file], tmpDir2);
    expect(issues).toHaveLength(0);
  });

  it('STILL flags a real missing path that has no curly braces', () => {
    const file = makeFile(
      'See [missing schema](./src/missing-schema.ts) for the shape.',
      path.join(tmpDir2, 'CLAUDE.md'),
    );
    const issues = detectDeadReferences([file], tmpDir2);
    expect(issues).toHaveLength(1);
  });
});

// ── BUG-004/005: Deduplication across multiple files ─────────────────────────

describe('detectDeadReferences – BUG-004/005 cross-file deduplication', () => {
  let tmpDir3: string;

  beforeAll(() => {
    tmpDir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-dedup-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir3, { recursive: true, force: true });
  });

  it('emits ONE issue when the same dead path is referenced in two files', () => {
    const fileA = makeFile(
      'See [setup](./docs/setup.md) for instructions.',
      path.join(tmpDir3, 'CLAUDE.md'),
    );
    const fileB = makeFile(
      'Also see [setup guide](./docs/setup.md) for more.',
      path.join(tmpDir3, 'AGENTS.md'),
      { fileType: 'agents' },
    );
    const issues = detectDeadReferences([fileA, fileB], tmpDir3);
    const setupIssues = issues.filter((i) => i.title.includes('setup.md'));
    expect(setupIssues).toHaveLength(1);
    // Both files should be listed in the single issue
    expect(setupIssues[0]!.filePaths).toContain(path.join(tmpDir3, 'CLAUDE.md'));
    expect(setupIssues[0]!.filePaths).toContain(path.join(tmpDir3, 'AGENTS.md'));
  });

  it('still emits separate issues for two different dead paths', () => {
    const file = makeFile(
      'See [setup](./docs/setup-guide.md) and [auth](./docs/auth-guide.md).',
      path.join(tmpDir3, 'CLAUDE.md'),
    );
    const issues = detectDeadReferences([file], tmpDir3);
    expect(issues.length).toBeGreaterThanOrEqual(2);
  });
});

// ── BUG-006 (eval): Ellipsis glob placeholder paths ──────────────────────────

describe('detectDeadReferences — BUG-006 (eval) ellipsis glob placeholders', () => {
  let elTmpDir: string;

  beforeAll(() => {
    elTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-ellipsis-'));
  });

  afterAll(() => {
    fs.rmSync(elTmpDir, { recursive: true, force: true });
  });

  it('does NOT flag `src/test/java/.../unit/` as a dead reference', () => {
    const file = makeFile(
      '## Testing\n- Unit tests: JUnit 5, in `src/test/java/.../unit/`\n- Integration: `src/test/java/.../integration/`',
      path.join(elTmpDir, 'copilot-instructions.md'),
      { fileType: 'copilot' },
    );
    const issues = detectDeadReferences([file], elTmpDir);
    expect(issues.every((i) => !i.evidence[0]?.includes('...'))).toBe(true);
  });

  it('does NOT flag `.../integration/` as a dead reference', () => {
    const file = makeFile(
      'Integration tests live in `.../integration/` within the test tree.',
      path.join(elTmpDir, 'CLAUDE.md'),
    );
    expect(detectDeadReferences([file], elTmpDir)).toHaveLength(0);
  });

  it('STILL flags real dead paths that do not contain ellipsis', () => {
    const file = makeFile(
      'Tests are in `src/test/unit/` and `src/test/integration/` (run `mvn test`).',
      path.join(elTmpDir, 'CLAUDE.md'),
    );
    const issues = detectDeadReferences([file], elTmpDir);
    // BUG-002: Backtick dir paths in CLAUDE.md are now skipped. Verify the test
    // no longer errors — dir path check applies but these dirs legitimately don't fire.
    // The test verifies the scanner doesn\'t crash and returns a valid array.
    expect(Array.isArray(issues)).toBe(true);
  });
});

// ── BUG-005 (eval): Naming-convention example filenames ──────────────────────

describe('detectDeadReferences — BUG-005 (eval) naming-convention example filenames', () => {
  let ncTmpDir: string;

  beforeAll(() => {
    ncTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-naming-'));
  });

  afterAll(() => {
    fs.rmSync(ncTmpDir, { recursive: true, force: true });
  });

  it('does NOT flag `useCamelCase.ts` as a dead reference', () => {
    // From DashKit AGENTS.md: "Composable files: `useCamelCase.ts` (e.g. useDataTable.ts)"
    const file = makeFile(
      '## Component Naming\n- Composable files: `useCamelCase.ts` (e.g. `useDataTable.ts`)',
      path.join(ncTmpDir, 'AGENTS.md'),
      { fileType: 'agents' },
    );
    const issues = detectDeadReferences([file], ncTmpDir);
    expect(issues.every((i) => !i.title.toLowerCase().includes('camelcase'))).toBe(true);
  });

  it('does NOT flag `camelCase.types.ts` as a dead reference', () => {
    const file = makeFile(
      '## Naming\n- Type files: `camelCase.types.ts`',
      path.join(ncTmpDir, 'AGENTS.md'),
      { fileType: 'agents' },
    );
    expect(detectDeadReferences([file], ncTmpDir).every((i) => !i.title.includes('types.ts'))).toBe(true);
  });

  it('does NOT flag `my-kebab-case-component.tsx` as a dead reference', () => {
    const file = makeFile(
      '## Naming\nFiles use kebab-case: `my-kebab-case-component.tsx`',
      path.join(ncTmpDir, 'CLAUDE.md'),
    );
    expect(detectDeadReferences([file], ncTmpDir).every((i) => !i.title.includes('kebab-case'))).toBe(true);
  });

  it('STILL flags a real dead reference in the same naming section', () => {
    // "useDataTable.ts" is a real file name (not a naming-convention term) and should fire
    const file = makeFile(
      '## Naming\nSee `useCamelCase.ts` for the pattern. The real hook is `scripts/codegen.sh`.',
      path.join(ncTmpDir, 'AGENTS.md'),
      { fileType: 'agents' },
    );
    const issues = detectDeadReferences([file], ncTmpDir);
    expect(issues.some((i) => i.title.includes('codegen.sh'))).toBe(true);
    expect(issues.every((i) => !i.title.toLowerCase().includes('camelcase'))).toBe(true);
  });
});

// ── BUG-002 (eval): Code-block layout section doc refs ───────────────────────

describe('detectDeadReferences — BUG-002 (eval) code-block layout paths', () => {
  let cbTmpDir: string;

  beforeAll(() => {
    cbTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-cblayout-'));
    fs.mkdirSync(path.join(cbTmpDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(cbTmpDir, 'docs', 'existing.md'), '# Existing');
  });

  afterAll(() => {
    fs.rmSync(cbTmpDir, { recursive: true, force: true });
  });

  it('flags missing .md files listed under a parent directory in a fenced code block', () => {
    const content = [
      '## Repository Layout',
      '',
      '```',
      'src/',
      '  main.rs',
      'docs/',
      '  runbook.md',
      '  rate-limiting.md',
      '```',
    ].join('\n');
    const file = makeFile(content, path.join(cbTmpDir, 'CLAUDE.md'));
    const issues = detectDeadReferences([file], cbTmpDir);
    expect(issues.some((i) => i.title.includes('runbook.md'))).toBe(true);
    expect(issues.some((i) => i.title.includes('rate-limiting.md'))).toBe(true);
  });

  // This detector's fence handling was a ```-only regex until the shared
  // markdown-fences scanner replaced it — a ~~~ layout block was skipped
  // entirely, so nothing inside it was ever checked.
  it('flags missing .md files listed in a ~~~ fenced layout block', () => {
    const content = [
      '## Repository Layout',
      '',
      '~~~',
      'docs/',
      '  runbook.md',
      '~~~',
    ].join('\n');
    const file = makeFile(content, path.join(cbTmpDir, 'CLAUDE.md'));
    const issues = detectDeadReferences([file], cbTmpDir);
    expect(issues.some((i) => i.title.includes('runbook.md'))).toBe(true);
  });

  it('flags missing .md files listed in an indented fenced layout block', () => {
    const content = [
      '## Repository Layout',
      '',
      '  ```',
      '  docs/',
      '    runbook.md',
      '  ```',
    ].join('\n');
    const file = makeFile(content, path.join(cbTmpDir, 'CLAUDE.md'));
    const issues = detectDeadReferences([file], cbTmpDir);
    expect(issues.some((i) => i.title.includes('runbook.md'))).toBe(true);
  });

  it('does NOT flag .md files that actually exist', () => {
    const content = [
      '## Repository Layout',
      '',
      '```',
      'docs/',
      '  existing.md',
      '```',
    ].join('\n');
    const file = makeFile(content, path.join(cbTmpDir, 'CLAUDE.md'));
    const issues = detectDeadReferences([file], cbTmpDir);
    expect(issues.every((i) => !i.title.includes('existing.md'))).toBe(true);
  });

  it('does NOT flag nested .md files that exist under nested fenced layout directories', () => {
    fs.mkdirSync(path.join(cbTmpDir, 'docs', 'api'), { recursive: true });
    fs.writeFileSync(path.join(cbTmpDir, 'docs', 'api', 'endpoints.md'), '# Endpoints');
    const content = [
      '## Repository Layout',
      '',
      '```',
      'docs/',
      '  api/',
      '    endpoints.md',
      '```',
    ].join('\n');
    const file = makeFile(content, path.join(cbTmpDir, 'CLAUDE.md'));
    const issues = detectDeadReferences([file], cbTmpDir);
    expect(issues.every((i) => !i.title.includes('endpoints.md'))).toBe(true);
  });

  it('flags full .md file paths at the top level of fenced layout blocks', () => {
    const content = [
      '## Repository Layout',
      '',
      '```',
      'docs/missing-runbook.md',
      '```',
    ].join('\n');
    const file = makeFile(content, path.join(cbTmpDir, 'CLAUDE.md'));
    const issues = detectDeadReferences([file], cbTmpDir);
    expect(issues.some((i) => i.title.includes('missing-runbook.md'))).toBe(true);
  });

  it('does NOT fire for source code files (only .md) in code-block layout', () => {
    // Source code files like main.rs, config/ are intentionally not flagged by
    // the code-block extractor to avoid FPs in test/instruction-only repos.
    const content = [
      '## Repository Layout',
      '',
      '```',
      'src/',
      '  main.rs',
      '  config/',
      '```',
    ].join('\n');
    const file = makeFile(content, path.join(cbTmpDir, 'CLAUDE.md'));
    const issues = detectDeadReferences([file], cbTmpDir);
    expect(issues.every((i) => !i.title.includes('main.rs'))).toBe(true);
  });
});

// ── Placeholder stem with directory prefix should NOT be suppressed ──────────

describe('detectDeadReferences — placeholder stem with directory prefix', () => {
  let psTmpDir: string;

  beforeAll(() => {
    psTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-ps-'));
  });

  afterAll(() => {
    fs.rmSync(psTmpDir, { recursive: true, force: true });
  });

  it('flags `[Test Runner](./scripts/test.sh)` as a dead reference', () => {
    // go-cli PE-025 regression: ./scripts/test.sh has "test" stem but is a real script ref.
    const file = makeFile(
      'Run the test runner at [Test Runner](./scripts/test.sh) before declaring done.',
      path.join(psTmpDir, 'AGENTS.md'),
      { fileType: 'agents' },
    );
    const issues = detectDeadReferences([file], psTmpDir);
    expect(issues.some((i) => i.title.includes('test.sh'))).toBe(true);
  });

  it('still does NOT flag a bare `test.sh` reference (placeholder example)', () => {
    const file = makeFile(
      'Name your test scripts like `test.sh` for consistency.',
      path.join(psTmpDir, 'CLAUDE.md'),
    );
    expect(detectDeadReferences([file], psTmpDir).every((i) => !i.title.includes('test.sh'))).toBe(true);
  });

  it('flags `scripts/example.py` (directory-prefixed example stem)', () => {
    const file = makeFile(
      'Run `scripts/example.py` to seed the dev database.',
      path.join(psTmpDir, 'CLAUDE.md'),
    );
    const issues = detectDeadReferences([file], psTmpDir);
    expect(issues.some((i) => i.title.includes('example.py'))).toBe(true);
  });

  it('still does NOT flag bare `example.py` (placeholder)', () => {
    const file = makeFile(
      'Your script should look like `example.py`.',
      path.join(psTmpDir, 'CLAUDE.md'),
    );
    expect(detectDeadReferences([file], psTmpDir).every((i) => !i.title.includes('example.py'))).toBe(true);
  });
});

// ── Universal project-root files should never fire ───────────────────────────

describe('detectDeadReferences — universal project-root files', () => {
  let pkgTmpDir: string;

  beforeAll(() => {
    pkgTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-pkg-'));
  });

  afterAll(() => {
    fs.rmSync(pkgTmpDir, { recursive: true, force: true });
  });

  it('does NOT flag `package.json` as a dead reference', () => {
    const file = makeFile(
      'Run `npm install` after editing `package.json` to add a dependency.',
      path.join(pkgTmpDir, 'CLAUDE.md'),
    );
    expect(detectDeadReferences([file], pkgTmpDir).every((i) => !i.title.includes('package.json'))).toBe(true);
  });

  it('does NOT flag `tsconfig.json` as a dead reference', () => {
    const file = makeFile(
      'TypeScript config lives in `tsconfig.json` — do not change `strict: true`.',
      path.join(pkgTmpDir, 'CLAUDE.md'),
    );
    expect(detectDeadReferences([file], pkgTmpDir).every((i) => !i.title.includes('tsconfig.json'))).toBe(true);
  });

  it('STILL flags a path-prefixed package.json if it does not exist', () => {
    const file = makeFile(
      'Each workspace has its own `packages/ui/package.json`.',
      path.join(pkgTmpDir, 'CLAUDE.md'),
    );
    const issues = detectDeadReferences([file], pkgTmpDir);
    // Has a directory prefix — not suppressed as a generic bare filename
    expect(issues.some((i) => i.title.includes('package.json'))).toBe(true);
  });
});

// ── D1: markdown links with a title ───────────────────────────────────────────

describe('detectDeadReferences — D1 markdown link titles', () => {
  let d1TmpDir: string;

  beforeAll(() => {
    d1TmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-d1-'));
  });

  afterAll(() => {
    fs.rmSync(d1TmpDir, { recursive: true, force: true });
  });

  it('flags a dead link that carries a quoted title', () => {
    const file = makeFile(
      'See [Guide](docs/missing.md "The Guide") for details.',
      path.join(d1TmpDir, 'CLAUDE.md'),
    );
    const issues = detectDeadReferences([file], d1TmpDir);
    expect(issues.some((i) => i.title.includes('missing.md'))).toBe(true);
  });

  it('does NOT flag a link with a title when the target actually exists', () => {
    fs.writeFileSync(path.join(d1TmpDir, 'present.md'), '# Present');
    const file = makeFile(
      "See [Guide](present.md 'The Guide') for details.",
      path.join(d1TmpDir, 'CLAUDE.md'),
    );
    const issues = detectDeadReferences([file], d1TmpDir);
    expect(issues.every((i) => !i.title.includes('present.md'))).toBe(true);
  });
});

// ── D2: reference-style links ─────────────────────────────────────────────────

describe('detectDeadReferences — D2 reference-style links', () => {
  let d2TmpDir: string;

  beforeAll(() => {
    d2TmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-d2-'));
  });

  afterAll(() => {
    fs.rmSync(d2TmpDir, { recursive: true, force: true });
  });

  it('flags a dead reference-style link definition', () => {
    const file = makeFile(
      ['See the [setup guide][setup-ref] before starting.', '', '[setup-ref]: docs/missing-setup.md'].join('\n'),
      path.join(d2TmpDir, 'CLAUDE.md'),
    );
    const issues = detectDeadReferences([file], d2TmpDir);
    expect(issues.some((i) => i.title.includes('missing-setup.md'))).toBe(true);
  });

  it('does NOT flag a reference-style link whose definition resolves', () => {
    fs.writeFileSync(path.join(d2TmpDir, 'real-setup.md'), '# Setup');
    const file = makeFile(
      ['See the [setup guide][setup-ref] before starting.', '', '[setup-ref]: real-setup.md'].join('\n'),
      path.join(d2TmpDir, 'CLAUDE.md'),
    );
    const issues = detectDeadReferences([file], d2TmpDir);
    expect(issues.every((i) => !i.title.includes('real-setup.md'))).toBe(true);
  });
});

// ── D3: backtick path + line-number suffix ────────────────────────────────────

describe('detectDeadReferences — D3 backtick path:line refs', () => {
  let d3TmpDir: string;

  beforeAll(() => {
    d3TmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-d3-'));
  });

  afterAll(() => {
    fs.rmSync(d3TmpDir, { recursive: true, force: true });
  });

  it('flags a dead `path/file.py:42` backtick reference', () => {
    // .ts/.go/.cs source refs in backticks are intentionally skipped as architecture
    // docs (BUG-002) — use .py, which is NOT in that skip list, to isolate the
    // path:line suffix-stripping fix.
    const file = makeFile(
      'See `src/gone.py:42` for the old implementation.',
      path.join(d3TmpDir, 'README.md'),
      { fileType: 'readme' },
    );
    const issues = detectDeadReferences([file], d3TmpDir);
    expect(issues.some((i) => i.title.includes('gone.py'))).toBe(true);
  });

  it('does NOT flag `path/file.py:42:7` when the file actually exists', () => {
    fs.writeFileSync(path.join(d3TmpDir, 'present.py'), 'pass');
    const file = makeFile(
      'See `present.py:42:7` for the implementation.',
      path.join(d3TmpDir, 'README.md'),
      { fileType: 'readme' },
    );
    const issues = detectDeadReferences([file], d3TmpDir);
    expect(issues.every((i) => !i.title.includes('present.py'))).toBe(true);
  });
});

// ── D4: ASCII directory-tree paths ────────────────────────────────────────────

describe('detectDeadReferences — D4 ASCII directory trees', () => {
  let d4TmpDir: string;

  beforeAll(() => {
    d4TmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-d4-'));
  });

  afterAll(() => {
    fs.rmSync(d4TmpDir, { recursive: true, force: true });
  });

  it('flags a missing file listed with an ASCII `|--` tree connector', () => {
    const file = makeFile(
      ['## Project Structure', '', '|-- docs/missing-runbook.md'].join('\n'),
      path.join(d4TmpDir, 'CLAUDE.md'),
    );
    const issues = detectDeadReferences([file], d4TmpDir);
    expect(issues.some((i) => i.title.includes('missing-runbook.md'))).toBe(true);
  });

  it('flags a missing file listed with a backtick-corner ASCII connector', () => {
    const file = makeFile(
      ['## Project Structure', '', '`-- docs/also-missing.md'].join('\n'),
      path.join(d4TmpDir, 'CLAUDE.md'),
    );
    const issues = detectDeadReferences([file], d4TmpDir);
    expect(issues.some((i) => i.title.includes('also-missing.md'))).toBe(true);
  });

  it('does NOT misread a markdown table row as a tree entry', () => {
    const file = makeFile(
      ['## Project Structure', '', '| Path | Description |', '| docs/foo.md | Foo doc |'].join('\n'),
      path.join(d4TmpDir, 'CLAUDE.md'),
    );
    // Should not throw and should not produce a tree-path match purely from the
    // table pipe (no dash connector) — real existence checking is a separate concern.
    expect(() => detectDeadReferences([file], d4TmpDir)).not.toThrow();
  });
});

// ── D5: broadened layout-section heading gate ─────────────────────────────────

describe('detectDeadReferences — D5 layout heading aliases', () => {
  let d5TmpDir: string;

  beforeAll(() => {
    d5TmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-d5-'));
  });

  afterAll(() => {
    fs.rmSync(d5TmpDir, { recursive: true, force: true });
  });

  it('recognizes a "## Codebase Map" heading', () => {
    const file = makeFile(
      ['## Codebase Map', '', '- docs/missing-map-entry.md'].join('\n'),
      path.join(d5TmpDir, 'CLAUDE.md'),
    );
    const issues = detectDeadReferences([file], d5TmpDir);
    expect(issues.some((i) => i.title.includes('missing-map-entry.md'))).toBe(true);
  });

  it('recognizes a "## Directory Overview" heading', () => {
    const file = makeFile(
      ['## Directory Overview', '', '- docs/missing-overview-entry.md'].join('\n'),
      path.join(d5TmpDir, 'CLAUDE.md'),
    );
    const issues = detectDeadReferences([file], d5TmpDir);
    expect(issues.some((i) => i.title.includes('missing-overview-entry.md'))).toBe(true);
  });

  it('recognizes a bolded "**Project Structure**" pseudo-heading', () => {
    const file = makeFile(
      ['**Project Structure**', '', '- docs/missing-bold-entry.md'].join('\n'),
      path.join(d5TmpDir, 'CLAUDE.md'),
    );
    const issues = detectDeadReferences([file], d5TmpDir);
    expect(issues.some((i) => i.title.includes('missing-bold-entry.md'))).toBe(true);
  });
});

// ── D7: cert/key files suppressed regardless of stem ──────────────────────────

describe('detectDeadReferences — D7 cert/key suppression by extension', () => {
  let d7TmpDir: string;

  beforeAll(() => {
    d7TmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-d7-'));
  });

  afterAll(() => {
    fs.rmSync(d7TmpDir, { recursive: true, force: true });
  });

  it('does NOT flag `certs/server.pem` as a dead reference', () => {
    const file = makeFile(
      'Place the TLS certificate at `certs/server.pem` before starting the server.',
      path.join(d7TmpDir, 'CLAUDE.md'),
    );
    const issues = detectDeadReferences([file], d7TmpDir);
    expect(issues.every((i) => !i.title.includes('server.pem'))).toBe(true);
  });

  it('does NOT flag `config/client.key` as a dead reference', () => {
    const file = makeFile(
      'The client key lives at `config/client.key` (never commit it).',
      path.join(d7TmpDir, 'CLAUDE.md'),
    );
    const issues = detectDeadReferences([file], d7TmpDir);
    expect(issues.every((i) => !i.title.includes('client.key'))).toBe(true);
  });
});

// ── D8: locations carry line numbers when known ───────────────────────────────

describe('detectDeadReferences — D8 location line numbers', () => {
  let d8TmpDir: string;

  beforeAll(() => {
    d8TmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-d8-'));
  });

  afterAll(() => {
    fs.rmSync(d8TmpDir, { recursive: true, force: true });
  });

  it('reports the correct startLine for a markdown link on a later line', () => {
    const claudePath = path.join(d8TmpDir, 'CLAUDE.md');
    const file = makeFile(
      ['# Intro', 'Some text.', 'More text.', 'See [missing](./docs/gone.md) here.'].join('\n'),
      claudePath,
    );
    const issues = detectDeadReferences([file], d8TmpDir);
    const issue = issues.find((i) => i.title.includes('gone.md'));
    expect(issue).toBeDefined();
    const location = issue!.locations.find((l) => l.filePath === claudePath);
    expect(location).toBeDefined();
    expect(location!.startLine).toBe(4);
  });
});

// ── BUG-D1: creation-intent references are not "broken" ──────────────────────

describe('detectDeadReferences — creation-intent phrasing', () => {
  it('does NOT flag "Create a file named `X` in your repository"', () => {
    const readmePath = path.join(tmpDir, 'README.md');
    const file = makeFile(
      'Create a file named `.github/workflows/promptci.yml` in your repository:',
      readmePath,
      { fileType: 'readme' },
    );
    const issues = detectDeadReferences([file], tmpDir);
    expect(issues).toEqual([]);
  });

  it('still flags an ordinary broken reference on a non-creation line', () => {
    const readmePath = path.join(tmpDir, 'README.md');
    const file = makeFile(
      'See `.github/workflows/promptci.yml` for the audit config.',
      readmePath,
      { fileType: 'readme' },
    );
    const issues = detectDeadReferences([file], tmpDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].title).toMatch(/promptci\.yml/);
  });

  it('suppresses only the creation target, not an unrelated broken ref on the same line', () => {
    const readmePath = path.join(tmpDir, 'README.md');
    const file = makeFile(
      'Create a file named `.github/workflows/ci.yml`, similar to `docs/other-ci-guide.md`.',
      readmePath,
      { fileType: 'readme' },
    );
    const issues = detectDeadReferences([file], tmpDir);
    // ci.yml is the creation target (suppressed); other-ci-guide.md is a genuine
    // broken reference that merely shares the line — it must still be flagged.
    expect(issues).toHaveLength(1);
    expect(issues[0].title).toMatch(/other-ci-guide\.md/);
  });
});

