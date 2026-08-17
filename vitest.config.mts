import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: [
      {
        // Run unit tests against core's SOURCE, not its build output.
        //
        // `@promptci/core` resolves through its exports map to ./dist/index.js,
        // which does not exist on a fresh clone — `pnpm install && pnpm test`
        // failed with "Failed to resolve entry for package "@promptci/core"",
        // an error that reads like a broken package.json rather than a missing
        // build. CI only avoided it because `pnpm typecheck` runs first and
        // happens to build core as a side effect, an undeclared dependency
        // that would break the moment the job order changed.
        //
        // Anchored so only the bare specifier is rewritten. cli-e2e.test.ts is
        // unaffected: it deliberately spawns the compiled binary and builds it
        // in beforeAll.
        find: /^@promptci\/core$/,
        replacement: fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      },
    ],
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/tests/**/*.test.ts'],
  },
});
