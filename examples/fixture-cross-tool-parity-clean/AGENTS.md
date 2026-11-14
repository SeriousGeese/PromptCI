# Agents

## Commands

Install dependencies with `pnpm install`. Avoid npm here.
Run `pnpm install` instead of `npm install`.
Tests run with `vitest`. Run them with `pnpm test`; `pnpm test:unit` runs the unit subset.
Install `@testing-library/jest-dom` for the DOM matchers.
Install the TypeScript compiler globally once with `npm install -g typescript`.
The docs site is standalone: `cd docs && npm install`.

## Files

Add your API keys to `.env`.
Add new SQL files under `db/migrations/`.
Run `pnpm install` to update `pnpm-lock.yaml`.
Never edit `src/generated/`.
