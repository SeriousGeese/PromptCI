# Troubleshooting

Common issues and solutions when running or configuring PromptCI.

### No files scanned / health score 100 with no issues on a real repo

Default patterns scan:
`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.windsurfrules`, `.cursor/rules/**`, `.github/copilot-instructions.md`, `.github/instructions/**/*.md`, `.claude/**/*.md`, `README.md`, `ai/**/*.md`, `ai-instructions/**/*.md`, `prompts/**/*.md`, `system-prompts/**/*.md`

Note: `docs/**/*.md` is intentionally **not** scanned by default — documentation directories tend to contain project docs (QA reports, plans) that generate false positives, not AI instruction files. If your instruction files live in `docs/`, add the specific paths to `include` in `.promptci/config.json`.

### "Error: path does not exist"

The `--path` argument must be an existing directory. Use an absolute path or verify the relative path from your working directory.

### "Failed to parse .promptci/config.json: invalid JSON"

Your config file has a syntax error. Validate it at [jsonlint.com](https://jsonlint.com) or run `node -e "require('fs').readFileSync('.promptci/config.json','utf8'); console.log('ok')"`.

### Too many false positives

Common causes:
- Large monorepos where many files legitimately share boilerplate — use `exclude` to skip generated or archived docs.
- Duplicate detector fires on shared sections — sections under headings like "Overview", "Summary", "Project Description", "Introduction", and "License" are filtered from duplicate detection (both near-duplicate and exact-match). If a non-boilerplate section is flagged unexpectedly, check whether the heading is generic enough to add to a future exclusion list.
- Dead-reference detector fires on source-code file paths (e.g. `lib/upload.ts`) — these are legitimate if the file exists in the repo but the fixture is instruction-files-only. In production scans against a real repo this resolves naturally.
- Conflict detector fires on unrelated directives — if you see spurious conflicts, check if the matched subject words are actually the same concept.

To reduce noise, raise the `severityThreshold` in config to `warning` or `high` so info-level findings are suppressed in CI.

### "--fail-on" exits 1 unexpectedly in CI

The exit code is 1 whenever any issue meets or exceeds the threshold. Use `--fail-on high` (not `warning`) for a less strict CI gate while you're cleaning up existing findings.

### review-diff: "Could not resolve base branch/commit"

The base ref has to exist in the local clone. In CI, `actions/checkout` makes a depth-1 clone
by default, so `origin/main` often is not there — set `fetch-depth: 0` on the checkout step.

### review-diff reports no changes for edits I just made

By default `review-diff` compares the **HEAD commit** against the base, so uncommitted work is
not counted (that is what keeps local scratch edits out of a PR's regression report). Commit
first, or pass `--working-tree`.

### Windows path separators in report output

File paths in the report reflect the OS path separator. This is expected on Windows.
