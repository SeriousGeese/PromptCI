import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../src/scan.js';
import { parseSections } from '../src/scanner.js';
import { detectVagueGuidance } from '../src/vague-guidance.js';
import { fileIdPath, sectionIdPath } from '../src/finding-id.js';
import type { InstructionFile } from '../src/types.js';

/**
 * pcic-whm: finding ids must not depend on where the repo is checked out.
 *
 * Ids used to hash the ABSOLUTE file path (e.g. vague-guidance's
 * sha1(`<abs path>:<line>:vague`)), so the same unchanged file scanned from
 * two directories — a PR's base and head worktrees, two CI runners, two temp
 * dirs — produced different ids, and every id-keyed comparison saw an
 * unchanged finding as new.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES = path.resolve(__dirname, '../../../examples');

function copyFixture(src: string, dest: string): void {
  fs.cpSync(src, dest, {
    recursive: true,
    // Generated scan output left behind by other tests is not fixture content.
    filter: (p) => !p.split(path.sep).includes('.promptci'),
  });
}

async function ids(repoPath: string): Promise<string[]> {
  const report = await scan({ repoPath });
  return [...report.issues, ...(report.suppressedIssues ?? [])].map((i) => i.id).sort();
}

describe('id path normalization', () => {
  function file(relativePath: string, abs: string): InstructionFile {
    const content = '# Style\n\nWrite clean code and follow best practices.\n';
    const sections = parseSections(content, abs, relativePath);
    return {
      path: abs,
      relativePath,
      fileType: 'claude',
      content,
      sections,
      lineCount: 3,
      charCount: content.length,
      estimatedTokens: Math.round(content.length / 4),
    };
  }

  it('hashes backslash and forward-slash relative paths identically', () => {
    expect(fileIdPath({ path: 'C:\\repo\\docs\\CLAUDE.md', relativePath: 'docs\\CLAUDE.md' })).toBe('docs/CLAUDE.md');
    expect(sectionIdPath({ filePath: '/repo/docs/CLAUDE.md', relativePath: './docs/CLAUDE.md' })).toBe('docs/CLAUDE.md');

    const windows = detectVagueGuidance([file('docs\\CLAUDE.md', 'C:\\a\\docs\\CLAUDE.md')]);
    const posix = detectVagueGuidance([file('docs/CLAUDE.md', '/b/docs/CLAUDE.md')]);
    expect(windows.length).toBeGreaterThan(0);
    expect(windows.map((i) => i.id)).toEqual(posix.map((i) => i.id));
  });
});

describe('finding ids are independent of the checkout location', () => {
  let tmp: string;
  const fixtures = fs
    .readdirSync(EXAMPLES, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-stable-ids-'));
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('has fixtures to compare', () => {
    expect(fixtures.length).toBeGreaterThan(3);
  });

  for (const name of fixtures) {
    it(`${name}: two copies in different directories yield identical ids`, async () => {
      // Different depths and names, so no shared absolute prefix can mask a leak.
      const a = path.join(tmp, 'a', name);
      const b = path.join(tmp, 'b', 'nested', 'deeper', `${name}-copy`);
      copyFixture(path.join(EXAMPLES, name), a);
      copyFixture(path.join(EXAMPLES, name), b);

      const idsA = await ids(a);
      const idsB = await ids(b);
      expect(idsB).toEqual(idsA);
      // No id may embed a checkout path in clear text either.
      for (const id of idsA) {
        expect(id).not.toContain(tmp);
        expect(id).not.toContain(tmp.replace(/\\/g, '/'));
      }
    });
  }

  it('covers vague-guidance ids, the originally reported case', async () => {
    const all: string[] = [];
    for (const name of fixtures) {
      const dest = path.join(tmp, 'vague', name);
      copyFixture(path.join(EXAMPLES, name), dest);
      all.push(...(await ids(dest)));
    }
    expect(all.some((id) => id.startsWith('vague-'))).toBe(true);
  });

  it('path-keyed detectors across many categories stay stable', async () => {
    // A repo built to trip several per-file detectors at once: vague guidance,
    // stale years, duplicates, conflicts, prompt-cache, dead references,
    // missing scripts, and an invalid suppression annotation.
    const repo = (root: string) => {
      const write = (p: string, body: string) => {
        fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
        fs.writeFileSync(path.join(root, p), body);
      };
      const shared = '## Testing\n\nRun `npm test` before committing. Keep tests fast and isolated.\n';
      write('package.json', JSON.stringify({ scripts: { test: 'vitest' } }));
      write(
        'CLAUDE.md',
        [
          '# Claude',
          '',
          '## Style',
          '',
          'Write clean code and follow best practices.',
          'Always use tabs for indentation.',
          '',
          shared,
          '## Notes',
          '',
          'Last updated: 2019-01-01 10:00:00. See `docs/missing.md` and run `npm run deploy-all`.',
          '<!-- promptci-ignore: not_a_category -->',
        ].join('\n'),
      );
      write(
        'AGENTS.md',
        ['# Agents', '', '## Style', '', 'Never use tabs for indentation.', '', shared].join('\n'),
      );
      write('GEMINI.md', '# Gemini\n\nBe careful and write good code.\n');
    };
    const a = path.join(tmp, 'multi-a');
    const b = path.join(tmp, 'x', 'y', 'multi-b');
    repo(a);
    repo(b);

    const idsA = await ids(a);
    expect(idsA.length).toBeGreaterThan(5);
    expect(await ids(b)).toEqual(idsA);
  });
});
