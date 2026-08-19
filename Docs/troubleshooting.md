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
- Duplicate detector fires on shared sections — sections under headings like "Overview", "Summary", "Project Description", "Introduction", and "License" are filtered from duplicate detection (both near-duplicate and exact-match). If a non-boilerplate section is flagged unexpectedly, suppress it inline with a `promptci-ignore` comment.
- Dead-reference detector fires on source-code file paths (e.g. `lib/upload.ts`) — a referenced path is flagged only when the scanner cannot find it on disk. When you scan a real repository the file usually exists, so the finding does not appear; it shows up mainly when instruction files are scanned in isolation from the code they reference.
- Conflict detector fires on unrelated directives — if you see spurious conflicts, check if the matched subject words are actually the same concept.

`severityThreshold` does **not** hide findings — every finding is always listed in the report. It only sets the default `--fail-on` gate (the lowest severity that makes `scan` exit non-zero), so *raising* it toward `critical` makes CI *more* lenient, not quieter. To genuinely reduce noise, use `exclude` patterns or inline `promptci-ignore` comments (see [cli-reference.md](cli-reference.md#severitythreshold-config-key)).

### `init && scan` exits 1 on my very first run

`scan` inherits `severityThreshold` from `.promptci/config.json` as its default `--fail-on`
gate. Newer configs seed `"high"`, so warnings pass; if your config predates that (or was set
to `"warning"`/`"info"`), the first scan exits 1 on warning-level findings. The failure message
now names the threshold and where it came from. Raise it to `"high"` in the config, or pass an
explicit `--fail-on high`. See [cli-reference.md](cli-reference.md#severitythreshold-config-key).

### "--fail-on" exits 1 unexpectedly in CI

The exit code is 1 whenever any issue meets or exceeds the threshold. Use `--fail-on high` (not `warning`) for a less strict CI gate while you're cleaning up existing findings.

### "Error: no dashboard URL configured"

`login` and `upload` talk to a dashboard that has no public endpoint yet, so they will not
guess one. Pass `--url https://your-dashboard`, set `PROMPTCI_API_URL`, or add `apiUrl` to
`.promptci/config.json`. `promptci login --url <url>` remembers the value in
`~/.promptci/global.json` for later runs.

Everything else — `scan`, `fix`, `context`, `review-diff`, `doctor` — works without a
dashboard.

### review-diff: "Could not resolve base branch/commit"

The base ref has to exist in the local clone. In CI, `actions/checkout` makes a depth-1 clone
by default, so `origin/main` often is not there — set `fetch-depth: 0` on the checkout step.

### review-diff reports no changes for edits I just made

By default `review-diff` compares the **HEAD commit** against the base, so uncommitted work is
not counted (that is what keeps local scratch edits out of a PR's regression report). Commit
first, or pass `--working-tree`.

### Windows path separators in report output

File paths in the report reflect the OS path separator. This is expected on Windows.
