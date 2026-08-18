# CLAUDE.md

Follow **AGENTS.md** ([open](AGENTS.md)) — it is the canonical guide for agents working in this
repo (how to work, the determinism constraint, and the self-scan gate). This file only adds a few
Claude-specific notes; it does not restate those rules.

## Claude-specific notes

- This repo dogfoods PromptCI: `CLAUDE.md` and `AGENTS.md` are scanned by the tool's own CI.
  Keep the two files complementary, not duplicated — canonical rules live in `AGENTS.md`, and
  duplicated instruction sections are themselves a finding the scanner reports.
- The scanner reads instruction files byte-for-byte. Line endings are pinned to LF via
  [.gitattributes](.gitattributes) so a Windows checkout and Linux CI produce the same findings;
  keep new instruction files LF.
- When you finish a change, verify it the way CONTRIBUTING.md and AGENTS.md describe, then say
  what actually passed — including the self-scan — rather than assuming.
