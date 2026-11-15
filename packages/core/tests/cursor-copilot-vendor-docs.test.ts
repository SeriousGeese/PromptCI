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
import { scan } from '../src/scan.js';
import { detectMissingContext } from '../src/missing-context.js';
import { UNSCORED_TAG } from '../src/health-score.js';
import type { InstructionFile } from '../src/types.js';
import { ctx, makeTempRepo, writeFile } from './ai-config-helpers.js';
import * as fs from 'node:fs';

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

describe('a plain .md under .github/instructions/ is not a live Copilot instruction file (#198)', () => {
  const big = Array.from({ length: 1100 }, (_, i) => `- Rule number ${i} for the team.`).join('\n');

  it('gets no Copilot line-limit/bloat finding, while a .instructions.md of the same size does', async () => {
    const repo = makeTempRepo('promptci-198-');
    try {
      writeFile(repo, '.github/instructions/plain.md', big);
      writeFile(repo, '.github/instructions/real.instructions.md', `---\napplyTo: "**"\n---\n${big}`);
      const { issues } = await scan({ repoPath: repo, projectType: 'typescript' });
      const forFile = (name: string) =>
        issues.filter((i) => i.filePaths.some((f) => f.replace(/\\/g, '/').endsWith(name)));
      const plain = forFile('instructions/plain.md');
      expect(plain.some((i) => i.title.includes('Copilot instructions file exceeds'))).toBe(false);
      expect(forFile('real.instructions.md').some((i) => i.title.includes('Copilot instructions file exceeds'))).toBe(true);
      const hint = plain.find((i) => i.title.includes('not named .instructions.md'));
      expect(hint?.tags).toContain(UNSCORED_TAG);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does not count as Copilot coverage for copilot-instructions.md topic silence', () => {
    const mk = (path: string, fileType: InstructionFile['fileType'], content: string): InstructionFile => ({
      path, fileType, content, sections: [], lineCount: 2, charCount: content.length, estimatedTokens: 10,
    });
    const claude = mk('/repo/CLAUDE.md', 'claude', '## File Naming\nUse kebab-case for all file and directory names.');
    const root = mk('/repo/.github/copilot-instructions.md', 'copilot', '## Tech Stack\nThis is a Next.js project.');
    // Typed as the scanner now types it (not 'copilot'); the path alone must not count either.
    const plain = mk('/repo/.github/instructions/naming.md', 'unknown', '## Naming\nAlways use kebab-case for file names.');
    const issues = detectMissingContext([claude, root, plain], 'unknown');
    expect(issues.some((i) => i.title.toLowerCase().includes('copilot') && i.title.toLowerCase().includes('naming'))).toBe(true);
  });

  it('skips README.md in that folder entirely', () => {
    const repo = makeTempRepo('promptci-198-');
    try {
      writeFile(repo, '.github/instructions/README.md', '# About these files');
      expect(detectCopilotInstructions(ctx(repo))).toEqual([]);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
