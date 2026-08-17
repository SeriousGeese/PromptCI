/**
 * The recommended `.gitignore` stanza for the `.promptci/` directory.
 *
 * BUG-7: the old recommendation everywhere — `init`, the security-pack
 * detector, the docs, and this repo's own .gitignore — was a bare
 * `.promptci/`, which ignores the entire directory including
 * `.promptci/baseline.json`. The CI ratchet (`--baseline` / `--fail-on-new`)
 * only works when the team's agreed baseline is committed and readable in CI,
 * so the recommended pattern was defeating the feature the directory exists to
 * serve. `config.json` is carved out for the same reason: a per-repo config
 * that only lives on one developer's machine is not a per-repo config.
 *
 * Two details of the pattern are load-bearing:
 *
 *   - `.promptci/*` rather than `.promptci/`. Git does not descend into an
 *     ignored *directory*, so with a trailing-slash pattern the `!` negations
 *     below would never be evaluated. Matching the directory's *contents*
 *     leaves them reachable.
 *   - The leading globstar segment. A pattern containing a slash is anchored
 *     to the .gitignore's own directory, so an unprefixed `.promptci/*` would
 *     stop covering nested checkouts that the old unanchored `.promptci/` did
 *     cover — in a monorepo, every sub-package's generated reports would start
 *     showing up as untracked files.
 */
export const PROMPTCI_GITIGNORE_LINES: readonly string[] = [
  '# PromptCI: ignore generated reports, keep the shared baseline and config',
  '**/.promptci/*',
  '!**/.promptci/baseline.json',
  '!**/.promptci/config.json',
];

/** The same stanza as text, LF-terminated. Callers on CRLF files should re-join. */
export const PROMPTCI_GITIGNORE_BLOCK: string = `${PROMPTCI_GITIGNORE_LINES.join('\n')}\n`;

/** Renders the stanza with the given line ending, trailing terminator included. */
export function renderPromptCiGitignore(lineEnding: string): string {
  return `${PROMPTCI_GITIGNORE_LINES.join(lineEnding)}${lineEnding}`;
}
