# Orders API

Fixture for the mirrored-instruction-files check (pcic-1ik0.5): `AGENTS.md`, `CLAUDE.md` and
`GEMINI.md` are byte-identical copies, the way some generators write them for each tool. The
scan should report the three as ONE warning, not one high-severity finding per section.

This README repeats one section of them, the contributing guide below. It is not part of the
mirror group, so that shared section stays an ordinary per-section duplicate finding.

## Contributing

Open pull requests against `main` with a short description and the issue they close. Keep each
pull request to one logical change, add or update tests for every behaviour change, and wait for
the CI checks to pass before asking for a review from a maintainer.
