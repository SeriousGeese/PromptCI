import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Stage 3 of the CICD consolidation: this repo's `.cicd/` contract with the
 * shared review engine in SeriousGeese/CICD, and the shadow workflow that runs
 * it alongside `scripts/pr-review.sh`.
 *
 * These are the failures that produce NO symptom, which is why they are pinned
 * here rather than left to review:
 *
 *  - `CICD_REQUIRED_CHECKS_FALLBACK` naming a check this repo does not have.
 *    `required_contexts()` in the engine fails OPEN, so a wrong value does not
 *    error — every skipped check silently counts as a pass and the merge gate
 *    stops gating. There is no automated link between this file and the branch
 *    ruleset, so the closest available anchor is ci.yml's own job ids.
 *  - The shadow acquiring the ability to write. Dry-run is a flag inside a
 *    2000-line script; the job's `permissions` block is the guarantee that does
 *    not depend on that flag being read correctly.
 *  - The shadow and the incumbent drifting apart in WHICH PRs they review. A
 *    shadow that reviews a different population is not a comparison.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(repoRoot, ...p), 'utf8');

const configEnv = read('.cicd', 'config.env');
const gatesHook = read('.cicd', 'quality-gates.sh');
const shadowYml = read('.github', 'workflows', 'pr-auto-review-next.yml');
const incumbentYml = read('.github', 'workflows', 'pr-auto-review.yml');
const ciYml = read('.github', 'workflows', 'ci.yml');

function setting(name: string): string | undefined {
  const m = configEnv.match(new RegExp(`^\\s*${name}=(.*)$`, 'm'));
  return m?.[1].replace(/\s*#.*$/, '').trim().replace(/^"(.*)"$/, '$1');
}

describe('.cicd/config.env', () => {
  it('names a required check that ci.yml actually defines', () => {
    const fallback = setting('CICD_REQUIRED_CHECKS_FALLBACK');
    expect(fallback, 'CICD_REQUIRED_CHECKS_FALLBACK must be set').toBeTruthy();

    // Job ids under `jobs:` — the status context GitHub publishes is the job id
    // unless the job carries a `name:`, and this repo's `ci` job does not.
    const jobsBlock = ciYml.slice(ciYml.indexOf('\njobs:'));
    const jobIds = [...jobsBlock.matchAll(/^ {2}([a-z][a-z0-9-]*):/gm)].map((m) => m[1]);
    expect(jobIds).toContain('ci');

    for (const context of fallback!.split(',').map((s) => s.trim())) {
      expect(jobIds, `config.env requires "${context}", which ci.yml does not define`).toContain(
        context,
      );
    }
  });

  it('is NOT strict about skipped checks, because auto-merge.yml skips by design', () => {
    // auto-merge.yml's job carries a job-level `if:`, so it reports SKIPPED on
    // every human-authored PR. Under strict mode the reviewer would wait out its
    // whole poll budget for a check that is already in its final state — on
    // every PR. Non-strict is safe only while the required context itself cannot
    // skip, which the next assertion covers.
    expect(setting('CICD_STRICT_SKIPPED')).toBe('false');
    const autoMergeYml = read('.github', 'workflows', 'auto-merge.yml');
    expect(autoMergeYml).toMatch(/^\s{4}if:/m);
  });

  it("the required `ci` job has no job-level `if:`, so it can never report skipped", () => {
    // The premise the non-strict setting rests on. A job-level `if:` here would
    // publish `ci` as SKIPPED, which GitHub counts as PASSING for branch
    // protection — the required check would stop gating and nothing would say so.
    //
    // Sliced from the `ci:` key to the NEXT top-level job key, not to the first
    // `steps:` in the file: `indexOf` searches from position 0, so with any job
    // declared before `ci` the end index would land BEFORE the start index and
    // `slice` would return the empty string — which passes this assertion
    // without examining anything. The bug is invisible today, because `ci` is
    // the only job; it would arrive silently on the day a second one is added,
    // which is also the day this assertion starts mattering. (Caught by this
    // repo's own auto-review bot on PR #110.)
    const start = ciYml.indexOf('\n  ci:');
    expect(start, 'ci.yml must declare a `ci` job').toBeGreaterThan(-1);
    const rest = ciYml.slice(start + 1);
    const nextJob = rest.slice(1).search(/^ {2}[a-z][a-z0-9-]*:/m);
    const ciJob = nextJob === -1 ? rest : rest.slice(0, nextJob + 1);
    expect(ciJob.startsWith('  ci:'), 'slice must begin at the ci job').toBe(true);
    expect(ciJob).toMatch(/^\s{4}steps:/m);
    expect(ciJob).not.toMatch(/^\s{4}if:/m);
  });

  it('skips Dependabot PRs, which arrive without the secrets a review needs', () => {
    expect(setting('CICD_FEATURE_DEPENDABOT_SKIP')).toBe('1');
  });
});

describe('.cicd/quality-gates.sh', () => {
  it('is valid bash', () => {
    execFileSync('bash', ['-n', path.join(repoRoot, '.cicd', 'quality-gates.sh')]);
  });

  it('rejects an unknown verb rather than silently passing', () => {
    // The engine reads a 0 exit as "all gates pass". A typo'd verb that exited 0
    // would report a green review for a PR whose gates never ran.
    const r = execFileSync('bash', ['-c', `bash '${path.join(repoRoot, '.cicd', 'quality-gates.sh')}' bogus; echo rc=$?`], { encoding: 'utf8' });
    expect(r).toContain('rc=1');
  });

  it('distinguishes an infra failure (2) from a PR defect (1)', () => {
    // Without the third exit code a registry outage reads as broken code: the
    // engine would discard the review's fixes and merge a PR whose gates never
    // actually ran.
    expect(gatesHook).toMatch(/return 2/);
    expect(gatesHook).toMatch(/PNPM_NETWORK_ERR_RE/);
  });

  it('runs build before test', () => {
    // cli-e2e executes the BUILT cli. ci.yml orders these the same way; a hook
    // that reordered them would fail every review with a stale-artifact error
    // that looks like a real test failure.
    expect(gatesHook.indexOf('gate build')).toBeLessThan(gatesHook.indexOf('gate test'));
  });
});

describe('the shadow workflow', () => {
  it('cannot write to the repository', () => {
    // Dry-run is a flag inside the engine. This is the guarantee that holds even
    // if that flag is misread: no `contents: write`, no `actions: write`.
    const perms = shadowYml.slice(shadowYml.indexOf('\npermissions:'), shadowYml.indexOf('\njobs:'));
    expect(perms).toContain('contents: read');
    expect(perms).not.toContain('contents: write');
    expect(perms).not.toContain('actions: write');
  });

  it('runs in dry-run with an empty auto-merge allowlist', () => {
    expect(shadowYml).toMatch(/dry-run:\s*'true'/);
    expect(shadowYml).toMatch(/automerge-authors:\s*''/);
    // The live allowlist must not leak in — the shadow reaches a verdict it
    // must not be able to act on. Matched as an INTERPOLATION, not a substring:
    // the file names the variable in a comment saying why it is not used, and a
    // substring check would forbid explaining the decision.
    expect(shadowYml).not.toMatch(/\$\{\{\s*vars\.AUTO_REVIEW_AUTOMERGE_AUTHORS/);
  });

  it('reviews exactly the population the incumbent reviews', () => {
    // Same three gates, character for character: !draft, same-repo, and
    // not-Dependabot. A shadow over a different population is not a comparison,
    // and the difference would show up only as a quietly smaller sample.
    const guard = (yml: string) => yml.match(/^\s{4}if: \$\{\{ !github\.event\.pull_request\.draft.*$/m)?.[0].trim();
    expect(guard(shadowYml)).toBeTruthy();
    expect(guard(shadowYml)).toBe(guard(incumbentYml));
  });

  it('does not share the incumbent’s concurrency group or checkout directory', () => {
    // cancel-in-progress is per GROUP, not per workflow: a shared group would
    // have each event kill the other workflow's in-flight run, and no PR would
    // ever produce two comments for the same SHA. A shared _work dir would have
    // one run rm -rf the other's live checkout.
    const groupOf = (yml: string) => yml.match(/^ {2}group: (.*)$/m)?.[1];
    expect(groupOf(shadowYml)).not.toBe(groupOf(incumbentYml));
    expect(shadowYml).toContain('_work-next-');
  });

  it('pins the shared action to a full commit SHA, like every other action here', () => {
    // A tag is a mutable pointer, and this one points at a repo that runs with
    // GH_TOKEN and the OpenRouter key in scope on a self-hosted runner.
    // Anchored: an unanchored /uses:/ also matches the tail of `statuses: read`.
    const uses = [...shadowYml.matchAll(/^\s*(?:- )?uses:\s*(\S+)/gm)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) {
      expect(u, `${u} is not pinned to a 40-character SHA`).toMatch(/@[0-9a-f]{40}$/);
    }
    // Every pin must name the same CICD commit — a half-updated pair would run
    // one action's code against another's engine.
    const shas = new Set(uses.filter((u) => u.startsWith('SeriousGeese/CICD/')).map((u) => u.split('@')[1]));
    expect(shas.size).toBe(1);
  });

  it("names its job with the prefix both engines exclude from CI", () => {
    // The single most consequential line in the file, and it reads as
    // cosmetic. Both engines drop the reviewer's own check run by the name
    // prefix `🤖 Auto-Review` — ci-status.jq and scripts/pr-review.sh's inline
    // jq both hard-code it — and neither has another way to tell a reviewer's
    // check run from a CI one.
    //
    // Outside the prefix, the pair DEADLOCKS: this job's queued check run is an
    // ordinary in-progress CI check to the incumbent, so the incumbent waits for
    // it while it sits queued behind the incumbent on the one `pr-review`
    // runner. The incumbent burns its full poll budget and reports
    // `blocked_infra` on a PR whose CI is green. Observed on this PR's own first
    // run, under the name `🕶️ Shadow review PR #N`.
    //
    // Only the incumbent hangs — the shadow excludes the incumbent's check
    // correctly — which is exactly what makes it easy to miss.
    const name = shadowYml.match(/^ {4}name: (.*)$/m)?.[1];
    expect(name).toBeTruthy();
    expect(name!.startsWith('🤖 Auto-Review'), `job name ${name} must start with the excluded prefix`).toBe(true);

    for (const jq of [read('scripts', 'pr-review.sh')]) {
      expect(jq).toContain('startswith("🤖 Auto-Review")');
    }
  });

  it('shadow-reviews a MERGED PR, so the sample is not biased toward refusals', () => {
    // There is one `pr-review` runner and the two jobs compete for it. When the
    // incumbent wins it reviews, merges, and is gone before this job starts —
    // observed on PR #112, merged at 16:30:36 with the shadow reaching its first
    // step at 16:30:48.
    //
    // Skipping there does not just lose samples, it BIASES them: the PRs the
    // shadow would miss are exactly the ones the incumbent MERGED, so the
    // comparison would be drawn almost entirely from PRs the incumbent refused.
    // The agreement that matters most would go unmeasured.
    expect(shadowYml).toMatch(/\[ "\$STATE" != "OPEN" \] && \[ "\$STATE" != "MERGED" \]/);
  });

  it('checks out refs/pull/<n>/head, which survives the branch deletion a merge performs', () => {
    // The consequence of the case above. `gh pr merge --delete-branch` removes
    // refs/heads/<branch>, so fetching by branch name would fail on precisely
    // the merged PRs that change exists to include. refs/pull/<n>/head is
    // maintained by GitHub for the life of the PR.
    expect(shadowYml).toContain('refs/pull/${PR_NUMBER}/head');
    expect(shadowYml).not.toMatch(/\+refs\/heads\/\$\{HEAD_REF\}/);
  });

  it('refuses to review a commit other than the one it reports', () => {
    // refs/pull/<n>/head tracks the head, so it can move between the resolve
    // step and the checkout. A comment whose metadata names one SHA while the
    // review looked at another is worse than no comparison at all.
    expect(shadowYml).toContain('got="$(git -C "$WORK_DIR" rev-parse HEAD)"');
    expect(shadowYml).toMatch(/if \[ "\$got" != "\$HEAD_SHA" \]/);
    // And that skip has to reach the steps that follow it.
    expect(shadowYml).toMatch(/steps\.checkout\.outputs\.skip != 'true'/);
  });

  it('resolves PR context through `gh api`, not `gh pr view --json`', () => {
    // The field list `gh pr view --json` accepts is baked into the gh BINARY,
    // and the runner fleet is heterogeneous. The exact command that works on
    // PromptCI's runner failed on promptci-cloud's with
    //     Unknown JSON field: "baseRefOid"
    // because that runner's gh predates the field. The REST payload is
    // versioned by GitHub rather than by whichever gh a runner happens to have.
    expect(shadowYml).toMatch(/\$GH_CLI api "repos\/\$\{REPO\}\/pulls\/\$\{PR_NUMBER\}"/);
    // Matched against COMMAND lines only. An unanchored search also hits the
    // comment above, which names `gh pr view --json` precisely to say why it is
    // not used — and a test that forbids explaining a decision is a test that
    // gets the explanation deleted.
    const commands = shadowYml
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(commands).not.toMatch(/\bpr view\b/);
    // Same reason as above: the comment quotes the exact error text
    // (`Unknown JSON field: "baseRefOid"`), which is the most useful thing it
    // could say. Only the commands are checked.
    expect(commands).not.toContain('baseRefOid');
    expect(commands).not.toContain('headRefOid');
  });

  it('distinguishes MERGED from CLOSED the way the REST payload spells it', () => {
    // REST `state` is only open/closed; `merged` is a separate boolean. Reading
    // `state` alone would classify every merged PR as CLOSED and skip exactly
    // the population this shadow was changed to include.
    expect(shadowYml).toMatch(/MERGED="\$\(echo "\$PR_JSON" \| jq -r '\.merged'\)"/);
    expect(shadowYml).toMatch(/if \[ "\$MERGED" = "true" \]; then STATE=MERGED/);
  });

  it('posts a comment ONLY when the review step itself succeeded', () => {
    // The guard was `always() && <two skip outputs> != 'true'`. A step that
    // FAILS sets neither output, so when "Resolve PR context" died the comment
    // step still ran, found no comment path, and fell back to
    // /tmp/pr-review-comment-<n>.md — a path the INCUMBENT reviewer writes on
    // the same runner. The shadow posted the incumbent's comment under a shadow
    // banner and the two "agreed" perfectly, about a review the shadow never
    // performed.
    //
    // A comparison harness that fabricates agreement is worse than one that
    // crashes: nothing about it looks wrong. Observed on promptci-cloud run
    // 34252901734.
    expect(shadowYml).toMatch(/if: \$\{\{ steps\.review\.conclusion == 'success' \}\}/);
  });

  it('has no fallback comment path that another workflow also writes', () => {
    // The second half of the same fix, asserted separately: even with the guard
    // right, a shared default path is a loaded gun. There is exactly one source
    // for the comment — the review step's own output.
    expect(shadowYml).not.toContain('${COMMENT_PATH:-/tmp/pr-review-comment-');
    expect(shadowYml).toContain('path="${COMMENT_PATH:-}"');
  });

  it('marks a merged-PR run as a degraded sample', () => {
    // The engine syncs the PR branch with the CURRENT base before reviewing, and
    // an already-merged PR has a base that moved past it. The first real
    // dispatch on promptci-cloud (PR #187) came back `blocked`, "merge conflicts
    // with main", llm_tier none — none of which is a finding about the PR.
    //
    // Without the banner those comments read as real defects and get counted as
    // divergences from the incumbent, which is precisely backwards: the merged-PR
    // path exists to REDUCE sampling bias, and unlabelled it would introduce a
    // worse one.
    expect(shadowYml).toContain('was_merged=$([ "$STATE" = "MERGED" ]');
    expect(shadowYml).toMatch(/WAS_MERGED: \$\{\{ steps\.resolve\.outputs\.was_merged \}\}/);
    expect(shadowYml).toContain('Degraded sample:');
    expect(shadowYml).toContain('not a divergence from the incumbent');
  });

  it('labels its comment as advisory', () => {
    // A reviewer comment that reads as authoritative but decides nothing is
    // worse than no shadow at all.
    expect(shadowYml).toContain('Shadow review — advisory only, decides nothing.');
  });
});

/**
 * An unrecognised `permissions:` key does not warn — it INVALIDATES the workflow
 * file. The run then fails with ZERO jobs and no annotation, which reads as a
 * mysterious red check rather than a typo.
 *
 * This is not hypothetical: a first cut of DnD's workflow-push-restriction fix
 * put `administration: read` in a permissions block — a GitHub App /
 * fine-grained-PAT scope, not an Actions permission — and killed two runs that
 * way before anyone worked out why.
 *
 * It lives here rather than in CICD because CICD ships composite actions, which
 * have no permissions block at all. The workflow is the consumer's.
 */
describe('workflow permissions blocks name only real Actions keys', () => {
  // GitHub's fixed set. Anything outside it invalidates the file.
  const VALID = new Set([
    'actions',
    'attestations',
    'checks',
    'contents',
    'deployments',
    'discussions',
    'id-token',
    'issues',
    'models',
    'packages',
    'pages',
    'pull-requests',
    'repository-projects',
    'security-events',
    'statuses',
  ]);

  for (const [label, yml] of [
    ['the shadow workflow', () => shadowYml],
    ['the incumbent workflow', () => incumbentYml],
  ] as const) {
    it(`${label} names no key outside GitHub's fixed set`, () => {
      const wf = yml();
      const start = wf.indexOf('\npermissions:');
      expect(start, 'no permissions block found').toBeGreaterThan(-1);
      const block = wf.slice(start + 1, wf.indexOf('\njobs:'));
      const keys = block
        .split('\n')
        .slice(1)
        .map((line) => /^\s{2}([a-z-]+):\s*(read|write|none)\s*$/.exec(line))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => m[1]);
      expect(keys.length, 'no permission keys parsed — the block moved or the regex rotted').toBeGreaterThan(0);
      expect(keys.filter((k) => !VALID.has(k))).toEqual([]);
      // `administration` specifically — the one that has already bitten.
      expect(block).not.toMatch(/^\s*administration:/m);
    });
  }
});
