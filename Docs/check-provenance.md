# Check provenance

Every check encodes a claim: about a repository, about an AI coding tool, or about how to write
instructions for a model. A provenance record says which, where the claim comes from, which tools it
is about and when someone last checked it. The records live in
[`packages/core/src/provenance/`](../packages/core/src/provenance/), next to the detectors they
describe, and `@promptci/core` exports them so a consumer can show "applies to" and "last verified"
per check.

```ts
import { CHECK_PROVENANCE, provenanceFor } from '@promptci/core';

provenanceFor('ai-config-mcp'); // every record for one detector id from DETECTORS
```

## A record

| Field | Meaning |
|---|---|
| `id` | The detector id, or `<detector-id>/<family>` when one detector rests on several claims |
| `detector` | The `DETECTORS` id in `packages/core/src/detectors.ts` |
| `kind` | `repo-fact` (a statement about the scanned repository), `tool-fact` (how a tool or framework behaves) or `opinion` (advice about how to write instructions) |
| `claim` | One sentence the check depends on, written so it can be false |
| `appliesTo` | `all`, or the tools the claim is about: `claude-code`, `codex`, `cursor`, `copilot`, `gemini-cli`, `windsurf` |
| `sources` | Pages that were actually read, each with the date (`readOn`), a `stance` (`supports`, `contradicts` or `context`) and a one-sentence note |
| `evals` | For an opinion, a path or URL of an eval that shows the advice changes what an agent does (none exists yet) |
| `unverified` | `true` when no source or eval was found. A result, not a failure: the check rests on judgement and says so |
| `thresholds` | Every numeric cut-off the check uses, each with its own source, or `unverified` for the author's own heuristic |
| `lastVerified` | `{ date, by }`: when, and who or what verified it |

A source is never reconstructed from memory. If nobody fetched the page, it is not a source; the
record is `unverified` instead.

## The three kinds age differently

- A **repo-fact** does not go stale (a file does not exist). It is exempt from expiry.
- A **tool-fact** goes stale when a vendor ships.
- An **opinion** goes stale as models improve.

## The expiry test

`packages/core/tests/provenance.test.ts` runs `provenanceProblems` over every record against today's
date and fails when:

- a `tool-fact` or `opinion` has a `lastVerified` more than 90 days old (the message names the check
  and the sources to re-read);
- a `tool-fact` or `opinion` has no source, no eval and is not explicitly `unverified`;
- a record says `unverified` and lists a source;
- a date is not a real `YYYY-MM-DD` date.

The same test checks that every detector in `DETECTORS` has at least one record and that no record
names a detector that does not exist, so a new detector cannot ship without one.
`provenanceExpiringSoon(records, today)` lists the records within 30 days of expiry, for a monthly
re-verification pass.

## Re-verifying a record

Read each source again, correct the claim or the note if the page changed, set `stance` to what the
page says now, and update `readOn` and `lastVerified`. A page that contradicts the check is recorded
as `contradicts`; the check is then reviewed by a person, never retired automatically.
