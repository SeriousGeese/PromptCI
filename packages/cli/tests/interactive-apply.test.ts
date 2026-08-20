import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import {
  applyChangesInteractively,
  NonInteractiveError,
  type ApplyUnit,
} from '../src/lib/interactive-apply.js';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'promptci-apply-test-'));
}

function unit(filePath: string, originalContent: string, newContent: string): ApplyUnit {
  return { changes: [{ filePath, originalContent, newContent }] };
}

describe('applyChangesInteractively', () => {
  let dir: string;
  const logs: string[] = [];
  const log = (m = '') => { logs.push(m); };

  beforeEach(async () => {
    dir = await makeTempDir();
    logs.length = 0;
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('errors instead of hanging when a prompt is needed and stdin ends unanswered', async () => {
    const file = path.join(dir, 'CLAUDE.md');
    await fs.writeFile(file, 'old\n', 'utf-8');
    await expect(
      applyChangesInteractively([unit(file, 'old\n', 'new\n')], {
        repoRoot: dir,
        interactive: true,
        input: Readable.from([]),
        log,
      }),
    ).rejects.toBeInstanceOf(NonInteractiveError);
    // Nothing written.
    expect(await fs.readFile(file, 'utf-8')).toBe('old\n');
  });

  it('accepts confirmations piped on stdin', async () => {
    const yes = path.join(dir, 'yes.md');
    const no = path.join(dir, 'no.md');
    await fs.writeFile(yes, 'old\n', 'utf-8');
    await fs.writeFile(no, 'old\n', 'utf-8');
    const { appliedCount } = await applyChangesInteractively(
      [unit(yes, 'old\n', 'new\n'), unit(no, 'old\n', 'new\n')],
      { repoRoot: dir, interactive: true, input: Readable.from('y\nn\n'), log },
    );
    expect(appliedCount).toBe(1);
    expect(await fs.readFile(yes, 'utf-8')).toBe('new\n');
    expect(await fs.readFile(no, 'utf-8')).toBe('old\n');
  });

  it('succeeds without input when no unit produces changes', async () => {
    const noop: ApplyUnit = { changes: async () => [] };
    const { appliedCount } = await applyChangesInteractively([noop], {
      repoRoot: dir,
      interactive: true,
      input: Readable.from([]),
      log,
    });
    expect(appliedCount).toBe(0);
  });

  it('previews without writing in dry-run, even with no usable stdin', async () => {
    const file = path.join(dir, 'CLAUDE.md');
    await fs.writeFile(file, 'old\n', 'utf-8');
    const { appliedCount } = await applyChangesInteractively([unit(file, 'old\n', 'new\n')], {
      repoRoot: dir,
      dryRun: true,
      interactive: true,
      input: Readable.from([]),
      log,
    });
    expect(appliedCount).toBe(0);
    expect(await fs.readFile(file, 'utf-8')).toBe('old\n');
    expect(logs.join('\n')).toContain('No changes written');
  });

  it('skips a unit whose skipIfModified file was written earlier in the run', async () => {
    const file = path.join(dir, 'README.md');
    await fs.writeFile(file, 'a\nb\nc\n', 'utf-8');
    const first: ApplyUnit = {
      changes: [{ filePath: file, originalContent: 'a\nb\nc\n', newContent: 'a\n' }],
    };
    // Second unit's changes were computed from scan-time line numbers; applying
    // them after the first unit shrank the file would edit the wrong lines.
    const second: ApplyUnit = {
      changes: async () => {
        const current = await fs.readFile(file, 'utf-8');
        return [{ filePath: file, originalContent: current, newContent: current + 'STALE\n' }];
      },
      skipIfModified: [file],
    };
    const { appliedCount, staleSkippedCount } = await applyChangesInteractively(
      [first, second],
      { repoRoot: dir, interactive: false, log },
    );
    expect(appliedCount).toBe(1);
    expect(staleSkippedCount).toBe(1);
    expect(await fs.readFile(file, 'utf-8')).toBe('a\n');
    expect(logs.join('\n')).toContain('Re-run the command');
  });

  it('applies a skipIfModified unit normally when its files are untouched', async () => {
    const file = path.join(dir, 'README.md');
    const other = path.join(dir, '.gitignore');
    await fs.writeFile(file, 'a\n', 'utf-8');
    await fs.writeFile(other, 'x\n', 'utf-8');
    const units: ApplyUnit[] = [
      { changes: [{ filePath: other, originalContent: 'x\n', newContent: 'x\ny\n' }] },
      {
        changes: [{ filePath: file, originalContent: 'a\n', newContent: 'a\nb\n' }],
        skipIfModified: [file],
      },
    ];
    const { appliedCount, staleSkippedCount } = await applyChangesInteractively(units, {
      repoRoot: dir,
      interactive: false,
      log,
    });
    expect(appliedCount).toBe(2);
    expect(staleSkippedCount).toBe(0);
    expect(await fs.readFile(file, 'utf-8')).toBe('a\nb\n');
  });

  it('applies without prompting when interactive is false', async () => {
    const file = path.join(dir, 'CLAUDE.md');
    await fs.writeFile(file, 'old\n', 'utf-8');
    const { appliedCount } = await applyChangesInteractively([unit(file, 'old\n', 'new\n')], {
      repoRoot: dir,
      interactive: false,
      log,
    });
    expect(appliedCount).toBe(1);
    expect(await fs.readFile(file, 'utf-8')).toBe('new\n');
  });

  it('writes on a "y" answer and skips on "n"', async () => {
    const yes = path.join(dir, 'yes.md');
    const no = path.join(dir, 'no.md');
    await fs.writeFile(yes, 'old\n', 'utf-8');
    await fs.writeFile(no, 'old\n', 'utf-8');
    const { appliedCount } = await applyChangesInteractively(
      [unit(yes, 'old\n', 'new\n'), unit(no, 'old\n', 'new\n')],
      { repoRoot: dir, interactive: true, answers: ['y', 'n'], log },
    );
    expect(appliedCount).toBe(1);
    expect(await fs.readFile(yes, 'utf-8')).toBe('new\n');
    expect(await fs.readFile(no, 'utf-8')).toBe('old\n');
    expect(logs.join('\n')).toContain('Skipped.');
  });

  it('rejects two conflicting changes to the same file in one unit', async () => {
    const file = path.join(dir, 'CLAUDE.md');
    await fs.writeFile(file, 'old\n', 'utf-8');
    const conflicting: ApplyUnit = {
      changes: [
        { filePath: file, originalContent: 'old\n', newContent: 'A\n' },
        { filePath: file, originalContent: 'old\n', newContent: 'B\n' },
      ],
    };
    await expect(
      applyChangesInteractively([conflicting], { repoRoot: dir, interactive: false, log }),
    ).rejects.toThrow(/Conflicting changes/);
  });

  it('refuses to write outside the repo root', async () => {
    const outside = path.join(dir, '..', 'escape.md');
    await expect(
      applyChangesInteractively([unit(outside, '', 'pwned\n')], {
        repoRoot: dir,
        interactive: false,
        log,
      }),
    ).rejects.toThrow(/Path traversal/);
    const exists = await fs.access(path.resolve(outside)).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  it('computes a unit\'s changes lazily so later units see earlier writes', async () => {
    const file = path.join(dir, '.gitignore');
    await fs.writeFile(file, 'a\n', 'utf-8');
    // Second unit reads the file on disk when its turn comes; it must observe
    // the first unit's appended line rather than the original content.
    const units: ApplyUnit[] = [
      { changes: async () => [{ filePath: file, originalContent: 'a\n', newContent: 'a\nb\n' }] },
      {
        changes: async () => {
          const current = await fs.readFile(file, 'utf-8');
          return [{ filePath: file, originalContent: current, newContent: current + 'c\n' }];
        },
      },
    ];
    const { appliedCount } = await applyChangesInteractively(units, {
      repoRoot: dir,
      interactive: false,
      log,
    });
    expect(appliedCount).toBe(2);
    expect(await fs.readFile(file, 'utf-8')).toBe('a\nb\nc\n');
  });
});
