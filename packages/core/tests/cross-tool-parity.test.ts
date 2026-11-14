/**
 * pcic-sev5: cross-tool parity. Each tool's instruction file is compared with
 * AGENTS.md on three concrete facts: package manager, test runner, a path not to
 * edit. The ambiguous twin of every case must stay quiet: a parity finding that
 * is only sometimes right trains people to ignore the rest. The reproductions
 * from the review of PR 167 are each a test here and a line in
 * examples/fixture-cross-tool-parity-clean.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectCrossToolParity } from '../src/cross-tool-parity.js';
import { computeHealthScore } from '../src/health-score.js';
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
/** Some content that is not what the files under test say, so two files are not near-identical. */
const FILLER = '# Notes\n\nKeep changes small.\nWrite a test for every fix.\nExplain the why in the PR body.\nAsk before large refactors.\n';

const titles = (issues: PromptCiIssue[]) => issues.map((i) => i.title);
const detect = (...files: InstructionFile[]) => detectCrossToolParity(files);

describe('package manager', () => {
  it('flags a tool file that names a different manager than AGENTS.md', () => {
    const issues = detect(agents(`${FILLER}Install with \`pnpm install\`.\n`), claude(`${FILLER}Install with \`npm install\`.\n`));
    expect(titles(issues)).toEqual([
      'Possible package manager disagreement with AGENTS.md: CLAUDE.md uses npm, AGENTS.md uses pnpm',
    ]);
    const [issue] = issues;
    expect(issue!.severity).toBe('info');
    expect(issue!.tags).toEqual(['unscored']);
    expect(issue!.category).toBe('conflict');
    expect(issue!.autoApplySafe).toBeUndefined();
    expect(issue!.fixEdits).toBeUndefined();
    expect(issue!.summary).toContain('Possible cross-tool mismatch');
    expect(issue!.evidence).toEqual([
      `AGENTS.md:${FILLER.split('\n').length}: Install with \`pnpm install\`.`,
      `CLAUDE.md:${FILLER.split('\n').length}: Install with \`npm install\`.`,
    ]);
    expect(issue!.locations.map((l) => l.filePath)).toEqual(['/repo/AGENTS.md', '/repo/CLAUDE.md']);
  });

  it('costs no health-score points', () => {
    const issues = detect(agents(`${FILLER}Use \`pnpm install\`.\n`), claude(`${FILLER}Use \`npm install\`.\n`));
    expect(issues).toHaveLength(1);
    expect(computeHealthScore(issues)).toBe(100);
  });

  it('reads prose and shell fences, not just code spans', () => {
    const issues = detect(agents(`${FILLER}We use pnpm here.\n`), claude(`${FILLER}## Setup\n\n\`\`\`bash\nyarn install\nyarn build\n\`\`\`\n`));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.title).toContain('CLAUDE.md uses yarn, AGENTS.md uses pnpm');
  });

  it('is more confident when one file rules out what the other uses', () => {
    const plain = detect(agents(`${FILLER}Use \`pnpm install\`.\n`), claude(`${FILLER}Use \`npm install\`.\n`));
    const explicit = detect(agents(`${FILLER}Use \`pnpm install\`. Do not use npm.\n`), claude(`${FILLER}Use \`npm install\`.\n`));
    expect(explicit).toHaveLength(1);
    expect(explicit[0]!.confidence).toBeGreaterThan(plain[0]!.confidence);
  });

  it('flags a file that uses what AGENTS.md rules out, even when the first names no manager of its own', () => {
    const issues = detect(agents(`${FILLER}Never use yarn in this repository.\n`), claude(`${FILLER}Install with \`yarn install\`.\n`));
    expect(titles(issues)).toEqual([
      'Possible package manager disagreement with AGENTS.md: yarn is used in CLAUDE.md and ruled out in AGENTS.md',
    ]);
  });

  it('stays quiet when the files agree, or the other file names no manager', () => {
    expect(detect(agents(`${FILLER}Use \`pnpm install\`.\n`), claude(`${FILLER}Run \`pnpm install\` first.\n`))).toEqual([]);
    expect(detect(agents(`${FILLER}Use \`pnpm install\`.\n`), claude(FILLER))).toEqual([]);
  });

  it('stays quiet when a file lists several managers', () => {
    expect(
      detect(agents(`${FILLER}Use \`pnpm install\`.\n`), claude(`${FILLER}Install with \`npm install\`, \`yarn install\` or \`pnpm install\`.\n`)),
    ).toEqual([]);
  });

  it('does not count a global tool install', () => {
    expect(detect(agents(`${FILLER}Use \`pnpm install\`.\n`), claude(`${FILLER}Install the compiler with \`npm install -g typescript\`.\n`))).toEqual([]);
  });

  it('does not count "publish", or "npm packages"', () => {
    expect(detect(agents(`${FILLER}Use \`pnpm install\`.\n`), claude(`${FILLER}Release with \`npm publish\`. Use npm packages sparingly.\n`))).toEqual([]);
  });

  it('ignores commands in non-shell fences (a workflow or JSON snippet)', () => {
    expect(detect(agents(`${FILLER}Use \`pnpm install\`.\n`), claude(`${FILLER}\`\`\`yaml\n- run: npm ci\n\`\`\`\n`))).toEqual([]);
  });

  // Review of PR 167, blocker 1: negation outside the code span, and bad examples.
  it('reads negation across the whole line, not only inside the code span', () => {
    expect(
      detect(
        agents(`${FILLER}Use \`pnpm install\`. Avoid npm here.\n`),
        claude(`${FILLER}Run \`pnpm install\` instead of \`npm install\`.\n`),
      ),
    ).toEqual([]);
  });

  it('ends a negation at the clause break: "Never hand-edit X — run `pnpm build`" does not rule out pnpm', () => {
    // Found by the 43-repository corpus run (akii09/pdfx AGENTS.md:19).
    for (const sep of [' — ', ' - ', ', then ', '; ']) {
      expect(
        detect(
          agents(`${FILLER}Never hand-edit the registry${sep}run \`pnpm build:registry\`.\n`),
          claude(`${FILLER}Run \`pnpm build:registry\` after editing.\n`),
        ),
        sep,
      ).toEqual([]);
    }
    // The dash variants that are plain hyphens inside a word still negate: "not npm or yarn".
    expect(
      detect(agents(`${FILLER}Use pnpm (not npm or yarn).\n`), claude(`${FILLER}Install with \`yarn install\`.\n`)),
    ).toHaveLength(1);
  });

  it('does not take a fenced "wrong" example as usage', () => {
    expect(
      detect(
        agents(`${FILLER}Use \`pnpm install\`.\n`),
        claude(`${FILLER}This repo uses pnpm. Avoid npm.\n\nWrong:\n\n\`\`\`bash\nnpm install\n\`\`\`\n`),
      ),
    ).toEqual([]);
    // ...but the same block with a neutral label is usage.
    expect(
      detect(
        agents(`${FILLER}Use \`pnpm install\`.\n`),
        claude(`${FILLER}Setup:\n\n\`\`\`bash\nnpm install\n\`\`\`\n`),
      ),
    ).toHaveLength(1);
  });

  it('skips a file that mirrors AGENTS.md exactly or nearly', () => {
    const body = 'Avoid npm here.\nRun `pnpm install` instead of `npm install`.\n';
    expect(detect(agents(body), claude(body))).toEqual([]);
    const lines = Array.from({ length: 20 }, (_, i) => `Rule number ${i} is to keep functions short.`).join('\n');
    // 20 shared lines and one different line each: 20 / 22 of the distinct lines are common.
    expect(detect(agents(`${lines}\nUse \`pnpm install\`.\n`), claude(`${lines}\nUse \`npm install\`.\n`))).toEqual([]);
  });

  it('skips a command that is directory-scoped', () => {
    for (const line of [
      'The docs site is standalone: `cd docs && npm install`.',
      'Inside `packages/legacy`, run `npm install`.',
      'Publish from packages/sdk with `npm run release`.',
      'The legacy package is separate: `npm install` there.',
    ]) {
      expect(detect(agents(`${FILLER}Use \`pnpm install\`.\n`), claude(`${FILLER}${line}\n`)), line).toEqual([]);
    }
    // A fenced block that `cd`s first is scoped to that directory.
    expect(
      detect(agents(`${FILLER}Use \`pnpm install\`.\n`), claude(`${FILLER}\`\`\`bash\ncd docs\nnpm install\n\`\`\`\n`)),
    ).toEqual([]);
  });

  it('defers to manifest-consistency when the manifest already names a manager', () => {
    const files = [agents(`${FILLER}Use \`pnpm install\`.\n`), claude(`${FILLER}Use \`npm install\`.\n`)];
    expect(detectCrossToolParity(files, { manifestPackageManager: 'unknown' })).toHaveLength(1);
    // pnpm in the manifest: the npm line is already `manifest-package-manager-mismatch`.
    expect(detectCrossToolParity(files, { manifestPackageManager: 'pnpm' })).toEqual([]);
  });

  it('reports one finding per tool file against AGENTS.md, never between the other two', () => {
    const issues = detect(
      agents(`${FILLER}Use \`pnpm install\`.\n`),
      claude(`${FILLER}Use \`npm install\`.\n`),
      cursor(`${FILLER}Use \`yarn install\`.\n`),
    );
    expect(titles(issues).sort()).toEqual([
      'Possible package manager disagreement with AGENTS.md: .cursorrules uses yarn, AGENTS.md uses pnpm',
      'Possible package manager disagreement with AGENTS.md: CLAUDE.md uses npm, AGENTS.md uses pnpm',
    ]);
    // Two files that disagree with each other but both agree with AGENTS.md: nothing.
    expect(detect(agents(`${FILLER}Use \`pnpm install\`.\n`), claude(`${FILLER}Use \`pnpm install\`.\n`), cursor(`${FILLER}Use \`pnpm install\`.\n`))).toEqual([]);
  });
});

describe('test runner', () => {
  it('flags different runners', () => {
    expect(titles(detect(agents(`${FILLER}Run \`vitest run\`.\n`), claude(`${FILLER}Run \`npx jest\`.\n`)))).toEqual([
      'Possible test runner disagreement with AGENTS.md: CLAUDE.md runs jest, AGENTS.md runs vitest',
    ]);
    expect(titles(detect(agents(`${FILLER}Run \`pytest -q\`.\n`), claude(`${FILLER}Run \`python -m unittest\`.\n`)))).toEqual([
      'Possible test runner disagreement with AGENTS.md: CLAUDE.md runs unittest, AGENTS.md runs pytest',
    ]);
  });

  // Review of PR 167, blocker 3.
  it('does not take a runner that is ruled out as the file\'s runner', () => {
    expect(detect(agents(`${FILLER}Tests run with \`vitest\`.\n`), claude(`${FILLER}Do not use \`jest\`.\n`))).toEqual([]);
  });

  it('does not match a runner inside a longer name', () => {
    expect(
      detect(agents(`${FILLER}Tests run with \`vitest\`.\n`), claude(`${FILLER}Install \`@testing-library/jest-dom\` and \`jest-extended\`.\n`)),
    ).toEqual([]);
  });

  it('does not treat two script names of the same runner as a contradiction', () => {
    expect(detect(agents(`${FILLER}Run \`pnpm test\`.\n`), claude(`${FILLER}Run \`pnpm test:unit\`.\n`))).toEqual([]);
  });

  it('stays quiet when a file lists several runners', () => {
    expect(detect(agents(`${FILLER}Run \`vitest run\`.\n`), claude(`${FILLER}Run \`vitest run\` or \`jest\`.\n`))).toEqual([]);
  });
});

describe('forbidden path', () => {
  it('flags a path AGENTS.md rules out and another file tells the reader to edit', () => {
    const issues = detect(
      agents(`${FILLER}Never edit \`src/generated/\`.\n`),
      claude(`${FILLER}Add new schema files under \`src/generated/api/\` when the API changes.\n`),
    );
    expect(titles(issues)).toEqual(['Possible forbidden path disagreement with AGENTS.md: src/generated']);
  });

  // Review of PR 167, blocker 2.
  it.each([
    ['Never commit `.env`.', 'Add your API keys to `.env`.'],
    ['Do not modify `pnpm-lock.yaml`.', 'Run `pnpm install` to update `pnpm-lock.yaml`.'],
    ['Never delete `db/migrations/`.', 'Add new SQL files under `db/migrations/`.'],
    ['Never remove `src/legacy/`.', 'Edit `src/legacy/index.ts` when you fix a bug.'],
  ])('does not read "%s" as the opposite of "%s"', (forbid, instruct) => {
    expect(detect(agents(`${FILLER}${forbid}\n`), claude(`${FILLER}${instruct}\n`))).toEqual([]);
    expect(detect(agents(`${FILLER}${instruct}\n`), claude(`${FILLER}${forbid}\n`))).toEqual([]);
  });

  it('stays quiet when the prohibition is only about editing by hand', () => {
    expect(
      detect(agents(`${FILLER}Do not edit \`src/generated/\` by hand.\n`), claude(`${FILLER}Regenerate \`src/generated/\` and update the checked-in copy.\n`)),
    ).toEqual([]);
  });

  it('stays quiet when the paths are unrelated or both files forbid the path', () => {
    expect(detect(agents(`${FILLER}Never edit \`src/generated/\`.\n`), claude(`${FILLER}Add new routes under \`src/routes/\`.\n`))).toEqual([]);
    expect(detect(agents(`${FILLER}Never edit \`dist/\`.\n`), claude(`${FILLER}Do not modify \`dist/\`.\n`))).toEqual([]);
  });
});

describe('what is compared', () => {
  it('needs an AGENTS.md: with none there is nothing to be in parity with', () => {
    expect(detect(claude(`${FILLER}Use \`pnpm install\`.\n`), cursor(`${FILLER}Use \`npm install\`.\n`))).toEqual([]);
    expect(detect(agents(`${FILLER}Use \`pnpm install\`.\n`))).toEqual([]);
    expect(detectCrossToolParity([])).toEqual([]);
  });

  it('ignores READMEs, docs and skills', () => {
    expect(
      detect(
        agents(`${FILLER}Use \`pnpm install\`.\n`),
        file('README.md', 'Use `npm install`.\n', 'readme'),
        file('docs/guide.md', 'Use `yarn install`.\n', 'docs'),
      ),
    ).toEqual([]);
  });

  it('compares files in the same scope only', () => {
    expect(detect(agents(`${FILLER}Use \`pnpm install\`.\n`), file('packages/legacy/CLAUDE.md', `${FILLER}Use \`npm install\`.\n`, 'claude'))).toEqual([]);
    expect(
      detect(
        file('packages/legacy/AGENTS.md', `${FILLER}Use \`pnpm install\`.\n`, 'agents'),
        file('packages/legacy/CLAUDE.md', `${FILLER}Use \`npm install\`.\n`, 'claude'),
      ),
    ).toHaveLength(1);
  });

  it('keeps any other hidden directory as a scope of its own', () => {
    expect(
      detect(
        agents(`${FILLER}Use \`pnpm install\`.\n`),
        file('.config/tooling/CLAUDE.md', `${FILLER}Use \`npm install\`.\n`, 'claude'),
        file('.devcontainer/AGENTS.md', `${FILLER}Use \`yarn install\`.\n`, 'agents'),
      ),
    ).toEqual([]);
  });

  it('puts a tool directory in the scope that holds it', () => {
    expect(detect(agents(`${FILLER}Use \`pnpm install\`.\n`), copilot(`${FILLER}Use \`npm install\`.\n`))).toHaveLength(1);
  });

  // Review of PR 167, blocker 4.
  it('skips .claude/commands and .claude/agents: task prompts, not the rulebook', () => {
    for (const rel of ['.claude/commands/release.md', '.claude/agents/release.md']) {
      expect(detect(agents(`${FILLER}Use \`pnpm install\`.\n`), file(rel, `${FILLER}Publish with \`npm install\` first.\n`, 'claude')), rel).toEqual([]);
    }
  });

  it('skips Cursor .mdc rules unless they say alwaysApply: true, and rules with globs', () => {
    const anchor = agents(`${FILLER}Use \`pnpm install\`.\n`);
    const mdc = (frontmatter: string) => file('.cursor/rules/web.mdc', `---\n${frontmatter}\n---\n${FILLER}Use \`yarn install\`.\n`, 'cursor');
    expect(detect(anchor, mdc('description: Style notes\nalwaysApply: false'))).toEqual([]);
    expect(detect(anchor, mdc('description: Style notes'))).toEqual([]);
    expect(detect(anchor, mdc('globs: apps/web/**'))).toEqual([]);
    expect(detect(anchor, mdc('alwaysApply: true'))).toHaveLength(1);
    // A plain Copilot or Cursor file with `applyTo:` covers part of the tree.
    expect(detect(anchor, file('.github/instructions/web.md', `---\napplyTo: "web/**"\n---\n${FILLER}Use \`yarn install\`.\n`, 'copilot'))).toEqual([]);
  });

  it('is deterministic whatever order the files arrive in', () => {
    const a = agents(`${FILLER}Use \`pnpm install\`. Run \`vitest\`.\n`);
    const b = claude(`${FILLER}Use \`npm install\`. Run \`npx jest\`.\n`);
    const c = cursor(`${FILLER}Use \`yarn install\`.\n`);
    const forward = detect(a, b, c);
    const backward = detect(c, b, a);
    expect(backward).toEqual(forward);
    expect(new Set(forward.map((i) => i.id)).size).toBe(forward.length);
  });
});

describe('fixtures', () => {
  const parityIn = async (name: string) => {
    const { issues } = await scan({ repoPath: path.join(EXAMPLES, name), projectType: 'typescript' });
    return issues.filter((i) => i.id.startsWith('cross-tool-parity-'));
  };

  it('examples/fixture-cross-tool-parity: all three dimensions fire through scan(), as info and unscored', async () => {
    const parity = await parityIn('fixture-cross-tool-parity');
    expect(parity.map((i) => i.title).sort()).toEqual([
      'Possible forbidden path disagreement with AGENTS.md: src/generated',
      'Possible package manager disagreement with AGENTS.md: CLAUDE.md uses npm, AGENTS.md uses pnpm',
      'Possible test runner disagreement with AGENTS.md: CLAUDE.md runs jest, AGENTS.md runs vitest',
    ]);
    for (const issue of parity) {
      expect(issue.severity).toBe('info');
      expect(issue.tags).toContain('unscored');
    }
  });

  it('examples/fixture-cross-tool-parity-clean: every reviewed false positive stays quiet', async () => {
    expect(await parityIn('fixture-cross-tool-parity-clean')).toEqual([]);
  });

  it('examples/fixture-cross-tool-parity-no-anchor: no AGENTS.md, no finding', async () => {
    expect(await parityIn('fixture-cross-tool-parity-no-anchor')).toEqual([]);
  });
});
