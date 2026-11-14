# Command Scope Fixture (triggering)

Detector corpus for package scripts that live outside the root manifest. Every
finding here is expected; `fixture-command-scope-clean` holds the twin that must
stay clean. The root manifest defines `build`, `build:web`, `build:api` and
`check`; `site` defines `dev` and `lint`; `tools` defines `seed`.

## Defined in a package the text does not name

```sh
npm run seed
```

An `info` note: the script exists, in `tools/`, and nothing says to run it there.

## Site (from `site/` directory)

```sh
npm run dev/nonexistent
```

`dev` is in `site/`, `nonexistent` is nowhere: one `warning`, for `nonexistent`.

## Typo under a named directory

From `site/`:

```sh
npm run buil
```

The root defines `build`, `site/` does not: a `warning` with no edit, because the
directory the text names changes which manifest runs it.

## At the repo root

The marketing pages live in `site/`. At the repo root run `npm run dev`.

The text says root, and the root has no `dev`: a `warning`, not a note.

## Broken on purpose

```sh
npm run release:nightly
```
