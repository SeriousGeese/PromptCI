# Mechanical Fix Recipe Fixture

Detector corpus for pcic-oonz: the two findings that carry a mechanical,
auto-applicable rewrite, each paired with a near-identical case that must stay
advisory because the correct replacement is not unambiguous.

## Verification

```bash
npm run bulid
npm run check:deb
npm run migrate:db
npm run deploy-to-staging-cluster
npm run build
npm run typecheck
```

The first command misspells the only script it could plausibly mean, so it can
be rewritten mechanically. The next three stay advisory, each for its own
reason: the second is equally close to two scripts the manifest defines; the
third is close to exactly one (`migrate:up`) but close enough to be a
different, real script rather than a misspelling of it; the fourth resembles
none of them. The last two are correct and must stay clean.

## Documents

The deployment steps live in [the runbook](./docs/runbook.md). That file moved
one directory up, and it is the only file of that name here, so the link can be
re-pointed mechanically.

The release gate is [the checklist](./docs/checklist.md). Two files carry that
name, so this link stays advisory.

A link that already resolves must stay clean: see
[the ops runbook](./ops/runbook.md).

A link written inside a fence is sample text, not a link this repository
follows, so it is reported but never rewritten — even though its target moved
exactly like the runbook's did:

```markdown
See [the release notes](./docs/release-notes.md) before tagging.
```
