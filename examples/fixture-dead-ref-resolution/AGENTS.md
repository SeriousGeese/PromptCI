# Dead Reference Resolution Fixture

Detector corpus for pcic-mh72: references that resolve somewhere other than
the instruction file's directory, and paths that belong to another project.

## CI

`deploy_pr.yml` runs the tests on every pull request, then
`verify-release.mjs` checks the bundle. `nightly-release.yml` publishes the
nightly build.

## Backend source

The backend lives in a separate Java repository. Start in
`src/main/java/org/example/backend/api/`, one class per resource.

Translations live in `src/i18n/{de,en}.json`. The payments code that lived in
`src/payments/` was removed.

## Commands

```bash
npm run build
npm run dev
```
