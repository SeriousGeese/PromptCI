# Command Scope Fixture

Detector corpus for package scripts that live outside the root manifest, and for
script names written as patterns. The root manifest defines `build`, `build:web`,
`build:api` and `check`; `site` defines `dev` and `lint`; `packages/docs` defines
`test:e2e`; `tools` defines `seed`.

## Site (from `site/` directory)

- `npm run dev` -- start the dev server
- `npm run lint` -- lint the site

## Docs end-to-end

From `packages/docs/`:

```sh
npm run test:e2e        # headless
```

## Validation

Run `pnpm check` first. Reserve `pnpm build*` for user requests, and `npm run build:<target>` for one target.

## Defined in a package the text does not name

```sh
npm run seed
```

## Broken on purpose

```sh
npm run release:nightly
```
