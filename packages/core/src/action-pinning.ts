import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type { RepoContext, WorkflowSource } from './repo-context.js';
import type { PromptCiIssue } from './types.js';

/**
 * GitHub Actions pinning detector (detect-only).
 *
 * Flags `uses:` references in `.github/workflows/*.yml` that point at a tag or
 * branch instead of a full commit SHA. A tag is a mutable pointer: whoever can
 * push to the action's repository can move it, and every workflow referencing
 * it runs the new code on its next run. A SHA cannot be repointed.
 *
 * Deliberately DETECT-ONLY: there is no fix recipe and `autoApplySafe` is never
 * set. Resolving a tag to its SHA needs a network call, and this package makes
 * none from detector code — pinning is left to the user (or Dependabot /
 * Renovate, which keep a pinned SHA and its version comment in step).
 *
 * Exempt: local actions (`./path`) and container actions (`docker://…`), which
 * have no git ref to pin. Workflow files are read from `workflows.sources`,
 * never from `context.files`, so they are never treated as instruction files.
 *
 * Deterministic and offline: line-oriented parsing of the YAML text, no clock,
 * no network.
 */

/** A full git commit id: 40-hex SHA-1, or 64-hex for SHA-256 repositories. */
const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/**
 * Owners whose actions GitHub itself maintains. An unpinned first-party ref is
 * still a mutable pointer, but the account holding it is GitHub's own, so it
 * is reported one severity lower than a third-party ref.
 */
const FIRST_PARTY_OWNERS: ReadonlySet<string> = new Set(['actions', 'github']);

/** `uses:` as a mapping key, optionally as the first key of a list item. */
const USES_LINE_RE = /^(\s*)(?:-\s+)?uses\s*:\s*(.*)$/;

/** Any mapping key whose value opens a YAML block scalar (`run: |`, `script: >-`). */
const BLOCK_SCALAR_RE = /^(\s*)(?:-\s+)?[\w.-]+\s*:\s*[|>][+-]?\d*\s*(?:#.*)?$/;

export type ActionUse = {
  /** The `uses:` value exactly as written, e.g. `actions/checkout@v4`. */
  ref: string;
  /** 1-based line number. */
  line: number;
};

export type UnpinnedUse = ActionUse & {
  /** `owner/repo[/path]` part before the `@`. */
  action: string;
  /** Git ref after the `@` (a tag or branch name). */
  version: string;
  owner: string;
};

/** Strip a trailing ` # comment` and surrounding quotes from a scalar value. */
function scalarValue(raw: string): string {
  let value = raw.trim();
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const end = value.indexOf(quote, 1);
    return end > 0 ? value.slice(1, end) : value.slice(1);
  }
  const comment = value.search(/\s#/);
  if (comment >= 0) value = value.slice(0, comment);
  return value.trim();
}

/**
 * Every `uses:` reference in a workflow file, in line order. Lines inside a
 * block scalar (a multi-line `run: |` script, say) are skipped, so a shell
 * script that happens to print `uses: foo@v1` is not read as a step.
 */
export function extractActionUses(content: string): ActionUse[] {
  const lines = content.split(/\r?\n/);
  const uses: ActionUse[] = [];
  let blockIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (blockIndent >= 0) {
      if (line.trim() === '') continue;
      const indent = /^\s*/.exec(line)![0].length;
      if (indent > blockIndent) continue;
      blockIndent = -1;
    }
    if (/^\s*#/.test(line)) continue;

    const usesMatch = USES_LINE_RE.exec(line);
    if (usesMatch) {
      const ref = scalarValue(usesMatch[2]!);
      if (ref) uses.push({ ref, line: i + 1 });
      continue;
    }

    const block = BLOCK_SCALAR_RE.exec(line);
    if (block) {
      // Content lines must be indented past the key itself; for a `- key: |`
      // list item that is past the dash, so the dash column is the floor.
      blockIndent = block[1]!.length;
    }
  }
  return uses;
}

/**
 * Classify one `uses:` value. Returns the parsed parts for a ref that should
 * be pinned but is not, or `undefined` when it is pinned, exempt, or not a
 * shape this detector understands (malformed values are GitHub's to reject).
 */
export function unpinnedUse(use: ActionUse): UnpinnedUse | undefined {
  const { ref } = use;
  if (ref.startsWith('./') || ref.startsWith('.\\')) return undefined; // local action
  if (ref.startsWith('docker://')) return undefined; // container action
  if (ref.includes('${{')) return undefined; // expression — not statically resolvable

  const at = ref.lastIndexOf('@');
  if (at <= 0 || at === ref.length - 1) return undefined;
  const action = ref.slice(0, at);
  const version = ref.slice(at + 1);
  if (!/^[\w.-]+\/[\w.-]+/.test(action)) return undefined;
  if (FULL_SHA_RE.test(version)) return undefined;

  return { ...use, action, version, owner: action.split('/')[0]!.toLowerCase() };
}

function issueId(ref: string): string {
  const hash = crypto.createHash('sha1').update(`action-pin:${ref}`).digest('hex').slice(0, 12);
  return `action-pin-${hash}`;
}

export function detectActionPinning(context: RepoContext): PromptCiIssue[] {
  const sources: WorkflowSource[] = context.workflows.sources ?? [];

  // One finding per distinct `uses:` value across all workflows: the fix is
  // per action ref, and a per-occurrence finding would multiply the score
  // penalty by how many jobs happen to use the same action.
  const byRef = new Map<string, { use: UnpinnedUse; sites: Array<{ filePath: string; line: number }> }>();
  for (const source of sources) {
    for (const use of extractActionUses(source.content)) {
      const unpinned = unpinnedUse(use);
      if (!unpinned) continue;
      const entry = byRef.get(unpinned.ref) ?? { use: unpinned, sites: [] };
      entry.sites.push({ filePath: source.filePath, line: unpinned.line });
      byRef.set(unpinned.ref, entry);
    }
  }

  const issues: PromptCiIssue[] = [];
  for (const ref of [...byRef.keys()].sort()) {
    const { use, sites } = byRef.get(ref)!;
    const firstParty = FIRST_PARTY_OWNERS.has(use.owner);
    const relFiles = [...new Set(sites.map((s) => s.filePath))].sort();
    const [repoOwner, repoName] = use.action.split('/');

    issues.push({
      id: issueId(ref),
      severity: firstParty ? 'info' : 'warning',
      category: 'security',
      title: `GitHub Action \`${ref}\` is not pinned to a commit SHA`,
      summary:
        `${relFiles.join(', ')} ${relFiles.length > 1 ? 'reference' : 'references'} \`${use.action}\` ` +
        `at \`${use.version}\`, which appears to be a tag or branch rather than a full commit SHA. ` +
        "A tag is a mutable pointer: whoever can push to the action's repository can move it, and " +
        "the next workflow run executes the new code with this repository's token and secrets. " +
        (firstParty
          ? 'This action is maintained by GitHub, which lowers but does not remove the risk.'
          : 'Consider pinning third-party actions to a reviewed commit.'),
      // Absolute, like every other finding's paths; the JSON report relativizes.
      filePaths: relFiles.map((f) => path.resolve(context.repoRoot, f)),
      locations: sites.map((s) => ({
        filePath: path.resolve(context.repoRoot, s.filePath),
        startLine: s.line,
        endLine: s.line,
      })),
      // No line numbers: baseline fingerprints hash evidence, and a line shift
      // must not turn an accepted finding into a "new" one.
      evidence: relFiles.map((f) => `${f}: uses: ${ref}`),
      recommendation:
        'Pin the action to the full commit SHA of the release you trust and keep the version in a ' +
        `trailing comment, e.g. \`uses: ${use.action}@<40-char-sha> # ${use.version}\`. Resolve the SHA ` +
        `from the action's own repository (\`gh api repos/${repoOwner}/${repoName}/commits/${use.version} ` +
        '--jq .sha`), and let Dependabot or Renovate update the SHA and comment together. PromptCI ' +
        'reports this but does not rewrite workflow files.',
      // The ref is certainly mutable; whether that matters for this repo is the
      // heuristic part, so confidence stays below 1 and the score hit modest.
      confidence: 0.8,
      tags: ['supply-chain', 'github-actions'],
    });
  }
  return issues;
}
