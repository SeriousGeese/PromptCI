import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanFiles } from '../src/scanner.js';
import { scan } from '../src/scan.js';
import { detectNegativeInstructionOverload } from '../src/negative-instructions.js';
import { detectBuriedCriticalInstructions } from '../src/buried-critical.js';
import { detectWithinSectionDedup } from '../src/within-section-dedup.js';
import { detectPromptCacheFriendliness } from '../src/prompt-cache.js';
import { detectAgentPractices } from '../src/agent-practices.js';
import { detectCanonicalOwner } from '../src/canonical-owner.js';
import { INSTRUCTION_FILE_TYPES } from '../src/types.js';
import type { FileType, InstructionFile } from '../src/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, '../../../examples/fixture-agent-formats');

function rel(root: string, file: InstructionFile): string {
  return path.relative(root, file.path).replace(/\\/g, '/');
}

function typesByPath(root: string, files: InstructionFile[]): Record<string, FileType> {
  return Object.fromEntries(files.map((f) => [rel(root, f), f.fileType]));
}

// pcic-2b6.4: GEMINI.md, Cline rules, and root-level persona files.
describe('default discovery — GEMINI.md, .clinerules, persona files', () => {
  it('discovers each new format with its own file type (fixture-agent-formats)', async () => {
    const types = typesByPath(FIXTURE, await scanFiles({ repoPath: FIXTURE }));
    expect(types['GEMINI.md']).toBe('gemini');
    expect(types['.clinerules/01-style.md']).toBe('cline');
    expect(types['SOUL.md']).toBe('persona');
    expect(types['USER.md']).toBe('persona');
    expect(types['TOOLS.md']).toBe('persona');
  });

  it('skips Cline on-demand workflows and nested persona-named files', async () => {
    const types = typesByPath(FIXTURE, await scanFiles({ repoPath: FIXTURE }));
    expect(types['.clinerules/workflows/release.md']).toBeUndefined();
    expect(types['docs/USER.md']).toBeUndefined();
  });

  it('never discovers GitHub workflow YAML as an instruction file', async () => {
    const files = await scanFiles({ repoPath: FIXTURE });
    expect(files.some((f) => /\.ya?ml$/.test(f.path))).toBe(false);
  });

  it('every new type is on the shared always-loaded allowlist (BUG-19)', () => {
    for (const t of ['gemini', 'cline', 'persona'] as const) {
      expect(INSTRUCTION_FILE_TYPES.has(t)).toBe(true);
    }
  });

  it('records a forward-slash, root-relative path on files and sections', async () => {
    const files = await scanFiles({ repoPath: FIXTURE });
    const cline = files.find((f) => f.fileType === 'cline')!;
    expect(cline.relativePath).toBe('.clinerules/01-style.md');
    expect(cline.sections.every((s) => s.relativePath === '.clinerules/01-style.md')).toBe(true);
  });
});

describe('default discovery — single-file .clinerules and root-only anchoring', () => {
  let root: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-agent-formats-'));
    const write = (p: string, body: string) => {
      fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
      fs.writeFileSync(path.join(root, p), body);
    };
    write('.clinerules', '# Cline\n\nRun the tests before finishing.\n');
    // Files an earlier release already discovered keep their old type even
    // when they carry one of the new names.
    write('.claude/skills/release/SKILL.md', '---\nname: release\ndescription: ship it\n---\n# Release\n');
    write('.claude/skills/release/GEMINI.md', '# Skill reference named GEMINI.md\n');
    write('prompts/USER.md', '# A prompt file named USER.md\n');
    write('ai/SOUL.md', '# An ai/ prompt named SOUL.md\n');
    // Nested copies of the new names are not discovered by default.
    write('packages/app/GEMINI.md', '# nested gemini\n');
    write('packages/app/TOOLS.md', '# nested tools\n');
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('types a single-file .clinerules as cline', async () => {
    const types = typesByPath(root, await scanFiles({ repoPath: root }));
    expect(types['.clinerules']).toBe('cline');
  });

  // Regression: the `.clinerules/**` directory glob made fast-glob scandir a
  // `.clinerules` FILE and throw ENOTDIR, which emptied the ENTIRE scan.
  it('a .clinerules file does not empty the rest of the scan', async () => {
    const types = typesByPath(root, await scanFiles({ repoPath: root }));
    expect(types['prompts/USER.md']).toBe('prompt');
    expect(Object.keys(types).length).toBeGreaterThanOrEqual(4);
  });

  it('leaves previously discovered files with their previous type', async () => {
    const types = typesByPath(root, await scanFiles({ repoPath: root }));
    expect(types['.claude/skills/release/GEMINI.md']).toBe('skill');
    expect(types['prompts/USER.md']).toBe('prompt');
    expect(types['ai/SOUL.md']).toBe('prompt');
  });

  it('does not discover nested GEMINI.md / persona files by default', async () => {
    const types = typesByPath(root, await scanFiles({ repoPath: root }));
    expect(types['packages/app/GEMINI.md']).toBeUndefined();
    expect(types['packages/app/TOOLS.md']).toBeUndefined();
  });

  it('a nested persona file pulled in by an explicit include is not typed persona', async () => {
    const types = typesByPath(root, await scanFiles({ repoPath: root, include: ['**/TOOLS.md'] }));
    expect(types['packages/app/TOOLS.md']).toBe('unknown');
  });
});

// The new types reach the prose detectors instead of being scanned and then
// ignored — the BUG-19 failure mode.
describe('new file types reach the always-loaded prose detectors', () => {
  function file(fileType: FileType, name: string, content: string): InstructionFile {
    const p = path.join(os.tmpdir(), name);
    return {
      path: p,
      relativePath: name,
      fileType,
      content,
      sections: [
        {
          id: 'x',
          filePath: p,
          relativePath: name,
          heading: undefined,
          startLine: 1,
          endLine: content.split('\n').length,
          text: content,
          normalizedText: content.toLowerCase(),
        },
      ],
      lineCount: content.split('\n').length,
      charCount: content.length,
      estimatedTokens: Math.round(content.length / 4),
    };
  }

  for (const [fileType, name] of [
    ['gemini', 'GEMINI.md'],
    ['cline', '.clinerules'],
    ['persona', 'SOUL.md'],
  ] as const) {
    it(`negative-instruction overload fires on a ${fileType} file`, () => {
      const lines = Array.from({ length: 12 }, (_, i) => `- Never do forbidden thing number ${i}.`);
      const issues = detectNegativeInstructionOverload([file(fileType, name, lines.join('\n'))]);
      expect(issues.length).toBeGreaterThan(0);
    });

    it(`prompt-cache friendliness inspects a ${fileType} file`, () => {
      const content = '# Notes\n\nLast updated: 2026-09-30 14:05:22\n\nSee /home/alice/projects/app/.\n';
      const issues = detectPromptCacheFriendliness([file(fileType, name, content)]);
      expect(issues.length).toBeGreaterThan(0);
    });
  }

  it('buried-critical and within-section-dedup accept the new types without throwing', () => {
    const f = file('gemini', 'GEMINI.md', '# Rules\n\nBe concise.\n');
    expect(() => detectBuriedCriticalInstructions([f])).not.toThrow();
    expect(() => detectWithinSectionDedup([f])).not.toThrow();
  });
});

describe('per-file behavioral guidance for GEMINI.md / .clinerules', () => {
  const AGENTS =
    '# Agents\n\n- Run `npm test` before saying a change is complete.\n' +
    '- Prefer focused diffs; do not refactor unrelated code.\n' +
    '- Read a file fully before editing it.\n- Report failures honestly.\n';

  function mk(name: string, fileType: FileType, content: string): InstructionFile {
    const p = path.join(os.tmpdir(), 'repo', name);
    return {
      path: p,
      relativePath: name,
      fileType,
      content,
      sections: [],
      lineCount: content.split('\n').length,
      charCount: content.length,
      estimatedTokens: Math.round(content.length / 4),
    };
  }
  const titles = (files: InstructionFile[]) => detectAgentPractices(files).map((i) => i.title);

  it('flags a GEMINI.md and a single-file .clinerules that carry no behavioral guidance', () => {
    const t = titles([
      mk('AGENTS.md', 'agents', AGENTS),
      mk('GEMINI.md', 'gemini', '# Gemini\n\nUse the Gemini 2.5 model for summaries.\n'),
      mk('.clinerules', 'cline', '# Cline\n\nPrefer small components.\n'),
    ]);
    expect(t).toContain('No behavioral guidance in GEMINI.md');
    expect(t).toContain('No behavioral guidance in .clinerules');
  });

  it('does not treat files inside a .clinerules/ directory as standalone targets', () => {
    const t = titles([
      mk('AGENTS.md', 'agents', AGENTS),
      mk('.clinerules/01-style.md', 'cline', '# Style\n\nTwo-space indentation.\n'),
    ]);
    expect(t.some((x) => x.includes('Cline'))).toBe(false);
    expect(t.some((x) => x.includes('.clinerules'))).toBe(false);
  });

  it('accepts "AGENTS.md is the single source of truth" as a forwarding pointer', () => {
    const stub =
      '# Gemini\n\n**`AGENTS.md` in the repo root is the single source of truth for all agents.**\n';
    expect(titles([mk('AGENTS.md', 'agents', AGENTS), mk('GEMINI.md', 'gemini', stub)])).not.toContain(
      'No behavioral guidance in GEMINI.md',
    );
  });

  it('a stub delegating authority to AGENTS.md is not a competing canonical claim', () => {
    const agents = mk('AGENTS.md', 'agents', `${AGENTS}\nThis file is the canonical source of truth for all agents.\n`);
    const stub = mk('GEMINI.md', 'gemini', '# Gemini\n\n`AGENTS.md` is the single source of truth for all agents.\n');
    const ambiguous = (files: InstructionFile[]) =>
      detectCanonicalOwner(files).some((i) => i.title.startsWith('Ambiguous authority'));
    expect(ambiguous([agents, stub])).toBe(false);
    // A real second claim still fires.
    const rival = mk('GEMINI.md', 'gemini', '# Gemini\n\nThis file is the canonical source of truth for all agents.\n');
    expect(ambiguous([agents, rival])).toBe(true);
  });

  it('a file naming ITSELF canonical is not forwarding anywhere', () => {
    const self = '# Claude\n\nThis CLAUDE.md is the canonical project guide.\n\n## Stack\n\nNext.js.\n';
    expect(titles([mk('AGENTS.md', 'agents', AGENTS), mk('CLAUDE.md', 'claude', self)])).toContain(
      'No behavioral guidance in CLAUDE.md',
    );
  });
});

describe('scan() over fixture-agent-formats', () => {
  it('counts the new files toward always-loaded instruction metrics', async () => {
    const report = await scan({ repoPath: FIXTURE });
    const scanned = report.filesScanned.map((f) => rel(FIXTURE, f));
    expect(scanned).toEqual(
      expect.arrayContaining(['GEMINI.md', '.clinerules/01-style.md', 'SOUL.md', 'USER.md', 'TOOLS.md']),
    );
    expect(report.metrics?.instructionFileCount).toBe(scanned.length);
  });
});
