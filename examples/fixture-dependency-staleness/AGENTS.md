# Storefront — agent instructions

A Next.js 15 storefront on React 19. Run the tests and report failures honestly before you
call a change done; prefer small, focused diffs; read a file before you edit it.

## Setup

```bash
pnpm install
pnpm add zustand          # client state
pnpm add -D vitest        # already declared, so quiet
```

## Conventions

- State: `import { create } from 'zustand'`.
- Dates: format with the `moment` package.
- Mounting: call `ReactDOM.render(<App />, root)` in `src/main.tsx`.
- Data: fetch with `getInitialProps` on each page.

## Things that must stay quiet

- Do not use `request`; use the built-in fetch instead.
- Never `npm install left-pad`. Replaced `enzyme` with Testing Library last year.
- Import aliases such as `import { Button } from '@/components/Button'` and `./local` are not packages.
- Placeholders: `npm install <package>`, `npm i @your-org/shared`, `pnpm add some-package`.
- Global tools: `npm install -g typescript`; one-offs: `npx create-next-app@latest`.
- Node built-ins: `import fs from 'node:fs'`.
- In the pages router, `getInitialProps` is how you would do this; we avoid it here.
