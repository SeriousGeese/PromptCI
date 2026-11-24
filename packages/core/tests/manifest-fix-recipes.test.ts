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
    ['an ancestor legacy section', '## Legacy workflow\n\n### Build\n\n- `npm run dev`'],
    ['a line that would still name npm', 'Run `npm install && npm test`.'],
    ['a cd into another directory', 'Run `cd site && npm run build`.'],
    ['a link', 'See [`npm run build`](docs/build.md).'],
    ['consumer instructions', 'To use this library in your own project, run `npm install`.'],
    ['instructions for end users', 'End users run `npm install` once.'],
    ['a directory named on the line', 'Inside `website/`, run `npm install`.'],
    ['a (cd dir) on the line', 'In the docs folder (cd docs), run npm install.'],
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
    ['an ancestor heading about support ranges', '## Supported runtimes\n\n### Server\n\n- Requires Node 18+'],
    ["a dependency's own requirement", 'Next.js 14 requires Node 18+'],
    ['an SDK that needs it', 'Expo SDK 50 needs Node 18'],
    ['a named package that requires it', 'Package `foo` requires Node 18+'],
    ['a product label before a requirement verb', '- Storybook: requires Node 18'],
    ['a product label with a plus', 'Supabase CLI: requires Node 18+'],
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
    ['a pairing with another versioned library', 'Use React Native 0.72 with React 17.'],
    ['a cue only on the line above', 'Use the following.\n\nReact 17'],
    ['a cue in an earlier sentence on the line', 'Use the following. React 17'],
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

    for (const body of ['Target Python 3.9.7 for all code.', 'Python 3.9 introduced the union operator for dicts.', 'Keep Python 3.9 shims.', 'Django 4.2 requires Python 3.9+', '- Django: requires Python 3.9+']) {
      const advisory = repoWith({ 'pyproject.toml': pyproject, 'CLAUDE.md': `# Repo\n\n${body}\n` });
      expectAdvisory(await finding(advisory, (i) => i.title.startsWith('Python version mismatch')));
    }

  });

  it('rewrites a declared Python library major (Pandas 1.x to Pandas 2.x)', async () => {
    const repo = repoWith({
      'pyproject.toml': '[tool.poetry.dependencies]\npython = "^3.11"\npandas = "^2.1"\n',
      'CLAUDE.md': '# Repo\n\nTarget library: Pandas 1.x\n',
    });
    const issue = await finding(repo, (i) => i.title.startsWith('Pandas version mismatch'));
    expect(await applied(repo, issue)).toBe('# Repo\n\nTarget library: Pandas 2.x\n');
  });
});

describe('the manifest version a rewrite writes (pcic-1ik0.24)', () => {
  const isTitled = (prefix: string) => (i: PromptCiIssue) => i.title.startsWith(prefix);

  it('reads devDependencies over a peer range: the finding stays, the rewrite is refused when they disagree', async () => {
    // A component library: installs React 19 to develop, supports 18 and 19.
    const packageJson = JSON.stringify({
      name: '@acme/ui',
      version: '2.3.0',
      peerDependencies: { react: '^18.0.0 || ^19.0.0', 'react-dom': '^18.0.0 || ^19.0.0' },
      devDependencies: { react: '^19.1.0', 'react-dom': '^19.1.0', typescript: '^5.8.3' },
    });
    const repo = repoWith({ 'package.json': packageJson, 'CLAUDE.md': '# UI\n\nUse this stack for new features:\n\n- **Framework:** React 17\n' });
    const issue = await finding(repo, isTitled('React version mismatch'));
    expect(issue.title).toBe('React version mismatch: instruction says 17.x, package.json uses 19.x');
    expectAdvisory(issue);

    const supported = repoWith({ 'package.json': packageJson, 'CLAUDE.md': '# UI\n\nComponents must support React 18.\n' });
    expect((await scan({ repoPath: supported })).issues.some(isTitled('React version mismatch'))).toBe(false);
  });

  it('still rewrites when the installed version and the peer range agree', async () => {
    const repo = repoWith({
      'package.json': JSON.stringify({ name: 'x', peerDependencies: { vite: '^8.0.0' }, devDependencies: { vite: '^8.1.0' } }),
      'CLAUDE.md': '# Repo\n\nWe use Vite 6.x\n',
    });
    expect(await applied(repo, await finding(repo, isTitled('Vite version mismatch')))).toBe('# Repo\n\nWe use Vite 8.x\n');
  });

  it('reads the main dependency over a Poetry group pin, and refuses the rewrite they disagree on', async () => {
    const pyproject = [
      '[project]',
      'name = "shop"',
      'version = "0.4.0"',
      'requires-python = ">=3.11"',
      'dependencies = [',
      '    "django>=5.0,<6",',
      '    "psycopg[binary]>=3.1",',
      ']',
      '',
      '[tool.poetry.group.lts.dependencies]',
      'django = "^4.2"',
      '',
    ].join('\n');
    const repo = repoWith({ 'pyproject.toml': pyproject, 'CLAUDE.md': '# Shop\n\nTarget library: Django 3.x\n' });
    const issue = await finding(repo, isTitled('Django version mismatch'));
    expect(issue.title).toBe('Django version mismatch: instruction says 3.x, pyproject.toml uses 5.x');
    expectAdvisory(issue);

    // Between the two: the group pin is not the project's version, so 4.x is stale too.
    const between = repoWith({ 'pyproject.toml': pyproject, 'CLAUDE.md': '# Shop\n\nTarget library: Django 4.x\n' });
    expectAdvisory(await finding(between, isTitled('Django version mismatch')));
  });

  it('reads an optional-dependencies entry as a claim, not as the version to write', async () => {
    const pyproject = [
      '[project]',
      'name = "toolkit"',
      'requires-python = ">=3.10"',
      'dependencies = ["httpx>=0.27"]',
      '',
      '[project.optional-dependencies]',
      'django = ["django>=4.2"]',
      '',
    ].join('\n');
    const repo = repoWith({ 'pyproject.toml': pyproject, 'CLAUDE.md': '# Toolkit\n\nTarget library: Django 3.x\n' });
    expectAdvisory(await finding(repo, isTitled('Django version mismatch')));

    // The same line is rewritten once the main dependency declares it.
    const main = repoWith({
      'pyproject.toml': pyproject.replace('dependencies = ["httpx>=0.27"]', 'dependencies = ["httpx>=0.27", "django>=4.2"]'),
      'CLAUDE.md': '# Toolkit\n\nTarget library: Django 3.x\n',
    });
    expect(await applied(main, await finding(main, isTitled('Django version mismatch')))).toBe('# Toolkit\n\nTarget library: Django 4.x\n');
  });

  it('reads requires-python ">3.8" as excluding 3.8: both 3.7 and 3.8 are flagged, neither is rewritten', async () => {
    const pyproject = '[project]\nname = "x"\nversion = "1.0.0"\nrequires-python = ">3.8"\ndependencies = []\n';
    for (const [mention, title] of [
      ['3.7', 'Python version mismatch: instruction says 3.7, pyproject.toml requires >3.8'],
      ['3.8', 'Python version mismatch: instruction says 3.8, pyproject.toml requires >3.8'],
    ]) {
      const repo = repoWith({ 'pyproject.toml': pyproject, 'CLAUDE.md': `# Repo\n\n- Runtime: Python ${mention}\n` });
      const issue = await finding(repo, isTitled('Python version mismatch'));
      expect(issue.title).toBe(title);
      expectAdvisory(issue);
    }
  });

  it('refuses the Python rewrite when requires-python and Poetry\'s python constraint disagree', async () => {
    const pyproject = [
      '[project]',
      'name = "x"',
      'requires-python = ">=3.9"',
      '',
      '[tool.poetry.dependencies]',
      'python = "^3.10"',
      '',
    ].join('\n');
    for (const mention of ['3.8', '3.9']) {
      // 3.9 is allowed by requires-python but not by Poetry, which also enforces its constraint.
      const repo = repoWith({ 'pyproject.toml': pyproject, 'CLAUDE.md': `# Repo\n\n- Runtime: Python ${mention}\n` });
      const issue = await finding(repo, isTitled('Python version mismatch'));
      expect(issue.title).toBe(`Python version mismatch: instruction says ${mention}, pyproject.toml requires ≥3.10`);
      expectAdvisory(issue);
    }
  });

  it('reads a requires-python whose upper bound comes first', async () => {
    const repo = repoWith({
      'pyproject.toml': '[project]\nname = "x"\nrequires-python = "<4,>=3.10"\n',
      'CLAUDE.md': '# Repo\n\n- Runtime: Python 3.8\n',
    });
    expect(await applied(repo, await finding(repo, isTitled('Python version mismatch')))).toBe('# Repo\n\n- Runtime: Python 3.10\n');
  });

  it('floors engines.node alternatives at the lowest: Node 18 is supported, Node 16 is flagged without a rewrite', async () => {
    const packageJson = JSON.stringify({ name: 'x', engines: { node: '^18.18.0 || ^20.9.0 || >=21.1.0' } });
    const supported = repoWith({ 'package.json': packageJson, 'CLAUDE.md': '# Repo\n\nRequires Node.js 18+.\n' });
    expect((await scan({ repoPath: supported })).issues.some(isNode)).toBe(false);

    const old = repoWith({ 'package.json': packageJson, 'CLAUDE.md': '# Repo\n\nRequires Node.js 16+.\n' });
    const issue = await finding(old, isNode);
    expect(issue.title).toBe('Node.js version mismatch: instruction says 16, project requires ≥18');
    expectAdvisory(issue);
  });

  it('reads engines.node ">18" as excluding 18, with no rewrite', async () => {
    const repo = repoWith({
      'package.json': JSON.stringify({ name: 'x', engines: { node: '>18' } }),
      'CLAUDE.md': '# Repo\n\nRequires Node.js 18+.\n',
    });
    const issue = await finding(repo, isNode);
    expect(issue.title).toBe('Node.js version mismatch: instruction says 18, project requires >18');
    expectAdvisory(issue);
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

describe('the version-reading fixture (pcic-1ik0.24)', () => {
  it('flags each version a disagreeing manifest excludes, rewrites none, and leaves the supported Node.js line clean', async () => {
    const repo = makeTempRepo('promptci-manifest-reading-');
    tempRepos.push(repo);
    fs.cpSync(path.resolve(FIXTURE, '../fixture-manifest-version-reading'), repo, { recursive: true });
    const issues = (await scan({ repoPath: repo })).issues;
    const versions = issues.filter((i) => / version mismatch: /.test(i.title));
    expect(versions.map((i) => i.title).sort()).toEqual([
      'Django version mismatch: instruction says 3.x, pyproject.toml uses 4.x',
      'Python version mismatch: instruction says 3.8, pyproject.toml requires >3.8',
      'React version mismatch: instruction says 17.x, package.json uses 19.x',
    ]);
    for (const issue of versions) expectAdvisory(issue);
    expect(issues.some(isNode)).toBe(false);
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
