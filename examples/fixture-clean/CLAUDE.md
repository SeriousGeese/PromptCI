# Project Instructions

## Commands

- Build: `pnpm build`
- Test: `pnpm test`
- Lint: `pnpm lint`
- Typecheck: `pnpm typecheck`

## Architecture

This is a TypeScript monorepo using pnpm workspaces. Each package in `packages/`
has its own `tsconfig.json` and build script. The root `vitest.config.ts` runs
all tests across packages.

## Coding Standards

- TypeScript strict mode is enabled; all `any` uses must be justified.
- Functions must not exceed 50 lines; extract helpers for longer logic.
- No commented-out code in committed files.
- All public APIs require JSDoc.

## Testing

Use Vitest. Tests live in `packages/*/tests/`. Each new detector must have
unit tests covering the happy path, empty input, and at least one edge case.
Run `pnpm test` before opening a PR.

## Working Practices

- If tests or commands fail, report the failure honestly; never claim success
  when checks error.
- If you are unsure about the correct approach, ask before proceeding rather
  than guessing.
- Always read a file fully before editing it.
- Prefer minimal diffs; do not rewrite unrelated code.
- Preserve existing code and only change what the task requires.
- For complex or multi-file tasks, outline the approach before writing code.
