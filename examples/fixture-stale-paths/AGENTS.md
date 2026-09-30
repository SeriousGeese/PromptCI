# Stale Paths Fixture

Detector corpus for directory references, backticked source files and `make`
targets (pcic-2b6.8, pcic-2b6.10, pcic-2b6.13).

## Layout

- HTTP handlers live in `src/api/` (also `./src/api/`); see [the API](./src/api/).
- The database module is `src/lib/db` and its source is `src/lib/db.ts`.
- The web app is `apps/web`. Interfaces are in `Scripts/Interfaces/`.
- Stale: payments moved out of `src/payments/`, the admin app `apps/admin` was
  deleted, [the old API docs](./src/old-api/) are gone, and so is
  `src/services/billing.ts`.

Not paths in this repository: `owner/repo`, `origin/main`, `@acme/ui`,
`internal/client/errors.go`, `pkg/registry/`, `docs/`, `./scripts`.
Generated or ignored: `src/generated/client/`, `src/dist/`, `apps/web/.next/cache`.

## Commands

```bash
make build
make lint
make CC=clang test
make -j4 test
make deploy
make -C tools package
make -C tools release
cd /srv/app && pnpm bogus
cd $APP_DIR && node scripts/missing.js
```

Run `./scripts` from the repo root, or `make fmt`.
