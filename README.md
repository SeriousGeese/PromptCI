# PromptCI

> Instruction health for AI coding workflows.

[![CI](https://github.com/SeriousGeese/PromptCI/actions/workflows/ci.yml/badge.svg)](https://github.com/SeriousGeese/PromptCI/actions/workflows/ci.yml)
[![instruction health](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2FSeriousGeese%2FPromptCI%2Fmain%2F.promptci%2Fhealth-badge.json)](.github/workflows/ci.yml)

PromptCI runs its own scanner against this repo in CI (see [.github/workflows/ci.yml](.github/workflows/ci.yml));
the health badge above reports the score from the committed baseline.

<!-- promptci-ignore-start: structure
     reason: This intro names CLAUDE.md, AGENTS.md, GEMINI.md, SOUL.md and friends as the
     file types PromptCI scans. They are product terminology here, not references to files in
     this repository. -->
PromptCI scans AI coding instruction files (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, Copilot
instructions, `GEMINI.md`, Cline's `.clinerules`, agent persona files such as `SOUL.md`,
README-style context, and more) and produces actionable health reports so you can catch
instruction rot before it costs you.

The scanner is **deterministic and rule-based** — no LLM calls, identical output for identical
input. It runs entirely on your machine; your files never leave it. The only network request
the package ever makes is a once-a-day, best-effort npm version check (see
[Hosted dashboard](#hosted-dashboard) for how to disable it).

## Why

AI coding workflows accumulate rot:

- `CLAUDE.md` grows endlessly
- `AGENTS.md` and Copilot instructions repeat each other
- Old project decisions linger after the codebase moved on
- Nobody knows which guidance is helping, hurting, ignored, or stale
<!-- promptci-ignore-end -->

PromptCI treats instruction files like maintainable engineering artifacts.

## Quickstart

Requires Node.js 22+.

For a 10-second read on your repo, run the CLI with no arguments (same as `promptci score`).
It needs no account, makes no network calls, and writes no files:

```bash
npx @promptci/cli
```

```text
PromptCI instruction health: 80/100 (Fair)

Top 3 findings (of 9):
  1. [warning] Vague guidance detected (AGENTS.md:11)
     Fix: Replace vague guidance with concrete constraints — specific commands, forbidden patterns, or measurable criteria. For example, replace "write clean code" with…
  2. [warning] No "read before edit" instruction (AGENTS.md)
     Fix: Add a rule such as: "Always read a file fully before editing it."
  3. [warning] No "ask when unsure" instruction (AGENTS.md)
     Fix: Add a rule such as: "If you are uncertain about the correct approach, say so and ask before proceeding rather than guessing."

Full report, score history, and PR reviews: https://promptci.dev (hosted dashboard; optional)
```

It always exits 0 after printing a score (it is a glance, not a gate); a bad `--path` or
unreadable `.promptci/config.json` exits 1. It uses the same config and score as `scan`, and
skips even the once-a-day version check. To get the full Markdown/JSON report, history, or a CI
gate, use `scan`:

```bash
npx @promptci/cli scan
```

The scan writes two files and prints a summary with a health score and top fixes:

- `.promptci/latest.md` — human-readable Markdown report
- `.promptci/report.json` — machine-readable JSON

Ignore the generated reports but keep `.promptci/baseline.json`, `.promptci/config.json`, and
`.promptci/custom-rules.json` committed — the CI ratchet (`--baseline` / `--fail-on-new`) reads
the baseline from the checkout, and custom rules must be committed so a local scan and the
GitHub Action see the same checks. `promptci init` writes this for you:

```gitignore
**/.promptci/*
!**/.promptci/baseline.json
!**/.promptci/config.json
!**/.promptci/custom-rules.json
```

Both details matter: `.promptci/*` rather than `.promptci/`, because git does not descend into
an ignored directory and the `!` lines would never take effect; and the leading `**/`, because a
pattern containing a slash is otherwise anchored to the repo root and would miss nested packages.

Common commands:

```bash
npx @promptci/cli score --path /path/to/repo   # quick score + top 3 findings, writes nothing
npx @promptci/cli scan --path /path/to/repo    # scan a specific repo
npx @promptci/cli init                         # create .promptci/config.json
npx @promptci/cli fix                          # apply deterministic fix recipes
npx @promptci/cli doctor                       # diagnose setup problems
npx @promptci/cli badge                        # write a Shields.io JSON for a README score badge
```

See [Docs/cli-reference.md](Docs/cli-reference.md) for the full command reference and
[Docs/troubleshooting.md](Docs/troubleshooting.md) for common problems.

## CI integration

Fail pull requests that make instruction files worse:

```yaml
- uses: actions/checkout@v5
  with:
    fetch-depth: 0        # review-diff compares against origin/<base_branch>
- uses: SeriousGeese/PromptCI@main
  with:
    fail_on_regression: 'true'
    base_branch: 'main'
    fail_on: 'high'       # also gate on absolute severity, not just regressions
```

The checkout step is required. `actions/checkout` defaults to `fetch-depth: 1` and fetches
only the PR head, so `origin/main` is not in the checkout and the comparison has nothing to
diff against. The action fetches the base ref itself as a fallback, but `fetch-depth: 0` is
the reliable form.

The fallback fetch assumes the remote is named **`origin`** (the name `actions/checkout`
always uses) and works with a depth-1 checkout — it pulls only the base branch tip, which is
all `review-diff` compares against. If you check out with a differently named remote, fetch
`origin/<base_branch>` yourself before the step, or use `fetch-depth: 0`.

`fail_on` and `fail_on_regression` are independent gates and both apply: a branch that
introduces no regression can still sit above the severity threshold. The action installs a
pinned CLI version; override it with the `cli_version` input (`'latest'` to always take the
newest release).

Or run the CLI directly:

```bash
npx @promptci/cli review-diff --base origin/main --fail-on-regression --fail-on high
```

## Health badge

Show your instruction-health score in your README, like the badge at the top of this page.
`promptci badge` scans and writes a Shields.io endpoint JSON (score only — no findings or file
contents) to `.promptci/health-badge.json`:

```bash
npx @promptci/cli badge
```

Commit that file (add `!**/.promptci/health-badge.json` to the PromptCI `.gitignore` stanza) and
reference its raw URL, URL-encoded, from a Shields.io endpoint badge:

```markdown
[![instruction health](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2F<owner>%2F<repo>%2F<branch>%2F.promptci%2Fhealth-badge.json)](https://github.com/SeriousGeese/PromptCI)
```

The score is self-reported by your own scan; regenerate the file in CI to keep it current. See
[Docs/cli-reference.md](Docs/cli-reference.md#badge-a-readme-health-badge) for the options.

## What gets detected

- Duplicate instruction sections, within and across files
- Conflicting directives (do/don't pairs, competing framework or version choices)
- Context bloat (file-size thresholds, token budget checks)
- Stale instructions (old years, dated TODOs, deprecated wording, outdated versions)
- Missing setup/validation commands and project-specific guidance
- Manifest consistency against `package.json` and `pyproject.toml`
- CI/workflow alignment between instructions and GitHub Actions
- Security and privacy gaps in instruction guidance
- Vague guidance, broken local references, agent-practice gaps
- Prompt-cache-hostile content that inflates the cost of every agent turn
- GitHub Actions `uses:` references (in workflows and composite actions) pinned to a tag or
  branch instead of a full commit SHA — detect-only, never rewritten; these findings cost at
  most 8 health-score points in total
<!-- promptci-ignore-start: structure
     reason: `.mcp.json` here names the config file the ai_config detectors audit,
     not a file this repo ships — PromptCI itself intentionally has no MCP config. -->
- AI-setup config rot beyond markdown: Agent Skills, subagents, hooks/settings,
  `.mcp.json` servers, and Cursor `.mdc` rules checked against filesystem reality
<!-- promptci-ignore-end -->
- Agent Skill supply-chain risk: SKILL.md files and their bundled scripts (under `.claude/`,
  `.agents/skills/`, and plugin `skills/` directories) read as text — never executed — for
  fetch-and-execute installers, remote code loading, credential exfiltration, prompt-injection
  and hidden text, and unpinned remote dependencies

Findings are heuristic and cautiously worded; every one carries evidence, a recommendation,
and a confidence value. Finding `id`s are derived from repo-relative paths, so they are the same
wherever the repo is checked out — upgrading from a release that hashed absolute paths changes
path-based ids once (baselines match on fingerprints, not ids, and are unaffected).

## Configuration

`promptci init` creates `.promptci/config.json`:

```json
{
  "severityThreshold": "high",
  "projectType": "auto"
}
```

`severityThreshold` is `scan`'s default `--fail-on` gate — the lowest severity that
makes a scan exit non-zero. It does **not** hide findings; the report always lists
everything. The default `"high"` lets a fresh `promptci init && promptci scan` pass on
ordinary warning-level findings while still failing CI on high/critical issues. See
[Docs/cli-reference.md](Docs/cli-reference.md#severitythreshold-config-key) for details.

Suppress a finding inline where it is wrong for your project:

```markdown
<!-- promptci-ignore: context_bloat
     reason: This section documents a product feature, not pasted output. -->
```

Add repo-specific checks in `.promptci/custom-rules.json` — deterministic `forbiddenPattern` and
`requiredSection` rules that run alongside the built-in detectors. Commit the file so a local
scan and CI evaluate the same rules; see [Docs/custom-rules.md](Docs/custom-rules.md).

## Repository structure

```
packages/
  core/   — scanner engine, detectors, scoring, report generation (@promptci/core)
  cli/    — CLI entrypoint (promptci)
examples/ — fixture repositories used as the test corpus
Docs/     — reference documentation
```

## Hosted dashboard

A hosted dashboard (scan history, improvement metrics, LLM-assisted fixes, GitHub PR
integration) is developed separately and is not part of this repository. This package is the
offline scanner only — it contains no LLM, auth, or upload code and makes no network requests
beyond the once-a-day npm version check described below. The hosted dashboard is optional:
`promptci score` only prints a one-line pointer to it, and nothing in the CLI logs in or uploads.

The one network touch in this package is a best-effort check against the npm registry, at most
once per day, for a newer `@promptci/cli` release. It never blocks a command and is skipped
entirely when `CI`, `NO_UPDATE_NOTIFIER`, or `PROMPTCI_NO_UPDATE_NOTIFIER` is set, and it never
runs for `promptci score`.

## Environment variables

The CLI reads only a few environment variables, all optional — there is no required configuration
and no `.env` file to create:

- `NO_UPDATE_NOTIFIER` — set to any value to disable the once-a-day npm version check.
- `PROMPTCI_NO_UPDATE_NOTIFIER` — PromptCI-specific alias for the same opt-out.
- `CI` — when set (as CI providers do automatically), the version check is skipped too.

Nothing else in the package inspects the environment. (Release automation in this repo
publishes to npm via OIDC trusted publishing — no npm token exists anywhere, and the CLI
reads no credentials at runtime.)

Never print, commit, or log secrets, tokens, or credentials — read any such variable silently, without echoing its value.

## Contributing

Bug reports, false-positive reports, and detector proposals are welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md) and the issue templates. Security problems go through
private advisories rather than public issues; see [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE) © SeriousGeese. "PromptCI" is a trademark of SeriousGeese; the license
covers the code, not the name.
