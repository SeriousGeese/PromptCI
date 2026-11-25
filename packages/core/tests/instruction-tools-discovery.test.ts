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
import { detectConflicts } from '../src/conflicts.js';
import { detectMissingContext } from '../src/missing-context.js';
import { detectWindsurfRules } from '../src/windsurf-detector.js';
import { scanFilesWithAliases } from '../src/scanner.js';
import { canSymlink, makeTempRepo, trySymlink, writeFile } from './ai-config-helpers.js';
import * as fs from 'node:fs';
import { afterEach } from 'vitest';
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

describe('review of PromptCI#247: scopes, overrides and file names', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });
  const tempRepo = (files: Record<string, string>): string => {
    const repo = makeTempRepo('promptci-instruction-tools-');
    tempDirs.push(repo);
    for (const [rel, content] of Object.entries(files)) writeFile(repo, rel, content);
    return repo;
  };
  const TABS = '# Indentation\n\nAlways use tabs for indentation in every source file of this project.\n';
  const NO_TABS = '# Indentation\n\nNever use tabs for indentation in every source file of this project.\n';
  const tabConflicts = (...files: InstructionFile[]) =>
    detectConflicts(files).filter((i) => i.title.toLowerCase().includes('tabs'));

  it('opposite directives in two Roo Code mode rules are not a conflict; a mode rule against an always-on rule still is', () => {
    const code = file('.roo/rules-code/style.md', TABS, 'roo');
    const ask = file('.roo/rules-ask/style.md', NO_TABS, 'roo');
    expect(tabConflicts(code, ask)).toEqual([]);
    expect(tabConflicts(file('.roorules-code', TABS, 'roo'), file('.roorules-ask', NO_TABS, 'roo'))).toEqual([]);
    expect(tabConflicts(code, file('AGENTS.md', NO_TABS, 'agents')).length).toBeGreaterThan(0);
  });

  it('two Kiro fileMatch files with different patterns are not a conflict; the same pattern still is', () => {
    const kiro = (rel: string, pattern: string, body: string) =>
      file(rel, `---\ninclusion: fileMatch\nfileMatchPattern: "${pattern}"\n---\n${body}`, 'kiro');
    expect(tabConflicts(kiro('.kiro/steering/a.md', 'api/**', TABS), kiro('.kiro/steering/b.md', 'web/**', NO_TABS))).toEqual([]);
    expect(tabConflicts(kiro('.kiro/steering/a.md', 'api/**', TABS), kiro('.kiro/steering/b.md', 'api/**', NO_TABS)).length).toBeGreaterThan(0);
    // Copilot applyTo and Cursor globs scope the same way.
    const copilot = (rel: string, glob: string, body: string) =>
      file(rel, `---\napplyTo: "${glob}"\n---\n${body}`, 'copilot');
    expect(tabConflicts(copilot('.github/instructions/a.instructions.md', '**/*.ts', TABS), copilot('.github/instructions/b.instructions.md', '**/*.py', NO_TABS))).toEqual([]);
  });

  it('Copilot does not read AGENT.md or AGENTS.override.md, so they do not silence the Copilot topic check', () => {
    const copilot = file('.github/copilot-instructions.md', '# Copilot\n\nKeep answers short.\n', 'copilot');
    const cursor = file('.cursorrules', '# Naming\n\nUse kebab-case for every file name.\n', 'cursor');
    const silent = (...files: InstructionFile[]) =>
      detectMissingContext(files, 'unknown').filter((i) => i.title.startsWith('copilot-instructions.md is silent on'));
    expect(silent(copilot, cursor, file('AGENT.md', '# Agent\n\nShip it.\n', 'agents'))).toHaveLength(1);
    expect(silent(copilot, cursor, file('AGENTS.override.md', '# Override\n\nShip it.\n', 'agents'))).toHaveLength(1);
    expect(silent(copilot, cursor, file('agents.md', '# Agents\n\nShip it.\n', 'agents'))).toEqual([]);
  });

  it('AGENTS.override.md is not compared with the AGENTS.md beside it, and the pair counts once in the total', () => {
    const FILLER = '# Notes\n\nKeep changes small.\nWrite a test for every fix.\nExplain the why in the PR body.\nAsk before large refactors.\n';
    const agents = file('AGENTS.md', `${FILLER}Install with \`pnpm install\`.\n`, 'agents');
    const override = file('AGENTS.override.md', 'Install with `npm install`.\n', 'agents');
    const parity = (...files: InstructionFile[]) =>
      detectCrossToolParity(files).filter((i) => i.title.startsWith('Possible package manager disagreement'));
    expect(parity(agents, override)).toEqual([]);
    // AGENTS.md is still the anchor for every other tool file in that directory.
    const claude = file('CLAUDE.md', `${FILLER.replace('Notes', 'Claude')}Install with \`npm install\`.\n`, 'claude');
    expect(parity(agents, override, claude).map((i) => i.filePaths.map((p) => p.split('/').pop()))).toEqual([['AGENTS.md', 'CLAUDE.md']]);

    const big = (rel: string) => file(rel, `# Rules\n\n${'Keep this rule in mind. '.repeat(900)}\n`, 'agents');
    const total = (...files: InstructionFile[]) => detectContextBloat(files).filter((i) => i.id === 'context-bloat-total');
    expect(total(big('AGENTS.md'), big('AGENTS.override.md'))).toEqual([]);
    expect(total(big('AGENTS.md'), big('AGENT.md'))).toHaveLength(1);
  });

  it('globs / applyTo do not scope an Amazon Q or Junie file, whose docs describe no frontmatter', () => {
    const fm = '---\nglobs: "**/*.ts"\napplyTo: "**/*.ts"\n---\n# A\n';
    expect(ruleActivation(file('.amazonq/rules/a.md', fm, 'amazonq'))).toBe('always');
    expect(ruleActivation(file('.junie/guidelines.md', fm, 'junie'))).toBe('always');
    expect(ruleActivation(file('.kiro/steering/a.md', fm, 'kiro'))).toBe('always');
    expect(ruleActivation(file('.windsurf/rules/a.md', fm, 'windsurf'))).toBe('always');
    expect(ruleActivation(file('.github/instructions/a.instructions.md', fm, 'copilot'))).toBe('scoped');
    expect(ruleActivation(file('docs/rules.md', fm, 'unknown'))).toBe('scoped');
  });

  it('a frontmatter block needs its closing --- on a line of its own', () => {
    expect(ruleActivation(file('.kiro/steering/a.md', '---\ninclusion: manual\n----\n# A\n', 'kiro'))).toBe('always');
    expect(ruleActivation(file('.kiro/steering/a.md', '---\ninclusion: manual\n---  \n# A\n', 'kiro'))).toBe('scoped');
  });

  it('a symlink alias .windsurf/rules/x.md -> AGENTS.md gets the Windsurf scope check, not the .windsurfrules size limit (synthetic alias)', () => {
    const MULTI = `# Rules\n\n## TypeScript\n\nStrict mode.\n\n## Python\n\nType hints.\n\n${'Keep this rule in mind. '.repeat(300)}\n`;
    const agents = file('AGENTS.md', MULTI, 'agents');
    const alias: InstructionFile = { ...file('.windsurf/rules/x.md', MULTI, 'windsurf'), aliasOf: 'AGENTS.md' };
    const ctx = { files: [agents], aliasFiles: [alias] } as unknown as Parameters<typeof detectWindsurfRules>[0];
    expect(detectWindsurfRules(ctx).map((i) => i.filePaths)).toEqual([[alias.path]]);
    expect(detectContextBloat([agents], undefined, [alias]).some((i) => i.title.includes('.windsurfrules'))).toBe(false);
  });

  it.skipIf(!canSymlink)('a real symlink .windsurf/rules/x.md -> AGENTS.md is scanned once, as a Windsurf alias', async () => {
    const repo = tempRepo({ 'AGENTS.md': '# Agents\n\nRun the tests before you finish.\n' });
    fs.mkdirSync(path.join(repo, '.windsurf', 'rules'), { recursive: true });
    expect(trySymlink(path.join('..', '..', 'AGENTS.md'), path.join(repo, '.windsurf', 'rules', 'x.md'))).toBe(true);
    const { files, aliases } = await scanFilesWithAliases({ repoPath: repo });
    expect(files.map((f) => f.relativePath)).toEqual(['AGENTS.md']);
    expect(aliases.map((f) => [f.relativePath, f.fileType, f.aliasOf])).toEqual([['.windsurf/rules/x.md', 'windsurf', 'AGENTS.md']]);
  });

  it('.roorules-<mode> files honour exclude, and an include list replaces the defaults (scan and selectScanPaths agree)', async () => {
    const repo = tempRepo({
      'AGENTS.md': '# Agents\n\nRun the tests.\n',
      '.roorules-ask': '# Ask\n\nAnswer only.\n',
      '.roorules-code': '# Code\n\nWrite code.\n',
      '.kiro/steering/tech.md': '# Tech\n\nTypeScript.\n',
    });
    const paths = ['AGENTS.md', '.roorules-ask', '.roorules-code', '.kiro/steering/tech.md'];
    const scanned = async (opts: { include?: string[]; exclude?: string[] }) =>
      (await scanFiles({ repoPath: repo, ...opts })).map((f) => f.relativePath!).sort();

    expect(await scanned({})).toEqual(['.kiro/steering/tech.md', '.roorules-ask', '.roorules-code', 'AGENTS.md']);
    expect(await scanned({ exclude: ['.roorules-ask'] })).toEqual(['.kiro/steering/tech.md', '.roorules-code', 'AGENTS.md']);
    expect(selectScanPaths(paths, { exclude: ['.roorules-ask'] }).instructionFiles).toEqual(['.kiro/steering/tech.md', '.roorules-code', 'AGENTS.md']);
    expect(await scanned({ include: ['AGENTS.md'] })).toEqual(['AGENTS.md']);
    expect(selectScanPaths(paths, { include: ['AGENTS.md'] }).instructionFiles).toEqual(['AGENTS.md']);
  });
});
