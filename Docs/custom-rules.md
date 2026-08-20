# Custom rules (`.promptci/custom-rules.json`)

Custom rules let a repository add its own instruction checks without writing any code. Drop a
`.promptci/custom-rules.json` file in the repo and PromptCI interprets it on every scan. Custom
findings behave exactly like built-in ones:

- their ids are namespaced `custom:<ruleId>` so they never collide with built-in detectors,
- they carry the `custom` category and count toward the health score,
- they can be silenced with inline [`promptci-ignore`](cli-reference.md) annotations,
- they participate in the baseline / `--fail-on-new` ratchet, and
- they run identically in a local `promptci scan` and in the GitHub Action (both read the same
  file), so local and CI results match.

The interpreter is deterministic — the same file and repo always produce the same findings. A
malformed file is rejected at scan time with a clear error that names the offending key; it never
crashes and never silently skips your rules.

## File shape

```json
{
  "rules": [
    { "id": "…", "type": "…", "message": "…" }
  ]
}
```

A bare top-level array (`[ { … } ]`) is also accepted. Every rule needs:

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Unique, non-empty. Becomes the finding id `custom:<id>`. |
| `type` | yes | One of `forbiddenPattern`, `absentPattern`, `requiredSection`, `crossFileConflict`. |
| `message` | yes | The finding title shown in the report. |
| `severity` | no | `info` \| `warning` \| `high` \| `critical` (default `warning`). |
| `files` | no | Array of globs; the rule only checks matching files (repo-relative paths). Defaults to all scanned instruction files. |
| `pattern` | pattern types | A JavaScript regular-expression source string. |
| `flags` | no | Regex flags (`gimsuy`) applied to `pattern`. |
| `heading` | `requiredSection` only | The section heading that must be present. |

## Rule types

### `forbiddenPattern`

Flags **each file** whose text matches `pattern`. Use it to ban content — leftover `TODO`s, a
deprecated tool name, secrets markers. The finding points at the matching line, so a
`promptci-ignore` on that line suppresses it.

```json
{ "id": "no-todo", "type": "forbiddenPattern", "pattern": "TODO", "severity": "info",
  "message": "Leftover TODO in instruction files" }
```

### `absentPattern`

Flags the repo **once** when `pattern` is absent from every targeted file. Use it to require
content — a license identifier, a required disclaimer.

```json
{ "id": "require-license", "type": "absentPattern", "pattern": "SPDX-License-Identifier",
  "message": "Instruction files must reference an SPDX license identifier" }
```

### `requiredSection`

Flags the repo when no targeted file contains a section whose heading matches `heading`
(case-insensitive, substring match). Use it to require structure — a "Setup" or "Security" section.

```json
{ "id": "require-setup", "type": "requiredSection", "heading": "Setup",
  "message": "Instructions must include a Setup section" }
```

### `crossFileConflict`

Flags when the same `pattern` yields **different values across files** — a drift check. If the
regex has a capture group, its first group is the compared value; otherwise the whole match is
compared. Fewer than two distinct values is not a conflict.

```json
{ "id": "node-version", "type": "crossFileConflict", "pattern": "node (\\d+)",
  "message": "Node version disagrees between instruction files" }
```

## Suppressing a custom finding

Use the finding's category (`custom`) or the catch-all `all`:

```markdown
<!-- promptci-ignore: custom
     reason: tracked in the migration ticket instead -->
```

## Errors

If the file is present but invalid, the scan stops with an actionable message, for example:

```
Error: Invalid .promptci/custom-rules.json: rule "node-version": "pattern" is not a valid
regular expression: Unterminated group
```

Fix the named key and re-run. A missing file is not an error — it simply means no custom rules.
