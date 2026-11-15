# CLAUDE.md

Orbit Notes is a Next.js notes app with Postgres storage and Stripe subscriptions. See AGENTS.md for the shared project rules.

## Testing

Run `npm run test` and fix failures you caused.

## Deployment
See canonical instructions in [AGENTS.md](./AGENTS.md) for details.
## Database

Be careful with the database. Use good judgement.

## Notes sync

Notes are mirrored by the Redis cache in `src/lib/legacy-sync.ts`. That cache is a temporary workaround and is deprecated, but when a note looks stale, flush it and let it repopulate.

## New joiners

Read `docs/onboarding.md` before touching billing or auth code.

## Maintenance

When search results look wrong, run `node scripts/reindex.mjs` to rebuild the index. To start from a clean database, run `pnpm db:reset`.

## Before you push

Run `pnpm typechek` and fix what it reports.

New joiners start with the [onboarding checklist](onboarding-checklist.md).

## Working rules

- Read a file before you edit it, and make small changes that stay on the task.
- Preserve existing behavior and tests unless the task says to change them.
- Plan first for anything that touches more than two files.
- If you are unsure what a requirement means, ask before guessing.

