/**
 * pcic-k1t3.12: line-anchored fix edits for the manifest-consistency findings
 * whose repair the manifest itself dictates: a package-manager mismatch, and a
 * Node.js, Python or library version older than the manifest's.
 *
 * Each recipe is all-or-nothing: a finding carries edits only when every
 * mention behind it is a plain swap. The applied output is asserted
 * byte-for-byte, and every case that needs a judgement call must stay advisory
 * (no `fixEdits`, no `autoApplySafe`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { scan } from '../src/scan.js';
import { applyFixRecipe, isRepairable, requiresOptIn } from '../src/fix-engine.js';
import { applyLineEditsToText } from '../src/line-edits.js';
import type { PromptCiIssue } from '../src/types.js';
import { makeTempRepo, writeFile } from './ai-config-helpers.js';

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../examples/fixture-manifest-fix-recipes',
);

const tempRepos: string[] = [];
afterEach(() => {
  for (const dir of tempRepos.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function repoWith(files: Record<string, string>): string {
  const repo = makeTempRepo('promptci-manifest-fix-');
  tempRepos.push(repo);
  for (const [rel, content] of Object.entries(files)) writeFile(repo, rel, content);
  return repo;
}

const PNPM_PACKAGE = JSON.stringify({
  name: 'x',
  private: true,
  packageManager: 'pnpm@9.15.0',
  scripts: { dev: 'vite', build: 'vite build', test: 'vitest run', 'dev:docs': 'vite docs' },
});

function pnpmRepo(claude: string, extra: Record<string, string> = {}): string {
  return repoWith({ 'package.json': PNPM_PACKAGE, 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n", 'CLAUDE.md': claude, ...extra });
}

async function finding(repo: string, match: (i: PromptCiIssue) => boolean): Promise<PromptCiIssue> {
  const issue = (await scan({ repoPath: repo })).issues.find(match);
  expect(issue).toBeDefined();
  return issue!;
}

const isPm = (i: PromptCiIssue) => i.id === 'manifest-package-manager-mismatch';
const isNode = (i: PromptCiIssue) => i.id.startsWith('manifest-node-version-mismatch:');

/** Applies the finding's recipe the way `promptci fix` does (no opt-in) and returns CLAUDE.md. */
async function applied(repo: string, issue: PromptCiIssue, rel = 'CLAUDE.md'): Promise<string> {
  expect(isRepairable(issue)).toBe(true);
  expect(requiresOptIn(issue)).toBe(false);
  for (const change of await applyFixRecipe(issue, repo)) fs.writeFileSync(change.filePath, change.newContent, 'utf-8');
  return fs.readFileSync(path.join(repo, rel), 'utf-8');
}

function expectAdvisory(issue: PromptCiIssue): void {
  expect(issue.fixEdits).toBeUndefined();
  expect(issue.autoApplySafe).toBeUndefined();
}

describe('package-manager mismatch recipe', () => {
  it('swaps a bare install and runs of defined scripts, prose and fenced, and the rescan no longer reports it', async () => {
    const repo = pnpmRepo(
      ['# Repo', '', 'Run `npm install`, then `npm run dev`.', '', '```bash', 'npm run build && npm run test', '```', ''].join('\n'),
    );
    const issue = await finding(repo, isPm);
    expect(issue.autoApplySafe).toBe(true);
    expect(await applied(repo, issue)).toBe(
      ['# Repo', '', 'Run `pnpm install`, then `pnpm run dev`.', '', '```bash', 'pnpm run build && pnpm run test', '```', ''].join('\n'),
    );
    expect((await scan({ repoPath: repo })).issues.some(isPm)).toBe(false);
  });

  it('keeps CRLF line endings and every other byte', async () => {
    const repo = pnpmRepo('# Repo\r\n\r\nRun `npm run build` first.\r\nThen deploy.');
    expect(await applied(repo, await finding(repo, isPm))).toBe('# Repo\r\n\r\nRun `pnpm run build` first.\r\nThen deploy.');
  });

  it('passes positional arguments through, and writes the manager the repository uses (yarn here)', async () => {
    const repo = repoWith({
      'package.json': JSON.stringify({ name: 'x', scripts: { tauri: 'tauri' } }),
      'yarn.lock': '',
      'CLAUDE.md': '# Repo\n\nStart it with `npm run tauri dev`.\n',
    });
    expect(await applied(repo, await finding(repo, isPm))).toBe('# Repo\n\nStart it with `yarn run tauri dev`.\n');
  });

  it.each([
    ['an install that names a package (consumer instructions)', 'Install it: `npm install eslint-plugin-x --save-dev`.'],
    ['an install with a flag', 'Run `npm install --legacy-peer-deps`.'],
    ['a script the repository does not define', 'Run `npm run deploy`.'],
    ['a flag after the script', 'Run `npm run dev -- --port 3000`.'],
    ['npm exec', 'Run `npm exec vite`.'],
    ['yarn add', 'Run `yarn add -D vite`.'],
    ['a placeholder', 'Run `npm run <script>`.'],
    ['a mention in an HTML comment', '<!-- npm run dev -->\nRun `pnpm run dev`.'],
    ['one swappable and one not', 'Run `npm run dev`, then `npm install left-pad`.'],
    ['a fallback', 'If pnpm is unavailable, fall back to `npm run build`.'],
    ['a line naming another manager', 'With pnpm missing, run `npm run build`.'],
    ['a Dockerfile in a fence', '```dockerfile\nRUN npm install\n```'],
    ['a fallback introduced on the line above a fence', 'If pnpm is not available, use npm:\n\n```bash\nnpm run build\n```'],
    ['a lead line naming another manager', 'On CI runners without pnpm:\n\n`npm run build`'],
    ['a section about the other manager', '## Using npm\n\n```bash\nnpm install\nnpm run build\n```'],
    ['a legacy section', '## Legacy workflow\n\n- `npm run dev`'],
    ['a fallback two paragraphs up', 'On machines where pnpm cannot be installed, build with npm.\n\nThen:\n\n```bash\nnpm run build\n```'],
    ['a find that is not unique on its line', 'Run `npm run dev` or `npm run dev:docs`.'],
  ])('stays advisory for %s', async (_label, line) => {
    const issue = await finding(pnpmRepo(`# Repo\n\n${line}\n`), isPm);
    expectAdvisory(issue);
  });
});

describe('Node.js version recipe', () => {
  const nodeRepo = (claude: string) =>
    repoWith({ 'package.json': JSON.stringify({ name: 'x', engines: { node: '>=22' } }), 'CLAUDE.md': claude });

  it('rewrites every flagged mention of the version in the file', async () => {
    const repo = nodeRepo('# Repo\n\nRequires Node.js 18+.\n\n- CI runtime: Node 18\n');
    const issue = await finding(repo, isNode);
    expect(issue.fixEdits).toHaveLength(2);
    expect(await applied(repo, issue)).toBe('# Repo\n\nRequires Node.js 22+.\n\n- CI runtime: Node 22\n');
    expect((await scan({ repoPath: repo })).issues.some(isNode)).toBe(false);
  });

  it.each([
    ['a range', 'Supported: Node 18 or 20.'],
    ['a dash range', 'Supported: Node 16-18.'],
    ['a more precise version', 'Use Node 18.17 exactly.'],
    ['history wording', 'We dropped Node 16 last year.'],
    ['two mentions on one line', 'Node 18 locally, Node 20 in CI.'],
    ['a fenced block', '```\n$ node --version\nNode 18\n```'],
    ['an indented code block', 'Output:\n\n    Node 18'],
    ['one clean mention and one in a range', 'Requires Node 18.\n\nRuns on Node 18 and 20.'],
    ['a fact about that release', 'Node 18 added native fetch, so no polyfill is needed.'],
    ['a "Node" that is not Node.js', 'Cluster Node 2 is the leader.'],
    ['a link label whose URL names the version', 'See [Node 18 docs](https://nodejs.org/docs/latest-v18.x/api/).'],
    ['a suffix after the number', 'Requires a Node 18-compatible runtime.'],
    ['a bare number ending a sentence', 'The leader is Node 2.'],
    ['a heading about support ranges', '## Supported runtimes\n\n- Requires Node 18+'],
    ['a history heading', '## History\n\nRequires Node.js 18+.'],
  ])('stays advisory for %s', async (_label, body) => {
    expectAdvisory(await finding(nodeRepo(`# Repo\n\n${body}\n`), isNode));
  });
});

describe('library and Python version recipes', () => {
  it('rewrites a declared library major (Vite 6 to Vite 8)', async () => {
    const repo = repoWith({
      'package.json': JSON.stringify({ name: 'x', devDependencies: { vite: '^8.1.0' } }),
      'CLAUDE.md': '# Repo\n\nUse this stack for new features:\n\n- **Build tool:** Vite 6\n',
    });
    const issue = await finding(repo, (i) => i.title.startsWith('Vite version mismatch'));
    expect(await applied(repo, issue)).toBe('# Repo\n\nUse this stack for new features:\n\n- **Build tool:** Vite 8\n');
  });

  it('keeps the ".x" of a declared major (Vite 6.x to Vite 8.x)', async () => {
    const repo = repoWith({
      'package.json': JSON.stringify({ name: 'x', devDependencies: { vite: '^8.1.0' } }),
      'CLAUDE.md': '# Repo\n\nWe use Vite 6.x\n',
    });
    const issue = await finding(repo, (i) => i.title.startsWith('Vite version mismatch'));
    expect(await applied(repo, issue)).toBe('# Repo\n\nWe use Vite 8.x\n');
  });

  it.each([
    ['guidance about the old major', 'Use React 17 lifecycle methods in class components.'],
    ['a numeric minor', 'Use React 17.0 for the build.'],
    ['a published support range', 'Supports React 17+.'],
    ['a compatibility heading', '## Compatibility\n\nUse React 17'],
    ['the tail of another package name', 'Use @vitejs/plugin-react 4.'],
  ])('leaves a library mention advisory for %s', async (_label, body) => {
    const repo = repoWith({
      'package.json': JSON.stringify({ name: 'x', dependencies: { react: '^19.0.0' } }),
      'CLAUDE.md': `# Repo\n\n${body}\n`,
    });
    expectAdvisory(await finding(repo, (i) => i.title.startsWith('React version mismatch')));
  });

  it('rewrites a declared Python version to the pyproject.toml minimum, and leaves a patch version, a fact and history advisory', async () => {
    const pyproject = '[project]\nname = "x"\nrequires-python = ">=3.11"\n';
    const repo = repoWith({ 'pyproject.toml': pyproject, 'CLAUDE.md': '# Repo\n\n- Runtime: Python 3.9\n' });
    const issue = await finding(repo, (i) => i.title.startsWith('Python version mismatch'));
    expect(await applied(repo, issue)).toBe('# Repo\n\n- Runtime: Python 3.11\n');

    for (const body of ['Target Python 3.9.7 for all code.', 'Python 3.9 introduced the union operator for dicts.', 'Keep Python 3.9 shims.']) {
      const advisory = repoWith({ 'pyproject.toml': pyproject, 'CLAUDE.md': `# Repo\n\n${body}\n` });
      expectAdvisory(await finding(advisory, (i) => i.title.startsWith('Python version mismatch')));
    }

  });

  it('rewrites a declared Python library major (Pandas 1.x to Pandas 2.x)', async () => {
    const repo = repoWith({
      'pyproject.toml': '[tool.poetry.dependencies]\npython = "^3.11"\npandas = "^2.1"\n',
      'CLAUDE.md': '# Repo\n\nTarget dataframe library: Pandas 1.x\n',
    });
    const issue = await finding(repo, (i) => i.title.startsWith('Pandas version mismatch'));
    expect(await applied(repo, issue)).toBe('# Repo\n\nTarget dataframe library: Pandas 2.x\n');
  });
});

describe('the fixture', () => {
  it('carries edits on all three findings, and fixing them all clears them', async () => {
    const repo = makeTempRepo('promptci-manifest-fixture-');
    tempRepos.push(repo);
    fs.cpSync(FIXTURE, repo, { recursive: true });
    const before = (await scan({ repoPath: repo })).issues;
    const targets = before.filter((i) => i.fixEdits !== undefined && i.autoApplySafe === true);
    expect(targets.map((i) => i.title).sort()).toEqual([
      'Node.js version mismatch: instruction says 18, project requires ≥22',
      'Possible package manager mismatch: instructions use alternatives to pnpm',
      'Vite version mismatch: instruction says 6.x, package.json uses 8.x',
    ]);
    for (const issue of targets) await applied(repo, issue);
    const after = (await scan({ repoPath: repo })).issues;
    for (const t of targets) expect(after.some((i) => i.id === t.id)).toBe(false);
  });
});

describe('applyLineEditsToText', () => {
  it('refuses the whole list when one edit does not apply, and splices replacement text literally', () => {
    expect(applyLineEditsToText('a b\nc\n', [{ line: 1, find: 'b', replace: '$&$1' }])).toBe('a $&$1\nc\n');
    expect(applyLineEditsToText('a b\nc\n', [{ line: 1, find: 'b', replace: 'x' }, { line: 2, find: 'z', replace: 'y' }])).toBeUndefined();
    expect(applyLineEditsToText('a a\n', [{ line: 1, find: 'a', replace: 'b' }])).toBeUndefined();
    expect(applyLineEditsToText('a\n', [{ line: 3, find: 'a', replace: 'b' }])).toBeUndefined();
  });
});
