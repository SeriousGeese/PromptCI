/**
 * pcic-1ik0.10: a CLAUDE.md / GEMINI.md that mirrors AGENTS.md is fixed by
 * ONE `@` import (which Claude Code and Gemini CLI load in place), never by a
 * markdown link (which neither loads). Fixtures cover: the triggering case,
 * a must-stay-clean repository that already imports, a copy with one
 * tool-specific extra section, a nested `.claude/CLAUDE.md`, and a drifted
 * mirror that gets no edit. Each fix must raise the score and add nothing.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../src/scan.js';
import { applyFixRecipe, isRepairable } from '../src/fix-engine.js';
import { computeFingerprint } from '../src/baseline.js';
import { importLine, importTarget } from '../src/mirror-import.js';
import type { PromptCiIssue, ScanReport } from '../src/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.resolve(__dirname, '../../../examples', name);
const isMirror = (i: PromptCiIssue) => i.title.startsWith('Possible mirrored instruction files');

/** Copy a fixture, apply its mirror finding's recipe, rescan; returns both reports and the new files. */
async function fixMirror(name: string): Promise<{ before: ScanReport; after: ScanReport; files: Record<string, string> }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `promptci-import-${name}-`));
  try {
    fs.cpSync(fixture(name), root, { recursive: true });
    const before = await scan({ repoPath: root });
    const [mirror] = before.issues.filter(isMirror);
    expect(mirror, 'mirror finding').toBeDefined();
    expect(isRepairable(mirror!)).toBe(true);
    const files: Record<string, string> = {};
    for (const change of await applyFixRecipe(mirror!, root)) {
      fs.writeFileSync(change.filePath, change.newContent);
      files[path.relative(root, change.filePath).replace(/\\/g, '/')] = change.newContent;
    }
    const after = await scan({ repoPath: root });
    const beforeKeys = new Set(before.issues.map((i) => computeFingerprint(i, root)));
    const added = after.issues.filter((i) => !beforeKeys.has(computeFingerprint(i, root)));
    expect(added.map((i) => i.title), 'no new findings').toEqual([]);
    expect(after.healthScore, 'score goes up').toBeGreaterThan(before.healthScore);
    return { before, after, files };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const noBehaviourGap = (report: ScanReport) =>
  report.issues.filter((i) => i.id.startsWith('per-file-behavior') || i.title.startsWith('Missing critical guidance'));

describe('import consolidation (fixtures)', () => {
  it('fixture-mirror-import: CLAUDE.md and GEMINI.md become one import each', async () => {
    const { after, files } = await fixMirror('fixture-mirror-import');
    expect(files).toEqual({ 'CLAUDE.md': '@AGENTS.md\n', 'GEMINI.md': '@./AGENTS.md\n' });
    expect(after.issues.filter((i) => i.category === 'duplicate')).toEqual([]);
    expect(noBehaviourGap(after)).toEqual([]);
  });

  it('fixture-mirror-import-extra: the Claude-only section stays below the import', async () => {
    const { after, files } = await fixMirror('fixture-mirror-import-extra');
    expect(files['CLAUDE.md']).toMatch(/^@AGENTS\.md\n\n## Claude Code only\n\nUse the `\/review` slash command/);
    expect(files['CLAUDE.md']).not.toContain('## Stack');
    expect(noBehaviourGap(after)).toEqual([]);
  });

  it('fixture-mirror-import-nested: a .claude/CLAUDE.md copy imports ../AGENTS.md', async () => {
    const { after, files } = await fixMirror('fixture-mirror-import-nested');
    expect(files).toEqual({ '.claude/CLAUDE.md': '@../AGENTS.md\n' });
    expect(after.issues.filter((i) => i.category === 'structure')).toEqual([]);
  });

  it('fixture-mirror-import-clean: a repository that already imports stays clean', async () => {
    const report = await scan({ repoPath: fixture('fixture-mirror-import-clean') });
    expect(report.issues.filter((i) => i.category === 'duplicate')).toEqual([]);
    expect(noBehaviourGap(report)).toEqual([]);
    expect(report.issues.filter((i) => i.autoApplySafe && i.category === 'duplicate')).toEqual([]);
  });

  it('fixture-mirrored-drift: a drifted mirror is advisory and its recipe makes no edit', async () => {
    const report = await scan({ repoPath: fixture('fixture-mirrored-drift') });
    const [mirror] = report.issues.filter(isMirror);
    expect(mirror!.autoApplySafe).toBe(false);
    expect(await applyFixRecipe(mirror!, fixture('fixture-mirrored-drift'))).toEqual([]);
  });

  it('a mirror with a Copilot copy is advisory: Copilot documents no import', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-import-copilot-'));
    try {
      fs.cpSync(fixture('fixture-mirror-import'), root, { recursive: true });
      fs.mkdirSync(path.join(root, '.github'));
      fs.copyFileSync(path.join(root, 'AGENTS.md'), path.join(root, '.github', 'copilot-instructions.md'));
      const [mirror] = (await scan({ repoPath: root })).issues.filter(isMirror);
      expect(mirror!.filePaths.map((p) => path.relative(root, p).replace(/\\/g, '/'))).toContain('.github/copilot-instructions.md');
      expect(mirror!.autoApplySafe).toBe(false);
      expect(await applyFixRecipe(mirror!, root)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('import lines', () => {
  it('are relative to the importing file, in each tool\'s documented form', () => {
    expect(importLine('claude-code', importTarget('/r/CLAUDE.md', '/r/AGENTS.md'))).toBe('@AGENTS.md');
    expect(importLine('claude-code', importTarget('/r/.claude/CLAUDE.md', '/r/AGENTS.md'))).toBe('@../AGENTS.md');
    expect(importLine('gemini-cli', importTarget('/r/GEMINI.md', '/r/AGENTS.md'))).toBe('@./AGENTS.md');
    expect(importLine('gemini-cli', importTarget('/r/docs/x/GEMINI.md', '/r/AGENTS.md'))).toBe('@../../AGENTS.md');
    expect(importLine('claude-code', importTarget('/r/CLAUDE.md', '/r/pkg/AGENTS.md'))).toBe('@pkg/AGENTS.md');
  });
});
