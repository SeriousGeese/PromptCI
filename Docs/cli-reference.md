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

# Explain
promptci explain                            # generate a prioritized LLM-written cleanup plan
promptci explain --path <dir>               # explain issues in a specific directory

# Doctor
promptci doctor                             # verify config, .gitignore, and system dependencies
promptci doctor --path <dir>                # check a specific directory

# Setup
promptci init                               # create .promptci/config.json

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
