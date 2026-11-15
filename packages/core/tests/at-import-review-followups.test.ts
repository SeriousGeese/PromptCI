/**
 * Review follow-ups for the `@` import work (#184, #204, #205): import-looking
 * words are not paths, a scanned import target must hold rules to forward, and
 * the prose-pointer hint is one per CLAUDE.md.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectAgentPractices } from '../src/agent-practices.js';
import { detectDeadReferences } from '../src/dead-references.js';
import { RepoTree } from '../src/repo-tree.js';
import type { InstructionFile } from '../src/types.js';

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
const rules =
  'Before saying done, run pnpm test. Report failures honestly. Always read a file before editing it. Prefer focused diffs.\n';
const agents = file('AGENTS.md', 'agents', `# Rules\n${rules}`);
const noGuidance = (issues: ReturnType<typeof detectAgentPractices>) =>
  issues.filter((i) => i.title === 'No behavioral guidance in CLAUDE.md');

describe('dead-references: import-looking lines without a path', () => {
  it.each(['@README', '@types/node', '@octocat'])('%s is not a broken reference', (line) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-at-'));
    try {
      const f = { ...file('CLAUDE.md', 'claude', `# Claude\n\n${line}\n`), path: path.join(dir, 'CLAUDE.md') };
      expect(detectDeadReferences([f], dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('agent-practices: scanned import targets and the prose-pointer hint', () => {
  it('an import of a scanned file without behavioral rules is still reported', () => {
    const readme = file('README.md', 'readme', '# Project\n\nA library.\n');
    const tree = new RepoTree('/repo', { knownPaths: ['README.md', 'CLAUDE.md', 'AGENTS.md'], knownPathsComplete: true });
    const issues = detectAgentPractices([agents, readme, file('CLAUDE.md', 'claude', '@README.md\n')], [], tree);
    expect(noGuidance(issues)).toHaveLength(1);
  });

  it('an import of a scanned file that holds the rules forwards', () => {
    const doc = file('docs/agent-rules.md', 'docs', `# Rules\n${rules}`);
    const tree = new RepoTree('/repo', { knownPaths: ['docs/agent-rules.md', 'CLAUDE.md'], knownPathsComplete: true });
    const issues = detectAgentPractices([agents, doc, file('CLAUDE.md', 'claude', '@docs/agent-rules.md\n')], [], tree);
    expect(noGuidance(issues)).toEqual([]);
  });

  it('gives one prose-pointer hint to a CLAUDE.md that has rules of its own too', () => {
    const issues = detectAgentPractices([agents, file('CLAUDE.md', 'claude', `Follow AGENTS.md.\n\n${rules}`)]);
    expect(issues.filter((i) => i.id.startsWith('prose-pointer'))).toHaveLength(1);
  });

  it('does not claim there is no import line when the file has one that reaches nothing', () => {
    const claude = file('.claude/CLAUDE.md', 'claude', '@AGENTS.md\n\nFollow AGENTS.md.\n');
    const hint = detectAgentPractices([agents, claude]).find((i) => i.id.startsWith('prose-pointer'))!;
    expect(hint.evidence.join(' ')).not.toMatch(/No import line for/);
  });
});
