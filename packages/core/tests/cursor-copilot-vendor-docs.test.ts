/**
 * Cursor and Copilot glob semantics and trigger wording, against vendor docs
 * (issues #197, #178, #180, #179, #198). Runs the detectors over the committed
 * fixtures: one that must trigger each finding, one that must stay clean.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectCursorRules } from '../src/cursor-rules-detector.js';
import { detectCopilotInstructions } from '../src/copilot-instructions-detector.js';
import { ctx } from './ai-config-helpers.js';

const ex = (name: string): string =>
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../examples', name);

describe('cursor/copilot vendor-doc fixtures', () => {
  const dir = ex('fixture-cursor-copilot-docs');

  it('Cursor: slashless glob is root-only, so it is reported; manual rule is info', () => {
    const issues = detectCursorRules(ctx(dir));
    const dead = issues.filter((i) => i.title === 'Cursor rule glob matches no files');
    expect(dead).toHaveLength(1);
    expect(dead[0]!.summary).toContain('root-level only');
    expect(dead[0]!.recommendation).toContain('**/*.ts');
    const manual = issues.filter((i) => i.title.includes('manual-only'));
    expect(manual).toHaveLength(1);
    expect(manual[0]!.severity).toBe('info');
    expect(manual[0]!.summary).toContain('@-mention');
  });

  it('Copilot: *.py is current-directory only; no applyTo/description is info; plain .md is reported', () => {
    const issues = detectCopilotInstructions(ctx(dir));
    expect(issues.filter((i) => i.title.includes('matches no files'))).toHaveLength(1);
    const bare = issues.filter((i) => i.title.includes('no applyTo glob or description'));
    expect(bare).toHaveLength(1);
    expect(bare[0]!.severity).toBe('info');
    expect(bare[0]!.summary).toContain('manual attachment');
    const plain = issues.filter((i) => i.title.includes('not named .instructions.md'));
    expect(plain).toHaveLength(1);
    expect(plain[0]!.filePaths[0]).toMatch(/\.github[\\/]instructions[\\/]plain\.md$/);
    // The misnamed file is not audited as a live instruction file.
    expect(issues.filter((i) => /plain.md$/.test(i.filePaths[0] ?? ''))).toHaveLength(1);
  });

  it('clean fixture stays clean', () => {
    const clean = ex('fixture-cursor-copilot-docs-clean');
    expect(detectCursorRules(ctx(clean))).toEqual([]);
    expect(detectCopilotInstructions(ctx(clean))).toEqual([]);
  });
});
