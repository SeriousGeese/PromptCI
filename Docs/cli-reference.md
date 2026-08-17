# CLI Reference

Detailed command-line interface documentation for PromptCI.

```bash
# Scanning
promptci scan                               # scan current directory
promptci scan --path <dir>                  # scan a specific directory
promptci scan --json                        # print JSON report to stdout (files are still written)
promptci scan --output <file>               # write markdown report to this path instead of default
promptci scan --fail-on <severity>          # exit 1 if any issues meet/exceed severity (info|warning|high|critical)
promptci scan --baseline <path>             # load baseline file to ignore existing issues
promptci scan --update-baseline             # run scan and save findings as the new baseline
promptci scan --fail-on-new <severity>      # exit 1 only if NEW issues (not in baseline) meet this threshold
promptci scan --fail-on-budget              # exit 1 if any context bloat issues are found
promptci scan --context-budget <chars>      # override total context budget (in characters)
promptci scan --file-context-budget <chars> # override per-file context budget (in characters)

# Context Analysis
promptci context analyze                    # print context-cost analysis without writing scan reports
promptci context analyze --path <dir>       # target directory to analyze
promptci context analyze --json             # print JSON analysis to stdout

# Context Optimization
promptci context optimize                   # refactor instruction files by splitting volatile or large sections
promptci context optimize --path <dir>      # target directory to optimize
promptci context optimize --dry-run         # output a diff of what would change without modifying files

# Fix
promptci fix                                # interactively fix deterministic issues
promptci fix --issue <id>                   # fix a specific issue by its ID
promptci fix --no-interactive               # apply all fixes without prompting
promptci fix --dry-run                      # preview changes without writing to disk
promptci fix --llm                          # use an LLM to resolve vague or conflicting instructions

# Branch Diff
promptci review-diff                        # compare current branch against main
promptci review-diff --base <branch>        # compare against a specific base branch or commit
promptci review-diff --path <dir>           # target a specific directory
promptci review-diff --json                 # print structured comparison JSON to stdout
promptci review-diff --fail-on-regression   # exit 1 if score decreases or new issues are introduced
promptci review-diff --working-tree         # compare uncommitted work instead of the HEAD commit

# Explain
promptci explain                            # generate a prioritized LLM-written cleanup plan
promptci explain --path <dir>               # explain issues in a specific directory

# Doctor
promptci doctor                             # verify config, .gitignore, and system dependencies
promptci doctor --path <dir>                # check a specific directory

# Setup
promptci init                               # create .promptci/config.json and add the .promptci/ ignore rules

# Dashboard (optional)
promptci login                              # open browser for GitHub OAuth sign-in
promptci auth set-token <token>             # store a token retrieved from the dashboard
promptci auth status                        # show whether a token is configured
promptci auth logout                        # clear the stored token
promptci upload                             # upload last scan to the hosted dashboard

# Self-update (when running from source)
promptci update                             # git pull + rebuild + re-link global CLI
promptci update --source <dir>              # set the source directory (first run)

promptci --version
promptci --help
```

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

## Baselines and the CI ratchet

`--baseline` / `--update-baseline` / `--fail-on-new` read and write
`.promptci/baseline.json`. The ratchet only holds if that file is **committed** — CI checks out
the repo and has nothing else to compare against.

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
