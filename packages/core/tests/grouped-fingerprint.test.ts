/**
 * pcic-1ik0.3 follow-up: the two grouped findings (one agent-practice finding
 * per repository, one action-pin finding per workflow file) list their members
 * in the evidence. Their baseline/SARIF fingerprint must not move when that
 * list does, or pinning one action or adding one rule reads as "resolved +
 * new" and fails `--fail-on-new` / `review-diff --fail-on-regression`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../src/scan.js';
import { computeFingerprint, createBaseline, filterNewIssues } from '../src/baseline.js';
import { isScored } from '../src/health-score.js';
import type { PromptCiIssue } from '../src/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRIGGER = path.resolve(__dirname, '../../../examples/fixture-grouped-findings');
const CLEAN = path.resolve(__dirname, '../../../examples/fixture-grouped-findings-clean');
const SHA = '0123456789abcdef0123456789abcdef01234567';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

function repoFrom(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-grouped-'));
  roots.push(root);
  write(root, files);
  return root;
}

function write(root: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
}

const workflow = (...uses: string[]) =>
  ['jobs:', '  t:', '    runs-on: ubuntu-latest', '    steps:', ...uses.map((u) => `      - uses: ${u}`)].join('\n') + '\n';

const grouped = (issues: PromptCiIssue[]) =>
  issues.filter((i) => i.id.startsWith('action-pin-') || i.id.startsWith('agent-practice-'));

/** Scan, change the repo, scan again: what `--fail-on-new` would see as new. */
async function newAfter(root: string, change: Record<string, string>): Promise<PromptCiIssue[]> {
  const before = await scan({ repoPath: root });
  const baseline = createBaseline(before.issues, root);
  write(root, change);
  const after = await scan({ repoPath: root });
  return filterNewIssues(after.issues, baseline, root).newIssues;
}

describe('grouped findings keep their fingerprint when their list changes', () => {
  it('pinning one of several actions in a workflow is not a new finding', async () => {
    const root = repoFrom({ 'AGENTS.md': '# Rules\n', '.github/workflows/ci.yml': workflow('a/one@v1', 'b/two@v2') });
    const fresh = await newAfter(root, { '.github/workflows/ci.yml': workflow(`a/one@${SHA}`, 'b/two@v2') });
    expect(grouped(fresh)).toEqual([]);
  });

  it('adding one practice sentence is not a new finding', async () => {
    const root = repoFrom({ 'AGENTS.md': '# Rules\nUse TypeScript.\n' });
    const fresh = await newAfter(root, { 'AGENTS.md': '# Rules\nUse TypeScript.\nIf you are unsure, ask before proceeding.\n' });
    expect(grouped(fresh)).toEqual([]);
  });

  it('adding a second instruction file is not a new agent-practice finding', async () => {
    const root = repoFrom({ 'AGENTS.md': '# Rules\nUse TypeScript.\n' });
    const fresh = await newAfter(root, { 'CLAUDE.md': '# More rules\nWrite tests.\n' });
    expect((await scan({ repoPath: root })).filesScanned).toHaveLength(2);
    expect(fresh.filter((i) => i.id.startsWith('agent-practice-'))).toEqual([]);
  });

  it('a grouped finding that grows (one more unpinned action) is not new either: it is info and unscored', async () => {
    const root = repoFrom({ 'AGENTS.md': '# Rules\n', '.github/workflows/ci.yml': workflow('a/one@v1') });
    const fresh = await newAfter(root, { '.github/workflows/ci.yml': workflow('a/one@v1', 'c/three@v3') });
    expect(grouped(fresh)).toEqual([]);
    const report = await scan({ repoPath: root });
    const pin = report.issues.find((i) => i.id.startsWith('action-pin-'))!;
    expect(pin.severity).toBe('info');
    expect(isScored(pin)).toBe(false);
  });

  it('a workflow that gains its first unpinned action IS a new finding', async () => {
    const root = repoFrom({ 'AGENTS.md': '# Rules\n', '.github/workflows/ci.yml': workflow(`a/one@${SHA}`) });
    const fresh = await newAfter(root, { '.github/workflows/release.yml': workflow('a/one@v1') });
    expect(grouped(fresh).map((i) => i.title)).toEqual([
      'GitHub Actions in `.github/workflows/release.yml` are not pinned to a commit SHA',
    ]);
  });

  it('keys each workflow file separately', async () => {
    const root = repoFrom({ '.github/workflows/a.yml': workflow('x/y@v1'), '.github/workflows/b.yml': workflow('x/y@v1') });
    const pins = (await scan({ repoPath: root })).issues.filter((i) => i.id.startsWith('action-pin-'));
    expect(pins.map((i) => i.fingerprintKey)).toEqual(['action-pin:.github/workflows/a.yml', 'action-pin:.github/workflows/b.yml']);
    expect(new Set(pins.map((i) => computeFingerprint(i, root))).size).toBe(2);
  });
});

describe('computeFingerprint for every other finding is unchanged', () => {
  it('still hashes category, title, sorted files and sorted evidence', () => {
    const issue = { category: 'duplicate', title: 'T', filePaths: ['b.md', 'a.md'], evidence: ['y', 'x'] };
    const expected = crypto.createHash('sha256').update(['duplicate', 'T', 'a.md', 'b.md', 'x', 'y'].join('|')).digest('hex');
    expect(computeFingerprint(issue)).toBe(expected);
  });

  it('a keyed fingerprint cannot be produced by a normal finding', () => {
    const keyed = computeFingerprint({ category: 'security', title: 'x', filePaths: [], evidence: [], fingerprintKey: 'k' });
    // The same parts joined the way the normal path joins them hash differently.
    const lookalike = computeFingerprint({ category: 'promptci-fingerprint-key/v1', title: 'security', filePaths: [], evidence: ['k'] });
    expect(keyed).not.toBe(lookalike);
    expect(keyed).toBe(
      crypto.createHash('sha256').update('promptci-fingerprint-key/v1\u0000security\u0000k').digest('hex'),
    );
  });

  it('only the two grouped families set fingerprintKey on the fixture corpus', async () => {
    const report = await scan({ repoPath: TRIGGER });
    const keyed = report.issues.filter((i) => i.fingerprintKey !== undefined).map((i) => i.id.replace(/-[0-9a-f]{12}$/, ''));
    expect([...new Set(keyed)].sort()).toEqual(['action-pin', 'agent-practice']);
  });
});

describe('fixture-grouped-findings and its clean twin', () => {
  it('the triggering fixture yields one finding per family, both info and unscored', async () => {
    const report = await scan({ repoPath: TRIGGER });
    const practice = report.issues.filter((i) => i.id.startsWith('agent-practice-'));
    const pins = report.issues.filter((i) => i.id.startsWith('action-pin-'));
    expect(practice).toHaveLength(1);
    expect(pins).toHaveLength(1);
    for (const issue of [...practice, ...pins]) {
      expect(issue.severity).toBe('info');
      expect(isScored(issue)).toBe(false);
    }
    // Each evidence line carries the line numbers of its ref, matching `locations`.
    expect(pins[0]!.evidence).toEqual([
      '.github/workflows/ci.yml:7: uses: actions/checkout@v4',
      '.github/workflows/ci.yml:9: uses: actions/setup-node@v4',
      '.github/workflows/ci.yml:8: uses: pnpm/action-setup@v4',
    ]);
    expect(pins[0]!.locations.map((l) => l.startLine)).toEqual([7, 8, 9]);
  });

  it('the clean twin yields neither', async () => {
    const report = await scan({ repoPath: CLEAN });
    expect(grouped(report.issues)).toEqual([]);
  });
});

describe('action-pin summary length', () => {
  it('names at most ten refs in the summary and lists every one in the evidence', async () => {
    const refs = Array.from({ length: 12 }, (_, i) => `org/action-${String(i).padStart(2, '0')}@v1`);
    const root = repoFrom({ '.github/workflows/ci.yml': workflow(...refs) });
    const [pin] = (await scan({ repoPath: root })).issues.filter((i) => i.id.startsWith('action-pin-'));
    expect(pin!.summary).toContain('`org/action-09@v1` and 2 more (see the evidence)');
    expect(pin!.summary).not.toContain('org/action-10@v1');
    expect(pin!.evidence).toHaveLength(12);
  });
});
