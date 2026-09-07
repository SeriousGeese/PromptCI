import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * PR auto-review: Dependabot handling and the missing-credentials path.
 *
 * Every recent `pr-auto-review` run in this repo failed, and every failing PR was
 * a Dependabot one. A `pull_request` run triggered by Dependabot receives NO
 * Actions secrets, so `OPENROUTER_API_KEY` arrives empty, every LLM tier is
 * skipped, and the script exited 1 — a red check on the majority of this repo's
 * PRs, reporting a review that never ran. `auto-merge.yml` was always the intended
 * merge authority for those PRs (the comment above `is_automerge_author` has said
 * so since this stack was ported from DnD) but the code to act on it was never
 * written.
 *
 * Three layers are pinned here, because each covers a hole the others do not:
 *  1. the script short-circuits Dependabot PRs before any LLM call;
 *  2. the workflow declines them earlier still, so a single-runner repo does not
 *     burn a slot and a checkout to reach the same conclusion;
 *  3. `review_llm` reports "no credentials" distinctly from "every tier failed",
 *     and that outcome exits 0. This is the layer that generalises: it covers any
 *     future secretless context, not just the one we know about.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const scriptPath = path.join(repoRoot, 'scripts', 'pr-review.sh');
const script = fs.readFileSync(scriptPath, 'utf-8');
const workflow = fs.readFileSync(
  path.join(repoRoot, '.github', 'workflows', 'pr-auto-review.yml'),
  'utf-8',
);

/** Source pr-review.sh without running it, then execute `body`. */
function runHarness(body: string, env: Record<string, string> = {}): { out: string; code: number } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-review-dependabot-'));
  const p = (s: string) => s.replace(/\\/g, '/');
  const lib = path.join(dir, 'lib.sh');
  // The script ends with a bare `main "$@"`; strip it so sourcing defines the
  // functions without starting a review.
  fs.writeFileSync(lib, script.replace(/\nmain "\$@"\s*$/, '\n'), 'utf-8');
  fs.mkdirSync(path.join(dir, 'work'), { recursive: true });

  const harness = path.join(dir, 'harness.sh');
  fs.writeFileSync(
    harness,
    `#!/usr/bin/env bash
export PR_NUMBER=108 PR_HEAD_REF=dependabot/npm_and_yarn/x PR_BASE_REF=main
export PR_TITLE="bump x" PR_BODY=""
export REPO=SeriousGeese/PromptCI WORK_DIR="${p(path.join(dir, 'work'))}"
export GH_TOKEN=fake GITHUB_OUTPUT="${p(path.join(dir, 'gh_output'))}"
export HEAD_SHA=aaaaaaaaaaaa BASE_SHA=bbbbbbbbbbbb GITHUB_RUN_ID=1
${Object.entries(env)
  .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
  .join('\n')}
# shellcheck source=/dev/null
source "${p(lib)}"
cleanup() { :; }
${body}
`,
    'utf-8',
  );
  fs.chmodSync(harness, 0o755);

  try {
    // `log()` writes to stderr, so stdout alone would miss every diagnostic these
    // assertions read. Merge the two streams inside the shell.
    const out = execFileSync('bash', ['-c', `"${p(harness)}" 2>&1`], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { out, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, code: err.status ?? 1 };
  }
}

describe('pr-review.sh Dependabot short-circuit', () => {
  it('skips the review and exits 0 for a Dependabot PR', () => {
    const r = runHarness('main', {
      PR_AUTHOR: 'dependabot[bot]',
      AUTOMERGE_AUTHORS: 'strickdd',
      OPENROUTER_API_KEY: '',
    });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Dependabot PR — auto-merge\.yml owns it/);
    // The whole point: no OpenRouter call is attempted.
    expect(r.out).not.toMatch(/Tier 'openrouter'/);
  });

  it('does NOT skip a human PR', () => {
    const r = runHarness(
      `PR_AUTHOR=strickdd
if [ "$PR_AUTHOR" = "dependabot[bot]" ] && ! is_automerge_author; then echo SKIPPED; else echo NOT_SKIPPED; fi`,
      { PR_AUTHOR: 'strickdd', AUTOMERGE_AUTHORS: 'strickdd' },
    );
    expect(r.out).toContain('NOT_SKIPPED');
  });
});

describe('pr-review.sh missing LLM credentials', () => {
  it('reports "no credentials" distinctly from "every tier failed"', () => {
    // No key set: no tier is attempted, so nothing failed — there is no reviewer
    // verdict to report and nothing to go red about.
    const r = runHarness(
      `review_llm "sys" "user" || true
echo "NO_CREDS=\${LLM_NO_CREDENTIALS}"`,
      { PR_AUTHOR: 'strickdd', OPENROUTER_API_KEY: '' },
    );
    expect(r.out).toContain('NO_CREDS=true');
    expect(r.out).toMatch(/No LLM credentials available in this context/);
  });

  it('does not claim "no credentials" when a key is present and the call fails', () => {
    // A real failure must stay a real failure — this is the regression that would
    // turn a genuinely broken reviewer into a silent green.
    const r = runHarness(
      `call_llm() { return 1; }
review_llm "sys" "user" || true
echo "NO_CREDS=\${LLM_NO_CREDENTIALS}"`,
      { PR_AUTHOR: 'strickdd', OPENROUTER_API_KEY: 'sk-present' },
    );
    expect(r.out).toContain('NO_CREDS=false');
  });

  it('routes the no-credentials outcome to a result that exits 0', () => {
    // `finish` exits 1 only for blocked/review_failed/held_label_lookup_failed.
    const exitOne = script.match(/^\s*blocked\|review_failed\|[a-z_]+\)\s*exit 1 ;;/m);
    expect(exitOne, 'the exit-1 result list should still exist').toBeTruthy();
    expect(exitOne![0]).not.toContain('no_llm_credentials');
    expect(script).toContain('"no_llm_credentials"');
  });
});

describe('pr-auto-review.yml Dependabot gate', () => {
  it('declines Dependabot pull_request runs at the job level', () => {
    expect(workflow).toMatch(/github\.event\.pull_request\.user\.login != 'dependabot\[bot\]'/);
  });

  it('still allows a human workflow_dispatch re-review of a Dependabot PR', () => {
    // The dispatch branch of the condition must not carry the Dependabot test,
    // so a maintainer can always reach the script and read its reasoned skip.
    const cond = workflow.match(/^\s*if: \$\{\{ !github\.event\.pull_request\.draft.*$/m);
    expect(cond, 'job-level if: not found').toBeTruthy();
    const dispatchBranch = cond![0].split("github.event_name == 'workflow_dispatch'")[1] ?? '';
    expect(dispatchBranch.startsWith(' ||')).toBe(true);
  });
});
