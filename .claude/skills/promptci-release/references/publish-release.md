# Publishing a new PromptCI release

See AGENTS.md for this repo's core behavioral rules — this is a task-specific runbook, not a
replacement for those.

## Before you start

There is no npm token — publishing authenticates via npm trusted publishing (OIDC). Both
packages' npm Settings pages must list a Trusted Publisher of GitHub Actions →
`SeriousGeese/PromptCI` → `publish.yml` → environment `release`, and the repo must have a
`release` environment (Settings → Environments) with a required reviewer. If either half is
missing, the publish fails with an npm auth error; fix the trust config rather than minting a
token.

Replace `X.Y.Z` below with the real version everywhere it appears.

## 1. Bump both package versions, in lockstep

```bash
git checkout main && git pull
git checkout -b bump-vX.Y.Z

(cd packages/cli && pnpm version X.Y.Z --no-git-tag-version)
(cd packages/core && pnpm version X.Y.Z --no-git-tag-version)

# Same PR: bump the composite action's pin to match (see the note below on why
# this can't wait for a follow-up PR). Confirm there's exactly one match first.
grep -n "cli_version:" -A8 action.yml   # verify a single `default: '...'` line
# then update that default from the old version to X.Y.Z, by hand or a checked sed

pnpm check-versions

git add packages/cli/package.json packages/core/package.json action.yml
git commit -m "chore: bump version to X.Y.Z"
```

Both `pnpm version` calls run from *inside* the package directory — see SKILL.md for why
`pnpm --filter <pkg> version` doesn't work.

**Why `action.yml` is in this same commit, not a later PR:**
`packages/cli/tests/action-yml.test.ts` asserts the action's `cli_version` default equals
`packages/cli/package.json`'s version. It reads both files directly, so the moment you bump the
package it fails *inside this bump PR* — not, as you might expect, only on some later `main` run.
CI gates merge on a green `ci` check, so the PR cannot go green (and cannot merge) unless the pin
is bumped in the same change. Bundle it here. (Confirmed on the first real release, v0.1.0 /
PR #95, 2026-08-20.)

## 2. Open the PR and get it merged

```bash
git push -u origin bump-vX.Y.Z
gh pr create --title "chore: bump version to X.Y.Z" \
  --body "Version bump ahead of the vX.Y.Z release."
```

Get it reviewed before merging — the `main` ruleset requires a green `ci` check but no human
review, so nothing technically stops an unreviewed merge. Merging is what makes the *next*
step publish for real, so treat the review as load-bearing even though git won't enforce it.

```bash
gh pr merge --merge
```

This repo's existing history merges with a real merge commit rather than squashing (check
`git log --oneline` if that's changed) — match that convention.

## 3. Tag the merge commit — not your local pre-merge commit

```bash
git checkout main && git pull
git tag vX.Y.Z
git push origin vX.Y.Z
```

Pulling `main` first matters: tag the commit that's actually on `main` after the merge, not the
commit made locally in step 1. If the PR got squash-merged, that local commit's SHA might not
even exist on `main` — tagging it would publish from a commit GitHub has no record of.

## 4. Approve the release gate, then watch the workflow

Pushing the tag triggers the publish workflow at .github/workflows/publish.yml, matched by its
`v*.*.*` trigger pattern. The run immediately pauses on the `release` environment and waits
for a maintainer to approve it: Actions tab → the queued Publish run → "Review deployments" →
approve (or `gh run list --workflow publish.yml` then approve in the UI — approval is not
scriptable by design). Once approved, it does not reuse the main CI workflow's results — that
workflow only triggers on pushes to `main` and PRs, never on tag pushes — so this one reruns
the full verification suite itself (lint, typecheck, build, test) before touching npm. Then it:

1. Re-checks the tag against both package versions (fails closed if either doesn't match).
2. Publishes `@promptci/core`, then `@promptci/cli`, via `npm publish --provenance
   --access public` (npm, not pnpm — the pinned pnpm major predates OIDC support).
3. Re-checks what npm now actually serves for both packages, to catch a partial publish or
   registry propagation lag.

```bash
gh run watch --repo SeriousGeese/PromptCI
```

or just watch the Actions tab. If it fails partway — say, core published but cli's step then
failed — a retry is safe: `npm publish` refuses to republish a version already live, so
re-running just picks up wherever it left off.

## 5. The composite action's CLI pin — already done in step 1

The composite GitHub Action at action.yml pins a specific `cli_version` default on purpose, so a
release can't silently change behavior for every consumer's pipeline mid-run. That pin was bumped
as part of the version-bump PR in step 1, because `packages/cli/tests/action-yml.test.ts` forces
it into the same change (see the "Why `action.yml` is in this same commit" note there).

So there is **no separate follow-up PR** for the pin. Just confirm the merged `main` already has
it in sync:

```bash
git checkout main && git pull
git show HEAD:action.yml | grep "default:"                 # should read X.Y.Z
git show HEAD:packages/cli/package.json | grep '"version"' # same X.Y.Z
```

If for some reason the pin *didn't* make it into the bump PR (e.g. a future refactor moves the
test), the action installs a `cli_version` that doesn't exist on npm yet and `main` CI goes red —
fix it immediately with a one-line PR bumping only `action.yml`'s `default`.
