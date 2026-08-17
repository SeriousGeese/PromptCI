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
.github/
  workflows/ci.yml
```

The scan pipeline lives in `packages/core/src/scan.ts`: discover files, detect project type,
run detectors, apply inline suppressions, compute the health score, and assemble a
`ScanReport`. Canonical types are in `packages/core/src/types.ts`.

The CLI (`packages/cli`) is a Commander wrapper over `@promptci/core`, bundled into a single
`dist/cli.cjs` with esbuild.
