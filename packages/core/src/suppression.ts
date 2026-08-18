/**
 * Inline suppression annotations for PromptCI.
 *
 * Annotation formats supported in any instruction file:
 *
 *   Section-scoped (suppresses the section containing or immediately following):
 *     <!-- promptci-ignore: <category>
 *          reason: <required explanation> -->
 *
 *   Range-scoped (suppresses everything between start and end markers):
 *     <!-- promptci-ignore-start: <category>
 *          reason: <required explanation> -->
 *     ...content...
 *     <!-- promptci-ignore-end -->
 *
 * Rules:
 *   - `reason` is required. Missing reason → warning issue, issue is NOT suppressed.
 *   - `category` must be a valid IssueCategory value or the special token `all`.
 *   - Invalid category → warning issue, annotation does not suppress anything.
 *   - An unpaired `promptci-ignore-start` (no matching end) → warning issue.
 */

import * as crypto from 'node:crypto';
import type { IssueCategory, InstructionFile, InstructionSection, PromptCiIssue } from './types.js';
import { blankCodeBlockLines } from './markdown-fences.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** All valid IssueCategory values plus the catch-all 'all' token. */
const VALID_ISSUE_CATEGORIES = [
  'duplicate',
  'conflict',
  'context_bloat',
  'missing_context',
  'stale_instruction',
  'vague_guidance',
  'structure',
  'command_validity',
  'agent_practices',
  'ai_config',
  'security',
] as const;


const VALID_SUPPRESSION_CATEGORIES = new Set<string>([
  ...VALID_ISSUE_CATEGORIES,
  'all',
]);

// ── Types ─────────────────────────────────────────────────────────────────────

export type SuppressionAnnotation = {
  filePath: string;
  category: IssueCategory | 'all';
  reason: string;
  startLine: number;
  /** Last line (inclusive) within the suppression scope. */
  endLine: number;
  /** false = malformed annotation; still tracked so we can emit a warning issue. */
  valid: boolean;
  validationMessage?: string;
};

// ── Regex patterns ────────────────────────────────────────────────────────────

/**
 * Matches: <!-- promptci-ignore: <category> [optional body] -->
 * Body may contain `reason: ...` on same line or a following line.
 */
const SINGLE_RE = /<!--\s*promptci-ignore:\s*(\S+)([\s\S]*?)-->/g;

/** Matches: <!-- promptci-ignore-start: <category> [optional body] --> */
const RANGE_START_RE = /<!--\s*promptci-ignore-start:\s*(\S+)([\s\S]*?)-->/g;

/** Matches: <!-- promptci-ignore-end --> */
const RANGE_END_RE = /<!--\s*promptci-ignore-end\s*-->/g;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert a character offset in content to a 1-indexed line number. */
function charToLine(content: string, offset: number): number {
  return content.slice(0, offset).split('\n').length;
}

/**
 * Find the end line for a section-scoped annotation.
 * Uses the already-parsed sections: the scope is the end of whichever section
 * contains the annotation line, or the first section that starts after it.
 */
function getSectionEndLine(
  annotationLine: number,
  annotationEndLine: number,
  sections: InstructionSection[],
  fileLineCount: number,
  content: string,
): number {
  const lines = content.split(/\r?\n/);
  // Find the section that contains this line
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]!;
    if (section.startLine <= annotationLine && section.endLine >= annotationLine) {
      // SU2: an annotation on the LAST line of a section, immediately
      // followed by another section's heading, is almost always meant to
      // scope that NEXT section — writing a suppression comment right above
      // the heading it applies to is the natural placement. Since sections
      // are contiguous, such an annotation is always *contained* by the
      // PREVIOUS section under a naive "which section contains this line"
      // lookup, so it silently suppressed zero lines of the intended target.
      const next = sections[i + 1];
      const gapLines = lines.slice(annotationEndLine, Math.max(annotationEndLine, next?.startLine ? next.startLine - 1 : annotationEndLine));
      const gapIsBlank = gapLines.every((line) => line.trim() === '');
      if (next && next.startLine > annotationEndLine && gapIsBlank) {
        return next.endLine;
      }
      return section.endLine;
    }
  }
  // Annotation falls between sections — use the next section's end
  for (const section of sections) {
    if (section.startLine > annotationLine) {
      return section.endLine;
    }
  }
  return fileLineCount;
}

/** Extract the `reason:` value from the comment body, or null if absent. */
function extractReason(body: string): string | null {
  const m = /reason:\s*(.+?)(?:\n|$)/i.exec(body);
  return m ? m[1].trim() : null;
}

function validate(
  rawCategory: string,
  reason: string | null,
): { valid: boolean; message?: string } {
  if (!VALID_SUPPRESSION_CATEGORIES.has(rawCategory)) {
    return {
      valid: false,
      message:
        `Unknown suppression category "${rawCategory}". ` +
        `Valid values: ${[...VALID_SUPPRESSION_CATEGORIES].join(', ')}.`,
    };
  }
  if (!reason || !reason.trim()) {
    return {
      valid: false,
      message:
        'promptci-ignore annotation is missing a required "reason:" field. ' +
        'Add: reason: <explanation of why this is intentional>.',
    };
  }
  return { valid: true };
}

function annotationIssueId(filePath: string, startLine: number, tag: string): string {
  const key = `suppression-invalid:${filePath}:${startLine}:${tag}`;
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
  return `suppression-invalid-${hash}`;
}


// ── Main parser ───────────────────────────────────────────────────────────────

function parseFileSuppressions(file: InstructionFile): SuppressionAnnotation[] {
  const { content, path: filePath, sections, lineCount } = file;
  const annotations: SuppressionAnnotation[] = [];

  // Strip fenced code blocks before parsing so examples of the annotation
  // syntax (e.g. in README.md) don't get interpreted as real suppressions.
  // Preserve line count so offsets still map to the original file's lines.
  const contentForParsing = blankCodeBlockLines(content);

  // ── Single annotations ────────────────────────────────────────────────────
  const singleRe = new RegExp(SINGLE_RE.source, SINGLE_RE.flags);
  let m: RegExpExecArray | null;

  while ((m = singleRe.exec(contentForParsing)) !== null) {
    const rawCategory = m[1]?.trim() ?? '';
    const body = m[2] ?? '';
    const reason = extractReason(body);
    const startLine = charToLine(contentForParsing, m.index);
    const annotationEndLine = charToLine(contentForParsing, m.index + m[0].length);
    const endLine = getSectionEndLine(startLine, annotationEndLine, sections, lineCount, content);

    const { valid, message } = validate(rawCategory, reason);
    annotations.push({
      filePath,
      category: valid ? (rawCategory as IssueCategory | 'all') : 'all',
      reason: reason ?? '',
      startLine,
      endLine,
      valid,
      validationMessage: message,
    });
  }

  // ── Range annotations ─────────────────────────────────────────────────────
  // SU1: pair start/end markers by DOCUMENT POSITION, not array index. The
  // old code zipped `starts[i]` with `endOffsets[i]` — a stray
  // `promptci-ignore-end` appearing BEFORE the first real start shifted
  // every subsequent pairing by one: start(line 10) would pair with
  // end(line 3) (an inverted [10, 3] range that overlaps nothing, so the
  // REAL suppression silently never applied), and the real end marker would
  // pair with nothing. Walking all markers in ascending offset order and
  // tracking "the currently open start" makes mismatched pairing
  // structurally impossible — an end can only close the start that most
  // recently opened before it, and an end with no open start is a stray
  // marker that's simply ignored rather than corrupting a later pairing.
  interface RangeMarker {
    kind: 'start' | 'end';
    offset: number;
    endOffset: number;
    category?: string;
    reason?: string | null;
  }

  const markers: RangeMarker[] = [];
  const startRe = new RegExp(RANGE_START_RE.source, RANGE_START_RE.flags);
  while ((m = startRe.exec(contentForParsing)) !== null) {
    markers.push({
      kind: 'start',
      offset: m.index,
      endOffset: m.index + m[0].length,
      category: m[1]?.trim() ?? '',
      reason: extractReason(m[2] ?? ''),
    });
  }
  const endRe = new RegExp(RANGE_END_RE.source, RANGE_END_RE.flags);
  while ((m = endRe.exec(contentForParsing)) !== null) {
    markers.push({ kind: 'end', offset: m.index, endOffset: m.index + m[0].length });
  }
  markers.sort((a, b) => a.offset - b.offset);

  const pushUnpairedStart = (start: RangeMarker) => {
    annotations.push({
      filePath,
      category: 'all',
      reason: '',
      startLine: charToLine(contentForParsing, start.offset),
      endLine: lineCount,
      valid: false,
      validationMessage:
        'promptci-ignore-start has no matching promptci-ignore-end marker.',
    });
  };

  let openStart: RangeMarker | null = null;
  for (const marker of markers) {
    if (marker.kind === 'start') {
      // A new start before the previous one was ever closed — the previous
      // one is unpaired.
      if (openStart) pushUnpairedStart(openStart);
      openStart = marker;
      continue;
    }
    // end marker
    if (!openStart) continue; // stray end with nothing open — ignore

    const startLine = charToLine(contentForParsing, openStart.offset);
    const endLine = charToLine(contentForParsing, marker.endOffset);
    const { valid, message } = validate(openStart.category ?? '', openStart.reason ?? null);
    annotations.push({
      filePath,
      category: valid ? (openStart.category as IssueCategory | 'all') : 'all',
      reason: openStart.reason ?? '',
      startLine,
      endLine,
      valid,
      validationMessage: message,
    });
    openStart = null;
  }
  if (openStart) pushUnpairedStart(openStart);

  return annotations;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Parse all suppression annotations from a set of instruction files.
 * Returns both valid and invalid annotations; call `buildValidationIssues`
 * to surface invalid ones as actual scan issues.
 */
export function parseSuppressions(files: InstructionFile[]): SuppressionAnnotation[] {
  return files.flatMap(parseFileSuppressions);
}

/**
 * Convert invalid suppression annotations into PromptCiIssue warning objects
 * so they appear in the scan report and count against the health score.
 * This ensures bad suppressions are visible rather than silently ignored.
 */
export function buildValidationIssues(
  annotations: SuppressionAnnotation[],
): PromptCiIssue[] {
  return annotations
    .filter((ann) => !ann.valid)
    .map((ann) => ({
      id: annotationIssueId(ann.filePath, ann.startLine, ann.validationMessage ?? ''),
      severity: 'warning' as const,
      category: 'structure' as const,
      title: 'Invalid promptci-ignore annotation',
      summary: ann.validationMessage ?? 'This promptci-ignore annotation is malformed.',
      filePaths: [ann.filePath],
      locations: [{ filePath: ann.filePath, startLine: ann.startLine }],
      evidence: [],
      recommendation:
        'Ensure the annotation has a valid category and a non-empty reason field. ' +
        'Example: <!-- promptci-ignore: vague_guidance\n     reason: This section documents examples. -->',
      confidence: 1.0,
    }));
}

/**
 * Partition a flat issues array into active and suppressed based on the
 * provided annotations.
 *
 * Matching rules:
 *   - Category match: annotation.category === 'all' OR === issue.category
 *   - Location match (issue HAS locations): at least one location's filePath +
 *     line range overlaps with the annotation's scope
 *   - Location match (issue has EMPTY locations, e.g. agent_practices): match
 *     by filePath alone (any of issue.filePaths matches annotation.filePath)
 *
 * Only valid annotations are used for matching; invalid ones emit warning issues
 * that are never themselves suppressed.
 */
export function applySuppressions(
  issues: PromptCiIssue[],
  annotations: SuppressionAnnotation[],
): { active: PromptCiIssue[]; suppressed: PromptCiIssue[] } {
  const validAnnotations = annotations.filter((a) => a.valid);

  const active: PromptCiIssue[] = [];
  const suppressed: PromptCiIssue[] = [];

  for (const issue of issues) {
    const isSuppressed = validAnnotations.some((ann) => {
      // Category check
      if (ann.category !== 'all' && ann.category !== issue.category) return false;

      // Issues with explicit locations: require line overlap in the same file.
      // If a location has no startLine (e.g. dead-ref detector found a file but
      // not the exact line), fall back to file-path-only matching so that an
      // annotation anywhere in the file can suppress it.
      if (issue.locations.length > 0) {
        const locationMatches = issue.locations.some((loc) => {
          if (loc.filePath !== ann.filePath) return false;
          if (loc.startLine === undefined) return true;
          const issueEnd = loc.endLine ?? loc.startLine;
          return loc.startLine <= ann.endLine && issueEnd >= ann.startLine;
        });
        if (locationMatches) return true;

        const issueFilePaths = new Set(issue.filePaths);
        const hasLocationInIssueFile = issue.locations.some((loc) => issueFilePaths.has(loc.filePath));
        if (!hasLocationInIssueFile && issue.filePaths.includes(ann.filePath)) return true;

        return false;
      }

      // Issues with no locations (e.g. agent_practices, missing_context):
      // match if any of the issue's filePaths is the annotated file
      return issue.filePaths.includes(ann.filePath);
    });

    if (isSuppressed) {
      suppressed.push(issue);
    } else {
      active.push(issue);
    }
  }

  return { active, suppressed };
}

/** @internal Compile-time type check to ensure VALID_ISSUE_CATEGORIES matches IssueCategory exactly */
type _CategoryListCheck = [
  ...typeof VALID_ISSUE_CATEGORIES
][number] extends IssueCategory
  ? IssueCategory extends [...typeof VALID_ISSUE_CATEGORIES][number]
    ? true
    : never
  : never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _check: _CategoryListCheck = true;

