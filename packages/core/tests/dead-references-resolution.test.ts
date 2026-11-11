/**
 * pcic-mh72: dead-reference false positives seen on public repositories.
 *
 * - A bare filename in a code span (`deploy_pr.yml`) names a file that lives
 *   under `.github/workflows/` (or `scripts/`, `src/translations/`, ...), not
 *   next to the instruction file. It resolves against any file of that name in
 *   the repository; a name that exists nowhere is still reported.
 * - A deep path from another project (`src/main/java/.../api/`) matched this
 *   repository on its first segment (`src`) alone. Past two missing levels the
 *   second segment must exist too.
 * - Brace alternation (`{de,en,ru}.json`) is a pattern, like a glob.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectDeadReferences } from '../src/dead-references.js';
import { scan } from '../src/scan.js';
import type { InstructionFile, PromptCiIssue } from '../src/types.js';
import { makeTempRepo, writeFile } from './ai-config-helpers.js';

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../examples/fixture-dead-ref-resolution',
);

let repo: string;

beforeAll(() => {
  repo = makeTempRepo('promptci-dead-ref-resolution-');
  writeFile(repo, '.github/workflows/deploy_pr.yml', 'name: deploy\n');
  writeFile(repo, 'scripts/verify-release.mjs', '');
  writeFile(repo, 'src/translations/en.json', '{}');
  writeFile(repo, 'src/api/v1/index.ts', 'export {};');
  writeFile(repo, 'node_modules/some-pkg/vendored.yml', '');
  writeFile(repo, '.gitignore', 'local/\n');
  writeFile(repo, 'local/only-local.yml', '');
  writeFile(repo, 'src/notes.txt', '');
  writeFile(repo, 'src/kept/index.ts', 'export {};');
  writeFile(repo, 'package.json', '{}');
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

function file(content: string, rel = 'AGENTS.md'): InstructionFile {
  return {
    path: path.join(repo, rel),
    fileType: 'agents',
    content,
    sections: [],
    lineCount: content.split('\n').length,
    charCount: content.length,
    estimatedTokens: Math.round(content.length / 4),
  };
}

function titles(content: string, rel?: string): string[] {
  return detectDeadReferences([file(content, rel)], repo).map((i: PromptCiIssue) => i.title).sort();
}

describe('bare filenames in code spans', () => {
  it('resolves a workflow filename that lives under .github/workflows/', () => {
    expect(titles('`deploy_pr.yml` runs the tests on every pull request.')).toEqual([]);
  });

  it('resolves bare names of files elsewhere in the tree', () => {
    expect(titles('Run `verify-release.mjs`, then copy `en.json`.')).toEqual([]);
  });

  it('resolves from an instruction file in a subdirectory', () => {
    expect(titles('`deploy_pr.yml` gates merges.', 'docs/AGENTS.md')).toEqual([]);
  });

  it('still reports a workflow filename that exists nowhere', () => {
    expect(titles('`nightly-release.yml` publishes the nightly build.')).toEqual([
      'Broken file reference: nightly-release.yml',
    ]);
  });

  it('still reports a name that exists only under a dependency directory', () => {
    expect(titles('See `vendored.yml`.')).toEqual(['Broken file reference: vendored.yml']);
  });

  it('still reports a name that exists only under a gitignored path', () => {
    expect(titles('See `only-local.yml`.')).toEqual(['Broken file reference: only-local.yml']);
  });

  it('resolves a bare name with a :line suffix', () => {
    expect(titles('The test job is at `deploy_pr.yml:12`.')).toEqual([]);
  });

  it('keeps checking an explicit ./name exactly', () => {
    expect(titles('See `./deploy_pr.yml`.')).toEqual(['Broken file reference: deploy_pr.yml']);
  });

  it('matches the name exactly, including case', () => {
    expect(titles('See `Deploy_PR.yml`.')).toEqual(['Broken file reference: Deploy_PR.yml']);
  });

  it('keeps resolving markdown links and @-refs relative to the instruction file', () => {
    expect(titles('See [the workflow](deploy_pr.yml) and @verify-release.mjs.')).toEqual([
      'Broken file reference: deploy_pr.yml',
      'Broken file reference: verify-release.mjs',
    ]);
  });

  it('keeps checking a code span with a directory exactly', () => {
    expect(titles('See `workflows/deploy_pr.yml`.')).toEqual(['Broken file reference: deploy_pr.yml']);
  });
});

describe('paths that match this repository only on their first segment', () => {
  it('does not flag another project\'s deep layout under a shared top-level name', () => {
    const content =
      'Read the Java backend in its own repository. Start in `src/main/java/edu/example/backend/api/`.';
    expect(titles(content)).toEqual([]);
  });

  it('does not flag a deep source file from another project', () => {
    expect(titles('See `src/panels/lovelace/strategies/original-strategy.ts`.')).toEqual([]);
  });

  it('still flags a missing path at most two levels below the lone anchor', () => {
    expect(titles('Removed: `src/payments/` and `src/legacy/auth/`.')).toEqual([
      'Broken directory reference: auth/',
      'Broken directory reference: payments/',
    ]);
  });

  it('stops at three levels below a lone anchor', () => {
    expect(titles('See `src/gone/b/c/`.')).toEqual([]);
  });

  it('checks three levels below the anchor when the second segment is a directory', () => {
    expect(titles('See `src/kept/b/c/`.')).toEqual(['Broken directory reference: c/']);
  });

  it('does not take a file as the second segment\'s directory', () => {
    expect(titles('See `src/notes.txt/a/b/c/`.')).toEqual([]);
  });

  it('still flags a deep missing path whose second segment exists', () => {
    expect(titles('Old handlers: `src/api/v1/handlers/legacy/`.')).toEqual([
      'Broken directory reference: legacy/',
    ]);
  });
});

describe('brace alternation', () => {
  it('treats `{de,en,ru}.json` as a pattern, not a path', () => {
    expect(titles('Add keys in `translations/{de,en,ru}.json` and `docs/{a,b}.md`.')).toEqual([]);
  });

  it('still checks the same directory written as a single path', () => {
    expect(titles('Add keys in `translations/fr.json`.')).toEqual(['Broken file reference: fr.json']);
  });
});

describe('fixture-dead-ref-resolution', () => {
  it('reports only the genuinely missing references and keeps the npm script finding', async () => {
    const report = await scan({ repoPath: FIXTURE, projectType: 'typescript' });
    const refs = report.issues
      .filter((i) => i.category === 'structure' && i.title.startsWith('Broken '))
      .map((i) => i.title)
      .sort();
    expect(refs).toEqual([
      'Broken directory reference: payments/',
      'Broken file reference: nightly-release.yml',
    ]);

    const commands = report.issues.filter((i) => i.category === 'command_validity').map((i) => i.title);
    expect(commands).toEqual(['Possible reference to missing command or file: `npm run dev`']);
  });
});
