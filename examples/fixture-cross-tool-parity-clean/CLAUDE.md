# Claude

See AGENTS.md for commands and boundaries.

Do not use `jest`.
Do not modify `pnpm-lock.yaml`.
Never delete `db/migrations/`.
Never commit `.env`.

## Reminders

Don't forget to run `pnpm install` after pulling.
Never push before running `pnpm test`.

Don't forget to install dependencies first:

```bash
pnpm install
```

Never commit without running the checks:

```bash
pnpm lint && pnpm test
```
