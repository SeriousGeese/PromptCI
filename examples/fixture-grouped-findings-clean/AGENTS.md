# Agent Guidelines

Must-stay-clean twin of `fixture-grouped-findings` (pcic-1ik0.3): every common agent practice is
written down and every action in `.github/workflows/ci.yml` is pinned to a full commit SHA, so the
scan reports neither an agent-practice nor an action-pin finding.

## How to work here

- Before saying done, run `pnpm test`. Work is not complete until it passes.
- If tests fail, report the failure honestly. Never claim success when a check errors.
- If you are uncertain about the approach, say so and ask before proceeding.
- Always read a file fully before editing it.
- Prefer focused, minimal diffs. Do not rewrite unrelated code.
- Preserve existing code and only change what the task requires.
- For multi-file changes, outline the approach before writing code.
