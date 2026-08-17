# promptci

Instruction health for AI coding workflows. Scans AI coding instruction files
(`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, Copilot instructions, and more) and produces
actionable health reports: duplicates, conflicting directives, stale guidance, context bloat,
broken references, and vague instructions.

The scanner is deterministic and rule-based — no LLM calls, no network access, identical
output for identical input.

## Usage

```bash
npx promptci scan
```

Writes `.promptci/latest.md` (human-readable) and `.promptci/report.json` (machine-readable),
and prints a summary with a health score and top fixes.

Common commands:

```bash
npx promptci scan --path /path/to/repo   # scan a specific repo
npx promptci init                        # create .promptci/config.json
npx promptci explain                     # explain findings (BYO OpenAI/Anthropic key)
npx promptci review-diff --base origin/main   # CI: fail on instruction regressions
```

Full documentation: https://github.com/SeriousGeese/PromptCI

## License

Apache-2.0. The scanner engine lives in [`@promptci/core`](https://www.npmjs.com/package/@promptci/core).
