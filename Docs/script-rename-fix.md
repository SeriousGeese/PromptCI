# When a mistyped script name is fixed automatically

`promptci fix` (and the hosted fix pull request) can rewrite a command in an instruction file when it
names a package script that does not exist and exactly one script is a typo away
(`npm run bulid` -> `npm run build`). The edit is applied without a person looking, on a repository
that may not be yours, so the rule is default-deny: a missed fix costs nothing, a wrong one lands in a
stranger's repository. In every other case the finding stays, names the close match in its
recommendation and carries no edit.

The edit is offered only when ALL of these hold:

1. **The repository is certainly one package.** The inventory is complete and fully fetched, the
   root `package.json` is the only `package.json` (outside `node_modules` and dot directories), and
   nothing declares workspaces (a `workspaces` field, `pnpm-workspace.yaml`, `lerna.json`,
   `nx.json`, `turbo.json`). With a second package, which manifest a command runs against depends on
   prose, and prose heuristics do not converge. A corrupt, oversized or unfetched manifest counts as
   "not certain".
2. **Nothing cautionary frames the command.** No marker such as don't, do not, never, avoid, wrong,
   bad, incorrect, deprecated, outdated, obsolete, old, legacy, removed, renamed, typo, mistake,
   warning, "no longer", "not this", "instead of", "before:", the marks ❌ ✖ ✗ ⚠ 🚫, strikethrough
   (`~~`, `<del>`, `<s>`, `<strike>`) appears in its whole heading chain, its whole fenced block or
   paragraph, any enclosing list item, its table row and header, an enclosing blockquote or
   `<details>` summary, or a trailing comment on its line. English only: a caution written in another
   language is a known gap, and the edit is still offered.
3. **The command is a plain root command.** Not in an HTML comment or an indented block, no `cd`
   or `pushd` before it in its block, no `--cwd`, `--prefix` or `-C`.
4. **The closest name is in the root manifest** and is the only name at that distance.

Findings are judged separately and more loosely: the text around a command (its line, the sentence or
list lead-in that introduces it, the comment lines above it, its heading) can name the directory it
runs from, which decides which manifest the script is looked up in and whether a script found only in
another package is an `info` note instead of a warning.
