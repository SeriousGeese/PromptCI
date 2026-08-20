/**
 * Duplicate section detector for PromptCI.
 *
 * Compares sections across all instruction files and flags groups that are
 * exact matches or near-duplicates (Jaccard ≥ 0.8).
 *
 * When the same section appears in N files, ONE issue is emitted listing
 * all N files — not N*(N-1)/2 pairwise issues.
 *
 * Wording is intentionally cautious — all findings are heuristic.
 */

import * as crypto from 'node:crypto';
import type { InstructionFile, InstructionSection, PromptCiIssue } from './types.js';
import { snippet } from './evidence.js';

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

      const keyA = `${a.filePath}:${a.startLine}`;
      const keyB = `${b.filePath}:${b.startLine}`;

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

  // Emit one issue per cluster
  const issues: PromptCiIssue[] = [];

  for (const [root, keys] of clusters) {
    if (keys.length < 2) continue;

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
    const summary = fileCount > 2
      ? `This section appears highly similar in ${fileCount} files. Consider consolidating into one canonical location.`
      : 'These sections appear highly similar. Consider consolidating them into one canonical location.';

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
        `Consolidate these sections into one canonical location (e.g. AGENTS.md) and use forwarding pointers to save ~${duplicateTokens} tokens per session. If both are intentional, add a comment clarifying the distinction.`,
      // `applyFixRecipe` can consolidate a duplicate that spans MULTIPLE files
      // (pick a canonical file, replace the copies with a forwarding pointer).
      // A cluster confined to one file has no other file to point at, so it
      // stays advisory. Same-file duplicate *headings* are handled by the other
      // detectors below and are never auto-applied.
      autoApplySafe: fileCount >= 2,
      confidence,
    });
  }

  return issues;
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

      const keys = sections.map((s) => `${file.path}:${s.startLine}`);
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
        const allKeys = allSections.map((s) => `${file.path}:${s.startLine}`);

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
