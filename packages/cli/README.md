# @promptci/cli

Instruction health for AI coding workflows. Scans AI coding instruction files
(`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, Copilot instructions, `GEMINI.md`, Cline rules, and
more) and produces
actionable health reports: duplicates, conflicting directives, stale guidance, context bloat,
broken references, and vague instructions.

The scanner is deterministic and rule-based — no LLM calls, no network access, identical
output for identical input.

## Usage

```bash
npx @promptci/cli          # quick score + top 3 findings: no account, no network, writes nothing
npx @promptci/cli scan     # full scan and reports
```

The no-argument form is `promptci score`; see the
[main README](https://github.com/SeriousGeese/PromptCI#quickstart) for sample output.

Writes `.promptci/latest.md` (human-readable) and `.promptci/report.json` (machine-readable),
and prints a summary with a health score and top fixes.

Common commands:

```bash
npx @promptci/cli scan --path /path/to/repo   # scan a specific repo
npx @promptci/cli init                        # create .promptci/config.json
npx @promptci/cli fix                         # apply deterministic fix recipes
npx @promptci/cli review-diff --base origin/main   # CI: fail on instruction regressions
npx @promptci/cli badge                       # write a Shields.io JSON for a README score badge
```

Full documentation: https://github.com/SeriousGeese/PromptCI

## License

Apache-2.0. The scanner engine lives in [`@promptci/core`](https://www.npmjs.com/package/@promptci/core).
