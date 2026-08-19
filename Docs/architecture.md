# Repository Structure

Details about the structure and codebase layout of PromptCI.

```
packages/
  core/        — scanner engine, detectors, scoring, report generator (@promptci/core)
  cli/         — CLI entrypoint (promptci)
examples/
  fixture-basic/           — TypeScript, has vague guidance
  fixture-conflicts/       — has duplicates and conflicting instructions
  fixture-unity/           — Unity repo missing Unity-specific AI guidance
  fixture-clean/           — well-written instructions, no issues expected
  fixture-no-instructions/ — no instruction files, verifies graceful empty scan
  fixture-suppression/     — inline promptci-ignore annotations
Docs/
scripts/          — repo automation (version-sync check, health-badge generator, PR auto-review)
action.yml        — the composite GitHub Action that runs promptci in other repositories' CI
.github/
  workflows/
    ci.yml             — lint, typecheck, build, test, self-scan, dependency audit
    publish.yml        — npm release (with provenance) when a version tag is pushed
    auto-merge.yml     — auto-merge green PRs
    pr-auto-review.yml — automated PR review pipeline
```

The scan pipeline lives in `packages/core/src/scan.ts`: discover files, detect project type,
run detectors, apply inline suppressions, compute the health score, and assemble a
`ScanReport`. Canonical types are in `packages/core/src/types.ts`.

The CLI (`packages/cli`) is a Commander wrapper over `@promptci/core`, bundled into a single
`dist/cli.cjs` with esbuild.

## Distribution & automation

- `action.yml` is the composite action published alongside the package; other repos reference it
  to run `promptci` in their own CI, pinned to a `cli_version`.
- `publish.yml` releases `@promptci/core` and `@promptci/cli` to npm with provenance when a
  version tag is pushed (see the promptci-release process).
- `scripts/` holds the repo's own automation: `check-version-sync.mjs` (keeps the cli/core
  versions in lockstep), `health-badge.mjs` (regenerates the README badge JSON from a scan), and
  the PR auto-review tooling (`pr-review.sh`, `review-prompt.md`).
