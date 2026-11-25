/**
 * pcic-k1t3.10: the instruction-file formats core discovers since then (Codex
 * AGENTS.override.md, AGENT.md, Devin Local / Windsurf rule files, Kiro steering,
 * Roo Code rules, Amazon Q rules, Junie guidelines), each with its own file type
 * so the always-loaded detectors run on it, and each format's frontmatter or
 * location read for when the tool loads the file (rule-activation.ts).
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSections, scanFiles } from '../src/scanner.js';
import { scan } from '../src/scan.js';
import { selectScanPaths } from '../src/discovery.js';
import { ruleActivation } from '../src/rule-activation.js';
import { detectCrossToolParity } from '../src/cross-tool-parity.js';
import { detectContextBloat } from '../src/context-bloat.js';
import { detectAgentPractices } from '../src/agent-practices.js';
import { INSTRUCTION_FILE_TYPES } from '../src/types.js';
import type { FileType, InstructionFile } from '../src/types.js';

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../examples/fixture-instruction-tools');

function file(relativePath: string, content: string, fileType: FileType): InstructionFile {
  return {
    path: `/repo/${relativePath}`,
    relativePath,
    fileType,
    content,
    sections: parseSections(content, `/repo/${relativePath}`, relativePath),
    lineCount: content.split('\n').length,
    charCount: content.length,
    estimatedTokens: Math.round(content.length / 4),
  };
}

const EXPECTED_TYPES: Record<string, FileType> = {
  'AGENTS.override.md': 'agents',
  'AGENT.md': 'agents',
  '.windsurf/rules/always.md': 'windsurf',
  '.windsurf/rules/tests.md': 'windsurf',
  '.devin/rules/style.md': 'windsurf',
  '.devin/global_rules.md': 'windsurf',
  '.kiro/steering/product.md': 'kiro',
  '.kiro/steering/api.md': 'kiro',
  '.roo/rules/01-general.md': 'roo',
  '.roo/rules/notes.txt': 'roo',
  '.roo/rules/testing.mdc': 'roo',
  '.roo/rules-code/typescript.md': 'roo',
  '.roorules': 'roo',
  '.roo/rules-architect/AGENTS.md': 'roo',
  '.roorules-ask': 'roo',
  '.amazonq/rules/cdk.md': 'amazonq',
  '.junie/guidelines.md': 'junie',
  '.junie/AGENTS.md': 'junie',
};

/** Near-miss paths: a subdirectory the docs do not describe, a sibling directory, a nested AGENT.md. */
const NOT_DISCOVERED = [
  '.windsurf/rules/nested/deep.md',
  '.kiro/specs/feature/requirements.md',
  '.roo/notes.md',
  'docs/AGENT.md',
];

describe('default discovery of the new instruction-file formats (fixture-instruction-tools)', () => {
  it('discovers each format with its own file type', async () => {
    const files = await scanFiles({ repoPath: FIXTURE });
    const types = Object.fromEntries(files.map((f) => [f.relativePath, f.fileType]));
    for (const [rel, type] of Object.entries(EXPECTED_TYPES)) expect(types[rel], rel).toBe(type);
    expect(types['AGENTS.md']).toBe('agents');
  });

  it('leaves the near-miss paths alone', async () => {
    const rels = (await scanFiles({ repoPath: FIXTURE })).map((f) => f.relativePath);
    for (const rel of NOT_DISCOVERED) expect(rels, rel).not.toContain(rel);
  });

  it('every new type is on the shared always-loaded allowlist (BUG-19)', () => {
    for (const t of ['kiro', 'roo', 'amazonq', 'junie'] as const) expect(INSTRUCTION_FILE_TYPES.has(t)).toBe(true);
  });

  it('the path-only discovery API selects the same files as a scan', async () => {
    const all = [...Object.keys(EXPECTED_TYPES), ...NOT_DISCOVERED, 'AGENTS.md', 'README.md'];
    const selected = selectScanPaths(all).instructionFiles;
    const scanned = (await scanFiles({ repoPath: FIXTURE })).map((f) => f.relativePath!).sort();
    expect(selected).toEqual(scanned);
  });

  it('runs the existing detectors on the new files: a dead link in an Amazon Q rule is reported', async () => {
    const report = await scan({ repoPath: FIXTURE });
    const deadRef = report.issues.find((i) => i.title.startsWith('Broken file reference') && i.evidence.some((e) => e.includes('missing-runbook.md')));
    expect(deadRef, 'dead reference in .amazonq/rules/cdk.md').toBeDefined();
    expect(deadRef!.filePaths.map((p) => path.relative(FIXTURE, p).replace(/\\/g, '/'))).toContain('.amazonq/rules/cdk.md');
  });

  it('a scoped rule that names another package manager is not a parity finding (fixture stays clean)', async () => {
    const report = await scan({ repoPath: FIXTURE });
    expect(report.issues.filter((i) => i.title.startsWith('Possible package manager disagreement'))).toEqual([]);
  });
});

describe('ruleActivation', () => {
  const act = (rel: string, type: FileType, content: string) => ruleActivation(file(rel, content, type));

  it('Windsurf / Devin Local: only trigger always_on (or no trigger) is always loaded', () => {
    expect(act('.windsurf/rules/a.md', 'windsurf', '---\ntrigger: always_on\nglobs: "*.ts"\n---\n# A\n')).toBe('always');
    expect(act('.windsurf/rules/a.md', 'windsurf', '# A\n')).toBe('always');
    for (const trigger of ['glob', 'model_decision', 'manual', "'manual'"]) {
      expect(act('.devin/rules/a.md', 'windsurf', `---\ntrigger: ${trigger}\n---\n# A\n`), trigger).toBe('scoped');
    }
  });

  it('Kiro: inclusion always is the default; fileMatch, manual and auto are scoped', () => {
    expect(act('.kiro/steering/a.md', 'kiro', '# A\n')).toBe('always');
    expect(act('.kiro/steering/a.md', 'kiro', '---\ninclusion: always\n---\n# A\n')).toBe('always');
    for (const inclusion of ['fileMatch', 'manual', 'auto']) {
      expect(act('.kiro/steering/a.md', 'kiro', `---\ninclusion: ${inclusion}\n---\n# A\n`), inclusion).toBe('scoped');
    }
  });

  it('Roo Code: mode-specific rules are scoped, general rules are not', () => {
    expect(act('.roo/rules-code/a.md', 'roo', '# A\n')).toBe('scoped');
    expect(act('.roorules-architect', 'roo', '# A\n')).toBe('scoped');
    expect(act('.roo/rules/a.md', 'roo', '# A\n')).toBe('always');
    expect(act('.roorules', 'roo', '# A\n')).toBe('always');
    // Roo Code reads a Cursor-style .mdc file in its rules directory as a plain rule.
    expect(act('.roo/rules/repo.mdc', 'roo', '---\nglobs: "*.ts"\n---\n# A\n')).toBe('always');
  });

  it('keeps the Cursor and Copilot reading cross-tool-parity always had', () => {
    expect(act('.cursor/rules/a.mdc', 'cursor', '---\nalwaysApply: true\n---\n# A\n')).toBe('always');
    expect(act('.cursor/rules/a.mdc', 'cursor', '---\nglobs: "*.ts"\n---\n# A\n')).toBe('scoped');
    expect(act('.github/instructions/a.instructions.md', 'copilot', '---\napplyTo: "**/*.ts"\n---\n# A\n')).toBe('scoped');
    expect(act('.github/instructions/a.instructions.md', 'copilot', '---\napplyTo:\n  - "**/*.ts"\n---\n# A\n')).toBe('scoped');
    expect(act('.github/copilot-instructions.md', 'copilot', '# A\n')).toBe('always');
  });

  it('a frontmatter-shaped key outside the leading block does not count', () => {
    expect(act('.kiro/steering/a.md', 'kiro', '# A\n\n---\ninclusion: manual\n---\n')).toBe('always');
  });
});

describe('cross-tool parity with the new formats', () => {
  const FILLER = '# Notes\n\nKeep changes small.\nWrite a test for every fix.\nExplain the why in the PR body.\nAsk before large refactors.\n';
  const agents = file('AGENTS.md', `${FILLER}Install with \`pnpm install\`.\n`, 'agents');
  const npm = 'Install with `npm install`.\n';
  const parity = (other: InstructionFile) =>
    detectCrossToolParity([agents, other]).filter((i) => i.title.startsWith('Possible package manager disagreement'));

  it('compares an always-loaded rule file of each new tool with AGENTS.md', () => {
    for (const [rel, type] of [
      ['.kiro/steering/tech.md', 'kiro'],
      ['.roo/rules/01-general.md', 'roo'],
      ['.amazonq/rules/setup.md', 'amazonq'],
      ['.junie/guidelines.md', 'junie'],
      ['.windsurf/rules/setup.md', 'windsurf'],
    ] as const) {
      expect(parity(file(rel, npm, type)), rel).toHaveLength(1);
    }
  });

  it('skips a rule file the tool loads only for some files, modes or requests', () => {
    expect(parity(file('.kiro/steering/api.md', `---\ninclusion: fileMatch\nfileMatchPattern: "api/**"\n---\n${npm}`, 'kiro'))).toEqual([]);
    expect(parity(file('.windsurf/rules/tests.md', `---\ntrigger: glob\nglobs: "**/*.test.ts"\n---\n${npm}`, 'windsurf'))).toEqual([]);
    expect(parity(file('.roo/rules-code/ts.md', npm, 'roo'))).toEqual([]);
  });
});

describe('the always-loaded total leaves out rule files loaded only for some files, modes or requests', () => {
  const body = (n: number) => `# Rules\n\n${'Keep this rule in mind. '.repeat(n)}\n`;
  const total = (...files: InstructionFile[]) => detectContextBloat(files).filter((i) => i.id === 'context-bloat-total');

  it('Roo Code mode rules are not summed as if every mode loaded at once', () => {
    const modes = ['architect', 'code', 'debug'].map((m) => file(`.roo/rules-${m}/rules.md`, body(800), 'roo'));
    expect(total(...modes)).toEqual([]);
    const general = ['a', 'b', 'c'].map((m) => file(`.roo/rules/${m}.md`, body(800), 'roo'));
    expect(total(...general)).toHaveLength(1);
  });

  it('a Kiro fileMatch file and a Cursor rule without alwaysApply are left out of the total too', () => {
    const kiro = file('.kiro/steering/api.md', `---\ninclusion: fileMatch\nfileMatchPattern: "api/**"\n---\n${body(1500)}`, 'kiro');
    const cursor = file('.cursor/rules/style.mdc', `---\nglobs: "*.ts"\n---\n${body(1500)}`, 'cursor');
    expect(total(kiro, cursor)).toEqual([]);
    const always = file('.kiro/steering/tech.md', body(1500), 'kiro');
    expect(total(kiro, cursor, always).map((i) => i.filePaths)).toEqual([['/repo/.kiro/steering/tech.md']]);
  });
});

describe('the Windsurf scope check skips a rule that is already scoped', () => {
  it('reports an always-on rule with several language headings, not a glob-triggered one', async () => {
    const { detectWindsurfRules } = await import('../src/windsurf-detector.js');
    const MULTI = '# Rules\n\n## TypeScript\n\nStrict mode.\n\n## Python\n\nType hints.\n';
    const ctx = (f: InstructionFile) => ({ files: [f], aliasFiles: [] }) as unknown as Parameters<typeof detectWindsurfRules>[0];
    expect(detectWindsurfRules(ctx(file('.windsurf/rules/all.md', MULTI, 'windsurf')))).toHaveLength(1);
    expect(detectWindsurfRules(ctx(file('.windsurf/rules/ts.md', `---\ntrigger: glob\nglobs: "*.ts"\n---\n${MULTI}`, 'windsurf')))).toEqual([]);
  });
});

describe('legacy .windsurfrules checks stay on the legacy file', () => {
  const big = `# Rules\n\n${'Keep this rule. '.repeat(500)}\n`;

  it('a large .windsurf/rules file gets the generic size check, not the .windsurfrules limit', () => {
    const titles = detectContextBloat([file('.windsurf/rules/big.md', big, 'windsurf')]).map((i) => i.title);
    expect(titles.some((t) => t.includes('.windsurfrules'))).toBe(false);
    expect(titles).toContain('Instruction file may be too large');
    const legacy = detectContextBloat([file('.windsurfrules', big, 'windsurf')]).map((i) => i.title);
    expect(legacy).toContain('.windsurfrules may exceed the Windsurf size limit');
  });

  it('a .windsurf/rules file is not a per-agent .windsurfrules target', () => {
    const agents = file('AGENTS.md', '# Agents\n\nRun `pnpm test` before you finish. Read a file before you edit it.\n', 'agents');
    const rule = file('.windsurf/rules/style.md', '# Style\n\nTwo-space indentation.\n', 'windsurf');
    const titles = detectAgentPractices([agents, rule]).map((i) => i.title);
    expect(titles.some((t) => t.includes('.windsurfrules'))).toBe(false);
  });
});
