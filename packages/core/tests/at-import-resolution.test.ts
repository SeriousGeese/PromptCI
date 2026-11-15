/**
 * `@path` imports in instruction files (issues #184, #199, #204, #205):
 *  - dead-references: `@AGENTS.md` in a code span names AGENTS.md, and a live
 *    import line is resolved from the importing file's directory only;
 *  - agent-practices: an import of a file the scan did not read still forwards
 *    when the repository holds it, and a prose pointer gets the import advice.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../src/scan.js';
import { detectAgentPractices } from '../src/agent-practices.js';
import { RepoTree } from '../src/repo-tree.js';
import { computeHealthScore } from '../src/health-score.js';
import type { InstructionFile } from '../src/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.resolve(__dirname, '../../../examples', name);

const brokenRefs = async (name: string) =>
  (await scan({ repoPath: fixture(name) })).issues.filter((i) => i.title.startsWith('Broken file reference'));

describe('dead-references: @ imports (#204)', () => {
  it('fixture-at-ref-spans-clean: `@AGENTS.md`, `@../AGENTS.md` and a resolving import line report nothing', async () => {
    expect(await brokenRefs('fixture-at-ref-spans-clean')).toEqual([]);
  });

  it('fixture-at-ref-broken: reports the missing code-span target without the @, and a bare import that resolves nowhere', async () => {
    const issues = await brokenRefs('fixture-at-ref-broken');
    expect(issues.map((i) => i.title).sort()).toEqual([
      'Broken file reference: AGENTS.md',
      'Broken file reference: MISSING.md',
    ]);
    const missing = issues.find((i) => i.title.endsWith('MISSING.md'))!;
    expect(missing.evidence).toContain('Reference: `@MISSING.md`');
    const agents = issues.find((i) => i.title.endsWith('AGENTS.md'))!;
    expect(agents.filePaths.map((p) => p.replace(/\\/g, '/'))).toEqual([expect.stringMatching(/\.claude\/CLAUDE\.md$/)]);
    expect(agents.evidence).toEqual(['Reference: @AGENTS.md']);
  });
});

describe('agent-practices: an @ import of a file outside the scanned set (#205)', () => {
  const noGuidance = async (name: string) =>
    (await scan({ repoPath: fixture(name) })).issues.filter((i) => i.title === 'No behavioral guidance in CLAUDE.md');

  it('fixture-import-unscanned-clean: CLAUDE.md imports an AGENTS.md the scan excludes, so nothing is reported', async () => {
    const report = await scan({ repoPath: fixture('fixture-import-unscanned-clean') });
    expect(report.issues.filter((i) => i.title === 'No behavioral guidance in CLAUDE.md')).toEqual([]);
    expect(report.issues.filter((i) => i.title.startsWith('Broken'))).toEqual([]);
    expect(report.issues.filter((i) => i.id.startsWith('unread-import'))).toEqual([]);
  });

  it('fixture-import-missing: an import of a file that does not exist is still reported, as advice and as a broken reference', async () => {
    const issues = await noGuidance('fixture-import-missing');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('info');
    expect(await brokenRefs('fixture-import-missing')).toHaveLength(1);
  });

  const claude = (content: string, rel = 'CLAUDE.md'): InstructionFile => ({
    path: `/repo/${rel}`,
    relativePath: rel,
    fileType: 'claude',
    content,
    sections: [],
    lineCount: content.split('\n').length,
    charCount: content.length,
    estimatedTokens: 10,
  });
  const agents: InstructionFile = {
    path: '/repo/.github/copilot-instructions.md',
    relativePath: '.github/copilot-instructions.md',
    fileType: 'copilot',
    content: 'Before saying done, run pnpm test. Report failures honestly. Read a file before editing it. Prefer focused diffs.\n',
    sections: [],
    lineCount: 2,
    charCount: 100,
    estimatedTokens: 25,
  };

  it('notes, as info, an imported file that exists but whose content the scan did not fetch', () => {
    const tree = new RepoTree('/repo', { knownPaths: ['AGENTS.md', 'CLAUDE.md'], knownPathsComplete: true });
    const issues = detectAgentPractices([claude('# Claude\n\n@AGENTS.md\n\nUse /review.\n'), agents], [], tree);
    expect(issues.filter((i) => i.title === 'No behavioral guidance in CLAUDE.md')).toEqual([]);
    const note = issues.filter((i) => i.id.startsWith('unread-import'));
    expect(note).toHaveLength(1);
    expect(note[0]!.severity).toBe('info');
  });

  it('does not count an import of a path the tree does not hold', () => {
    const tree = new RepoTree('/repo', { knownPaths: ['CLAUDE.md'], knownPathsComplete: true });
    const issues = detectAgentPractices([claude('# Claude\n\n@AGENTS.md\n\nUse /review.\n'), agents], [], tree);
    expect(issues.filter((i) => i.title === 'No behavioral guidance in CLAUDE.md')).toHaveLength(1);
  });
});

describe('agent-practices: prose pointer and per-tool gaps are advice (#184, #199)', () => {
  const file = (rel: string, fileType: InstructionFile['fileType'], content: string): InstructionFile => ({
    path: `/repo/${rel}`,
    relativePath: rel,
    fileType,
    content,
    sections: [],
    lineCount: content.split('\n').length,
    charCount: content.length,
    estimatedTokens: 10,
  });
  const agents = file(
    'AGENTS.md',
    'agents',
    '# Rules\nBefore saying done, run pnpm test. Report failures honestly. Always read a file before editing it. Prefer focused diffs.\n',
  );

  it('recommends the @AGENTS.md import when CLAUDE.md only points to AGENTS.md in words', () => {
    const issues = detectAgentPractices([agents, file('CLAUDE.md', 'claude', 'Follow AGENTS.md for behavioral rules.')]);
    const advice = issues.filter((i) => i.id.startsWith('prose-pointer'));
    expect(advice).toHaveLength(1);
    expect(advice[0]!.severity).toBe('info');
    expect(advice[0]!.recommendation).toContain('`@AGENTS.md`');
    expect(issues.filter((i) => i.title === 'No behavioral guidance in CLAUDE.md')).toEqual([]);
  });

  it('gives no pointer advice for a CLAUDE.md that already imports, or for a pointer in a file whose tool has no import', () => {
    const imports = detectAgentPractices([agents, file('CLAUDE.md', 'claude', '@AGENTS.md\n')]);
    expect(imports.filter((i) => i.id.startsWith('prose-pointer'))).toEqual([]);
    const cursor = detectAgentPractices([agents, file('.cursorrules', 'cursor', 'Follow AGENTS.md for behavioral rules.')]);
    expect(cursor.filter((i) => i.id.startsWith('prose-pointer'))).toEqual([]);
  });

  it('points the import at AGENTS.md from the importing file\'s directory', () => {
    const issues = detectAgentPractices([agents, file('.claude/CLAUDE.md', 'claude', 'Follow AGENTS.md for behavioral rules.')]);
    expect(issues.find((i) => i.id.startsWith('prose-pointer'))!.recommendation).toContain('`@../AGENTS.md`');
  });

  it('reports a tool file without the rules as unscored info that recommends the import (not a prose pointer)', () => {
    const issues = detectAgentPractices([agents, file('CLAUDE.md', 'claude', '# Claude\n\nUse /review.\n')]);
    const gap = issues.find((i) => i.title === 'No behavioral guidance in CLAUDE.md')!;
    expect(gap.severity).toBe('info');
    expect(gap.tags).toContain('unscored');
    expect(gap.recommendation).toContain('`@AGENTS.md`');
    expect(gap.recommendation).not.toMatch(/Follow AGENTS\.md/);
    expect(computeHealthScore([gap])).toBe(100);
  });
});
