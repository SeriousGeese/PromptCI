import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { annotateIssueTokens, computeAddressableTokens, ADDRESSABLE_CATEGORIES, scan } from '../src/index.js';
import type { InstructionFile, PromptCiIssue } from '../src/index.js';

function file(name: string, lines: string[], fileType: InstructionFile['fileType'] = 'claude'): InstructionFile {
  const content = lines.join('\n') + '\n';
  return {
    path: path.resolve('/repo', name),
    fileType,
    content,
    sections: [],
    lineCount: lines.length,
    charCount: content.length,
    estimatedTokens: Math.round(content.length / 4),
  };
}

function issue(
  id: string,
  category: PromptCiIssue['category'],
  locations: PromptCiIssue['locations'],
): PromptCiIssue {
  return {
    id,
    severity: 'warning',
    category,
    title: id,
    summary: id,
    filePaths: [...new Set(locations.map((l) => l.filePath))],
    locations,
    evidence: [],
    recommendation: 'fix',
    confidence: 0.8,
  };
}

// Each line is 39 chars + newline = 40 chars = 10 tokens.
const line = 'x'.repeat(39);
const tenLines = Array.from({ length: 10 }, () => line);

describe('annotateIssueTokens', () => {
  it('estimates tokens from the lines the finding covers', () => {
    const f = file('CLAUDE.md', tenLines);
    const [a] = annotateIssueTokens([issue('a', 'duplicate', [{ filePath: f.path, startLine: 1, endLine: 3 }])], [f]);
    expect(a!.estimatedTokens).toBe(30);
  });

  it('uses the whole-file estimate when the location has no line range', () => {
    const f = file('CLAUDE.md', tenLines);
    const [a] = annotateIssueTokens([issue('a', 'context_bloat', [{ filePath: f.path }])], [f]);
    expect(a!.estimatedTokens).toBe(f.estimatedTokens);
  });

  it('counts overlapping locations of one finding once', () => {
    const f = file('CLAUDE.md', tenLines);
    const [a] = annotateIssueTokens(
      [
        issue('a', 'conflict', [
          { filePath: f.path, startLine: 1, endLine: 4 },
          { filePath: f.path, startLine: 3, endLine: 6 },
        ]),
      ],
      [f],
    );
    expect(a!.estimatedTokens).toBe(60);
  });

  it('leaves findings that point at no scanned file untouched', () => {
    const f = file('CLAUDE.md', tenLines);
    const input = issue('a', 'security', [{ filePath: path.resolve('/repo/package.json'), startLine: 1 }]);
    const [a] = annotateIssueTokens([input], [f]);
    expect(a!.estimatedTokens).toBeUndefined();
  });
});

describe('computeAddressableTokens', () => {
  it('counts a section flagged by two findings once', () => {
    const f = file('CLAUDE.md', tenLines);
    const issues = [
      issue('a', 'duplicate', [{ filePath: f.path, startLine: 2, endLine: 5 }]),
      issue('b', 'vague_guidance', [{ filePath: f.path, startLine: 4, endLine: 7 }]),
    ];
    // Lines 2-7 = 6 lines = 60 tokens, not 40 + 40.
    expect(computeAddressableTokens(issues, [f])).toBe(60);
  });

  it('counts the same section from two identical findings once', () => {
    const f = file('CLAUDE.md', tenLines);
    const loc = [{ filePath: f.path, startLine: 1, endLine: 2 }];
    expect(computeAddressableTokens([issue('a', 'duplicate', loc), issue('b', 'conflict', loc)], [f])).toBe(20);
  });

  it('ignores categories that are not about size', () => {
    const f = file('CLAUDE.md', tenLines);
    const loc = [{ filePath: f.path, startLine: 1, endLine: 5 }];
    const cats = ['security', 'missing_context', 'command_validity'] as const;
    expect(computeAddressableTokens(cats.map((c) => issue(c, c, loc)), [f])).toBe(0);
    for (const c of cats) expect(ADDRESSABLE_CATEGORIES.has(c)).toBe(false);
  });

  it('never counts files that are not in the always-loaded set', () => {
    const always = file('CLAUDE.md', tenLines);
    const onDemand = file('.claude/skills/x/SKILL.md', tenLines, 'skill');
    const issues = [
      issue('a', 'duplicate', [{ filePath: onDemand.path, startLine: 1, endLine: 10 }]),
      issue('b', 'duplicate', [{ filePath: always.path, startLine: 1, endLine: 2 }]),
    ];
    expect(computeAddressableTokens(issues, [always])).toBe(20);
  });

  it('never exceeds the always-loaded total', () => {
    const f = file('CLAUDE.md', tenLines);
    const issues = [
      issue('a', 'context_bloat', [{ filePath: f.path }]),
      issue('b', 'duplicate', [{ filePath: f.path, startLine: 1, endLine: 999 }]),
    ];
    expect(computeAddressableTokens(issues, [f])).toBe(f.estimatedTokens);
  });
});

describe('scan() integration', () => {
  it('keeps addressable within the always-loaded total and excludes on-demand files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'promptci-tokens-'));
    try {
      const body = ['# Rules', '', 'Always write good code and be careful.', 'Always write good code and be careful.', ''].join('\n');
      await fs.writeFile(path.join(dir, 'CLAUDE.md'), body);
      await fs.mkdir(path.join(dir, '.claude', 'skills', 'big'), { recursive: true });
      await fs.writeFile(
        path.join(dir, '.claude', 'skills', 'big', 'SKILL.md'),
        '---\nname: big\ndescription: big skill\n---\n' + 'Be careful and write good code.\n'.repeat(200),
      );
      const report = await scan({ repoPath: dir });
      const m = report.metrics!;
      expect(m.estimatedAddressableTokens).toBeGreaterThanOrEqual(0);
      expect(m.estimatedAddressableTokens!).toBeLessThanOrEqual(m.estimatedInstructionTokens);
      expect(m.estimatedOnDemandTokens).toBeGreaterThan(m.estimatedInstructionTokens);
      for (const i of report.issues) {
        if (i.estimatedTokens !== undefined) expect(i.estimatedTokens).toBeGreaterThanOrEqual(0);
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
