/**
 * pcic-2b6.8: directory / extension-less references and backticked source files.
 *
 * A code-span path is reported only when its FIRST segment exists in the repo
 * (so it demonstrably names part of this tree); markdown links are checked
 * directly. Output directories, gitignored paths, module specifiers and
 * abbreviated paths that exist deeper in the tree are never reported.
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
  '../../../examples/fixture-stale-paths',
);

let repo: string;

beforeAll(() => {
  repo = makeTempRepo('promptci-stale-dirs-');
  writeFile(repo, 'src/api/index.ts', 'export {};');
  writeFile(repo, 'src/lib/db.ts', 'export {};');
  writeFile(repo, 'apps/web/package.json', '{}');
  writeFile(repo, 'Assets/Scripts/Interfaces/IDamageable.cs', '');
  writeFile(repo, 'Scripts/tool.sh', '');
  writeFile(repo, 'docs/guide.md', '# Guide');
  writeFile(repo, '.gitignore', 'generated/\n/data/\n');
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

function file(content: string, rel = 'AGENTS.md', fileType: InstructionFile['fileType'] = 'agents'): InstructionFile {
  return {
    path: path.join(repo, rel),
    fileType,
    content,
    sections: [],
    lineCount: content.split('\n').length,
    charCount: content.length,
    estimatedTokens: Math.round(content.length / 4),
  };
}

function detect(content: string, rel?: string): PromptCiIssue[] {
  return detectDeadReferences([file(content, rel)], repo);
}

describe('directory references in code spans', () => {
  it('flags a missing directory whose first segment exists', () => {
    const issues = detect('Payments live in `src/payments/`.');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.title).toBe('Broken directory reference: payments/');
    expect(issues[0]!.confidence).toBe(0.6);
    expect(issues[0]!.summary).toContain('"src/payments/"');
  });

  it('flags a missing extension-less path', () => {
    const issues = detect('The admin app is `apps/admin`.');
    expect(issues.map((i) => i.title)).toEqual(['Broken path reference: admin']);
  });

  it('does not flag existing directories in any spelling', () => {
    expect(detect('See `src/api/`, `./src/api/`, `src/api` and `apps/web`.')).toEqual([]);
  });

  it('accepts an extension-less module path whose file exists (`src/lib/db` -> db.ts)', () => {
    expect(detect('Import from `src/lib/db`.')).toEqual([]);
  });

  it('accepts an abbreviated path that exists deeper in the tree', () => {
    // Root `Scripts/` exists, but the doc means `Assets/Scripts/Interfaces/`.
    expect(detect('Interfaces go in `Scripts/Interfaces/`.')).toEqual([]);
  });

  it.each([
    ['a GitHub slug', '`owner/repo`'],
    ['a git ref', '`origin/main`'],
    ['a scoped package', '`@acme/ui`'],
    ['another project\'s layout', '`pkg/registry/`'],
    ['a single segment', '`docs/`'],
    ['a bare ./dir', '`./scripts`'],
    ['a parent-relative path', '`../other/src/`'],
    ['a placeholder', '`src/<feature>/`'],
    ['a glob', '`src/*/handlers/`'],
    ['an output directory', '`src/dist/` and `apps/web/.next/cache`'],
    ['a gitignored directory', '`src/generated/client/`'],
    ['a .git path', '`.git/hooks/`'],
    ['a site route', '`/api/users/`'],
  ])('does not flag %s', (_label, span) => {
    expect(detect(`Reference: ${span}.`)).toEqual([]);
  });
});

describe('directory references in markdown links', () => {
  it('flags a link to a missing directory', () => {
    const issues = detect('See [the old API](./src/old-api/).');
    expect(issues.map((i) => i.title)).toEqual(['Broken directory reference: old-api/']);
    expect(issues[0]!.confidence).toBe(0.8);
  });

  it('flags a link to a missing extension-less file', () => {
    expect(detect('Read the [license](LICENSE).').map((i) => i.title)).toEqual(['Broken path reference: LICENSE']);
  });

  it('does not flag links to existing directories, site routes, or paths outside the repo', () => {
    expect(
      detect('[api](./src/api/) [docs](docs/) [pricing](/pricing) [issues](../../issues) [x](https://e.x/a/)'),
    ).toEqual([]);
  });

  it('reports a span and a link to the same missing directory once', () => {
    const issues = detect('Moved out of `src/payments/`; see [payments](./src/payments/).');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.confidence).toBe(0.6);
  });
});

describe('backticked source files', () => {
  it('flags a missing source file whose first segment exists', () => {
    const issues = detect('Billing is in `src/services/billing.ts`.');
    expect(issues.map((i) => i.title)).toEqual(['Broken file reference: billing.ts']);
    expect(issues[0]!.confidence).toBe(0.6);
  });

  it('does not flag an existing source file or one from another project', () => {
    expect(detect('See `src/lib/db.ts` and `internal/client/errors.go` and `Controller.cs`.')).toEqual([]);
  });

  it('does not flag a source file that exists deeper in the tree', () => {
    expect(detect('The contract is `Scripts/Interfaces/IDamageable.cs`.')).toEqual([]);
  });
});

describe('gitignore applies to every reference kind', () => {
  it('does not flag a missing file under a gitignored directory', () => {
    expect(detect('Cache: `data/cache/index.json`.')).toEqual([]);
  });
});

describe('fixture-stale-paths', () => {
  it('reports exactly the stale paths and make targets the fixture documents', async () => {
    const report = await scan({ repoPath: FIXTURE, projectType: 'typescript' });
    const refs = report.issues
      .filter((i) => i.category === 'structure' && i.title.startsWith('Broken '))
      .map((i) => i.title)
      .sort();
    expect(refs).toEqual([
      'Broken directory reference: old-api/',
      'Broken directory reference: payments/',
      'Broken file reference: billing.ts',
      'Broken path reference: admin',
    ]);

    const commands = report.issues
      .filter((i) => i.category === 'command_validity')
      .map((i) => i.summary)
      .sort();
    expect(commands).toEqual([
      'make target "deploy" does not appear in Makefile',
      'make target "release" does not appear in tools/Makefile',
    ]);
    // Nothing about the unknown-directory commands or the bare `./scripts` mention.
    expect(report.issues.some((i) => /bogus|missing\.js|"\.\/scripts"/.test(i.summary))).toBe(false);
  });
});
