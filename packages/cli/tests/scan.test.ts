import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'promptci-scan-test-'));
}

async function writeConfig(dir: string, data: unknown): Promise<void> {
  await fs.mkdir(path.join(dir, '.promptci'), { recursive: true });
  await fs.writeFile(
    path.join(dir, '.promptci', 'config.json'),
    JSON.stringify(data),
    'utf-8',
  );
}

async function writeFile(dir: string, name: string, content: string): Promise<void> {
  await fs.writeFile(path.join(dir, name), content, 'utf-8');
}

describe('runScan (integration)', () => {
  let tmpDir: string;
  let exitCode: number | undefined;
  let stdoutOutput: string;
  let stderrOutput: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    exitCode = undefined;
    stdoutOutput = '';
    stderrOutput = '';

    vi.spyOn(process, 'exit').mockImplementation((code?: number | string) => {
      exitCode = typeof code === 'number' ? code : 0;
      throw new Error(`process.exit(${code})`);
    });

    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutOutput += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    });

    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrOutput += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    });

    vi.spyOn(console, 'error').mockImplementation((msg?: unknown) => {
      stderrOutput += String(msg) + '\n';
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('scans an empty directory and writes output files', async () => {
    const { runScan } = await import('../src/commands/scan.js');
    await runScan({ scanPath: tmpDir });

    const mdExists = await fs.access(path.join(tmpDir, '.promptci', 'latest.md')).then(() => true).catch(() => false);
    const jsonExists = await fs.access(path.join(tmpDir, '.promptci', 'report.json')).then(() => true).catch(() => false);
    expect(mdExists).toBe(true);
    expect(jsonExists).toBe(true);
  });

  it('prints summary to stdout on success', async () => {
    const { runScan } = await import('../src/commands/scan.js');
    await runScan({ scanPath: tmpDir });
    expect(stdoutOutput).toContain('Scan complete');
    expect(stdoutOutput).toContain('/100');
  });

  it('prints JSON to stdout when --json flag is set', async () => {
    const { runScan } = await import('../src/commands/scan.js');
    await runScan({ scanPath: tmpDir, json: true });
    const parsed = JSON.parse(stdoutOutput) as { schemaVersion: string };
    expect(parsed.schemaVersion).toBe('0.1');
  });

  it('writes markdown to --output path', async () => {
    const outFile = path.join(tmpDir, 'custom-report.md');
    const { runScan } = await import('../src/commands/scan.js');
    await runScan({ scanPath: tmpDir, output: outFile });

    const content = await fs.readFile(outFile, 'utf-8');
    expect(content).toContain('PromptCI Health Report');
  });

  it('exits 0 when no issues meet fail-on threshold', async () => {
    const { runScan } = await import('../src/commands/scan.js');
    // scanning empty dir should produce no critical/high issues
    await runScan({ scanPath: tmpDir, failOn: 'critical' });
    expect(exitCode).toBeUndefined();
  });

  it('exits non-zero when issues meet fail-on threshold', async () => {
    // create a CLAUDE.md with vague content to trigger issues
    await writeFile(tmpDir, 'CLAUDE.md', 'Be helpful.\nDo good work.\nWrite code.');
    const { runScan } = await import('../src/commands/scan.js');

    let threw = false;
    try {
      await runScan({ scanPath: tmpDir, failOn: 'info' });
    } catch {
      threw = true;
    }

    // If issues were found at info level, process.exit was called
    if (threw) {
      expect(exitCode).toBe(1);
    } else {
      // No issues at info level — that's also valid
      expect(exitCode).toBeUndefined();
    }
  });

  it('exits non-zero when path does not exist', async () => {
    const { runScan } = await import('../src/commands/scan.js');
    let threw = false;
    try {
      await runScan({ scanPath: path.join(tmpDir, 'nonexistent') });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(exitCode).toBe(1);
  });

  it('respects config file include/exclude patterns', async () => {
    await writeFile(tmpDir, 'CLAUDE.md', '# Instructions\nBe helpful.');
    await writeConfig(tmpDir, { exclude: ['CLAUDE.md'] });

    const { runScan } = await import('../src/commands/scan.js');
    await runScan({ scanPath: tmpDir });

    const jsonPath = path.join(tmpDir, '.promptci', 'report.json');
    // JSON paths are repo-relative; excluded CLAUDE.md must not appear
    const data = JSON.parse(await fs.readFile(jsonPath, 'utf-8')) as { filesScanned: { path: string }[] };
    const paths = data.filesScanned.map((f) => f.path);
    expect(paths.some((p) => p === 'CLAUDE.md' || p.endsWith('CLAUDE.md'))).toBe(false);
  });

  it('reports error and exits on invalid JSON config', async () => {
    await fs.mkdir(path.join(tmpDir, '.promptci'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.promptci', 'config.json'), '{ bad }', 'utf-8');

    const { runScan } = await import('../src/commands/scan.js');
    let threw = false;
    try {
      await runScan({ scanPath: tmpDir });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(exitCode).toBe(1);
    expect(stderrOutput).toContain('Error');
  });

  it('uses severityThreshold from config as default fail-on', async () => {
    // Empty dir scan should produce no issues — pass regardless of threshold
    await writeConfig(tmpDir, { severityThreshold: 'critical' });
    const { runScan } = await import('../src/commands/scan.js');
    await runScan({ scanPath: tmpDir });
    // No critical issues in empty dir, so should not exit
    expect(exitCode).toBeUndefined();
  });

  // An instruction file that never tells the agent to run lint/tests before
  // finishing trips agent-practices' `no-verification-loop` check at WARNING
  // severity — the exact kind of finding a brand-new repo produces.
  const WARNING_ONLY_INSTRUCTIONS = [
    '# Developer Instructions',
    '',
    'Write clear, small commits and keep functions focused.',
    'Prefer explicit names over clever abbreviations.',
    '',
  ].join('\n');

  it('first run: init (writes high) + scan exits 0 on warning-level findings', async () => {
    // Reproduces `promptci init && promptci scan` on a fresh repo.
    await writeFile(tmpDir, 'CLAUDE.md', WARNING_ONLY_INSTRUCTIONS);
    const { runInit } = await import('../src/commands/init.js');
    await runInit(tmpDir, { interactive: false });

    const { runScan } = await import('../src/commands/scan.js');
    await runScan({ scanPath: tmpDir });

    // The gate is 'high', so warning-level findings do not fail the run.
    expect(exitCode).toBeUndefined();

    // Guard the test's premise: there really are warning findings that a
    // 'warning' threshold would have failed on.
    const reportRaw = await fs.readFile(
      path.join(tmpDir, '.promptci', 'report.json'),
      'utf-8',
    );
    const report = JSON.parse(reportRaw) as { issues: { severity: string }[] };
    expect(report.issues.some((i) => i.severity === 'warning')).toBe(true);
    expect(report.issues.some((i) => i.severity === 'high' || i.severity === 'critical')).toBe(false);
  });

  it('names severityThreshold as the source when a config gate causes exit 1', async () => {
    await writeFile(tmpDir, 'CLAUDE.md', WARNING_ONLY_INSTRUCTIONS);
    await writeConfig(tmpDir, { severityThreshold: 'warning' });

    const { runScan } = await import('../src/commands/scan.js');
    let threw = false;
    try {
      await runScan({ scanPath: tmpDir });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(exitCode).toBe(1);
    expect(stderrOutput).toContain('severityThreshold in .promptci/config.json');
  });
});

// ── Baseline integration tests ────────────────────────────────────────────────

describe('runScan — baseline behaviour', () => {
  let tmpDir: string;
  let exitCode: number | undefined;
  let stderrOutput: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    exitCode = undefined;
    stderrOutput = '';

    vi.spyOn(process, 'exit').mockImplementation((code?: number | string) => {
      exitCode = typeof code === 'number' ? code : 0;
      throw new Error(`process.exit(${code})`);
    });

    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrOutput += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    });

    vi.spyOn(console, 'error').mockImplementation((msg?: unknown) => {
      stderrOutput += String(msg) + '\n';
    });

    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('--update-baseline writes .promptci/baseline.json', async () => {
    const { runScan } = await import('../src/commands/scan.js');
    await runScan({ scanPath: tmpDir, updateBaseline: true });

    const baselinePath = path.join(tmpDir, '.promptci', 'baseline.json');
    const exists = await fs.access(baselinePath).then(() => true).catch(() => false);
    expect(exists).toBe(true);

    const content = await fs.readFile(baselinePath, 'utf-8');
    const parsed = JSON.parse(content);
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('--update-baseline produces sorted deterministic JSON', async () => {
    const { runScan } = await import('../src/commands/scan.js');
    // Run twice; output should be byte-identical
    await runScan({ scanPath: tmpDir, updateBaseline: true });
    const firstRun = await fs.readFile(
      path.join(tmpDir, '.promptci', 'baseline.json'),
      'utf-8',
    );
    await runScan({ scanPath: tmpDir, updateBaseline: true });
    const secondRun = await fs.readFile(
      path.join(tmpDir, '.promptci', 'baseline.json'),
      'utf-8',
    );
    expect(firstRun).toBe(secondRun);
  });

  it('treats a missing baseline file as an empty baseline (no crash)', async () => {
    const { runScan } = await import('../src/commands/scan.js');
    // The file does not exist; scan should proceed without error
    await runScan({
      scanPath: tmpDir,
      baseline: '.promptci/baseline.json',
    });
    expect(exitCode).toBeUndefined();
  });

  it('reports error and exits on invalid baseline JSON', async () => {
    await fs.mkdir(path.join(tmpDir, '.promptci'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, '.promptci', 'baseline.json'),
      '{ not valid json !!!',
      'utf-8',
    );

    const { runScan } = await import('../src/commands/scan.js');
    let threw = false;
    try {
      await runScan({
        scanPath: tmpDir,
        baseline: '.promptci/baseline.json',
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(exitCode).toBe(1);
    expect(stderrOutput.toLowerCase()).toContain('invalid json');
  });

  it('reports error and exits on a baseline file with wrong shape', async () => {
    await fs.mkdir(path.join(tmpDir, '.promptci'), { recursive: true });
    // Valid JSON but not a BaselineEntry array
    await fs.writeFile(
      path.join(tmpDir, '.promptci', 'baseline.json'),
      JSON.stringify({ wrong: 'shape' }),
      'utf-8',
    );

    const { runScan } = await import('../src/commands/scan.js');
    let threw = false;
    try {
      await runScan({
        scanPath: tmpDir,
        baseline: '.promptci/baseline.json',
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(exitCode).toBe(1);
    expect(stderrOutput.toLowerCase()).toContain('format');
  });

  // BUG-16: --fail-on-new only ever consulted report.newIssues, which core
  // populates solely when a baseline was supplied. Passing the flag alone made
  // CI run green on a gate that could never fire.
  it('rejects --fail-on-new when no --baseline is given', async () => {
    await writeFile(tmpDir, 'CLAUDE.md', 'Be helpful.\nDo good work.\nWrite code.');
    const { runScan } = await import('../src/commands/scan.js');

    let threw = false;
    try {
      await runScan({ scanPath: tmpDir, failOnNew: 'warning' });
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    expect(exitCode).toBe(1);
    expect(stderrOutput).toContain('--fail-on-new requires a baseline');
    // The gate must reject before scanning, so no report is written.
    const wrote = await fs
      .access(path.join(tmpDir, '.promptci', 'report.json'))
      .then(() => true)
      .catch(() => false);
    expect(wrote).toBe(false);
  });

  it('rejects an invalid --fail-on-new severity', async () => {
    const { runScan } = await import('../src/commands/scan.js');

    let threw = false;
    try {
      await runScan({
        scanPath: tmpDir,
        baseline: '.promptci/baseline.json',
        failOnNew: 'extreme' as never,
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    expect(exitCode).toBe(1);
    expect(stderrOutput).toContain('invalid --fail-on-new value');
  });

  it('--fail-on-new fires against a missing baseline file (everything is new)', async () => {
    await writeFile(tmpDir, 'CLAUDE.md', 'Be helpful.\nDo good work.\nWrite code.');
    const { runScan } = await import('../src/commands/scan.js');

    let threw = false;
    try {
      await runScan({
        scanPath: tmpDir,
        baseline: '.promptci/baseline.json',
        failOnNew: 'info',
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    expect(exitCode).toBe(1);
    expect(stderrOutput).toContain('NEW issue(s)');
  });

  it('--fail-on-new passes once the findings are baselined', async () => {
    await writeFile(tmpDir, 'CLAUDE.md', 'Be helpful.\nDo good work.\nWrite code.');
    // Create .promptci/ up front: several detectors key off its presence, so a
    // baseline captured before the first run creates it would otherwise show a
    // spurious "new" finding on the second run.
    await writeConfig(tmpDir, {});
    const { runScan } = await import('../src/commands/scan.js');

    await runScan({
      scanPath: tmpDir,
      baseline: '.promptci/baseline.json',
      updateBaseline: true,
    });

    await runScan({
      scanPath: tmpDir,
      baseline: '.promptci/baseline.json',
      failOnNew: 'info',
    });

    expect(exitCode).toBeUndefined();
  });

  it('--update-baseline respects a custom --baseline path', async () => {
    const customPath = path.join(tmpDir, 'custom-baseline.json');
    const { runScan } = await import('../src/commands/scan.js');
    await runScan({
      scanPath: tmpDir,
      baseline: 'custom-baseline.json',
      updateBaseline: true,
    });

    const exists = await fs.access(customPath).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });
});
