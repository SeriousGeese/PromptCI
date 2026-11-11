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

## Elsewhere

The release check is `Scripts/verify-release.mjs`: the directory is
`scripts/`, so the reference is broken on Linux and on GitHub, and is reported
on every platform. Shared rules live in
[the parent rules](../no-such-fixture/AGENTS.md) and
[the root guide](../../no-such-guide.md), outside this repository, so they
are not checked.

## Commands

```bash
npm run build
npm run dev
node scripts/verify-release.mjs
node Scripts/verify-release.mjs
node ../no-such-fixture/release.mjs
bash /opt/no-such-fixture/setup.sh
```

The second release command uses the wrong case and is reported on every
platform. The last two run scripts outside this repository, so they are not
checked.
