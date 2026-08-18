# Contributing to PromptCI

Thanks for your interest in PromptCI. This file covers how to get set up and what a
mergeable change looks like.

## Setup

Requirements: Node.js 22 or newer. The package manager release is pinned in the
`packageManager` field of `package.json`; `corepack enable` picks it up automatically.

```bash
git clone https://github.com/SeriousGeese/PromptCI
cd PromptCI
pnpm install
pnpm build
```

Run the CLI against a repo:

```bash
node packages/cli/dist/cli.cjs scan --path /path/to/some/repo
```

## Verification

All four must pass before a PR is ready. CI runs the same set, in this order.

```bash
pnpm lint && pnpm typecheck && pnpm build && pnpm test
```

Run a single test file while iterating:

```bash
pnpm test packages/core/tests/duplicates.test.ts
```

`pnpm test` does not require a build first — vitest aliases `@promptci/core` to
`packages/core/src/index.ts`, so unit tests run against source. The one exception is
`packages/cli/tests/cli-e2e.test.ts`, which spawns the compiled binary and builds it itself.
`pnpm build` still runs before `pnpm test` in CI so that a build failure surfaces as a failed
build rather than as a confusing test error.

## Dependency updates

Dependabot config lives in `.github/dependabot.yml` and covers two ecosystems: `npm` (which is
the correct key for a pnpm workspace — there is no separate `pnpm` value) and `github-actions`.
Routine minor/patch updates are grouped into one PR per ecosystem per week; majors get their own
PR so each is reviewed against its own release notes.

There are currently **no `pnpm.overrides`**. A pair of them once pinned `vite` and `esbuild`
above their security advisories, because vitest's range was wide enough that pnpm kept resolving
a flagged version. Both declared ranges have since moved past the patched versions on their own,
so the overrides were removed — they had begun blocking the very updates Dependabot was opening.

If you add an override for a future advisory, say so here and state the condition for removing
it. An override that outlives its advisory silently caps a dependency.

Anything imported by a config file at the repo root must be a **declared** devDependency.
`eslint.config.mjs` imports `@eslint/js`, which resolved for a long time only because pnpm's
default `public-hoist-pattern` includes `*eslint*` and ESLint 9 happened to depend on it. ESLint
10 does not, and lint broke until it was declared explicitly.

## GitHub Actions pins

Every action in `.github/workflows` **and in the published `action.yml`** is pinned to a full
commit SHA, with the readable version in a trailing comment:

```yaml
- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
```

A tag is a mutable pointer — whoever can push to the action's repo can move `v7` to different
code, and every workflow referencing it picks that up on the next run. A SHA cannot be
repointed. This matters most in `action.yml`, which runs inside every consumer's repository.

Don't replace a SHA with a tag for readability; the `github-actions` Dependabot entry updates
the SHA and its comment together. When adding a step, resolve the SHA from the action's own
repository (not a fork):

```bash
gh api repos/actions/checkout/commits/v7.0.1 --jq .sha
```

Also in `action.yml`: pass inputs to `run:` steps through `env:`, never by interpolating
`${{ inputs.x }}` into the script. A composite action executes in the caller's workflow, so a
value spliced into a shell line is a script-injection sink.

## Changing a detector

Detector changes shift results for every user, so they carry extra requirements.

1. **Stay deterministic.** Detectors are rule-based. No LLM calls, no network requests, no
   clock or randomness in detector code. The same input must always produce the same report.
   (`callLlm` in core is an optional helper for downstream consumers — nothing in the scan
   pipeline may call it.)
2. **Add fixtures.** Repos under `examples/` are the scanner's test corpus
   (`fixture-basic`, `fixture-clean`, `fixture-conflicts`, `fixture-suppression`, and others).
   A new rule needs both a fixture that triggers it and a case that must stay clean.
3. **Word findings cautiously.** Findings are heuristic. "Possible conflict", "These sections
   appear similar", "Consider reviewing" — never assert certainty.
4. **Check for noise.** Run your build against a few real repositories before opening the PR
   and say what you found in the PR's Detector impact section. A rule that fires on healthy
   instruction files is worse than no rule.
5. **Reuse the canonical types.** `PromptCiIssue`, `IssueCategory`, and `IssueSeverity` live in
   `packages/core/src/types.ts`. Do not redefine them locally.

## Pull requests

- Branch from `main`. One logical change per PR.
- Title in Conventional Commit style: `feat:`, `fix:`, `docs:`, `chore:`. Release notes are
  generated from labels, and the title is what readers see.
- Fill in the PR template, including the Detector impact section when you touch
  `packages/core`.
- Every behavior change needs a test.
- Never stage generated `.promptci/` output (`.promptci/latest.md`, `.promptci/report.json`,
  `.promptci/history/`). The three committed exceptions are `.promptci/baseline.json`,
  `.promptci/config.json`, and `.promptci/health-badge.json`; refresh the first and last only
  via `pnpm selfscan:update`.

## Reporting problems

Use the issue templates. The two that matter most for a heuristic scanner:

- **False positive** — PromptCI flagged something that is fine.
- **False negative** — PromptCI missed something it should have caught.

Both ask for the finding `id` and `category` from `.promptci/report.json` plus the instruction
text involved, which is what we need to turn a report into a regression fixture.

Security problems go through private advisories, not public issues. See `SECURITY.md`.

## Suppressing a finding in your own repo

If a finding is wrong for your project but the rule is sound in general, suppress it inline
rather than filing an issue:

```markdown
<!-- promptci-ignore: context_bloat
     reason: Explains a product feature; the pasted-report heuristic misreads it. -->
```

If the rule itself is wrong, file a false-positive report instead so it gets fixed for everyone.

## Licensing and sign-off

Everything in this repository is licensed under [Apache-2.0](LICENSE). We use the
[Developer Certificate of Origin](https://developercertificate.org/) instead of a Contributor
License Agreement — you keep the copyright to your work, and we take no right to relicense it.
Certify that you wrote the patch by signing off each commit:

```bash
git commit -s -m "fix: stop vague-guidance firing on code fences"
```

That appends a `Signed-off-by: Your Name <you@example.com>` trailer. Add it to existing commits
with `git rebase --signoff main`.
