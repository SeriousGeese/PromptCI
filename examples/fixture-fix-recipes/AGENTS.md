# Mechanical Fix Recipe Fixture

Detector corpus for pcic-oonz: the two findings that carry a mechanical,
auto-applicable rewrite, each paired with a near-identical case that must stay
advisory because the correct replacement is not unambiguous.

## Verification

```bash
npm run bulid
npm run check:deb
npm run deploy-to-staging-cluster
npm run build
npm run typecheck
```

The first command misspells the only script it could plausibly mean, so it can
be rewritten mechanically. The second is equally close to two scripts the
manifest defines, and the third resembles none of them; both stay advisory —
only the author knows which was meant, if any. The last two are correct and
must stay clean.

## Documents

The deployment steps live in [the runbook](./docs/runbook.md). That file moved
one directory up, and it is the only file of that name here, so the link can be
re-pointed mechanically.

The release gate is [the checklist](./docs/checklist.md). Two files carry that
name, so this link stays advisory.

A link that already resolves must stay clean: see
[the ops runbook](./ops/runbook.md).
