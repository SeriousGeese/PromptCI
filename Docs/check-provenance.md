# Check provenance

Every check encodes a claim: about a repository, about an AI coding tool, or about how to write
instructions for a model. A provenance record says which, where the claim comes from, which tools it
is about and when someone last checked it. The records live in
[`packages/core/src/provenance/`](../packages/core/src/provenance/), next to the detectors they
describe, and `@promptci/core` exports them so a consumer can show "applies to", "last verified" and
the status per check.

```ts
import { CHECK_PROVENANCE, provenanceFor, provenanceStatus } from '@promptci/core';

provenanceFor('ai-config-mcp').map((r) => [r.id, provenanceStatus(r)]);
```

Provenance is data and pure helpers. The scanner never imports it while scanning and never reads a
clock for it, so it cannot change a scan's output.

## A record

| Field | Meaning |
|---|---|
| `id` | The detector id, or `<detector-id>/<family>` when one detector rests on several claims |
| `detector` | The `DETECTORS` id in `packages/core/src/detectors.ts` |
| `kind` | `repo-fact` (a statement about the scanned repository), `tool-fact` (how a tool or framework behaves) or `opinion` (advice about how to write instructions) |
| `claim` | One sentence the check depends on, written so it can be false |
| `appliesTo` | The AI tools the claim is about (`claude-code`, `codex`, `cursor`, `copilot`, `gemini-cli`, `windsurf`), `all` for every tool or the repository, or `n/a` when it is not about an AI tool (a package manager, a language, a framework, git) |
| `sources` | Pages that were actually read, each with the date (`readOn`), a `stance` and a one-sentence note |
| `evals` | For an opinion, a path or URL of an eval that shows the advice changes what an agent does (none exists yet) |
| `unverified` / `refuted` | See the status below |
| `caveat` | Something a reader should know that is not a source, such as a vendor banner announcing a replacement product |
| `thresholds` | Every numeric cut-off the check uses, each with its own source, or `unverified` for the author's own heuristic |
| `lastVerified` | `{ date, by }`: when, and who or what verified it |

A source is never reconstructed from memory. If nobody fetched the page, it is not a source. Store
the URL the page finally resolves to, not a redirecting one.

## Status

`provenanceStatus(record)` says what a record stands on:

- **`repo-fact`**: a statement about the scanned repository. Needs no source and never expires.
- **`sourced`**: a tool-fact with at least one source whose stance is `supports` (or an eval). A page
  that only `contradicts` or gives `context` does not make it sourced.
- **`unverified`**: nothing supports the claim. A result, not a failure: the check rests on judgement
  and says so. An opinion is `unverified` unless an eval supports it: documentation is related
  reading, not an eval. An unverified record may keep `context` sources (and, for an opinion, any
  related documentation).
- **`refuted`**: the only on-point source contradicts the claim, so the check is probably wrong. A
  refuted check is reviewed by a person; it is never retired automatically, and each one has an
  issue in the detector repository.

Stances are judged against `appliesTo`: a page about the Claude API says nothing about Cursor.

## Rules and the expiry check

Two sets of rules, run in different places on purpose:

- **Structure** (`provenanceStructureProblems`) needs no clock, so it runs in `pnpm test`
  (`packages/core/tests/provenance.test.ts`): the statuses above, real dates, a record not verified
  before a source it cites was read, and a record for every detector in `DETECTORS`, so a new
  detector cannot ship without one.
- **Expiry** (`provenanceDateProblems`) reads the clock, so it is not part of `pnpm test`: it would
  turn every pull request red on the day the records age out, and a rebuild of an old tagged release
  with it. It runs as `pnpm provenance:check` (`scripts/check-provenance.mjs`) from
  `.github/workflows/provenance.yml`, weekly and on demand. It **fails** when a `tool-fact` or
  `opinion` (of any status) has a `lastVerified` more than 90 days old, naming the check and the
  sources to re-read, and **warns** (an annotation on a green run) for every record within 30 days
  of expiring. `PROVENANCE_TODAY=2027-02-01 pnpm provenance:check` shows what a given day would say.

## Re-verifying

When the weekly run warns (or fails), for each record it names:

1. Read each source again (its URL, as stored, is the page to open) and read any vendor changelog
   that touches the claim.
2. Correct the `claim` or the notes if the page changed, set each `stance` to what the page says now,
   and set the `unverified` or `refuted` flag if the status changed.
3. Update `readOn` on every source you re-read, and `lastVerified` to `{ date, by }`.
4. Run `pnpm test` and `pnpm provenance:check`.

A check whose record became `refuted` gets an issue in the detector repository; the check itself is
changed in its own pull request, not in the provenance one.
