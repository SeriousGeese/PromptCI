# CI Automation — Operator Guide

PromptCI runs the same PR automation stack as SeriousGeese/DnD (where it was
battle-tested; the `DnD-xxxxx` references in the scripts are that repo's issue
tracker IDs, kept as provenance for the incidents that shaped the design).

## The moving parts

| Piece | File | Runs on | Purpose |
|---|---|---|---|
| CI | `.github/workflows/ci.yml` | GitHub-hosted | lint / typecheck / build / test / version-sync / self-scan. The `ci` check is required by the `main` ruleset. |
| PR Auto-Review | `.github/workflows/pr-auto-review.yml` + `scripts/pr-review.sh`, `scripts/review-prompt.md`, `scripts/extract-fixes.py` | **self-hosted, label `pr-review`** | LLM review of every same-repo PR; auto-fix + squash-merge for allow-listed authors. |
| Auto-merge | `.github/workflows/auto-merge.yml` | GitHub-hosted | LLM-free path that squash-merges Dependabot and `automerge`-labeled PRs once required checks pass. Deliberately disjoint from the review bot. |
| Labels | `scripts/setup-labels.sh` | one-time | merge-control labels (`do-not-merge`, `hold`, `blocked`, `automerge`) + changelog categories. |
| Release notes | `.github/release.yml` | GitHub | maps changelog labels into generated release notes. |

## Behavior summary

- Every non-draft, **same-repo** PR gets an LLM review comment. Fork PRs are
  never reviewed — this is a public repo and the job runs on a self-hosted
  runner, so fork code must not execute there (job-level guard in the
  workflow).
- Authors listed in the `AUTO_REVIEW_AUTOMERGE_AUTHORS` repo variable
  additionally get: base-branch sync merges, auto-applied review fixes
  (quality-gated: `pnpm typecheck && pnpm lint && pnpm build && pnpm test`),
  and a squash-merge once CI is green. Everyone else is comment-only.
- A `do-not-merge`, `hold`, or `blocked` label (case-insensitive) stops the
  bot from merging or pushing fixes, regardless of author. The label check
  **fails closed**: if labels can't be read, nothing merges.
- Dependabot and `automerge`-labeled PRs merge via `auto-merge.yml` using
  GitHub's native auto-merge, gated on the ruleset's required `ci` check. Do
  **not** add `dependabot[bot]` to `AUTO_REVIEW_AUTOMERGE_AUTHORS`.
- The `main` ruleset requires the `ci` status check and blocks non-FF pushes
  and branch deletion. Note this means direct pushes to `main` are effectively
  blocked (a fresh commit has no green check at push time) — use PRs.

## Level 1 — self-hosted `pr-review` runner

The bot workflow is `runs-on: [self-hosted, pr-review]` — the bare
`self-hosted` label is NOT enough. Required on PATH: `git`, `gh`, `jq`,
`python3`, Node 22+, `pnpm`. No production secrets belong on this host; the
job gets repo write via the automatic GITHUB_TOKEN and the OpenRouter key via
workflow env.

Current runner: **artemis-promptci-pr-review** on the Artemis host
(`~/promptci-actions-runner`, user-level systemd unit
`actions.runner.SeriousGeese-PromptCI.artemis-promptci-pr-review.service`),
alongside the DnD repo's runner in `~/github-actions-runner`.

To provision a new one:

```bash
mkdir -p ~/promptci-actions-runner && cd ~/promptci-actions-runner
# download + extract the latest actions-runner linux-x64 tarball, then:
TOKEN="$(gh api -X POST repos/SeriousGeese/PromptCI/actions/runners/registration-token --jq .token)"
./config.sh --url https://github.com/SeriousGeese/PromptCI --token "$TOKEN" \
  --name <host>-promptci-pr-review --labels pr-review --unattended
# run as a user systemd service (see the unit file above for a template)
```

## Level 2 — secrets & variables (repo level)

Secret:

- `OPENROUTER_API_KEY` — mint at https://openrouter.ai/keys, then:
  `gh secret set OPENROUTER_API_KEY -R SeriousGeese/PromptCI`

Variables (`gh variable set <NAME> -R SeriousGeese/PromptCI --body <value>`):

- `OPENROUTER_MODEL` — primary reviewer model (e.g. `z-ai/glm-5.2`)
- `OPENROUTER_FALLBACK_MODEL` — free fallback (e.g.
  `nvidia/nemotron-3-super-120b-a12b:free`)
- `AUTO_REVIEW_AUTOMERGE_AUTHORS` — comma-separated GitHub logins the bot may
  auto-fix/auto-merge. Empty = review-only for everyone. No `dependabot[bot]`
  here (see above).
- `GH_CLI_PATH` (optional) — hint to the gh binary location; the workflow
  falls back through PATH and known install locations if the hint is wrong
  for the runner that picked up the job.

## Level 3 — labels (one-time)

```bash
bash scripts/setup-labels.sh
```

Idempotent; safe to re-run after adding categories.

## Level 4 — ruleset + auto-merge (repo settings)

- Repository ruleset **main**: active; requires the `ci` status check;
  blocks force-pushes and deletion.
- **Allow auto-merge** enabled in repo settings (needed by `auto-merge.yml`).
- Actions fork-PR approval policy: require approval for **all outside
  collaborators** (Settings → Actions → General) — defense in depth on top of
  the workflow's same-repo guard.

## Verify end-to-end

Open a test PR from an allow-listed author. Expect:

1. The "🤖 Auto-Review PR #N" check runs on the `pr-review` runner.
2. A review comment appears (with a metadata YAML block).
3. If the author is in `AUTO_REVIEW_AUTOMERGE_AUTHORS` and `ci` is green, the
   PR squash-merges and the branch is deleted.
4. A Dependabot or `automerge`-labeled PR merges via `auto-merge.yml` without
   touching the self-hosted runner.

## Troubleshooting

- **"🤖 Auto-Review PR" check pending forever** — no online runner carries
  the `pr-review` label. It is not a required check, so it never blocks
  manual merges.
- **Every PR held on `<label lookup failed>`** — the runner's `gh` is missing
  or every `gh` call lacks `--repo`; see the "Resolve gh CLI" step and the
  fail-closed design notes in `scripts/pr-review.sh`.
- **Bot pushed a fix but CI never ran on it** — GITHUB_TOKEN pushes fire no
  workflows; the script dispatches `ci.yml` explicitly and fails closed if
  that dispatch fails (usually: the PR branch predates ci.yml's
  `workflow_dispatch` trigger — merge main into the branch).
- **Reviewer down / out of credits** — the run goes red with bypass
  instructions in the PR comment; merge manually with
  `gh pr merge <n> --squash --delete-branch` once CI is green.
