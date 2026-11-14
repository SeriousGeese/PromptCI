# CLI Reference

Detailed command-line interface documentation for PromptCI.

For repo-specific checks beyond the built-in detectors, see
[custom-rules.md](custom-rules.md) — the `.promptci/custom-rules.json` rule format.

```bash
# Quick score (also what a bare `promptci` runs)
promptci score                              # print the health score + top 3 findings; writes nothing, no network
promptci score --path <dir>                 # score a specific directory

# Scanning
promptci scan                               # scan current directory
promptci scan --path <dir>                  # scan a specific directory
promptci scan --json                        # print JSON report to stdout (files are still written)
promptci scan --format sarif                # print SARIF 2.1.0 to stdout and write .promptci/report.sarif
promptci scan --format json                 # same as --json
promptci scan --output <file>               # write markdown report to this path instead of default
                                             # (SARIF path instead, when --format sarif is set)
promptci scan --fail-on <severity>          # exit 1 if any issues meet/exceed severity (info|warning|high|critical)
promptci scan --baseline <path>             # load baseline file to ignore existing issues
promptci scan --update-baseline             # run scan and save findings as the new baseline
promptci scan --fail-on-new <severity>      # exit 1 only if NEW issues (not in baseline) meet this threshold (requires --baseline)
promptci scan --fail-on-budget              # exit 1 if any context bloat issues are found
promptci scan --context-budget <chars>      # override total context budget (in characters)
promptci scan --file-context-budget <chars> # override per-file context budget (in characters)
promptci scan --target-model <model>        # scale context-bloat thresholds to a model preset (e.g. claude-opus-5)

# Context Analysis
promptci context analyze                    # print context analysis without writing scan reports
promptci context analyze --path <dir>       # target directory to analyze
promptci context analyze --json             # print JSON analysis to stdout

# Context Optimization (previews by default — see below)
promptci context optimize                   # preview a refactor that splits volatile or large sections
promptci context optimize --path <dir>      # target directory to optimize
promptci context optimize --dry-run         # print the diff without modifying files (the default)
promptci context optimize --write           # apply the previewed changes to disk

# Fix
promptci fix                                # interactively fix deterministic issues
promptci fix --issue <id>                   # fix a specific issue by its ID
promptci fix --no-interactive               # apply all fixes without prompting
promptci fix --dry-run                      # preview changes without writing to disk

# Branch Diff
promptci review-diff                        # compare current branch against main
promptci review-diff --base <branch>        # compare against a specific base branch or commit
promptci review-diff --path <dir>           # target a specific directory
promptci review-diff --json                 # print structured comparison JSON to stdout
promptci review-diff --fail-on-regression   # exit 1 if score decreases or new issues are introduced
promptci review-diff --fail-on <severity>   # exit 1 if any issue on this branch is at or above severity
promptci review-diff --working-tree         # compare uncommitted work instead of the HEAD commit

# Badge
promptci badge                              # scan, then write .promptci/health-badge.json (Shields.io endpoint JSON)
promptci badge --path <dir>                 # target directory to scan
promptci badge --report <file>              # take the score from an existing report.json instead of scanning
promptci badge --output <file>              # badge JSON path, relative to --path
promptci badge --label <text>               # badge label (default: "instruction health")

# Doctor
promptci doctor                             # verify config, .gitignore, and system dependencies
promptci doctor --path <dir>                # check a specific directory

# Setup
promptci init                               # create .promptci/config.json and add the .promptci/ ignore rules

promptci --version
promptci --help
```

## `score`: the zero-footprint teaser

`promptci score` (and a bare `promptci` / `npx @promptci/cli`) scans the directory and prints one
overall score plus the three top findings. Use `promptci scan` for full local reports.
Sample output is in the [README quickstart](../README.md#quickstart).

- **No network.** It also skips the once-a-day npm version check that other commands run.
- **No writes.** It does not create `.promptci/` reports or history; it only reads your files and
  an existing `.promptci/config.json` (same `include`, `exclude`, `projectType`, budgets, and
  `targetModel` as `scan`, so the two commands report the same score).
- **No account or upload.** Nothing is sent anywhere and nothing is stored.
- **Ranking.** Findings are ordered by severity, then confidence, then id (deterministic), and are
  not de-duplicated by category. `scan`'s "Top fixes" uses the same leading order but keeps only
  one finding per category, so the two lists can differ when a category has several top findings.
- **Exit codes.** `0` after printing a score, or "nothing to score" when no instruction files are
  found, whatever the findings. `1` for a missing or non-directory `--path`, or an unreadable
  `.promptci/config.json`. To gate CI, use `scan --fail-on <severity>` or `review-diff`.

## `context optimize` is preview-first

`context optimize` rewrites instruction files in place and moves whole sections into new
documents under `Docs/`. There is no undo, so it **previews by default** and writes only
when you pass `--write`:

```bash
promptci context optimize            # read the diff
promptci context optimize --write    # then apply it
```

Two things it deliberately will not do:

- **It never touches `README.md`.** The scanner reads your README for context cost, but
  restructuring a human-facing document is not what `optimize` is for.
- **It only extracts sections holding generated output** — a `Health Score: 87` line, a
  `Files scanned:` count, a pasted `# PromptCI Health Report`, or its `Generated by
  PromptCI` footer. Prose that merely mentions scan history or PromptCI reports stays put.

## What `promptci fix` will apply

Most findings are advisory: their `fixRecipe` is text for a human (or an agent) to act on,
because applying it needs judgement. `promptci fix` offers only the recipes the engine can
perform as a mechanical, reviewable edit, and a finding opts in explicitly — the report marks
those with `autoApplySafe`. Everything else is reported and left alone, so on a healthy
repository `fix` may well have nothing to offer.

The five it can apply today:

| Finding | What it does | Only when |
| --- | --- | --- |
| `security-pack-no-promptci-gitignore` | Appends the baseline-preserving `.promptci/` stanza to `.gitignore` | No active line already covers `.promptci` |
| `security-pack-unignored-dirs` | Appends each flagged build/dependency directory to `.gitignore` | No active line already covers that directory |
| `duplicate-*` (cross-file) | Keeps one canonical copy (`AGENTS.md` if it is one of them) and replaces the others with a link to it | The duplicate spans at least two files |
| `cmd-validity-*` | Rewrites a **misspelled** package-manager script name to the one the manifest defines | Exactly one defined script is a close match **and** the difference is a misspelling rather than a different script — see below. The command must name a single script, and the text to replace must appear once on its line |
| `dead-ref-*` | Re-points a broken relative markdown link at the file it names | Exactly one non-ignored file in the repository carries that basename, the scan could read the whole tree, every occurrence of that target is a plain inline **file** link outside any code fence or span, the path it would be rewritten to needs no escaping and is not the linking file itself, and each occurrence appears once on its line |

A close match is not enough to rewrite a script name, because most one-edit neighbours of a
script name are a real sibling script: `test:api` → `test:app`, `test:unit` → `test:init`,
`db:up` → `db:rm`, `build:v1` → `build:v2` are each the unique nearest neighbour, and each
rewrite would silently run the wrong command. A rewrite is applied only when all of the
following hold (`packages/core/src/close-match.ts`):

- it is a pure case or separator difference (`type-check` → `typecheck`); **or**
- both names have the same number of `:`-separated segments with the difference confined to
  one of them, within one edit (two only for names of 8+ characters), the differing segments
  are not a trailing-digit variant of each other (`v1`/`v2`, `py2`/`py3`), and — for a
  differing segment under 5 characters — the change is a transposition or a mid-name digit
  swap rather than a substituted letter.

A candidate that fails those tests is still named, cautiously, in the finding's
`recommendation`; it is simply never applied for you.

Ambiguity always loses elsewhere too. Two equally close script names, two files sharing a
basename, a tree the scan could not fully list, or a link form the recipe does not reassemble
(a link title, a `<bracketed>` target) all leave the finding advisory rather than guessing. The
last two recipes name the exact text they replace and refuse to run unless it is still there,
so a fix computed against a file that has since changed applies nothing instead of editing the
wrong line — and an issue whose edits cannot all be applied applies none of them.

GitHub Actions `uses:` references pinned to a tag are reported but never rewritten: resolving
a tag to the commit SHA you actually want needs a network lookup against the action's own
repository, which a deterministic, offline scanner will not do.

## `badge`: a README health badge

`promptci badge` writes a [Shields.io endpoint](https://shields.io/badges/endpoint-badge) JSON
document with the health score — and nothing else: no finding text, file names, or file
contents.

```json
{
  "schemaVersion": 1,
  "label": "instruction health",
  "message": "92/100",
  "color": "brightgreen"
}
```

The colour follows the report's score bands: `brightgreen` (90+, Healthy), `yellowgreen`
(70–89, Fair), `orange` (50–69, Needs attention), `red` (below 50).

By default it scans the repository with the same `.promptci/config.json` settings as `scan`
(without writing the scan reports). Pass `--report .promptci/report.json` to reuse the score of a
scan you already ran — for example right after `promptci scan` in CI.

Commit the file and point a Shields.io endpoint badge at its raw URL (URL-encoded):

```markdown
[![instruction health](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2F<owner>%2F<repo>%2F<branch>%2F.promptci%2Fhealth-badge.json)](https://github.com/SeriousGeese/PromptCI)
```

The recommended `.gitignore` stanza ignores `.promptci/*`, so add an exception for the badge:

```gitignore
!**/.promptci/health-badge.json
```

The badge is **self-reported**: it shows whatever the last committed scan produced. Regenerate it
in CI (and fail if the committed copy is stale) if you want it to stay honest — this repository
does exactly that for its own badge. Shields.io fetches the JSON from your repository when the
README is viewed; PromptCI itself makes no network request.

## `severityThreshold` config key

`.promptci/config.json` may set `severityThreshold` (`info` | `warning` | `high` | `critical`).
It is **`scan`'s default `--fail-on` value** — the lowest severity that makes a scan exit
non-zero — and nothing else:

- It is **not a display filter.** Every finding is always listed in the report regardless of
  the threshold; the key only affects the process exit code.
- An explicit `--fail-on <severity>` on the command line **overrides** it.
- `promptci init` seeds `"high"`, so a fresh `promptci init && promptci scan` exits 0 on the
  ordinary warning-level findings a new repo produces, while still failing CI on `high` and
  `critical`. Lower it to `warning` (or `info`) for a stricter gate; raise it to `critical` for
  the most lenient one.

When the threshold causes a non-zero exit, `scan` prints which severity fired and whether it
came from `--fail-on` or from `severityThreshold` in the config, so an inherited gate is never a
silent surprise.

## `vagueGuidanceSeverity` config key

`.promptci/config.json` may set `vagueGuidanceSeverity` (`info` | `warning`) to force **every**
vague-guidance finding to that severity. By default the detector tiers its own output: high-signal
platitudes ("write clean code", "best practices", "SOLID principles", "clean architecture",
"be careful", …) are reported at `warning`, while softer style/UX/paradigm phrases ("great user
experience", "user-friendly", …) are `info`. Set the key to `warning` to hold all vague guidance
to the stricter tier, or to `info` to demote every vague-guidance finding below a `warning` gate.
The override changes only the severity; each finding's confidence still reflects its matched tier.

## `targetModel` config key

`.promptci/config.json` may set `targetModel` to scale the **context-bloat** thresholds to the
model that will actually carry the instructions each turn. A fixed character budget is a blunt
instrument — 30k characters is a large slice of a small context window but a rounding error in a
1M-token one — so the preset derives a total and per-file character budget from the model's
approximate context window.

- Recognised model ids: `claude-opus-5`, `claude-opus-4-8`, `claude-sonnet-5`, `claude-sonnet-4-6`,
  `claude-haiku-4-5`, `claude-fable-5`, `gpt-5`, `gpt-5-mini`, `gemini-2.5-pro`, `gemini-2.5-flash`.
  Short family aliases also work: `claude`, `claude-opus`, `claude-sonnet`, `claude-haiku`, `gpt`,
  `openai`, `copilot`, `gemini`.
- `--target-model <model>` on the command line **overrides** the config value.
- An explicit `--context-budget` / `--file-context-budget` (flag or config) **overrides the preset**
  for that budget — the preset only fills in the budgets you did not set yourself.
- Same preset in local scans and the GitHub Action: set `targetModel` in `.promptci/config.json`
  and both the `scan` and `review-diff` paths pick it up.
- An unknown model name is a hard, actionable error at scan time (it names the offending key and
  lists the valid ids) rather than a silent fallback.

The window numbers behind the presets are approximate and used only to scale the heuristic; a dated
staleness guard in the test suite fails when the table ages out, forcing a periodic refresh so it
cannot silently rot.

## How `review-diff` compares two revisions

Both sides are real checkouts. `review-diff` creates a temporary `git worktree` for the base
commit — and, by default, for `HEAD` too — then scans each with the **same** project config
from `.promptci/config.json`. Symmetry is the whole point: a difference in the report has to
come from the code, not from the two sides being scanned differently.

Two consequences worth knowing:

- **It compares commits, not your working tree.** Uncommitted edits are invisible by default,
  so local scratch work is not reported as a regression your branch introduced. Pass
  `--working-tree` to include it.
- **The base commit must exist locally.** In CI that means fetching history —
  `actions/checkout` defaults to a depth-1 clone, where `origin/main` may not be present:

  ```yaml
  - uses: actions/checkout@v5
    with:
      fetch-depth: 0
  ```

The temporary worktrees are removed when the command exits, including on failure.

`--fail-on-regression` and `--fail-on` are independent gates, and both are evaluated when both
are passed. The first asks "did this branch make things worse than the base?"; the second asks
"is anything on this branch at or above `<severity>`?" — a branch can be regression-free and
still fail the absolute threshold it inherited.

## Baselines and the CI ratchet

`--baseline` / `--update-baseline` / `--fail-on-new` read and write
`.promptci/baseline.json`. The ratchet only holds if that file is **committed** — CI checks out
the repo and has nothing else to compare against.

`--fail-on-new` is meaningless on its own: without `--baseline` there is nothing to diff
against, so the flag is rejected rather than passing silently. Always pair them:
`promptci scan --baseline .promptci/baseline.json --fail-on-new warning`. If the baseline file
does not exist yet, it is treated as empty — every finding counts as new.

So ignore the generated reports without ignoring the baseline:

```gitignore
# PromptCI: ignore generated reports, keep the shared baseline and config
**/.promptci/*
!**/.promptci/baseline.json
!**/.promptci/config.json
```

`promptci init` and `promptci fix` both write exactly this. Two details matter: `.promptci/*`
rather than `.promptci/` (git does not descend into an ignored *directory*, so a trailing slash
leaves the negations unreachable), and the leading `**/` (a pattern containing a slash is
otherwise anchored to the repo root and misses nested packages).

A typical flow:

```bash
promptci scan --update-baseline    # accept today's findings as the starting point
git add .promptci/baseline.json && git commit -m "chore: add promptci baseline"
promptci scan --fail-on-new warning   # in CI: fail only on findings added since
```

### Unscored findings

Two checks fire on nearly every repository, so they are reported but do not count toward the
health score: the repository-level agent-practice finding (common practices no instruction file
mentions) and the per-workflow unpinned GitHub Actions finding. Both are `info` and carry the
`unscored` tag; `@promptci/core` exports `UNSCORED_TAG` and `isScored(issue)` for consumers that
re-score or filter findings, and `computeHealthScore` skips them. Third-party unpinned actions
are `info` like GitHub's own, so `--fail-on warning` does not fail on them.

### Grouped findings and fingerprints

A finding is matched to the baseline by its fingerprint: category, title, file paths and
evidence, never the id or line numbers. Two grouped findings use a fixed identity instead,
because their evidence is a list that changes as the repository improves: the agent-practice
finding (one per repository, listing the practices not found) and the action-pin finding (one per
workflow file, listing its unpinned actions). They carry a `fingerprintKey`, and their
fingerprint hashes only the category and that key. Pinning one action, adding one rule or adding
an instruction file keeps them baselined, and so does a grouped finding that grows (one more
unpinned action): both are `info` and do not count toward the health score. A workflow that gets
its first unpinned action is a new finding. `review-diff --fail-on-regression`, the scan trend
(`trend.newIssueIds`, `trend.resolvedIssueIds` and their counts) and SARIF `partialFingerprints`
use the same fingerprint. `fingerprintKey` is an optional field on `PromptCiIssue` and is written
to `report.json` with the rest of the finding.

Upgrading from 0.3.0: a baseline (or previous `report.json`) written by 0.3.0 has these findings
under their old, per-practice and per-action form, so the first scan with the new version shows
the two grouped findings as new once, and the old ones as resolved. They are `info`, so only
`--fail-on-new info` trips on it; refresh the baseline with `--update-baseline`.

## SARIF

`promptci scan --format sarif` writes `.promptci/report.sarif` (override the path with
`--output`, which then names the SARIF path instead of the markdown one) and prints the same
SARIF 2.1.0 log to stdout. `--format json` is equivalent to `--json`.

Upload it with [`github/codeql-action/upload-sarif`](https://github.com/github/codeql-action)
to see findings in the repository's Security tab:

```yaml
permissions:
  contents: read
  security-events: write
  actions: read

jobs:
  promptci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      # `--format sarif` needs @promptci/cli 0.3.0 or later.
      - run: npx --yes @promptci/cli@0.3.0 scan --format sarif
      - uses: github/codeql-action/upload-sarif@33d7b85da1a04171e211befe2c739303b9a4c066 # v4.39.3
        if: always()
        with:
          sarif_file: .promptci/report.sarif
```

The upload step runs `if: always()` so a scan that exits non-zero (e.g. `--fail-on high`) still
uploads the findings that caused the failure, instead of the Security tab silently going stale
on every red run.

`critical`/`high` findings map to SARIF `error`, `warning` stays `warning`, and `info` maps to
`note`. Findings silenced by an inline `promptci-ignore` annotation are still included, each
marked with a SARIF `suppressions` entry rather than dropped — GitHub's SARIF documentation does
not promise any particular handling of `suppressions`-bearing results, so treat this as "marked
suppressed in the SARIF," not a guarantee about how a given consumer displays it.

`ruleId` is the issue's `category` (`duplicate`, `conflict`, `context_bloat`, …) — the only
detector/category identifier present on every finding today. This is coarser than one rule per
detector: renaming or splitting a *category* later would change every result's `ruleId` and, in
a consumer that keys dismissals off it, could reopen alerts a user had already dismissed under
the old id. A finer, per-check rule id would need `PromptCiIssue` to carry an explicit, detector-
assigned rule id distinct from `category` — noted here as a possible follow-up, not done in this
change.

Each finding's `partialFingerprints["promptci/v1"]` is PromptCI's own stable identity key (the
same category+title+filePaths+evidence fingerprint `--baseline` already uses, or category plus
`fingerprintKey` for the two grouped findings described under Baselines) — it is a hint for
GitHub's own cross-run matching, not the `primaryLocationLineHash` GitHub computes and uses
itself. Within a single run, multiple findings can legitimately share the same `promptci/v1`
value (the fingerprint excludes line numbers, so e.g. two instances of the same duplicate check
on different lines fingerprint identically); each gets a trailing `:N` occurrence suffix so
results that share a fingerprint still have distinct `partialFingerprints` within that run.

Locations are written relative to whatever directory `--path` scans — `uri: "AGENTS.md"` means
"AGENTS.md at the root of the scanned directory," not necessarily the repository root. Scanning
a subdirectory of a monorepo (`--path packages/foo`) therefore produces URIs relative to
`packages/foo`, which will not line up with the checked-out repository root in GitHub's Security
tab. Either run the scan from the repository root, or have the SARIF consumer account for the
offset (`upload-sarif` accepts a `checkout_uri`/`checkout_path` for this).

The GitHub Action ([action.yml](action.yml)) does not yet expose a `format` input for this —
run the CLI step above directly until it does.
