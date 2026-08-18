# Updating promptci-cloud to a new PromptCI release

See AGENTS.md for this repo's core behavioral rules — this is a task-specific runbook, not a
replacement for those.

promptci-cloud is a separate repository (a sibling checkout — confirm the actual local path with
the user rather than assuming one). It consumes this repo's published packages in two
independent places. Don't conflate them — they update differently, and only one needs action.

## Place 1: the PR-check workflow — nothing to do here

promptci-cloud's PR-check workflow (grep its workflow directory for the exact filename rather
than assuming) runs the scanner via an unpinned `npx -y @promptci/cli scan ...` call, with no
version specifier. That means it always resolves to whatever npm's `latest` tag currently points
at. Once a release finishes publishing from this repo, the very next PR check in promptci-cloud
picks it up automatically — nothing to bump, no PR to open, no action needed.

(If someone ever wants that pinned instead, for reproducibility, raise it as a deliberate
tradeoff rather than changing it unprompted — pinning trades "always current" for "needs its own
manual bump every release".)

## Place 2: the web app's core dependency — this one needs a real bump

promptci-cloud's web app package has a genuine runtime dependency on `@promptci/core`, pinned
with a caret range in its own manifest. It's imported directly in a server-side scanner module
and used by several API routes — this is the actual scan engine behind the hosted product, not a
CI convenience. That means:

- This is a real integration point. Core's public API (the `scan` function and its report type)
  could change between versions, so bumping it deserves an actual build/typecheck check, not a
  rubber-stamp version-string edit.
- The caret range matters more than usual here: a caret range on a `0.0.x` version only matches
  that exact version under semver — `^0.0.1` does not resolve to `0.0.2` on a plain install the
  way `^1.2.0` would resolve across patch/minor bumps. The version string has to be hand-edited;
  installing alone will never pick up a new `0.0.x` release on its own.

Update it like this, from inside the promptci-cloud checkout:

```bash
cd PATH_TO_PROMPTCI_CLOUD
git checkout main && git pull
git checkout -b bump-promptci-core-X.Y.Z
```

Find the `@promptci/core` dependency line in the web app's manifest and change the version to
the one you just published, then:

```bash
pnpm install
pnpm --filter @promptci/web typecheck
pnpm --filter @promptci/web build
```

Both need to pass before committing — they're the actual signal that the new core version's API
is still compatible with what the web app expects, not just that the string changed.

```bash
git add -A
git commit -m "chore: bump @promptci/core to X.Y.Z"
git push -u origin bump-promptci-core-X.Y.Z
gh pr create --title "chore: bump @promptci/core to X.Y.Z" \
  --body "Picks up the new scan engine from the SeriousGeese/PromptCI release."
```

Get it reviewed and merged the normal way for that repo — nothing about this bump warrants
skipping review, since it changes the engine behind the live product.
