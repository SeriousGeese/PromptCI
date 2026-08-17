# PromptCI

> Instruction health for AI coding workflows.

<!-- promptci-ignore-start: structure
     reason: This intro names CLAUDE.md and AGENTS.md as the file types PromptCI scans.
     They are product terminology here, not references to files in this repository. -->
PromptCI scans AI coding instruction files (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, Copilot
instructions, README-style context, and more) and produces actionable health reports so you can
catch instruction rot before it costs you.

The scanner is **deterministic and rule-based** — no LLM calls, no network access, identical
output for identical input. It runs entirely on your machine; your files never leave it.

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

```bash
npx @promptci/cli scan
```

The scan writes two files and prints a summary with a health score and top fixes:

- `.promptci/latest.md` — human-readable Markdown report
- `.promptci/report.json` — machine-readable JSON

Ignore the generated reports but keep `baseline.json` and `config.json` committed — the CI
ratchet (`--baseline` / `--fail-on-new`) reads the baseline from the checkout. `promptci init`
writes this for you:

```gitignore
**/.promptci/*
!**/.promptci/baseline.json
!**/.promptci/config.json
```

Both details matter: `.promptci/*` rather than `.promptci/`, because git does not descend into
an ignored directory and the `!` lines would never take effect; and the leading `**/`, because a
pattern containing a slash is otherwise anchored to the repo root and would miss nested packages.

Common commands:

```bash
npx @promptci/cli scan --path /path/to/repo    # scan a specific repo
npx @promptci/cli init                         # create .promptci/config.json
npx @promptci/cli explain                      # explain findings (BYO OpenAI/Anthropic key)
npx @promptci/cli fix                          # apply deterministic fix recipes
npx @promptci/cli doctor                       # diagnose setup problems
```

See [Docs/cli-reference.md](Docs/cli-reference.md) for the full command reference and
[Docs/troubleshooting.md](Docs/troubleshooting.md) for common problems.

## CI integration

Fail pull requests that make instruction files worse:

```yaml
- uses: SeriousGeese/PromptCI@main
  with:
    fail_on_regression: 'true'
    base_branch: 'main'
```

Or run the CLI directly:

```bash
npx @promptci/cli review-diff --base origin/main --fail-on-regression
```

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
- AI cost reduction opportunities (cache-hostile content, verbosity, context splits)

Findings are heuristic and cautiously worded; every one carries evidence, a recommendation,
and a confidence value.

## Configuration

`promptci init` creates `.promptci/config.json`:

```json
{
  "severityThreshold": "warning",
  "projectType": "auto"
}
```

Suppress a finding inline where it is wrong for your project:

```markdown
<!-- promptci-ignore: context_bloat
     reason: This section documents a product feature, not pasted output. -->
```

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
integration) is developed separately and is not part of this repository. The
`login`, `auth`, and `upload` CLI commands connect to it; everything else works without it.

There is no public endpoint yet, so those commands need one supplied explicitly — via
`--url`, the `PROMPTCI_API_URL` environment variable, or `apiUrl` in
`.promptci/config.json`. They error out rather than guessing a default.

## Contributing

Bug reports, false-positive reports, and detector proposals are welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md) and the issue templates. Security problems go through
private advisories rather than public issues; see [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE) © SeriousGeese. "PromptCI" is a trademark of SeriousGeese; the license
covers the code, not the name.
