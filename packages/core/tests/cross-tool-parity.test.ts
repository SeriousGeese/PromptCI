/**
 * pcic-sev5: cross-tool parity. Each tool's instruction file is compared with
 * the others on three concrete facts: package manager, test command, forbidden
 * path. The ambiguous twin of every case must stay quiet: a parity finding that
 * is only sometimes right trains people to ignore the rest.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectCrossToolParity } from '../src/cross-tool-parity.js';
import { scan } from '../src/scan.js';
import type { FileType, InstructionFile, PromptCiIssue } from '../src/types.js';

const EXAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../examples');

function file(relativePath: string, content: string, fileType: FileType): InstructionFile {
  return {
    path: `/repo/${relativePath}`,
    relativePath,
    fileType,
    content,
    sections: [],
    lineCount: content.split('\n').length,
    charCount: content.length,
    estimatedTokens: Math.round(content.length / 4),
  };
}

const agents = (content: string) => file('AGENTS.md', content, 'agents');
const claude = (content: string) => file('CLAUDE.md', content, 'claude');
const cursor = (content: string) => file('.cursorrules', content, 'cursor');
const copilot = (content: string) => file('.github/copilot-instructions.md', content, 'copilot');

const titles = (issues: PromptCiIssue[]) => issues.map((i) => i.title);

describe('package manager', () => {
  it('flags two tool files that name different package managers', () => {
    const issues = detectCrossToolParity([
      agents('Install with `pnpm install`.\n'),
      claude('Install with `npm install`.\n'),
    ]);
    expect(titles(issues)).toEqual(['Possible package manager disagreement between tool files: npm vs pnpm']);
    const [issue] = issues;
    expect(issue!.category).toBe('conflict');
    expect(issue!.severity).toBe('warning');
    expect(issue!.autoApplySafe).toBeUndefined();
    expect(issue!.fixEdits).toBeUndefined();
    expect(issue!.summary).toContain('Possible cross-tool mismatch');
    expect(issue!.evidence).toEqual([
      'AGENTS.md:1: Install with `pnpm install`.',
      'CLAUDE.md:1: Install with `npm install`.',
    ]);
    expect(issue!.locations).toEqual([
      { filePath: '/repo/AGENTS.md', startLine: 1 },
      { filePath: '/repo/CLAUDE.md', startLine: 1 },
    ]);
  });

  it('reads prose and shell fences, not just code spans', () => {
    const issues = detectCrossToolParity([
      agents('We use pnpm here.\n'),
      claude('## Setup\n\n```bash\nyarn install\nyarn build\n```\n'),
    ]);
    expect(titles(issues)).toEqual(['Possible package manager disagreement between tool files: pnpm vs yarn']);
  });

  it('is more confident when one file rules out what the other uses', () => {
    const plain = detectCrossToolParity([agents('Use `pnpm install`.\n'), claude('Use `npm install`.\n')]);
    const explicit = detectCrossToolParity([
      agents('Use `pnpm install`. Do not use npm.\n'),
      claude('Use `npm install`.\n'),
    ]);
    expect(explicit).toHaveLength(1);
    expect(explicit[0]!.confidence).toBeGreaterThan(plain[0]!.confidence);
    expect(explicit[0]!.evidence.join('\n')).toContain('Do not use npm');
  });

  it('flags a file that uses what another forbids, even when the first names no manager of its own', () => {
    const issues = detectCrossToolParity([
      agents('Never use yarn in this repository.\n'),
      claude('Install with `yarn install`.\n'),
    ]);
    expect(titles(issues)).toEqual(['Possible package manager disagreement between tool files: yarn is both used and ruled out']);
  });

  it('stays quiet when the files agree', () => {
    expect(detectCrossToolParity([agents('Use `pnpm install`.\n'), claude('Run `pnpm install` first.\n')])).toEqual([]);
  });

  it('stays quiet when a file names several managers (a list of alternatives says nothing)', () => {
    expect(
      detectCrossToolParity([
        agents('Use `pnpm install`.\n'),
        claude('Install with `npm install`, `yarn install` or `pnpm install`.\n'),
      ]),
    ).toEqual([]);
  });

  it('does not count a global tool install as the project package manager', () => {
    expect(
      detectCrossToolParity([
        agents('Use `pnpm install`.\n'),
        claude('Install the compiler once with `npm install -g typescript`.\n'),
      ]),
    ).toEqual([]);
  });

  it('does not count a command that is being ruled out', () => {
    expect(
      detectCrossToolParity([agents('Use `pnpm install`.\n'), claude('Use `pnpm install`, never `npm install`.\n')]),
    ).toEqual([]);
  });

  it('does not read "npm packages" as a package manager choice', () => {
    expect(detectCrossToolParity([agents('Use `pnpm install`.\n'), claude('Use npm packages sparingly.\n')])).toEqual([]);
  });

  it('ignores commands in non-shell fences (a workflow or JSON snippet)', () => {
    expect(
      detectCrossToolParity([
        agents('Use `pnpm install`.\n'),
        claude('```yaml\n- run: npm ci\n```\n'),
      ]),
    ).toEqual([]);
  });

  it('merges every pair of one disagreement into one finding', () => {
    const issues = detectCrossToolParity([
      agents('Use `pnpm install`.\n'),
      claude('Use `npm install`.\n'),
      cursor('Use `npm install`.\n'),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.filePaths).toEqual(['/repo/.cursorrules', '/repo/AGENTS.md', '/repo/CLAUDE.md']);
  });
});

describe('test command', () => {
  it('flags different test scripts', () => {
    const issues = detectCrossToolParity([
      agents('Run `pnpm test` before you push.\n'),
      claude('Run `pnpm test:unit` before you push.\n'),
    ]);
    expect(titles(issues)).toEqual(['Possible test command disagreement between tool files: test vs test:unit']);
  });

  it('flags different test runners and Python test frameworks', () => {
    expect(titles(detectCrossToolParity([agents('Run `vitest run`.\n'), claude('Run `npx jest`.\n')]))).toEqual([
      'Possible test command disagreement between tool files: jest vs vitest',
    ]);
    expect(titles(detectCrossToolParity([agents('Run `pytest -q`.\n'), claude('Run `python -m unittest`.\n')]))).toEqual([
      'Possible test command disagreement between tool files: pytest vs unittest',
    ]);
  });

  it('reports a package-manager-only difference once, as a package manager finding', () => {
    const issues = detectCrossToolParity([agents('Run `pnpm test`.\n'), claude('Run `npm test`.\n')]);
    expect(titles(issues)).toEqual(['Possible package manager disagreement between tool files: npm vs pnpm']);
  });

  it('stays quiet when a file lists several test commands or the files share one', () => {
    expect(
      detectCrossToolParity([
        agents('Run `pnpm test`.\n'),
        claude('Run `pnpm test`, and `pnpm test:e2e` before release.\n'),
      ]),
    ).toEqual([]);
  });

  it('does not compare across families (a script and a runner say different things)', () => {
    expect(detectCrossToolParity([agents('Run `pnpm test`.\n'), claude('Run `vitest run src/a.test.ts`.\n')])).toEqual([]);
  });
});

describe('forbidden path', () => {
  it('flags a path one file rules out and another tells the reader to edit', () => {
    const issues = detectCrossToolParity([
      agents('Never edit `src/generated/`.\n'),
      claude('Add new schema files under `src/generated/api/` when the API changes.\n'),
    ]);
    expect(titles(issues)).toEqual(['Possible forbidden path disagreement between tool files: src/generated']);
    expect(issues[0]!.evidence).toEqual([
      'AGENTS.md:1: Never edit `src/generated/`.',
      'CLAUDE.md:1: Add new schema files under `src/generated/api/` when the API changes.',
    ]);
  });

  it('stays quiet when the prohibition is only about editing by hand', () => {
    expect(
      detectCrossToolParity([
        agents('Do not edit `src/generated/` by hand.\n'),
        claude('Regenerate `src/generated/` and update the checked-in copy.\n'),
      ]),
    ).toEqual([]);
  });

  it('stays quiet when the paths are unrelated', () => {
    expect(
      detectCrossToolParity([agents('Never edit `src/generated/`.\n'), claude('Add new routes under `src/routes/`.\n')]),
    ).toEqual([]);
  });

  it('stays quiet when both files forbid the path', () => {
    expect(
      detectCrossToolParity([agents('Never edit `dist/`.\n'), claude('Do not modify `dist/`.\n')]),
    ).toEqual([]);
  });

  it('does not take a glob as a path', () => {
    expect(
      detectCrossToolParity([agents('Never edit `src/gen/**`.\n'), claude('Add files under `src/gen/api/`.\n')]).map((i) => i.title),
    ).toEqual(['Possible forbidden path disagreement between tool files: src/gen']);
  });
});

describe('what is compared', () => {
  it('needs two tool files', () => {
    expect(detectCrossToolParity([agents('Use `pnpm install`.\n')])).toEqual([]);
    expect(detectCrossToolParity([])).toEqual([]);
  });

  it('ignores READMEs, docs and skills', () => {
    expect(
      detectCrossToolParity([
        agents('Use `pnpm install`.\n'),
        file('README.md', 'Use `npm install`.\n', 'readme'),
        file('docs/guide.md', 'Use `yarn install`.\n', 'docs'),
      ]),
    ).toEqual([]);
  });

  it('compares files in the same scope only: a nested package may differ from the root', () => {
    expect(
      detectCrossToolParity([
        agents('Use `pnpm install`.\n'),
        file('packages/legacy/CLAUDE.md', 'Use `npm install`.\n', 'claude'),
      ]),
    ).toEqual([]);
    // Two tool files of the same nested package ARE compared.
    expect(
      detectCrossToolParity([
        file('packages/legacy/AGENTS.md', 'Use `pnpm install`.\n', 'agents'),
        file('packages/legacy/CLAUDE.md', 'Use `npm install`.\n', 'claude'),
      ]),
    ).toHaveLength(1);
  });

  it('puts a tool directory in the scope that holds it', () => {
    expect(detectCrossToolParity([agents('Use `pnpm install`.\n'), copilot('Use `npm install`.\n')])).toHaveLength(1);
  });

  it('skips glob-scoped rule files', () => {
    const scoped = file(
      '.cursor/rules/web.mdc',
      '---\nglobs: apps/web/**\n---\nUse `yarn install`.\n',
      'cursor',
    );
    expect(detectCrossToolParity([agents('Use `pnpm install`.\n'), scoped])).toEqual([]);
    const always = file('.cursor/rules/all.mdc', '---\nglobs: "**"\nalwaysApply: true\n---\nUse `yarn install`.\n', 'cursor');
    expect(detectCrossToolParity([agents('Use `pnpm install`.\n'), always])).toHaveLength(1);
  });

  it('is deterministic whatever order the files arrive in', () => {
    const a = agents('Use `pnpm install`. Run `pnpm test`.\n');
    const b = claude('Use `npm install`. Run `npm run test:unit`.\n');
    const c = cursor('Use `yarn install`.\n');
    const forward = detectCrossToolParity([a, b, c]);
    const backward = detectCrossToolParity([c, b, a]);
    expect(backward).toEqual(forward);
    expect(new Set(forward.map((i) => i.id)).size).toBe(forward.length);
  });
});

describe('fixtures', () => {
  it('examples/fixture-cross-tool-parity: all three dimensions fire through scan()', async () => {
    const { issues } = await scan({ repoPath: path.join(EXAMPLES, 'fixture-cross-tool-parity'), projectType: 'typescript' });
    const parity = issues.filter((i) => i.id.startsWith('cross-tool-parity-'));
    expect(parity.map((i) => i.title).sort()).toEqual([
      'Possible forbidden path disagreement between tool files: src/generated',
      'Possible package manager disagreement between tool files: npm vs pnpm',
      'Possible test command disagreement between tool files: test vs test:unit',
    ]);
    const pm = parity.find((i) => i.title.includes('package manager'))!;
    // The Copilot file's "Do not use npm" makes it explicit and pulls it into the finding.
    expect(pm.filePaths.map((p) => path.basename(p)).sort()).toEqual(['AGENTS.md', 'CLAUDE.md', 'copilot-instructions.md']);
    expect(pm.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('examples/fixture-cross-tool-parity-clean: pointer files, a nested package, a global install and a glob-scoped rule stay quiet', async () => {
    const { issues } = await scan({ repoPath: path.join(EXAMPLES, 'fixture-cross-tool-parity-clean'), projectType: 'typescript' });
    expect(issues.filter((i) => i.id.startsWith('cross-tool-parity-'))).toEqual([]);
  });
});
