# Monorepo Scripts Fixture

Detector corpus for package-manager script checks in a pnpm workspace. The root
manifest defines `build`, `lint` and `typecheck`; the `web` workspace defines
`dev` and `test:e2e`. Everything below is valid except the last command.

## Commands

```bash
pnpm install
pnpm build
pnpm vitest run
pnpm tsc --noEmit
pnpm eslint .
pnpm prettier --check .
pnpm --filter web dev
pnpm -r build
cd apps/web && pnpm test:e2e
npm run-script lint
```

Playwright runs through the `web` workspace: `pnpm --filter web test:e2e`.

## Broken on purpose

```bash
pnpm run release:nightly
```

Afterwards, pnpm run release:nightly to publish.
