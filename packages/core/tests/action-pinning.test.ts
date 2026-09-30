import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectActionPinning, extractActionUses, unpinnedUse } from '../src/action-pinning.js';
import { buildRepoContext } from '../src/repo-context.js';
import { scan } from '../src/scan.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, '../../../examples/fixture-agent-formats');
const SHA = '0123456789abcdef0123456789abcdef01234567';

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
});

describe('unpinnedUse', () => {
  const u = (ref: string) => unpinnedUse({ ref, line: 1 });

  it('flags tags and branches', () => {
    expect(u('actions/checkout@v4')?.version).toBe('v4');
    expect(u('owner/repo/sub/path@release/1.x')?.action).toBe('owner/repo/sub/path');
    expect(u('owner/repo@main')?.owner).toBe('owner');
  });

  it('accepts full 40-hex (and 64-hex) SHAs, not abbreviated ones', () => {
    expect(u(`actions/checkout@${SHA}`)).toBeUndefined();
    expect(u(`actions/checkout@${SHA}${SHA.slice(0, 24)}`)).toBeUndefined();
    expect(u('actions/checkout@0123456')).toBeDefined();
  });

  it('exempts local, docker and expression refs and ignores malformed values', () => {
    expect(u('./.github/actions/setup')).toBeUndefined();
    expect(u('docker://alpine:3.20')).toBeUndefined();
    expect(u('owner/repo@${{ matrix.ref }}')).toBeUndefined();
    expect(u('actions/checkout')).toBeUndefined();
    expect(u('not-a-ref@v1')).toBeUndefined();
  });
});

describe('detectActionPinning — fixture-agent-formats', () => {
  it('flags exactly the unpinned remote refs, one finding per ref', async () => {
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

describe('detectActionPinning — clean and excluded workflows', () => {
  let root: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-action-pin-'));
    const wf = path.join(root, '.github', 'workflows');
    fs.mkdirSync(wf, { recursive: true });
    fs.writeFileSync(
      path.join(wf, 'pinned.yml'),
      [
        'jobs:',
        '  t:',
        '    steps:',
        `      - uses: actions/checkout@${SHA} # v4`,
        '      - uses: ./.github/actions/local',
        '      - uses: docker://node:22',
      ].join('\n'),
    );
    fs.writeFileSync(path.join(wf, 'legacy.yml'), 'jobs:\n  t:\n    steps:\n      - uses: some/action@v1\n');
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('a fully pinned workflow stays clean', async () => {
    const context = await buildRepoContext({ repoPath: root, exclude: ['.github/workflows/legacy.yml'] });
    expect(detectActionPinning(context)).toEqual([]);
  });

  it('honors --exclude for workflow files', async () => {
    const all = detectActionPinning(await buildRepoContext({ repoPath: root }));
    expect(all.map((i) => i.title)).toEqual(['GitHub Action `some/action@v1` is not pinned to a commit SHA']);
  });

  it('returns nothing when there are no workflows', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-action-pin-none-'));
    try {
      expect(detectActionPinning(await buildRepoContext({ repoPath: empty }))).toEqual([]);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
