import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanFiles } from '../src/scanner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, '../../../examples');

describe('scanFiles', () => {
  it('fixture-basic: finds AGENTS.md with correct fileType and content', async () => {
    const files = await scanFiles({ repoPath: path.join(FIXTURES, 'fixture-basic') });
    const agents = files.find((f) => path.basename(f.path) === 'AGENTS.md');
    expect(agents).toBeDefined();
    expect(agents!.fileType).toBe('agents');
    expect(agents!.content.length).toBeGreaterThan(0);
    expect(agents!.lineCount).toBeGreaterThan(0);
  });

  it('fixture-conflicts: finds CLAUDE.md with fileType claude', async () => {
    const files = await scanFiles({ repoPath: path.join(FIXTURES, 'fixture-conflicts') });
    const claude = files.find((f) => path.basename(f.path) === 'CLAUDE.md');
    expect(claude).toBeDefined();
    expect(claude!.fileType).toBe('claude');
  });

  it('fixture-unity: finds AGENTS.md', async () => {
    const files = await scanFiles({ repoPath: path.join(FIXTURES, 'fixture-unity') });
    const agents = files.find((f) => path.basename(f.path) === 'AGENTS.md');
    expect(agents).toBeDefined();
    expect(agents!.fileType).toBe('agents');
  });

  it('missing directory: returns [] without throwing', async () => {
    const files = await scanFiles({ repoPath: path.join(FIXTURES, 'does-not-exist') });
    expect(files).toEqual([]);
  });

  it('stable sort: two runs return identical path order', async () => {
    const run1 = await scanFiles({ repoPath: FIXTURES });
    const run2 = await scanFiles({ repoPath: FIXTURES });
    expect(run1.map((f) => f.path)).toEqual(run2.map((f) => f.path));
  });

  it('no .git or node_modules files leak into results', async () => {
    const files = await scanFiles({ repoPath: FIXTURES });
    for (const f of files) {
      const norm = f.path.replace(/\\/g, '/');
      expect(norm).not.toMatch(/\/\.git\//);
      expect(norm).not.toMatch(/\/node_modules\//);
    }
  });

  it('sections are parsed from markdown headings', async () => {
    const files = await scanFiles({ repoPath: path.join(FIXTURES, 'fixture-basic') });
    const agents = files.find((f) => path.basename(f.path) === 'AGENTS.md');
    expect(agents).toBeDefined();
    expect(agents!.sections.length).toBeGreaterThan(0);
    for (const s of agents!.sections) {
      expect(s.startLine).toBeGreaterThanOrEqual(1);
      expect(s.endLine).toBeGreaterThanOrEqual(s.startLine);
      expect(typeof s.normalizedText).toBe('string');
    }
  });

  it('estimatedTokens is charCount / 4 rounded', async () => {
    const files = await scanFiles({ repoPath: path.join(FIXTURES, 'fixture-basic') });
    for (const f of files) {
      expect(f.estimatedTokens).toBe(Math.round(f.charCount / 4));
    }
  });

  it('empty include array uses default patterns (not zero files)', async () => {
    const files = await scanFiles({
      repoPath: path.join(FIXTURES, 'fixture-basic'),
      include: [],
    });
    // Should behave identically to omitting include — finds AGENTS.md
    expect(files.length).toBeGreaterThan(0);
    const agents = files.find((f) => path.basename(f.path) === 'AGENTS.md');
    expect(agents).toBeDefined();
  });

  it('fixture-no-instructions: returns empty array when no instruction files exist', async () => {
    const files = await scanFiles({ repoPath: path.join(FIXTURES, 'fixture-no-instructions') });
    expect(files).toEqual([]);
  });

  it('fixture-clean: scans without errors and finds CLAUDE.md', async () => {
    const files = await scanFiles({ repoPath: path.join(FIXTURES, 'fixture-clean') });
    const claude = files.find((f) => path.basename(f.path) === 'CLAUDE.md');
    expect(claude).toBeDefined();
    expect(claude!.fileType).toBe('claude');
  });
});

// ── Section parser: bash comments inside code blocks must not become headings ──

describe('parseSections — code block awareness', () => {
  let cbTmpDir: string;

  beforeAll(() => {
    cbTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-scanner-cb-'));
  });

  afterAll(() => {
    fs.rmSync(cbTmpDir, { recursive: true, force: true });
  });

  it('does not split a section at bash comments inside a fenced code block', async () => {
    const content = [
      '## Environment Setup',
      '',
      '```bash',
      '# Install dependencies',
      'npm install',
      '',
      '# Build',
      'npm run build',
      '```',
      '',
      '## Code Style',
      '',
      'Use ESLint.',
    ].join('\n');

    const filePath = path.join(cbTmpDir, 'CLAUDE.md');
    fs.writeFileSync(filePath, content);

    const files = await scanFiles({ repoPath: cbTmpDir });
    const claude = files.find((f) => path.basename(f.path) === 'CLAUDE.md');
    expect(claude).toBeDefined();

    // Should have exactly 2 real sections: "Environment Setup" and "Code Style"
    // (plus possibly a pre-heading intro section if any)
    const headings = claude!.sections.map((s) => s.heading).filter(Boolean);
    expect(headings).toContain('Environment Setup');
    expect(headings).toContain('Code Style');
    // Bash comments should NOT appear as headings
    expect(headings).not.toContain('Install dependencies');
    expect(headings).not.toContain('Build');
  });

  it('parses ATX headings indented by up to three spaces', async () => {
    const content = [
      '  ## Setup',
      '',
      'Use pnpm install before running tests.',
      '',
      '   ### Validation',
      '',
      'Run pnpm test.',
    ].join('\n');

    const filePath = path.join(cbTmpDir, 'INDENTED-HEADINGS.md');
    fs.writeFileSync(filePath, content);

    const files = await scanFiles({ repoPath: cbTmpDir, include: ['INDENTED-HEADINGS.md'] });
    const file = files.find((f) => path.basename(f.path) === 'INDENTED-HEADINGS.md');
    expect(file).toBeDefined();

    const headings = file!.sections.map((s) => s.heading).filter(Boolean);
    expect(headings).toContain('Setup');
    expect(headings).toContain('Validation');
  });

  it('includes the full code block content in the section text', async () => {
    const content = [
      '## Setup',
      '',
      '```bash',
      '# Install Python dependencies',
      'python -m venv .venv',
      'pip install -r requirements.txt',
      '```',
    ].join('\n');

    const filePath = path.join(cbTmpDir, 'AGENTS.md');
    fs.writeFileSync(filePath, content);

    const files = await scanFiles({ repoPath: cbTmpDir });
    const agents = files.find((f) => path.basename(f.path) === 'AGENTS.md');
    expect(agents).toBeDefined();

    const setupSection = agents!.sections.find((s) => s.heading === 'Setup');
    expect(setupSection).toBeDefined();
    // Full code block content should be inside the section text
    expect(setupSection!.text).toContain('python -m venv .venv');
    expect(setupSection!.text).toContain('pip install -r requirements.txt');
  });

  it('a ~~~ line inside a ``` fence does not close the fence early', async () => {
    const content = [
      '## Docs',
      '',
      '```markdown',
      'Example of a tilde fence:',
      '~~~',
      'some text',
      '~~~',
      '```',
      '',
      '## After',
      '',
      '# not a heading (still inside ``` example above? no, this is after)',
    ].join('\n');

    const filePath = path.join(cbTmpDir, 'MIXED-FENCE.md');
    fs.writeFileSync(filePath, content);

    const files = await scanFiles({ repoPath: cbTmpDir, include: ['MIXED-FENCE.md'] });
    const file = files.find((f) => path.basename(f.path) === 'MIXED-FENCE.md');
    expect(file).toBeDefined();

    const headings = file!.sections.map((s) => s.heading).filter(Boolean);
    expect(headings).toContain('Docs');
    expect(headings).toContain('After');
    // The ~~~ lines must not have toggled the (backtick) fence state early.
    expect(headings).not.toContain('some text');
  });

  it('a 4-backtick fence containing a nested ``` example is not closed by the nested fence', async () => {
    const content = [
      '## Nested Example',
      '',
      '````markdown',
      '```bash',
      '# not a heading',
      '```',
      '````',
      '',
      '## Next Section',
    ].join('\n');

    const filePath = path.join(cbTmpDir, 'NESTED-FENCE.md');
    fs.writeFileSync(filePath, content);

    const files = await scanFiles({ repoPath: cbTmpDir, include: ['NESTED-FENCE.md'] });
    const file = files.find((f) => path.basename(f.path) === 'NESTED-FENCE.md');
    expect(file).toBeDefined();

    const headings = file!.sections.map((s) => s.heading).filter(Boolean);
    expect(headings).toEqual(['Nested Example', 'Next Section']);
    expect(headings).not.toContain('not a heading');
  });

  it('fences indented 1-3 spaces are still tracked as code blocks', async () => {
    const content = ['## Indented', '', '   ```bash', '   # not a heading', '   ```', '', '## Done'].join(
      '\n'
    );

    const filePath = path.join(cbTmpDir, 'INDENTED-FENCE.md');
    fs.writeFileSync(filePath, content);

    const files = await scanFiles({ repoPath: cbTmpDir, include: ['INDENTED-FENCE.md'] });
    const file = files.find((f) => path.basename(f.path) === 'INDENTED-FENCE.md');
    expect(file).toBeDefined();

    const headings = file!.sections.map((s) => s.heading).filter(Boolean);
    expect(headings).toEqual(['Indented', 'Done']);
  });

  it('lineCount and last section endLine are not inflated by a trailing newline', async () => {
    const contentWithTrailingNewline = ['## Only Section', '', 'Body line.'].join('\n') + '\n';
    const contentNoTrailingNewline = ['## Only Section', '', 'Body line.'].join('\n');

    fs.writeFileSync(path.join(cbTmpDir, 'TRAILING.md'), contentWithTrailingNewline);
    fs.writeFileSync(path.join(cbTmpDir, 'NO-TRAILING.md'), contentNoTrailingNewline);

    const files = await scanFiles({
      repoPath: cbTmpDir,
      include: ['TRAILING.md', 'NO-TRAILING.md'],
    });

    const withTrailing = files.find((f) => path.basename(f.path) === 'TRAILING.md');
    const withoutTrailing = files.find((f) => path.basename(f.path) === 'NO-TRAILING.md');
    expect(withTrailing).toBeDefined();
    expect(withoutTrailing).toBeDefined();

    // Both files have 3 real lines of content; the trailing '\n' must not add a phantom 4th.
    expect(withTrailing!.lineCount).toBe(3);
    expect(withoutTrailing!.lineCount).toBe(3);

    const section = withTrailing!.sections.find((s) => s.heading === 'Only Section');
    expect(section).toBeDefined();
    expect(section!.endLine).toBe(3);
  });
});

// BUG-19: `.windsurfrules` was in DEFAULT_PATTERNS but had no branch in
// deriveFileType, so it was read (and counted toward context-bloat totals) and
// then skipped by every filetype-gated detector.
describe('scanFiles — .windsurfrules typing', () => {
  let wsTmpDir: string;

  beforeAll(() => {
    wsTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-scanner-ws-'));
    fs.writeFileSync(
      path.join(wsTmpDir, '.windsurfrules'),
      '## Rules\nAlways run the test suite before finishing.\n',
    );
  });

  afterAll(() => {
    fs.rmSync(wsTmpDir, { recursive: true, force: true });
  });

  it('types .windsurfrules as windsurf, not unknown', async () => {
    const files = await scanFiles({ repoPath: wsTmpDir });
    const windsurf = files.find((f) => path.basename(f.path) === '.windsurfrules');
    expect(windsurf).toBeDefined();
    expect(windsurf!.fileType).toBe('windsurf');
  });
});
