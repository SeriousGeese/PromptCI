# Command Scope Fixture (must stay clean)

Detector corpus for package scripts that live outside the root manifest, and for
script names written as patterns. Nothing here may produce a command finding. The
root manifest defines `build`, `build:web`, `build:api` and `check`; `site`
defines `dev` and `lint`; `packages/docs` defines `test:e2e`.

## Site (from `site/` directory)

- `npm run dev` -- start the dev server
- `npm run lint` -- lint the site

## Docs end-to-end

From `packages/docs/`:

```sh
# headless run; the comment line is not a heading
npm run test:e2e
```

## Validation

Run `pnpm check` first. Reserve `pnpm build*` for user requests, `npm run build:<target>` for one target,
and `npm run $SCRIPT` or `npm run ${SCRIPT}` for a script chosen at run time.

## A command in a comment no reader sees

<!-- run `npm run not-a-script` once -->

## Slash-joined scripts

From `site/`: `npm run dev/lint`.

## Setext heading

Site
====

From `site/`:

```sh
npm run dev
```
