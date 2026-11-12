# Troubleshooting

Common issues and solutions when running or configuring PromptCI.

### No files scanned / health score 100 with no issues on a real repo

Default patterns scan:
`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.windsurfrules`, `GEMINI.md`, `.clinerules` (the single file, or `.clinerules/**/*.md` except `.clinerules/workflows/`), `SOUL.md`, `USER.md`, `TOOLS.md`, `.cursor/rules/**`, `.github/copilot-instructions.md`, `.github/instructions/**/*.md`, `.claude/**/*.md`, `README.md`, `ai/**/*.md`, `ai-instructions/**/*.md`, `prompts/**/*.md`, `system-prompts/**/*.md`

Bare file names match at the repository root only. `GEMINI.md` and the persona files
(`SOUL.md`, `USER.md`, `TOOLS.md`) are deliberately root-only: a nested `docs/USER.md` is far
more likely a user guide than an agent persona. Add nested copies to `include` if you want them
scanned (a nested persona-named file is then typed `unknown`, not `persona`).

GitHub Actions workflows (`.github/workflows/*.yml`) and composite actions (`action.yml` at the
root or under `.github/actions/`) are read separately — for the CI-alignment and action-pinning
checks — and are never scanned as instruction files. `exclude` patterns (including directory
patterns such as `.github/workflows`) also remove them from the action-pinning check.

Note: `docs/**/*.md` is intentionally **not** scanned by default — documentation directories tend to contain project docs (QA reports, plans) that generate false positives, not AI instruction files. If your instruction files live in `docs/`, add the specific paths to `include` in `.promptci/config.json`.

### "Error: path does not exist"

The `--path` argument must be an existing directory. Use an absolute path or verify the relative path from your working directory.

### "Failed to parse .promptci/config.json: invalid JSON"

Your config file has a syntax error. Validate it at [jsonlint.com](https://jsonlint.com) or run `node -e "require('fs').readFileSync('.promptci/config.json','utf8'); console.log('ok')"`.

### Too many false positives

Common causes:
- Large monorepos where many files legitimately share boilerplate — use `exclude` to skip generated or archived docs.
- Duplicate detector fires on shared sections — sections under headings like "Overview", "Summary", "Project Description", "Introduction", and "License" are filtered from duplicate detection (both near-duplicate and exact-match). If a non-boilerplate section is flagged unexpectedly, suppress it inline with a `promptci-ignore` comment.
- Dead-reference detector fires on source-code file paths (e.g. `lib/upload.ts`) — a referenced path is flagged only when the scanner cannot find it on disk. When you scan a real repository the file usually exists, so the finding does not appear; it shows up mainly when instruction files are scanned in isolation from the code they reference. A compiled-source file or a directory written in a code span (`src/payments/`) is only reported when its first path segment exists in the repository, and never when it is gitignored, under a build-output directory, or found deeper in the tree (an abbreviated path). Paths are matched with exact case on every platform, so `Docs/guide.md` is reported when the file is `docs/guide.md`, as it would be on Linux and GitHub. References that lead outside the scanned directory (`../other/AGENTS.md`, absolute paths, or through a committed symlink out of the tree) are not checked at all. When part of the repository cannot be listed (for example, a directory without read permission), the references that depend on it are left unchecked and a single warning, "Dead-reference check incomplete", names what could not be read.
- Command-validity detector fires on a documented command (`node scripts/x.js`, `./scripts/x.sh`, `docker compose -f`, `make <target>`, a package script): a command is flagged only when the script, file, or target it names cannot be found in the scanned repository. Paths are matched with exact case on every platform, as on Linux and in CI. Paths that lead outside the scanned directory (`../other/x.sh`, absolute paths, `~` or `$VAR` paths, or through a committed symlink out of the tree) are not checked at all. When part of the repository cannot be listed, the commands that depend on it are left unchecked and a single warning, "Command check incomplete", names what could not be read.
- Security and framework findings fire (or stop firing) based on whether a marker path exists — `.env`, `supabase/migrations`, `.promptci/`, a build directory like `coverage/`, `go.mod`, `Cargo.toml`, `Assets/`, `Pipfile`, `requirements.txt`. These are matched with exact case on every platform and are never followed through a committed symlink out of the scanned directory; see "A build-directory or framework finding changed after upgrading" below.
- Conflict detector fires on unrelated directives — if you see spurious conflicts, check if the matched subject words are actually the same concept.

`severityThreshold` does **not** hide findings — every finding is always listed in the report. It only sets the default `--fail-on` gate (the lowest severity that makes `scan` exit non-zero), so *raising* it toward `critical` makes CI *more* lenient, not quieter. To genuinely reduce noise, use `exclude` patterns or inline `promptci-ignore` comments (see [cli-reference.md](cli-reference.md#severitythreshold-config-key)).

### A build-directory or framework finding changed after upgrading

The checks that look for a fixed marker path now match a directory entry of **exactly**
that name on every platform, and never follow a committed symlink out of the scanned
directory. Two consequences:

- On Windows and macOS, a repository whose directory is `Logs/` is no longer reported as
  having an unignored `logs` directory. `fs.existsSync` matched that case-insensitively, so
  those scans produced a finding a Linux scan of the same checkout did not. Every platform
  now agrees with Linux and with GitHub. If you *want* the finding, name the directory in
  the case the check looks for (the lowercase form), or add it to `.gitignore` either way.
- A marker that only exists as a symlink pointing outside the repository (`go.mod ->
  ../elsewhere/go.mod`) no longer counts as present, so the framework pack it would have
  enabled stays off. In-repository symlinks are still followed.

The same exact-case rule has applied to dead references and documented commands since
earlier releases.

### `init && scan` exits 1 on my very first run

`scan` inherits `severityThreshold` from `.promptci/config.json` as its default `--fail-on`
gate. Newer configs seed `"high"`, so warnings pass; if your config predates that (or was set
to `"warning"`/`"info"`), the first scan exits 1 on warning-level findings. The failure message
now names the threshold and where it came from. Raise it to `"high"` in the config, or pass an
explicit `--fail-on high`. See [cli-reference.md](cli-reference.md#severitythreshold-config-key).

### "--fail-on" exits 1 unexpectedly in CI

The exit code is 1 whenever any issue meets or exceeds the threshold. Use `--fail-on high` (not `warning`) for a less strict CI gate while you're cleaning up existing findings.

### Does PromptCI phone home?

No. This package is the offline scanner: `scan`, `fix`, `context`, `review-diff`, `doctor`,
`badge`, and `init` all run entirely on your machine and make no network requests. (`badge` only
writes a JSON file; shields.io fetches it from your repository when someone views your README.) The single exception is a
best-effort npm version check that runs at most once a day and never blocks a command; disable it
by setting `CI`, `NO_UPDATE_NOTIFIER`, or `PROMPTCI_NO_UPDATE_NOTIFIER`.

### review-diff: "Could not resolve base branch/commit"

The base ref has to exist in the local clone. In CI, `actions/checkout` makes a depth-1 clone
by default, so `origin/main` often is not there — set `fetch-depth: 0` on the checkout step.

### review-diff reports no changes for edits I just made

By default `review-diff` compares the **HEAD commit** against the base, so uncommitted work is
not counted (that is what keeps local scratch edits out of a PR's regression report). Commit
first, or pass `--working-tree`.

### Windows path separators in report output

File paths in the report reflect the OS path separator. This is expected on Windows.
