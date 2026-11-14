import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type { RepoContext, WorkflowSource } from './repo-context.js';
import type { PromptCiIssue } from './types.js';
import { UNSCORED_TAG } from './health-score.js';

/**
 * GitHub Actions pinning detector (detect-only).
 *
 * Flags `uses:` references in `.github/workflows/*.yml` and in composite
 * actions (`action.yml` at the repo root or under `.github/actions/`) that
 * point at a tag or branch instead of a full commit SHA. A tag is a mutable
 * pointer: whoever can push to the action's repository can move it, and every
 * workflow referencing it runs the new code on its next run. A SHA cannot be
 * repointed.
 *
 * One info-level finding per file lists every unpinned ref in it, tagged
 * unscored: it costs no health-score points (pcic-1ik0.3).
 *
 * Deliberately DETECT-ONLY: there is no fix recipe and `autoApplySafe` is never
 * set. Resolving a tag to its SHA needs a network call, and this package makes
 * none from detector code — pinning is left to the user (or Dependabot /
 * Renovate, which keep a pinned SHA and its version comment in step).
 *
 * Exempt: local actions (`./path`) and container actions (`docker://…`), which
 * have no git ref to pin. These files are read from `workflows.sources`, never
 * from `context.files`, so they are never treated as instruction files.
 *
 * Deterministic and offline: line-oriented parsing of the YAML text, no clock,
 * no network.
 */

/** A full git commit id: 40-hex SHA-1, or 64-hex for SHA-256 repositories. */
const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/** `owner/repo` or `owner/repo/sub/path` — the only action shape shown verbatim. */
const ACTION_RE = /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?$/;

/** A plausible tag/branch name — the only version shape shown verbatim. */
const VERSION_RE = /^[\w./+-]+$/;

/**
 * Owners whose actions GitHub itself maintains. An unpinned first-party ref is
 * still a mutable pointer, but the account holding it is GitHub's own, so it
 * is reported one severity lower than a third-party ref.
 */
const FIRST_PARTY_OWNERS: ReadonlySet<string> = new Set(['actions', 'github']);

/** A `key: value` mapping line, optionally the first key of a list item. */
const KEY_LINE_RE = /^(\s*)(-\s+)?([\w.-]+)\s*:(?:\s+(.*))?$/;

/** A list item whose value is a flow mapping: `- { uses: x@v1, with: {...} }`. */
const FLOW_ITEM_RE = /^\s*-\s+(\{.*)$/;

/** A block scalar indicator (`|`, `>-`, `|2+`), optionally followed by a comment. */
const BLOCK_SCALAR_RE = /^[|>][+-]?\d*\s*(?:#.*)?$/;

/**
 * Keys whose block-mapping values are free-form data, not steps. A `uses:` key
 * nested under them (e.g. an input literally named `uses`) is not a step.
 */
const DATA_MAPPING_KEYS: ReadonlySet<string> = new Set(['with', 'env', 'secrets', 'inputs', 'outputs']);

export type ActionUse = {
  /** The `uses:` value as written (quotes and trailing comment stripped). */
  ref: string;
  /** 1-based line number. */
  line: number;
};

export type UnpinnedUse = ActionUse & {
  /**
   * False when the ref's text does not match the plain `owner/repo[/path]@ref`
   * shape. Such a ref is still reported, but its raw text is never
   * interpolated into titles, evidence, or the recommended `gh` command — it
   * came from the scanned repo and may carry shell or Markdown metacharacters.
   */
  displayable: boolean;
  /** `owner/repo[/path]` part before the `@` (only meaningful when displayable). */
  action: string;
  /** Git ref after the `@` (only meaningful when displayable). */
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
  const comment = value.search(/(?:^|\s)#/);
  if (comment >= 0) value = value.slice(0, comment);
  return value.trim();
}

/**
 * The value of a top-level `uses` key in a single-line flow mapping, or
 * undefined. Nested maps (`with: { uses: … }`) are depth > 1 and ignored.
 */
function flowMappingUses(flow: string): string | undefined {
  const entries: string[] = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (const c of flow) {
    if (quote) {
      if (c === quote) quote = '';
      if (depth === 1) current += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      if (depth === 1) current += c;
      continue;
    }
    if (c === '{' || c === '[') {
      depth++;
      if (depth > 1) current += c;
      continue;
    }
    if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) break;
      current += c;
      continue;
    }
    if (c === ',' && depth === 1) {
      entries.push(current);
      current = '';
      continue;
    }
    if (depth >= 1) current += c;
  }
  entries.push(current);
  for (const entry of entries) {
    const m = /^\s*uses\s*:\s*(.*)$/.exec(entry);
    if (m) return scalarValue(m[1]!);
  }
  return undefined;
}

/**
 * Every step/job-level `uses:` reference in a workflow or composite-action
 * file, in line order. Skipped: comments, lines inside block scalars (a
 * `run: |` script that prints `uses: foo@v1`), and `uses` keys nested under
 * data mappings such as `with:`.
 */
export function extractActionUses(content: string): ActionUse[] {
  const lines = content.split(/\r?\n/);
  const uses: ActionUse[] = [];
  // Lines indented deeper than this column belong to a block scalar or data
  // mapping and are skipped; -1 = not inside one.
  let skipDeeperThan = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    const indent = /^\s*/.exec(line)![0].length;
    if (skipDeeperThan >= 0) {
      if (indent > skipDeeperThan) continue;
      skipDeeperThan = -1;
    }
    if (/^\s*#/.test(line)) continue;

    const flow = FLOW_ITEM_RE.exec(line);
    if (flow) {
      const ref = flowMappingUses(flow[1]!);
      if (ref) uses.push({ ref, line: i + 1 });
      continue;
    }

    const kv = KEY_LINE_RE.exec(line);
    if (!kv) continue;
    const keyCol = kv[1]!.length + (kv[2]?.length ?? 0);
    const key = kv[3]!;
    const rawValue = kv[4] ?? '';
    const value = rawValue.trim();

    if (key === 'uses') {
      const ref = scalarValue(rawValue);
      if (ref) uses.push({ ref, line: i + 1 });
      continue;
    }
    if (BLOCK_SCALAR_RE.test(value)) {
      skipDeeperThan = keyCol;
      continue;
    }
    if ((value === '' || value.startsWith('#')) && DATA_MAPPING_KEYS.has(key)) {
      skipDeeperThan = keyCol;
    }
  }
  return uses;
}

/**
 * Classify one `uses:` value. Returns the parts for a remote ref that should
 * be pinned but is not, or `undefined` when it is pinned, local, a container,
 * or an expression.
 */
export function unpinnedUse(use: ActionUse): UnpinnedUse | undefined {
  const { ref } = use;
  if (ref.startsWith('./') || ref.startsWith('.\\')) return undefined; // local action
  if (ref.startsWith('docker://')) return undefined; // container action
  if (ref.includes('${{')) return undefined; // expression — not statically resolvable

  const at = ref.lastIndexOf('@');
  if (at <= 0 || !ref.slice(0, at).includes('/')) return undefined; // not a remote action ref
  const action = ref.slice(0, at);
  const version = ref.slice(at + 1);
  if (FULL_SHA_RE.test(version)) return undefined;

  const displayable = ACTION_RE.test(action) && VERSION_RE.test(version);
  return {
    ...use,
    displayable,
    action,
    version,
    owner: displayable ? action.split('/')[0]!.toLowerCase() : '',
  };
}

function shortHash(value: string): string {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 12);
}

/** Belt and braces for text that is shown inside Markdown code spans. */
function codeSafe(text: string): string {
  return text.replace(/`/g, "'");
}

type Site = { lines: number[]; use: UnpinnedUse };

/** Evidence line for one unpinned ref; the raw text of an odd-shaped ref never appears. */
function evidenceLine(filePath: string, site: Site): string {
  // Line numbers are safe here: the finding's fingerprint hashes its
  // `fingerprintKey`, not its evidence. They map each ref to its `locations`.
  const where = `${filePath}:${site.lines.join(',')}`;
  return site.use.displayable
    ? `${where}: uses: ${codeSafe(site.use.ref)}`
    // A hash of the raw value keeps two different odd refs in one file distinct.
    : `${where}: unrecognised uses: value (sha1 ${shortHash(site.use.ref)})`;
}

/** Refs named in the summary before the rest are counted; the evidence lists all of them. */
const SUMMARY_REF_LIMIT = 10;

/**
 * ONE info-level finding per workflow or composite-action file, listing every
 * unpinned ref in it (pcic-1ik0.3, PromptCI#158). One finding per ref made
 * this 29% of all findings in a 43-repository corpus, and it describes CI
 * configuration rather than instruction health, so it is tagged unscored and
 * costs no health-score points.
 */
function buildIssue(context: RepoContext, filePath: string, sites: Site[]): PromptCiIssue {
  const absPath = path.resolve(context.repoRoot, filePath);
  const lines = [...new Set(sites.flatMap((site) => site.lines))].sort((a, b) => a - b);
  const shown = sites.filter((site) => site.use.displayable).map((site) => site.use);
  const hidden = sites.length - shown.length;
  const thirdParty = shown.filter((use) => !FIRST_PARTY_OWNERS.has(use.owner));
  // The example in the recommendation: a third-party ref when there is one.
  const example = thirdParty[0] ?? shown[0];
  const file = codeSafe(filePath);

  const listed =
    shown.slice(0, SUMMARY_REF_LIMIT).map((use) => `\`${codeSafe(use.ref)}\``).join(', ') +
    (shown.length > SUMMARY_REF_LIMIT ? ` and ${shown.length - SUMMARY_REF_LIMIT} more (see the evidence)` : '');
  const odd =
    hidden === 0
      ? ''
      : ` ${shown.length > 0 ? 'It also has' : 'They are'} ${hidden} \`uses:\` value(s) that do not look like a ` +
        'plain `owner/repo@ref` and are not shown here; review them by hand.';
  const firstPartyNote =
    shown.length > 0 && thirdParty.length === 0 && hidden === 0
      ? ' All of them are maintained by GitHub, which lowers but does not remove the risk.'
      : '';

  let recommendation =
    'Pin each action to the full commit SHA of a release you trust and keep the version in a trailing comment';
  if (example) {
    const [repoOwner, repoName] = example.action.split('/');
    recommendation +=
      `, e.g. \`uses: ${codeSafe(example.action)}@<40-char-sha> # ${codeSafe(example.version)}\`. ` +
      `Resolve the SHA from the action's own repository (\`gh api repos/${repoOwner}/${repoName}/commits/` +
      `${example.version} --jq .sha\`)`;
  } else {
    recommendation += ", resolving the SHA from the action's own repository";
  }
  recommendation +=
    ', and let Dependabot or Renovate update the SHA and comment together. PromptCI reports this but does not ' +
    'rewrite workflow files.';

  return {
    id: `action-pin-${shortHash(`action-pin:${filePath}`)}`,
    severity: 'info',
    category: 'security',
    title: `GitHub Actions in \`${file}\` are not pinned to a commit SHA`,
    summary:
      `${file} references ${sites.length} action(s) by a tag or branch rather than a full commit SHA` +
      (shown.length > 0 ? `: ${listed}.` : '.') +
      odd +
      " A tag or branch is a mutable pointer: whoever can push to the action's repository can move it, and the " +
      "next run executes the new code with this repository's token and secrets." +
      firstPartyNote +
      ' This finding does not count toward the health score.',
    // Absolute, like every other finding's paths; the JSON report relativizes.
    filePaths: [absPath],
    locations: lines.map((line) => ({ filePath: absPath, startLine: line, endLine: line })),
    evidence: sites.map((site) => evidenceLine(filePath, site)),
    // One identity per file whichever refs are unpinned in it, so pinning one
    // of several is not "resolved + new" in a baseline, review-diff or SARIF.
    fingerprintKey: `action-pin:${filePath}`,
    recommendation,
    // The refs are certainly mutable; whether that matters for this repo is
    // the heuristic part, so confidence stays below 1.
    confidence: 0.8,
    tags: ['supply-chain', 'github-actions', UNSCORED_TAG],
  };
}

export function detectActionPinning(context: RepoContext): PromptCiIssue[] {
  const sources: WorkflowSource[] = context.workflows.sources ?? [];

  // Group occurrences by file, then by ref: several jobs in one workflow using
  // the same unpinned action are one entry in that file's finding.
  const byFile = new Map<string, Map<string, Site>>();
  for (const source of sources) {
    for (const use of extractActionUses(source.content)) {
      const unpinned = unpinnedUse(use);
      if (!unpinned) continue;
      const refs = byFile.get(source.filePath) ?? new Map<string, Site>();
      const site = refs.get(unpinned.ref) ?? { lines: [], use: unpinned };
      site.lines.push(unpinned.line);
      refs.set(unpinned.ref, site);
      byFile.set(source.filePath, refs);
    }
  }

  return [...byFile.keys()].sort().map((filePath) => {
    const refs = byFile.get(filePath)!;
    const sites = [...refs.keys()].sort().map((ref) => refs.get(ref)!);
    return buildIssue(context, filePath, sites);
  });
}
