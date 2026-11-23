# Fixture: manifest fix recipes

Fixture for the line-anchored fix recipes of the manifest-consistency findings
(pcic-k1t3.12). Each stale line below is one the manifest settles on its own.

## Stack

- **Runtime:** Requires Node.js 18+.
- **Build tool:** Vite 6

Use the stack above for all new features.

## Commands

Run `npm install`, then `npm run dev` to start the dev server.

```bash
npm run build
npm run test
```

## Rules

- Never commit secrets, API keys or credentials; read them from the environment silently.
- Read a file before you edit it, and keep diffs focused on the task.
- Run `pnpm lint` and `pnpm test` before you say a change is done.
