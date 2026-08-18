---
name: promptci-release
description: >-
  Walks through releasing @promptci/cli and @promptci/core to npm from this repo, and updating the downstream promptci-cloud repo to pick it up. Use this whenever the user wants to publish, release, ship, cut, or tag a new PromptCI version; bump the cli or core package version; or update/sync promptci-cloud (or its @promptci/core dependency) to a newer release — including casual phrasing like "let's ship 0.0.3", "cut a release", or "bump promptci-cloud to the latest core". Always consult this before running any pnpm/npm publish or version-bump commands here — the release process has non-obvious gotchas that are easy to get wrong by guessing.
---

See AGENTS.md for this repo's core behavioral rules (verification loop, honesty, scope
control) — this skill only layers release-specific steps on top of those.

# Releasing PromptCI

This repo publishes two npm packages together, in lockstep: `@promptci/cli` and
`@promptci/core`. Core is bundled into cli's built output as a frozen esbuild snapshot (a
devDependency of cli, not a runtime one), so nothing on npm's side keeps their versions tied
together on its own — the release process is what enforces that. See CONTRIBUTING.md's
"Releasing" section for the short version; this skill has the exact command sequence plus traps
that section doesn't spell out.

## Two separate jobs — figure out which one the user wants

1. **Cutting a new PromptCI release** (bumping the version, tagging, publishing to npm) →
   read [references/publish-release.md](references/publish-release.md).
2. **Picking up a PromptCI release in the downstream `promptci-cloud` repo** (a different repo,
   at a sibling path) → read [references/update-promptci-cloud.md](references/update-promptci-cloud.md).

A full release usually means both, in that order: publish here first, then go update
promptci-cloud once the new version is actually live on npm. Don't start step 2 before step 1's
publish workflow has succeeded — promptci-cloud's web app depends on the real published
package, not on anything local to this repo.

## The one thing to internalize before touching any commands

`pnpm --filter <pkg> version <newversion> --no-git-tag-version` looks like the obvious way to
bump a single workspace package's version, but it does not work: combined with `--filter`, pnpm
treats `version` as a request to run a `"version"` npm script rather than its own built-in
version-bump subcommand. Neither package defines one, so pnpm prints `None of the selected
packages has a "version" script` and exits 0 — no version changes, no error surfaces unless
you're reading the output closely. The correct form runs `pnpm version` *from inside* each
package's own directory. Both reference docs use the correct form; don't shortcut it.

## Verifying you're not about to publish a lie

Both packages must land on the exact same version. `pnpm check-versions` (backed by
scripts/check-version-sync.mjs) checks this locally, and it's also enforced as a CI step and
again inside the publish workflow itself — but running it yourself right after bumping is a fast
way to catch a typo before it becomes a PR.
