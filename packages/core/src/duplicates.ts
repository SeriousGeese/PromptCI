/**
 * Duplicate section detector for PromptCI.
 *
 * Compares sections across all instruction files and flags groups that are
 * exact matches or near-duplicates (Jaccard ≥ 0.8).
 *
 * When the same section appears in N files, ONE issue is emitted listing
 * all N files — not N*(N-1)/2 pairwise issues. When whole files mirror each
 * other (most sections match), ONE warning is emitted for the group of files
 * in place of the per-section findings between them (pcic-1ik0.5).
 *
 * Wording is intentionally cautious — all findings are heuristic.
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type { InstructionFile, InstructionSection, PromptCiIssue } from './types.js';
import { snippet } from './evidence.js';
import { fileIdPath, sectionIdPath } from './finding-id.js';
import { sameSectionText } from './same-text.js';

export { sameSectionText } from './same-text.js';
import { MIRROR_CANONICAL_BASENAME, importingToolFor, isImportOnlySection } from './mirror-import.js';

/** Tag on the mirrored-instruction-files finding; the fix engine's import recipe keys on it. */
export const MIRRORED_FILES_TAG = 'mirrored-files';

/**
 * The pointer sentence the pre-0.4.1 consolidation recipe wrote under each
 * heading. A section holding only that (or only an `@` import) is a pointer,
 * not content, and is never duplicate-eligible: otherwise one fix PR's own
 * pointers read as new duplicates of each other on the next scan.
 */
const LEGACY_POINTER_RE = /^see canonical instructions in \[[^\]]+\]\([^)]+\) for details\.$/i;

function isPointerOnlySection(section: InstructionSection): boolean {
  if (isImportOnlySection(section)) return true;
  const body = section.text.split(/\r?\n/).slice(section.heading !== undefined ? 1 : 0).map((l) => l.trim()).filter(Boolean);
  return body.length > 0 && body.every((l) => LEGACY_POINTER_RE.test(l));
}

/**
 * Cross-file: sections shorter than this (normalised chars) are too noisy to flag.
 * Within-file: we use a lower bar so short but verbatim-repeated bash blocks are caught.
 */
const MIN_SECTION_LENGTH = 150;       // cross-file minimum
const WITHIN_FILE_MIN_SECTION_LENGTH = 80;  // BUG-001: within-file exact/near-dups need less content
const MIN_TOKEN_COUNT = 10;            // lowered from 20 — short blocks can have fewer tokens

/**
 * Jaccard similarity threshold for near-duplicate detection.
 * Within the same file a lower threshold is appropriate because a repeated
 * section (e.g. condensed bullet-list restatement of a prose section) is
 * almost always an accidental duplicate rather than intentional.
 *
 * BUG-003: A second, lower cross-file threshold catches borderline near-duplicates
 * (e.g. "Getting Started" vs "Environment Setup" with ~60% overlap) at info severity.
 * These are worth flagging but with lower confidence than clear duplicates.
 */
const CROSS_FILE_JACCARD_THRESHOLD = 0.8;
const CROSS_FILE_JACCARD_THRESHOLD_INFO = 0.60; // BUG-003: info-level borderline duplicates
const WITHIN_FILE_JACCARD_THRESHOLD = 0.6; // BUG-001

/**
 * Generic boilerplate headings that commonly appear in every instruction file
 * but don't represent actionable duplicate content.
 * BUG-010: Added summary/description terms so short project-preamble sections
 * in multiple instruction files are not flagged as duplicates.
 */
const BOILERPLATE_HEADINGS = new Set([
  'introduction',
  'overview',
  'notes',
  'note',
  'about',
  'background',
  'context',
  'disclaimer',
  'warning',
  'important',
  'readme',
  // BUG-010 additions
  'summary',
  'project summary',
  'project overview',
  'project description',
  'description',
  'what is this',
  'table of contents',
  'contents',
  'license',
  'changelog',
]);

/** Normalise text for comparison: lowercase, collapse whitespace, strip markdown syntax. */
export function normalizeSection(text: string): string {
  return text
    .toLowerCase()
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[\s]*[-*+]\s+/gm, '')
    .replace(/^[\s]*\d+\.\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tokenise text into a Set of lowercase words for Jaccard calculation. */
function tokenize(text: string): Set<string> {
  const words = text.match(/\b\w+\b/g) ?? [];
  return new Set(words);
}

/** Jaccard similarity between two token sets. Returns 0–1. */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersectionSize = 0;
  for (const token of a) {
    if (b.has(token)) intersectionSize++;
  }
  return intersectionSize / (a.size + b.size - intersectionSize);
}

function isBoilerplateHeading(heading: string | undefined): boolean {
  if (!heading) return false;
  const lower = heading.toLowerCase().trim();
  if (BOILERPLATE_HEADINGS.has(lower)) return true;
  // BUG-010: also match headings that START WITH a boilerplate term (e.g.
  // "Project Summary / NovaSaaS — Claude Code Instructions" starts with "project summary").
  for (const term of BOILERPLATE_HEADINGS) {
    if (lower.startsWith(term)) return true;
  }
  return false;
}

/** True when every section in the list has the same text (see {@link sameSectionText}). */
function allSameText(sections: Array<Pick<InstructionSection, 'text'>>): boolean {
  return new Set(sections.map(sameSectionText)).size === 1;
}

function normalizedHeading(heading: string | undefined): string {
  return heading?.toLowerCase().replace(/\s+/g, ' ').trim() ?? '';
}

function isActionableShortExactDuplicate(a: InstructionSection, b: InstructionSection): boolean {
  const headingA = normalizedHeading(a.heading);
  const headingB = normalizedHeading(b.heading);
  return headingA.length > 0 && headingA === headingB;
}

// ── Union-Find ────────────────────────────────────────────────────────────────

function find(parent: Map<string, string>, key: string): string {
  if (!parent.has(key)) return key;
  const root = find(parent, parent.get(key)!);
  parent.set(key, root); // path compression
  return root;
}

function union(parent: Map<string, string>, a: string, b: string): void {
  const ra = find(parent, a);
  const rb = find(parent, b);
  if (ra !== rb) parent.set(ra, rb);
}

// ── ID helpers ────────────────────────────────────────────────────────────────

/** Deterministic ID for a cluster of section keys. */
function clusterIssueId(keys: string[]): string {
  const sorted = [...keys].sort().join('|');
  const hash = crypto.createHash('sha1').update(sorted).digest('hex').slice(0, 12);
  return `duplicate-${hash}`;
}

// ── Detector ─────────────────────────────────────────────────────────────────

/**
 * Detect duplicate or near-duplicate sections across all instruction files.
 *
 * Groups all N-way duplicates into a single issue instead of N*(N-1)/2 pairs.
 *
 * - Exact normalised match → severity "high", confidence 0.95
 * - Jaccard ≥ 0.80         → severity "warning", confidence 0.75
 */
export function detectDuplicates(files: InstructionFile[]): PromptCiIssue[] {
  // Flatten eligible sections.
  // Use the lower within-file threshold here; the cross-file threshold is
  // enforced per-pair in the comparison loop below.
  const eligible: InstructionSection[] = [];
  for (const file of files) {
    for (const section of file.sections) {
      const norm = normalizeSection(section.text);
      if (norm.length < WITHIN_FILE_MIN_SECTION_LENGTH) continue;  // BUG-001: lower global floor
      if (isPointerOnlySection(section)) continue;  // pcic-1ik0.10: a pointer is not content
      if (tokenize(norm).size < MIN_TOKEN_COUNT) continue;
      eligible.push({ ...section, normalizedText: norm });
    }
  }

  // Union-Find parent map and per-section metadata
  const parent = new Map<string, string>();
  // sectionByKey: key → section
  const sectionByKey = new Map<string, InstructionSection>();

  /**
   * DU1: every matching pair's severity/confidence, recorded WITHOUT trying to
   * attribute it to a cluster root yet. Union-find roots can change after a
   * pair is processed — e.g. A==B (root becomes keyB) unions with A~C later,
   * which re-roots the WHOLE {A,B} cluster onto keyC. The old code recorded
   * severity keyed by "the root at the moment this pair was unioned"
   * (`clusterSeverity.set(find(parent, keyA), severity)`), so a later
   * re-rooting orphaned that entry — the final lookup by the NEW root missed
   * it entirely and silently fell back to the pair processed last, even if
   * an earlier pair in the same cluster had a stronger severity.
   * Deferring root attribution to a second pass (after ALL unions are done,
   * see below) makes this immune to re-rooting.
   */
  const edges: Array<{
    keyA: string;
    keyB: string;
    severity: PromptCiIssue['severity'];
    confidence: number;
  }> = [];

  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const a = eligible[i];
      const b = eligible[j];

      if (a.filePath === b.filePath && a.startLine === b.startLine) continue;

      const keyA = `${sectionIdPath(a)}:${a.startLine}`;
      const keyB = `${sectionIdPath(b)}:${b.startLine}`;

      const normA = a.normalizedText;
      const normB = b.normalizedText;

      let severity: PromptCiIssue['severity'] | null = null;
      let confidence = 0;

      // BUG-010: Apply boilerplate heading filter to ALL comparisons, including exact
      // matches. "Project Summary" and similar sections are intentionally duplicated
      // across instruction files and should never be flagged.
      if (isBoilerplateHeading(a.heading) || isBoilerplateHeading(b.heading)) continue;

      const sameFile = a.filePath === b.filePath;

      if (normA === normB) {
        if (
          !sameFile &&
          (normA.length < MIN_SECTION_LENGTH || normB.length < MIN_SECTION_LENGTH) &&
          !isActionableShortExactDuplicate(a, b)
        ) {
          continue;
        }
        severity = 'high';
        confidence = 0.95;
      } else {
        // BUG-001: apply a stricter length floor for cross-file near-duplicate
        // comparisons so short same-file repeated blocks are caught while
        // cross-file noise is kept low. Short exact duplicates are handled
        // above only when their matching headings make them actionable.
        if (!sameFile && (normA.length < MIN_SECTION_LENGTH || normB.length < MIN_SECTION_LENGTH)) {
          continue;
        }

        // BUG-001: within-file near-duplicates use a lower Jaccard threshold because
        // a repeated (possibly condensed) section in the same file is almost certainly
        // an accidental duplicate, not intentional.
        const jaccardThreshold = sameFile
          ? WITHIN_FILE_JACCARD_THRESHOLD
          : CROSS_FILE_JACCARD_THRESHOLD;
        const sim = jaccardSimilarity(tokenize(normA), tokenize(normB));
        if (sim >= jaccardThreshold) {
          severity = 'warning';
          confidence = sameFile ? 0.8 : 0.75;
        } else if (!sameFile && sim >= CROSS_FILE_JACCARD_THRESHOLD_INFO) {
          // BUG-003: Borderline near-duplicate — same topic, moderate text overlap (65–79%).
          // Flag at info severity with lower confidence rather than silently ignoring.
          severity = 'info';
          confidence = 0.5;
        }
      }

      if (severity === null) continue;

      sectionByKey.set(keyA, a);
      sectionByKey.set(keyB, b);
      union(parent, keyA, keyB);
      edges.push({ keyA, keyB, severity, confidence });
    }
  }

  // Group section keys by cluster root — all unions are complete by this
  // point, so every `find()` call here returns the TRUE final root.
  const clusters = new Map<string, string[]>();
  for (const key of sectionByKey.keys()) {
    const root = find(parent, key);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root)!.push(key);
  }

  // DU1: attribute each recorded edge's severity to its FINAL root (re-computed
  // now, after every union has already happened) and keep the highest-ranked
  // one per cluster. This is what makes the fix immune to re-rooting — an
  // edge processed early (e.g. the exact-duplicate A==B pair) is looked up
  // under the SAME final root as a later edge that merged its cluster into a
  // bigger one (e.g. A~C), so the strongest severity in the whole cluster
  // always wins regardless of processing order.
  const SEVERITY_RANK: Record<PromptCiIssue['severity'], number> = {
    info: 0, warning: 1, high: 2, critical: 3,
  };
  const clusterSeverity = new Map<string, PromptCiIssue['severity']>();
  const clusterConfidence = new Map<string, number>();
  for (const edge of edges) {
    const root = find(parent, edge.keyA); // same final root as edge.keyB
    const prev = clusterSeverity.get(root);
    if (!prev || SEVERITY_RANK[edge.severity] > SEVERITY_RANK[prev]) {
      clusterSeverity.set(root, edge.severity);
      clusterConfidence.set(root, edge.confidence);
    }
  }

  // pcic-1ik0.5: clusters entirely inside a group of mirrored files are
  // reported once for the group (below), not once per section.
  const mirrors = findMirrorGroups(files, edges, sectionByKey);
  const absorbed = new Map<number, string[][]>(); // mirror group index → its clusters
  for (const [, keys] of clusters) {
    if (keys.length < 2) continue;
    const group = mirrorGroupOf(keys.map((k) => sectionByKey.get(k)!.filePath), mirrors);
    if (group === undefined) continue;
    const list = absorbed.get(group) ?? [];
    list.push(keys);
    absorbed.set(group, list);
  }
  const absorbedKeys = new Set([...absorbed.values()].flat(2));

  // Emit one issue per cluster
  const issues: PromptCiIssue[] = [];

  for (const [root, keys] of clusters) {
    if (keys.length < 2) continue;
    if (absorbedKeys.has(keys[0]!)) continue;

    const sections = keys.map((k) => sectionByKey.get(k)!);
    const severity = clusterSeverity.get(root) ?? 'warning';
    const confidence = clusterConfidence.get(root) ?? 0.75;

    // Deduplicate file paths while preserving order
    const filePaths = [...new Set(sections.map((s) => s.filePath))];

    // Build a concise heading label
    const uniqueHeadings = [...new Set(sections.map((s) => s.heading ?? '(untitled)'))];
    const headingLabel = uniqueHeadings.length === 1
      ? uniqueHeadings[0]
      : uniqueHeadings.slice(0, 2).join(' / ');

    const fileCount = filePaths.length;
    const title = fileCount > 2
      ? `Possible duplicate: ${headingLabel} (${fileCount} files)`
      : `Possible duplicate: ${headingLabel}`;

    const duplicateTokens = sections.slice(1).reduce((sum, s) => sum + Math.round(s.text.length / 4), 0);
    // Copies that are similar but not the same text (near-duplicates) must not
    // be consolidated unattended: the pointer would replace the text that
    // differs, and with it the evidence of a conflict. Same text = byte-identical
    // after the normalisation in same-text.ts (line endings, trailing
    // whitespace, a leading BOM, edge blank lines only; pcic-1ik0.5, PromptCI#160).
    const identical = allSameText(sections);
    const summary =
      (fileCount > 2
        ? `This section appears highly similar in ${fileCount} files. Consider consolidating into one canonical location.`
        : 'These sections appear highly similar. Consider consolidating them into one canonical location.') +
      (identical ? '' : ' The copies are not identical: they differ in places, so compare them before consolidating.');

    issues.push({
      id: clusterIssueId(keys),
      severity,
      category: 'duplicate',
      title,
      summary,
      filePaths,
      locations: sections.map((s) => ({
        filePath: s.filePath,
        startLine: s.startLine,
        endLine: s.endLine,
      })),
      evidence: [
        // normalizedText is already whitespace-collapsed; keep the prior
        // 200-char clip (the shared snippet defaults to 120).
        snippet(sections[0]!.normalizedText, 200),
        `Duplicated size: ~${duplicateTokens} tokens`,
      ],
      recommendation:
        (identical
          ? ''
          : 'The copies differ: decide which text is right before consolidating, since a pointer would discard the other. Then ') +
        `${identical ? 'Consolidate' : 'consolidate'} these sections into one canonical location (e.g. AGENTS.md) to save ~${duplicateTokens} tokens per session. ` +
        'A CLAUDE.md or GEMINI.md can load AGENTS.md with an `@AGENTS.md` import line; a markdown link is not loaded by any of these tools. ' +
        'If both copies are intentional, add a comment clarifying the distinction.',
      // pcic-1ik0.10: advisory. Replacing ONE section of a file with a pointer
      // drops it from the agent's context (no tool loads a markdown link), and
      // an import would load the whole canonical file, not just this section.
      // The unattended fix is the mirrored-files finding's import recipe,
      // offered only when a whole file is a copy (see mirrorIssue).
      autoApplySafe: false,
      // pcic-1ik0.10: an exact duplicate's identity is the repeated text, not
      // the list of files that repeat it, so a copy being removed (the import
      // fix on a mirror) or added keeps the finding in the baseline, the trend
      // and SARIF. Near-duplicates keep the default fingerprint.
      ...(identical
        ? { fingerprintKey: `duplicate-section:${crypto.createHash('sha1').update(sameSectionText(sections[0]!)).digest('hex')}` }
        : {}),
      confidence,
    });
  }

  for (const [group, groupClusters] of [...absorbed].sort((a, b) => a[0] - b[0])) {
    issues.push(mirrorIssue(mirrors.groups[group]!, groupClusters, sectionByKey, mirrors));
  }

  return issues;
}

// ── Mirrored instruction files (pcic-1ik0.5) ─────────────────────────────────

/**
 * Two files mirror each other when their matching sections (exact, or at the
 * near-duplicate threshold) make up at least MIRROR_SHARE of BOTH files'
 * comparable sections, or at least MIRROR_COPY_SHARE of EITHER file's (one
 * file is mostly a copy of parts of the other, e.g. an AGENTS.md cut down
 * from a longer CLAUDE.md). Below both, the shared sections stay ordinary
 * per-section findings: two files that merely repeat a few sections are not
 * copies of each other.
 */
const MIRROR_SHARE = 0.5;
const MIRROR_COPY_SHARE = 0.8;
/**
 * A pair needs at least this many matching sections, unless each file is a
 * single section and the two match (a whole one-section file copied).
 */
const MIRROR_MIN_SHARED = 2;

type MirrorGroups = {
  /** Each group's file paths, sorted with the canonical file first. */
  groups: string[][];
  groupOfFile: Map<string, number>;
  /** Per file: its comparable section count (the share's denominator). */
  comparable: Map<string, number>;
};

/**
 * Id of a mirror-group finding: sha1 of `mirror:` plus the group's
 * repo-relative file paths in canonical order, joined by `|`. It depends only
 * on which files form the group, so it is the same in every checkout and does
 * not change when the copied sections inside the files do.
 */
function mirrorIssueId(relativePaths: string[]): string {
  const hash = crypto.createHash('sha1').update(`mirror:${relativePaths.join('|')}`).digest('hex').slice(0, 12);
  return `duplicate-${hash}`;
}

/** The canonical file of a group: AGENTS.md when present, else the first path. */
function canonicalFirst(files: string[]): string[] {
  const sorted = [...files].sort();
  const agents = sorted.find((f) => path.basename(f).toLowerCase() === 'agents.md');
  return agents ? [agents, ...sorted.filter((f) => f !== agents)] : sorted;
}

/**
 * Groups of instruction files that mirror one another: every pair linked in a
 * group shares at least MIRROR_SHARE of each file's comparable sections.
 * Repositories keep AGENTS.md, CLAUDE.md and GEMINI.md (or per-tool rule
 * files) identical on purpose, or generate them; reported per section, one
 * mirror was dozens of high-severity findings.
 */
function findMirrorGroups(
  files: InstructionFile[],
  edges: Array<{ keyA: string; keyB: string; severity: PromptCiIssue['severity'] }>,
  sectionByKey: Map<string, InstructionSection>,
): MirrorGroups {
  // The share's denominator: EVERY section of the file that has body text,
  // short ones included. Counting only the sections long enough to compare
  // made two files whose one long section matched read as "1 of 1" mirrors
  // however many short sections each had of its own.
  const comparableKeys = new Map<string, Set<string>>();
  for (const file of files) {
    for (const s of file.sections) {
      if (!hasBody(s)) continue;
      const set = comparableKeys.get(s.filePath) ?? new Set<string>();
      set.add(`${sectionIdPath(s)}:${s.startLine}`);
      comparableKeys.set(s.filePath, set);
    }
  }

  // For each ordered file pair, the sections of the first that match the second.
  const matched = new Map<string, Map<string, Set<string>>>();
  const exactPairs = new Set<string>();
  const note = (from: string, to: string, key: string) => {
    const byTarget = matched.get(from) ?? new Map<string, Set<string>>();
    const keys = byTarget.get(to) ?? new Set<string>();
    keys.add(key);
    byTarget.set(to, keys);
    matched.set(from, byTarget);
  };
  for (const edge of edges) {
    if (edge.severity !== 'high' && edge.severity !== 'warning') continue; // borderline matches do not count
    const a = sectionByKey.get(edge.keyA)!.filePath;
    const b = sectionByKey.get(edge.keyB)!.filePath;
    if (a === b) continue;
    note(a, b, edge.keyA);
    note(b, a, edge.keyB);
    if (edge.severity === 'high') exactPairs.add([a, b].sort().join('\u0000'));
  }

  const denominator = (file: string, keys: Set<string>) =>
    new Set([...(comparableKeys.get(file) ?? []), ...keys]).size;

  const parent = new Map<string, string>();
  const mirrored = new Set<string>();
  const mirrorPairs = new Set<string>();
  for (const [a, byTarget] of matched) {
    for (const [b, aKeys] of byTarget) {
      if (a >= b) continue; // each unordered pair once
      const bKeys = matched.get(b)?.get(a) ?? new Set<string>();
      const aShare = aKeys.size / denominator(a, aKeys);
      const bShare = bKeys.size / denominator(b, bKeys);
      // A one-section file counts only as an EXACT copy: near-identical
      // single-section files (sibling slash commands sharing a template)
      // are separate files on purpose.
      const wholeFiles = aShare === 1 && bShare === 1 && exactPairs.has([a, b].sort().join('\u0000'));
      if (Math.min(aKeys.size, bKeys.size) < MIRROR_MIN_SHARED && !wholeFiles) continue;
      if (Math.min(aShare, bShare) < MIRROR_SHARE && Math.max(aShare, bShare) < MIRROR_COPY_SHARE) continue;
      union(parent, a, b);
      mirrored.add(a);
      mirrored.add(b);
      mirrorPairs.add(pairKey(a, b));
    }
  }

  const members = new Map<string, string[]>();
  for (const file of mirrored) {
    const root = find(parent, file);
    members.set(root, [...(members.get(root) ?? []), file]);
  }
  // Every pair in a group must itself be a mirror pair. Connected components
  // alone would chain A~B and B~C into one group although A and C share
  // nothing, and the consolidation fix would then point C's own text at A.
  const groups = [...members.values()]
    .flatMap((component) => splitIntoCliques(component, (x, y) => mirrorPairs.has(pairKey(x, y))))
    .map(canonicalFirst)
    .sort((x, y) => x[0]!.localeCompare(y[0]!));

  const comparable = new Map<string, number>();
  const groupOfFile = new Map<string, number>();
  groups.forEach((files, i) => {
    for (const file of files) {
      groupOfFile.set(file, i);
      comparable.set(file, comparableKeys.get(file)?.size ?? 0);
    }
  });
  return { groups, groupOfFile, comparable };
}

const pairKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

/**
 * Split a connected set of files into groups in which every two files are
 * linked, deterministically: seed each group with the canonical remaining file
 * (AGENTS.md first, else the first path), add each other remaining file, in
 * path order, that is linked to every member so far, and repeat with what is
 * left. Groups of one file are dropped.
 */
function splitIntoCliques(files: string[], linked: (a: string, b: string) => boolean): string[][] {
  const groups: string[][] = [];
  let remaining = canonicalFirst(files);
  while (remaining.length > 1) {
    const group = [remaining[0]!];
    for (const file of remaining.slice(1)) {
      if (group.every((member) => linked(member, file))) group.push(file);
    }
    if (group.length > 1) groups.push(group);
    remaining = canonicalFirst(remaining.filter((f) => !group.includes(f)));
  }
  return groups;
}

/** True when a section has text beyond its heading line. */
function hasBody(section: InstructionSection): boolean {
  const body = section.text.replace(/^\s*#{1,6}\s+[^\n]*\n?/, '');
  return normalizeSection(body).length > 0;
}

/** The mirror group holding every one of these files (at least two distinct), if any. */
function mirrorGroupOf(files: string[], mirrors: MirrorGroups): number | undefined {
  const distinct = [...new Set(files)];
  if (distinct.length < 2) return undefined;
  const group = mirrors.groupOfFile.get(distinct[0]!);
  if (group === undefined) return undefined;
  return distinct.every((f) => mirrors.groupOfFile.get(f) === group) ? group : undefined;
}

/** ONE warning for a group of mirrored files, replacing its per-section duplicate findings. */
function mirrorIssue(
  files: string[],
  groupClusters: string[][],
  sectionByKey: Map<string, InstructionSection>,
  mirrors: MirrorGroups,
): PromptCiIssue {
  const canonical = files[0]!;
  const sectionsOf = (keys: string[]) => keys.map((k) => sectionByKey.get(k)!);
  const all = groupClusters.flatMap(sectionsOf);
  const label = new Map<string, string>();
  const idPath = new Map<string, string>();
  for (const s of all) {
    label.set(s.filePath, s.relativePath ?? path.basename(s.filePath));
    // A section's id path is its FILE's repo-relative path (finding-id.ts).
    idPath.set(s.filePath, sectionIdPath(s));
  }
  const names = files.map((f) => label.get(f) ?? path.basename(f));
  const canonicalName = names[0]!;

  // Tokens a session pays for the copies: every section of a cluster but one
  // (the canonical file's, when it holds one).
  let duplicateTokens = 0;
  for (const keys of groupClusters) {
    const sections = sectionsOf(keys);
    const keep = sections.find((s) => s.filePath === canonical) ?? sections[0]!;
    duplicateTokens += sections.filter((s) => s !== keep).reduce((sum, s) => sum + Math.round(s.text.length / 4), 0);
  }

  const shared = (file: string) => new Set(all.filter((s) => s.filePath === file).map((s) => s.startLine)).size;
  const order = new Map(files.map((f, i) => [f, i]));
  const locations = [...all]
    .sort((a, b) => order.get(a.filePath)! - order.get(b.filePath)! || a.startLine - b.startLine)
    .map((s) => ({ filePath: s.filePath, startLine: s.startLine, endLine: s.endLine }));
  const heading = (keys: string[]) => sectionsOf(keys)[0]!.heading ?? '(untitled)';
  const headings = [...new Set(groupClusters.map(heading))];

  // Copies that have DRIFTED (near-duplicates, not the same text) must not be
  // replaced unattended: the pointer would delete the text that differs, and
  // with it the evidence of a conflict. Same rule as per-section findings.
  const drifted = groupClusters.filter((keys) => !allSameText(sectionsOf(keys))).map(heading);
  // pcic-1ik0.10: the fix replaces each copy with one `@AGENTS.md` import, so
  // it is offered only when the canonical file is exactly one AGENTS.md and
  // every other member is a file whose tool loads an import (CLAUDE.md,
  // GEMINI.md). A Copilot, Cursor or Windsurf copy has no import to point at.
  const canonicalIsAgents =
    path.basename(canonical) === MIRROR_CANONICAL_BASENAME &&
    files.filter((f) => path.basename(f) === MIRROR_CANONICAL_BASENAME).length === 1;
  const nonImporting = files.slice(1).filter((f) => importingToolFor(f) === undefined);
  const importable = canonicalIsAgents && nonImporting.length === 0;
  const importAdvice = importable
    ? `In ${names.slice(1).join(' and ')}, replace the copied sections with one \`@${canonicalName}\` import line ` +
      '(relative to the file), which Claude Code and Gemini CLI load in place; keep any section only that file has ' +
      'below it. A markdown link is not loaded by either tool.'
    : `keeping one canonical file (here ${canonicalName}). A CLAUDE.md or GEMINI.md copy of an AGENTS.md can be ` +
      'replaced with one `@AGENTS.md` import line, which those tools load; tools without an import (Copilot, Cursor, ' +
      'Windsurf) need their own copy or a symlink where the tool follows one. If a generator writes these files, ' +
      'configure it accordingly.';
  const counts = files
    .map((f, i) => `${names[i]} ${shared(f)} of ${Math.max(shared(f), mirrors.comparable.get(f) ?? 0)}`)
    .join(', ');

  return {
    id: mirrorIssueId(files.map((f) => idPath.get(f) ?? f)),
    severity: 'warning',
    category: 'duplicate',
    title: `Possible mirrored instruction files: ${names.join(', ')}`,
    summary:
      `These ${files.length} instruction files appear to be copies of one another: ${groupClusters.length} ` +
      'section(s) have the same or nearly the same text in more than one of them, covering most of at least one ' +
      `file (shared sections per file: ${counts}). That is common when copies are kept in step for tools that ` +
      'read different files, or generated. Reported once for the group rather than once per section. Every tool ' +
      `that loads more than one of them pays about ${duplicateTokens} extra tokens per session, and copies tend ` +
      'to drift apart.' +
      (drifted.length > 0
        ? ` The copies already differ in ${drifted.length} section(s): ${snippet(drifted.join(', '), 200)}.`
        : ''),
    filePaths: files,
    locations,
    // The member files and shared headings. Counts and sizes live in the
    // summary; identity is `fingerprintKey`, so neither moves the fingerprint.
    evidence: [...names.map((n) => `Mirrored file: ${n}`), `Shared sections: ${snippet(headings.join(', '), 200)}`],
    recommendation:
      (drifted.length > 0
        ? `Reconcile the sections that differ (${snippet(drifted.join(', '), 120)}) first: decide which text is ` +
          'right, since dropping a copy would discard the other. Then '
        : '') +
      (importable ? importAdvice : `${drifted.length > 0 ? 'consider' : 'Consider'} ${importAdvice}`),
    // The import recipe (mirror-import.ts) drops each section of a copy that
    // is the same text as a section of the canonical file and adds one import
    // line. Only when every copy is the same text and every copy's tool loads
    // an import; otherwise advisory.
    autoApplySafe: drifted.length === 0 && importable,
    tags: [MIRRORED_FILES_TAG],
    // One identity per mirror group, keyed on its canonical file: editing a
    // copied section, or the group gaining or losing a member, is the same
    // finding (baseline, trend, SARIF), not "resolved + new".
    fingerprintKey: `duplicate-mirror:${idPath.get(canonical) ?? canonical}`,
    confidence: 0.8,
  };
}

// ── BUG-004: Same-heading duplicate within a single file ─────────────────────

/**
 * Detect when the same section heading appears more than once in a single
 * instruction file. This is almost always a structural mistake — accidental
 * copy/paste, merged conflicts, or two incremental additions that were never
 * consolidated.
 *
 * Unlike the Jaccard-based detector above, this fires on heading identity alone
 * (case-insensitive, markdown stripped) regardless of content similarity.
 *
 * Severity: warning, confidence 0.85.
 */
export function detectDuplicateHeadings(files: InstructionFile[]): PromptCiIssue[] {
  const issues: PromptCiIssue[] = [];

  for (const file of files) {
    // heading (normalised) → sections that carry it
    const headingMap = new Map<string, InstructionSection[]>();

    for (const section of file.sections) {
      if (!section.heading) continue;
      if (isBoilerplateHeading(section.heading)) continue;

      const key = section.heading
        .toLowerCase()
        .replace(/^#+\s*/, '')
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      if (key.length < 3) continue;

      if (!headingMap.has(key)) headingMap.set(key, []);
      headingMap.get(key)!.push(section);
    }

    for (const [, sections] of headingMap) {
      if (sections.length < 2) continue;

      // Don't flag headings that appear at different nesting levels (e.g. "## Troubleshooting"
      // and "### Troubleshooting" in the same file are in distinct structural contexts).
      const levels = new Set(sections.map((s) => {
        const m = /^(#{1,6})\s/.exec(s.text);
        return m ? m[1].length : 0;
      }));
      if (levels.size > 1) continue;

      const keys = sections.map((s) => `${fileIdPath(file)}:${s.startLine}`);
      const id = clusterIssueId(keys);

      const headingLabel = sections[0]!.heading ?? '(untitled)';
      issues.push({
        id,
        severity: 'warning',
        category: 'duplicate',
        title: `Duplicate section heading in one file: "${headingLabel}"`,
        summary:
          `The heading "${headingLabel}" appears ${sections.length} times in this file. ` +
          `This is likely an accidental duplicate — consider consolidating into one section.`,
        filePaths: [file.path],
        locations: sections.map((s) => ({ filePath: file.path, startLine: s.startLine, endLine: s.endLine })),
        evidence: [`Heading "${headingLabel}" found at lines: ${sections.map((s) => s.startLine).join(', ')}`],
        recommendation:
          'Merge the duplicate sections into one, or rename one if the distinction is intentional.',
        confidence: 0.85,
      });
    }

    // BUG-006: Also check for headings where one is a prefix of another within
    // the same file (e.g. "Accessibility" and "Accessibility Standards").
    // These are almost always overlapping sections that should be merged.
    const headingKeys = [...headingMap.keys()];
    const prefixReported = new Set<string>();

    for (let i = 0; i < headingKeys.length; i++) {
      for (let j = i + 1; j < headingKeys.length; j++) {
        const keyA = headingKeys[i]!;
        const keyB = headingKeys[j]!;

        // One must be a strict prefix of the other, and both must be meaningful
        const shorter = keyA.length <= keyB.length ? keyA : keyB;
        const longer  = keyA.length <= keyB.length ? keyB : keyA;
        if (shorter.length < 4) continue;
        if (!longer.startsWith(shorter)) continue;

        // DU2: the longer heading must have at least one extra WORD after the
        // prefix, not just a mid-word continuation. The old check called
        // `.trimStart()` before testing anything, which threw away the one
        // signal it needed — whether a space actually followed the shared
        // prefix — so "Lint" → "Linting" (extra = "ing", no space) passed the
        // same `/^\w/` test as "accessibility" → "accessibility standards"
        // (extra = " standards", a real space). Test the RAW (untrimmed)
        // remainder for a leading space first; only trim after that check.
        const extraRaw = longer.slice(shorter.length);
        if (!/^\s/.test(extraRaw)) continue; // mid-word continuation — skip
        const extra = extraRaw.trimStart();
        if (!extra) continue; // trailing whitespace only, nothing real followed

        const pairKey = [keyA, keyB].sort().join('|');
        if (prefixReported.has(pairKey)) continue;
        prefixReported.add(pairKey);

        const secA = headingMap.get(keyA)!;
        const secB = headingMap.get(keyB)!;
        const allSections = [...secA, ...secB].sort((a, b) => a.startLine - b.startLine);
        const allKeys = allSections.map((s) => `${fileIdPath(file)}:${s.startLine}`);

        issues.push({
          id: clusterIssueId(allKeys),
          severity: 'warning',
          category: 'duplicate',
          title: `Overlapping section headings in one file: "${secA[0]!.heading}" / "${secB[0]!.heading}"`,
          summary:
            `These section headings appear to cover the same topic — one is a prefix/subset of the other. ` +
            `This is likely an accidental split. Consider merging into one canonical section.`,
          filePaths: [file.path],
          locations: allSections.map((s) => ({ filePath: file.path, startLine: s.startLine, endLine: s.endLine })),
          evidence: [
            `"${secA[0]!.heading}" at line ${secA[0]!.startLine}`,
            `"${secB[0]!.heading}" at line ${secB[0]!.startLine}`,
          ],
          recommendation:
            'Consolidate these sections into one. If the distinction is intentional, rename one to make the difference clear.',
          confidence: 0.75,
        });
      }
    }
  }

  return issues;
}
