# Publishing a new PromptCI release

See AGENTS.md for this repo's core behavioral rules — this is a task-specific runbook, not a
replacement for those.

## Before you start

The `NPM_TOKEN` repository secret (Settings → Secrets and variables → Actions → Repository
secrets, an npm automation token with publish rights on both packages) has to already exist —
without it the publish workflow's npm auth step fails. Check with `gh secret list --repo
SeriousGeese/PromptCI` if you're not sure; don't assume.

Replace `X.Y.Z` below with the real version everywhere it appears.

## 1. Bump both package versions, in lockstep

```bash
git checkout main && git pull
git checkout -b bump-vX.Y.Z

(cd packages/cli && pnpm version X.Y.Z --no-git-tag-version)
(cd packages/core && pnpm version X.Y.Z --no-git-tag-version)

pnpm check-versions

git add packages/cli/package.json packages/core/package.json
git commit -m "chore: bump version to X.Y.Z"
```

Both `pnpm version` calls run from *inside* the package directory — see SKILL.md for why
`pnpm --filter <pkg> version` doesn't work.

## 2. Open the PR and get it merged

```bash
git push -u origin bump-vX.Y.Z
gh pr create --title "chore: bump version to X.Y.Z" \
  --body "Version bump ahead of the vX.Y.Z release."
```

Get it reviewed before merging — this repo currently has no branch protection on `main`, so
nothing technically stops a direct merge, but merging is what makes the *next* step publish for
real, so treat the review as load-bearing even though git won't enforce it.

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

## 4. Watch the publish workflow

Pushing the tag triggers the publish workflow at .github/workflows/publish.yml, matched by its
`v*.*.*` trigger pattern. It does not reuse the main CI workflow's results — that workflow only
triggers on pushes to `main` and PRs, never on tag pushes — so this one reruns the full
verification suite itself (lint, typecheck, build, test) before touching npm. Then it:

1. Re-checks the tag against both package versions (fails closed if either doesn't match).
2. Publishes `@promptci/core`, then `@promptci/cli`, with `--provenance --access public
   --no-git-checks`.
3. Re-checks what npm now actually serves for both packages, to catch a partial publish or
   registry propagation lag.

```bash
gh run watch --repo SeriousGeese/PromptCI
```

or just watch the Actions tab. If it fails partway — say, core published but cli's step then
failed — a retry is safe: `pnpm publish` refuses to republish a version already live, so
re-running just picks up wherever it left off.

## 5. Follow-up PR: keep the composite action's CLI pin in sync

The composite GitHub Action at action.yml pins a specific `cli_version` default on purpose, so a
release can't silently change behavior for every consumer's pipeline mid-run.
`packages/cli/tests/action-yml.test.ts` asserts that default equals `packages/cli/package.json`'s
version — and starts failing on the next CI run against `main` until you bump it. Do this as its
own PR, right after the publish above actually succeeds:

```bash
git checkout main && git pull
git checkout -b bump-action-yml-vX.Y.Z
grep -n "cli_version:" -A5 action.yml
```

Confirm there's exactly one `default: '...'` line in that block before editing. Then update it
to the new version (by hand, or a targeted `sed` once you've confirmed the match is unambiguous),
and:

```bash
git add action.yml
git commit -m "chore: bump action.yml cli_version to X.Y.Z"
git push -u origin bump-action-yml-vX.Y.Z
gh pr create --title "chore: bump action.yml cli_version to X.Y.Z" \
  --body "Keeps the composite action's pin in sync with the newly published @promptci/cli@X.Y.Z."
gh pr merge --merge
```
