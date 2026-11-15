# AGENTS.md

Shared guidance for coding agents working on Orbit Notes.

## Project layout

- `src/app/` holds the Next.js routes.
- `src/lib/` holds the database, auth, billing and notes modules.
- `supabase/migrations/` holds the SQL migrations.

## Testing

Run `pnpm test` before pushing. End-to-end specs live in `e2e/` and run with `pnpm e2e`.

## Deployment

Deploy with `pnpm build` then `pnpm deploy`. Tag the release as vX.Y.Z first, wait for the staging smoke test to pass, and roll back with `pnpm rollback` if the health check fails.

## Commands

- Build: `pnpm build`
- Lint: `pnpm lint`
- Migrate: `pnpm db:migrate`

## Working rules

- Read a file before you edit it, and make small changes that stay on the task.
- Preserve existing behavior and tests unless the task says to change them.
- Plan first for anything that touches more than two files.
- If you are unsure what a requirement means, ask before guessing.

## Next.js

Routes use the App Router in `src/app/`. Server components are the default; add `'use client'` only for components that need browser APIs.

## Security

Never print or commit secrets, API keys, or credentials. Use environment variables silently without echoing their values. The Supabase service role key is server-side only and must never reach client code.
