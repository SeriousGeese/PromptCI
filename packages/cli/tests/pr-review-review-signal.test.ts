import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * pcic-lb52: auto-merge waits for an explicit review signal on PRs that change
 * the scanner or a fix recipe (`packages/core/src/`, `packages/cli/src/`).
 *
 * On 2026-11-14 four such PRs merged on green CI 10 to 20 minutes after they
 * opened, before any second-pass review, and all four needed follow-up fixes.
 * The signal is the `reviewed` label (removed on every push) or an APPROVED
 * review whose commit is the head. Two merge paths are gated:
 *  1. scripts/pr-review.sh `merge_pr` (the review bot), via `review_signal_status`;
 *  2. .github/workflows/auto-merge.yml (`automerge`-labelled PRs), whose jobs'
 *     own `run:` blocks are executed here against a fake gh.
 * Docs-only and dependency PRs are unchanged on both paths.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'pr-review.sh'), 'utf-8');
const autoMerge = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'auto-merge.yml'), 'utf-8');
const p = (s: string) => s.replace(/\\/g, '/');

const HEAD = 'c0ffee0000000000000000000000000000000000';

type Pr = {
  files: string[];
  changedFiles?: number;
  labels?: string[];
  reviews?: Array<{ state: string; oid: string; assoc?: string }>;
  autoMerge?: boolean;
};

function prJson(pr: Pr): string {
  return JSON.stringify({
    files: pr.files.map((f) => ({ path: f, additions: 1, deletions: 0 })),
    changedFiles: pr.changedFiles ?? pr.files.length,
    labels: (pr.labels ?? []).map((name) => ({ name })),
    // gh's latestReviews: one per reviewer, their latest.
    latestReviews: (pr.reviews ?? []).map((r) => ({ state: r.state, commit: { oid: r.oid }, authorAssociation: r.assoc ?? 'MEMBER' })),
    headRefOid: HEAD,
    autoMergeRequest: pr.autoMerge ? { mergeMethod: 'SQUASH' } : null,
  });
}

/**
 * A fake gh: `pr view` prints the PR JSON (or fails with FAKE_GH_FAIL=1),
 * every other call is recorded in calls.log.
 */
function fakeGh(dir: string, json: string | null): { gh: string; calls: () => string[] } {
  const jsonFile = path.join(dir, 'pr.json');
  if (json !== null) fs.writeFileSync(jsonFile, json, 'utf-8');
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(log, '', 'utf-8');
  const gh = path.join(dir, 'gh');
  fs.writeFileSync(
    gh,
    `#!/usr/bin/env bash
if [ "$1 $2" = "pr view" ]; then
  if [ "${json === null ? '1' : ''}" = "1" ]; then echo "HTTP 502: bad gateway" >&2; exit 1; fi
  cat "${p(jsonFile)}"
  exit 0
fi
echo "$*" >> "${p(log)}"
`,
    'utf-8',
  );
  fs.chmodSync(gh, 0o755);
  return {
    gh,
    calls: () => fs.readFileSync(log, 'utf-8').split('\n').filter(Boolean),
  };
}

function runBash(file: string): { out: string; code: number } {
  try {
    const out = execFileSync('bash', ['-c', `"${p(file)}" 2>&1`], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { out, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, code: err.status ?? 1 };
  }
}

/** Source pr-review.sh (without running main) against a fake gh, then run `body`. */
function runScript(pr: Pr | null, body: string): { out: string; calls: string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-review-signal-'));
  const { gh, calls } = fakeGh(dir, pr === null ? null : prJson(pr));
  const lib = path.join(dir, 'lib.sh');
  fs.writeFileSync(lib, script.replace(/\nmain "\$@"\s*$/, '\n'), 'utf-8');
  fs.mkdirSync(path.join(dir, 'work'), { recursive: true });
  const harness = path.join(dir, 'harness.sh');
  fs.writeFileSync(
    harness,
    `#!/usr/bin/env bash
export PR_NUMBER=216 PR_HEAD_REF=fix/x PR_BASE_REF=main PR_AUTHOR=someone
export PR_TITLE="t" PR_BODY=""
export REPO=SeriousGeese/PromptCI WORK_DIR="${p(path.join(dir, 'work'))}"
export GH_TOKEN=fake GITHUB_OUTPUT="${p(path.join(dir, 'gh_output'))}"
export HEAD_SHA=${HEAD} BASE_SHA=bbbbbbbbbbbb GITHUB_RUN_ID=1
export GH_CLI="${p(gh)}"
source "${p(lib)}"
cleanup() { :; }
has_do_not_merge_label() { return 1; }
close_linked_issues() { :; }
${body}
`,
    'utf-8',
  );
  fs.chmodSync(harness, 0o755);
  try {
    const { out } = runBash(harness);
    return { out, calls: calls() };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const status = (pr: Pr | null): string =>
  runScript(pr, 'echo "STATUS=$(review_signal_status 2>/dev/null)"').out.match(/STATUS=(\S+)/)?.[1] ?? '';

// Each case spawns bash, which takes seconds on a loaded Windows host.
const SLOW = { timeout: 120_000 };

describe('review_signal_status', SLOW, () => {
  it.each<[string, Pr, string]>([
    ['docs only', { files: ['README.md', 'Docs/cli-reference.md'] }, 'not_needed'],
    ['a dependency bump', { files: ['package.json', 'pnpm-lock.yaml', 'packages/core/package.json'] }, 'not_needed'],
    ['tests and fixtures only', { files: ['packages/core/tests/x.test.ts', 'examples/fixture-x/AGENTS.md'] }, 'not_needed'],
    ['a detector change, no signal', { files: ['packages/core/src/dead-references.ts'] }, 'missing'],
    ['a fix recipe change, no signal', { files: ['packages/core/src/fix-engine.ts', 'README.md'] }, 'missing'],
    ['a cli fix command change, no signal', { files: ['packages/cli/src/commands/fix.ts'] }, 'missing'],
    ['a detector change with the label', { files: ['packages/core/src/x.ts'], labels: ['reviewed'] }, 'present'],
    ['the label in another case', { files: ['packages/core/src/x.ts'], labels: ['Reviewed'] }, 'present'],
    ['an approving review of the head', { files: ['packages/cli/src/x.ts'], reviews: [{ state: 'APPROVED', oid: HEAD }] }, 'present'],
    ['an approving review of an older commit', { files: ['packages/core/src/x.ts'], reviews: [{ state: 'APPROVED', oid: 'deadbeef' }] }, 'missing'],
    ['a comment review of the head', { files: ['packages/core/src/x.ts'], reviews: [{ state: 'COMMENTED', oid: HEAD }] }, 'missing'],
    ['an approval of the head from a collaborator', { files: ['packages/core/src/x.ts'], reviews: [{ state: 'APPROVED', oid: HEAD, assoc: 'COLLABORATOR' }] }, 'present'],
    ['an approval of the head from anyone on the internet', { files: ['packages/core/src/x.ts'], reviews: [{ state: 'APPROVED', oid: HEAD, assoc: 'NONE' }] }, 'missing'],
    ['an approval from a contributor who is not a collaborator', { files: ['packages/core/src/x.ts'], reviews: [{ state: 'APPROVED', oid: HEAD, assoc: 'CONTRIBUTOR' }] }, 'missing'],
    ['a reviewer whose latest review requests changes', { files: ['packages/core/src/x.ts'], reviews: [{ state: 'CHANGES_REQUESTED', oid: HEAD }] }, 'missing'],
    ['a hold-like label is not a signal', { files: ['packages/core/src/x.ts'], labels: ['automerge', 'reviewed-later'] }, 'missing'],
    ['a truncated file list (fails closed)', { files: ['README.md'], changedFiles: 150 }, 'missing'],
    ['a src-like path elsewhere', { files: ['scripts/packages/core/src/x.ts', 'packages/core/srcx/y.ts'] }, 'not_needed'],
  ])('%s -> %s', (_name, pr, expected) => {
    expect(status(pr)).toBe(expected);
  });

  it('fails closed when the PR cannot be read', () => {
    expect(status(null)).toBe('lookup_failed');
  });
});

describe('merge_pr waits for the review signal', SLOW, () => {
  const merge = (pr: Pr | null) =>
    runScript(pr, 'if merge_pr; then echo MERGED; else echo "NOT_MERGED signal=$REVIEW_SIGNAL result=$(review_signal_result)"; fi');

  it('merges a docs-only PR', () => {
    const r = merge({ files: ['README.md'] });
    expect(r.out).toContain('MERGED');
    expect(r.calls.some((c) => c.startsWith('pr merge'))).toBe(true);
  });

  it('does not merge a scanner PR without the signal, and reports a green wait', () => {
    const r = merge({ files: ['packages/core/src/x.ts'] });
    expect(r.out).toContain('NOT_MERGED signal=missing result=held_awaiting_review');
    expect(r.out).toMatch(/MERGE WAITING: PR #216/);
    expect(r.calls.some((c) => c.startsWith('pr merge'))).toBe(false);
  });

  it('merges a scanner PR with the label', () => {
    const r = merge({ files: ['packages/core/src/x.ts'], labels: ['reviewed'] });
    expect(r.out).toContain('MERGED');
    expect(r.calls.some((c) => c.startsWith('pr merge'))).toBe(true);
  });

  it('does not merge when the PR cannot be read, and reports a red block', () => {
    const r = merge(null);
    expect(r.out).toContain('NOT_MERGED signal=lookup_failed result=blocked');
    expect(r.calls.some((c) => c.startsWith('pr merge'))).toBe(false);
  });

  it('keeps held_awaiting_review out of the exit-1 results', () => {
    const exitOne = script.match(/^\s*blocked\|review_failed\|[a-z_|]+\)\s*exit 1 ;;/m);
    expect(exitOne, 'the exit-1 result list should still exist').toBeTruthy();
    expect(exitOne![0]).not.toContain('held_awaiting_review');
  });

  it('pushes no bot fixes to a PR that needs the signal', () => {
    expect(script).toMatch(/if \[ "\$automerge_eligible" != "true" \] \|\| \[ "\$review_gated" = "true" \]; then/);
    expect(script).toMatch(/early_signal="\$\(review_signal_status\)"/);
  });
});

/** The `run: |` block of the step named `stepName` in auto-merge.yml. */
function runBlock(stepName: string): string {
  const lines = autoMerge.split('\n');
  const at = lines.findIndex((l) => l.includes(`- name: ${stepName}`));
  expect(at, `step "${stepName}" not found`).toBeGreaterThan(-1);
  const runAt = lines.findIndex((l, i) => i > at && /^\s*run: \|\s*$/.test(l));
  const indent = (lines[runAt + 1] ?? '').match(/^\s*/)![0].length;
  const block: string[] = [];
  for (const l of lines.slice(runAt + 1)) {
    if (l.trim() !== '' && l.match(/^\s*/)![0].length < indent) break;
    block.push(l.slice(indent));
  }
  return block.join('\n');
}

function runStep(stepName: string, pr: Pr): { out: string; calls: string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-merge-step-'));
  const { gh, calls } = fakeGh(dir, prJson(pr));
  const regex = autoMerge.match(/REVIEW_SIGNAL_PATHS: '([^']+)'/)![1]!;
  const stepFile = path.join(dir, 'step.sh');
  fs.writeFileSync(
    stepFile,
    `#!/usr/bin/env bash
set -eo pipefail
gh() { "${p(gh)}" "$@"; }
export PR_URL=https://github.com/SeriousGeese/PromptCI/pull/216 GH_TOKEN=fake
export REVIEW_SIGNAL_PATHS='${regex}'
${runBlock(stepName)}
`,
    'utf-8',
  );
  fs.chmodSync(stepFile, 0o755);
  try {
    const { out } = runBash(stepFile);
    return { out, calls: calls() };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('auto-merge.yml (the automerge-label path)', SLOW, () => {
  it('uses the same path regex as pr-review.sh', () => {
    const yml = autoMerge.match(/REVIEW_SIGNAL_PATHS: '([^']+)'/)?.[1];
    const sh = script.match(/: "\$\{REVIEW_SIGNAL_PATHS:=([^}]+)\}"/)?.[1];
    expect(yml).toBeDefined();
    expect(yml).toBe(sh);
  });

  it('resets before it enables, and does not enable after a failed reset', () => {
    expect(autoMerge).toMatch(/enable-automerge:\n\s+needs: reset-review-signal/);
    // A cancelled or failed reset may have left a stale `reviewed` label: only success or skipped.
    expect(autoMerge).toContain("(needs.reset-review-signal.result == 'success' || needs.reset-review-signal.result == 'skipped') &&");
    expect(autoMerge).not.toMatch(/result != 'failure'/);
    // Without always(), a skipped reset (every non-push event) would skip enabling too.
    expect(autoMerge).toMatch(/enable-automerge:\n\s+needs: reset-review-signal\n\s+if: >-\n\s+always\(\) &&/);
    expect(autoMerge).toMatch(/reset-review-signal:\n\s+if: github\.event\.action == 'synchronize'/);
  });

  const enable = (pr: Pr) => runStep('Enable squash auto-merge', pr).calls.some((c) => c.startsWith('pr merge --auto'));

  it.each<[string, Pr, boolean]>([
    ['a docs PR', { files: ['README.md'], labels: ['automerge'] }, true],
    ['a dependency bump', { files: ['package.json', 'pnpm-lock.yaml'] }, true],
    ['a scanner PR with only automerge', { files: ['packages/core/src/x.ts'], labels: ['automerge'] }, false],
    ['a scanner PR with automerge and reviewed', { files: ['packages/core/src/x.ts'], labels: ['automerge', 'reviewed'] }, true],
    ['a scanner PR approved at the head', { files: ['packages/cli/src/x.ts'], labels: ['automerge'], reviews: [{ state: 'APPROVED', oid: HEAD }] }, true],
    ['a scanner PR approved at an older commit', { files: ['packages/core/src/x.ts'], labels: ['automerge'], reviews: [{ state: 'APPROVED', oid: 'old' }] }, false],
    ['a scanner PR approved by a non-collaborator', { files: ['packages/core/src/x.ts'], labels: ['automerge'], reviews: [{ state: 'APPROVED', oid: HEAD, assoc: 'NONE' }] }, false],
    ['a truncated file list', { files: ['README.md'], changedFiles: 300, labels: ['automerge'] }, false],
    ['a held PR', { files: ['README.md'], labels: ['automerge', 'hold'] }, false],
  ])('enable-automerge: %s -> %s', (_name, pr, expected) => {
    expect(enable(pr)).toBe(expected);
  });

  it.each<[string, Pr, string[]]>([
    ['removes the label from any PR', { files: ['README.md'], labels: ['reviewed'] }, ['pr edit https://github.com/SeriousGeese/PromptCI/pull/216 --remove-label reviewed']],
    [
      'turns off queued auto-merge on a scanner PR',
      { files: ['packages/core/src/x.ts'], labels: ['reviewed'], autoMerge: true },
      ['pr edit https://github.com/SeriousGeese/PromptCI/pull/216 --remove-label reviewed', 'pr merge --disable-auto https://github.com/SeriousGeese/PromptCI/pull/216'],
    ],
    ['leaves queued auto-merge on a docs PR', { files: ['README.md'], autoMerge: true }, []],
    ['does nothing to a scanner PR with nothing queued', { files: ['packages/core/src/x.ts'] }, []],
    [
      'treats a truncated file list as a scanner PR and turns off queued auto-merge',
      { files: ['README.md'], changedFiles: 150, autoMerge: true },
      ['pr merge --disable-auto https://github.com/SeriousGeese/PromptCI/pull/216'],
    ],
  ])('reset-review-signal: %s', (_name, pr, expected) => {
    expect(runStep('A new head needs its own review', pr).calls).toEqual(expected);
  });
});

describe('scripts/setup-labels.sh', () => {
  // GitHub refuses a label description over 100 characters, so one long line makes
  // `gh label create` fail and the `reviewed` label never exists (seen creating it for #217).
  it("keeps every label description within GitHub's 100-character limit", () => {
    const labels = fs.readFileSync(path.join(repoRoot, 'scripts', 'setup-labels.sh'), 'utf-8');
    const descriptions = [...labels.matchAll(/^label "([^"]+)"\s+"[0-9A-Fa-f]{6}"\s+"([^"]*)"/gm)];
    expect(descriptions.map((m) => m[1])).toContain('reviewed');
    for (const [, name, description] of descriptions) expect(description!.length, name).toBeLessThanOrEqual(100);
  });
});
