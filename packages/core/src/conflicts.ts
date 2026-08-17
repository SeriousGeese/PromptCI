/**
 * Conflict detector for PromptCI.
 *
 * Looks for contradictory directive pairs within or across instruction files:
 *   "use X"       vs "do not use X"
 *   "always X"    vs "never X"
 *   "must X"      vs "avoid X"
 *   "prefer X"    vs "avoid X"
 *
 * Only flags pairs where the extracted subject noun/phrase is the same or
 * highly similar — unrelated sentences that happen to contain "use" and
 * "avoid" on different topics are NOT flagged.
 *
 * Wording is intentionally cautious — all findings are heuristic.
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type { InstructionFile, InstructionSection, PromptCiIssue } from './types.js';

/**
 * C2: previously a 50-char floor dropped every section shorter than that —
 * including terse, information-dense one-liner rule files like
 * "Never use Dapper." (18 chars), silently hiding them from cross-file
 * comparison. Directive-pattern matching plus the subject-length/generic
 * checks in extractDirectives already filter noise (a bare heading or empty
 * body simply produces zero matches), so the floor only needs to reject
 * genuinely-empty sections, not merely short ones.
 */
const MIN_SECTION_LENGTH = 1; // chars — effectively "non-empty", see comment above

// Stop-words that signal the subject noun phrase has ended.
const STOP_WORDS = new Set([
  'for', 'to', 'when', 'in', 'with', 'as', 'from', 'the', 'and', 'or',
  'but', 'if', 'are', 'is', 'has', 'have', 'had', 'will', 'was', 'were',
  'by', 'of', 'at', 'on', 'an', 'a', 'all', 'any', 'this', 'that',
  'these', 'those', 'our', 'your', 'their', 'its', 'so', 'than', 'be',
]);

/**
 * BUG-011: Scope-qualifier words — a subset of STOP_WORDS that, when they
 * terminate subject extraction on a NEGATIVE directive, indicate the prohibition
 * is scoped ("don't use X for Y" / "never use X when Y") rather than absolute.
 * Scoped prohibitions often complement a positive directive and should not be
 * flagged as hard conflicts.
 *
 * Deliberately narrow: "for", "when", "if", "unless", "except".
 * "in" is NOT included — "never use Jest in this project" is an absolute
 * prohibition ("in this project" = the whole scope, not a sub-context).
 */
const QUALIFIER_STOP_WORDS = new Set(['for', 'when', 'if', 'unless', 'except']);

/**
 * Generic verbs/adjectives that produce low-value conflict subjects.
 * A subject consisting entirely of these words is too vague to flag.
 */
const GENERIC_SUBJECTS = new Set([
  'it', 'them', 'they', 'we', 'code', 'sure', 'careful', 'good', 'clean',
  'simple', 'easy', 'proper', 'consistent', 'clear', 'correct', 'possible',
  'necessary', 'appropriate',
]);

/**
 * Common directive verbs that appear immediately after "always/never/must/prefer".
 * When extracting a subject for those pairs, we skip the first word if it's in
 * this set so that "always use pandas" → subject "pandas", not "use".
 * Without this, "always use X" and "always use Y" (for different X and Y)
 * both extract subject "use" and falsely look like a conflict.
 *
 * NOTE: This skip is NOT applied for the "use / do not use" pair because
 * there "use" is the directive keyword itself, not a trailing verb.
 */
const LEADING_DIRECTIVE_VERBS = new Set([
  'use', 'run', 'write', 'call', 'create', 'add', 'implement', 'put',
  'keep', 'follow', 'apply', 'make', 'define', 'ensure', 'check', 'test',
  'build', 'deploy', 'configure', 'handle', 'prefer', 'avoid', 'include',
  'return', 'pass', 'store', 'log', 'load', 'fetch', 'set', 'get', 'import',
]);

/**
 * Extract up to `maxWords` content words after an anchor position,
 * stopping at stop-words or non-word characters.
 *
 * @param skipLeadingVerb - when true, skip the first word if it is a common
 *   directive verb (e.g. "use" in "always use pandas" → subject "pandas").
 *   Should be true for always/never/must/prefer pairs but false for the
 *   "use / do not use" pair where "use" is already the anchor keyword.
 */
function extractSubjectWords(line: string, anchorIndex: number, maxWords = 3, skipLeadingVerb = false): string {
  // Consume the rest of the line after the anchor
  let rest = line.slice(anchorIndex).replace(/^\s+/, '');

  // Optionally skip a leading directive verb so "always use X" → subject "X"
  if (skipLeadingVerb) {
    const firstWordMatch = /^([a-zA-Z]+)\s+/.exec(rest);
    if (firstWordMatch && LEADING_DIRECTIVE_VERBS.has(firstWordMatch[1].toLowerCase())) {
      rest = rest.slice(firstWordMatch[0].length);
    }
  }

  const words: string[] = [];

  // Truncate at em/en dashes, commas, semicolons, colons, periods, and
  // parenthetical content ("Cobra (github.com/cobra)" → "Cobra").
  // Parentheticals often contain package paths or URLs that become noise tokens.
  const truncated = rest
    .replace(/[—–].*$/, '')
    .replace(/\s*\(.*$/, '')   // drop "(…)" commentary before further truncation
    .replace(/[,;:.].*$/, '')
    .trim();

  for (const raw of truncated.split(/\s+/)) {
    const word = raw.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '').toLowerCase();
    if (!word) continue;
    if (STOP_WORDS.has(word)) break;
    // C4: accept digit-LEADING tech names ("11ty", "7zip", "3proxy") — only
    // abort on a word that's letter-less entirely (a bare version number like
    // "16" or "2024"), not merely digit-first.
    if (!/^[a-z]/i.test(word) && !/^[0-9]+[a-z]/i.test(word)) break;
    words.push(word);
    if (words.length >= maxWords) break;
  }

  return words.join(' ');
}

interface PairDef {
  label: string;
  positivePattern: RegExp;
  negativePattern: RegExp;
  /** Skip a leading verb when extracting the subject (e.g. "use" in "always use X"). */
  skipLeadingVerb?: boolean;
  /**
   * BUG-005: When true, extract the subject from BEFORE the matched keyword rather
   * than after it. Applies to BOTH polarities. Used for fully-symmetric copula
   * pairs where both positive and negative have the subject before the predicate
   * (e.g. "X are preferred" / "X are only acceptable").
   */
  extractSubjectBefore?: boolean;
  /**
   * BUG-002: Like extractSubjectBefore but only applies to the POSITIVE pattern.
   * Use this when the positive is a copula ("X is acceptable") but the negative
   * is a standard verb phrase ("Never use X") so subjects are extracted differently.
   */
  extractPositiveSubjectBefore?: boolean;
  /**
   * BUG-001: When true, allow the within-pair Jaccard match even when one side
   * has a single-token subject. Used for pairs where subject length asymmetry is
   * expected (e.g. "use Redux Toolkit" → "redux toolkit" vs "migrating away from
   * Redux" → "redux").
   */
  allowSingleTokenMatch?: boolean;
}

const DIRECTIVE_PAIRS: PairDef[] = [
  {
    label: 'use / do not use',
    positivePattern: /\buse\s+/i,
    // BUG-003: extend to also catch em/en-dash "— not X" negation (e.g. "use urfave/cli — not Cobra")
    negativePattern: /\b(?:do\s+not|don['']t|never)\s+use\s+|[—–]\s*not\s+/i,
    // "use" IS the anchor keyword here — do not skip
    skipLeadingVerb: false,
  },
  {
    // BUG-001: "migrating away from X" / "moving away from X" is a clear negative
    // directive for X — even without explicit "do not use" language.
    // Positive side re-uses the "use" pattern so "We use Redux Toolkit" is the
    // counterpart to "We are migrating away from Redux".
    // allowSingleTokenMatch: the positive often has "redux toolkit" (2 words) while
    // the negative has "redux" (1 word, since the sentence ends after the library name).
    label: 'use / migrating away from',
    positivePattern: /\buse\s+/i,
    negativePattern: /\b(?:migrat(?:ing|e|ed)\s+(?:away\s+from|off\s+of)\s+|moving\s+away\s+from\s+|switch(?:ing|ed)?\s+(?:away\s+from|off\s+of)\s+|dropping\s+)/i,
    skipLeadingVerb: false,
    allowSingleTokenMatch: true,
  },
  {
    // BUG-002: "X is acceptable in tests" is a positive scoped permission that
    // can conflict with "Never use X" — e.g. unwrap() scoping between files.
    // extractPositiveSubjectBefore: positive "X is acceptable" extracts before the copula;
    // negative "Never use X" extracts AFTER the verb (handled by default).
    label: 'acceptable / never',
    positivePattern: /\b(?:is|are)\s+acceptable\b/i,
    negativePattern: /\bnever\s+use\s+|\b(?:do\s+not|don['']t)\s+use\s+/i,
    skipLeadingVerb: false,
    extractPositiveSubjectBefore: true,
  },
  {
    // BUG-003 (eval): "This project uses X" / "Use X" vs "Avoid X" catches imperative
    // contradictions like "Avoid Lombok" (CLAUDE.md) vs "This project uses Lombok extensively" (AGENTS.md).
    // Uses? matches both "use" and "uses".
    label: 'use / avoid',
    positivePattern: /\buses?\s+/i,
    negativePattern: /\bavoid\s+/i,
    skipLeadingVerb: false,
    allowSingleTokenMatch: true,
  },
  {
    // BUG-003: Catch declarative stack references like "CLI framework: Cobra" vs "not Cobra".
    // positivePattern matches "keyword: Value" tech-stack declarations.
    // Negative restricted to em/en-dash phrases ("— not X") and "not using X" to avoid
    // false positives from contrast clauses like "use Jinja there, not Python".
    label: 'declared stack / not',
    positivePattern: /\b(?:framework|library|runtime|sdk|engine|package|tool|stack|lang(?:uage)?|cli)\b[^:\n]{0,20}:\s*/i,
    negativePattern: /[—–]\s*not\s+|\bnot\s+using\s+/i,
    skipLeadingVerb: false,
  },
  {
    label: 'always / never',
    positivePattern: /\balways\s+/i,
    negativePattern: /\bnever\s+/i,
    // "always use X" → skip "use" → subject "X"
    skipLeadingVerb: true,
  },
  {
    label: 'always / avoid',
    positivePattern: /\balways\s+/i,
    negativePattern: /\bavoid\s+/i,
    // catches "always use pandas" vs "avoid pandas for large datasets"
    skipLeadingVerb: true,
  },
  {
    label: 'must / avoid',
    positivePattern: /\bmust\s+/i,
    negativePattern: /\bavoid\s+/i,
    skipLeadingVerb: true,
  },
  {
    label: 'prefer / avoid',
    positivePattern: /\bprefer\s+/i,
    negativePattern: /\bavoid\s+/i,
    skipLeadingVerb: true,
  },
  {
    // BUG-005: Copula pattern — "X are/is preferred" vs "X are/is only acceptable".
    // "preferred" is an endorsement; "only acceptable" restricts to an edge case.
    // The subject comes BEFORE the copula ("are/is"), so we use extractSubjectBefore.
    label: 'preferred / only acceptable',
    positivePattern: /\b(?:is|are)\s+(?:generally\s+|usually\s+)?preferred\b/i,
    negativePattern: /\b(?:is|are)\s+only\s+acceptable\b|\b(?:acceptable|allowed)\s+only\b/i,
    skipLeadingVerb: false,
    extractSubjectBefore: true,
  },
];

interface DirectiveMatch {
  section: InstructionSection;
  pairIndex: number;
  polarity: 'positive' | 'negative';
  subject: string;
  matchedLine: string;
  /** BUG-011: true when the negative directive is scoped ("don't use X for Y").
   *  Scoped prohibitions are complementary to positive directives, not contradictions. */
  hasQualifier?: boolean;
}

/**
 * BUG-011: After extracting a subject, detect whether the first stop-word that
 * terminated extraction was a scope qualifier ("for", "when", "in", "if", …).
 * If so, the directive is scoped ("don't use X for Y") rather than absolute.
 *
 * Works by re-walking the same token sequence that extractSubjectWords uses,
 * so the result is guaranteed to be consistent.
 */
function detectQualifierAfterSubject(
  line: string,
  anchorIndex: number,
  subject: string,
  skipLeadingVerb: boolean,
): boolean {
  let rest = line.slice(anchorIndex).replace(/^\s+/, '');

  if (skipLeadingVerb) {
    const fw = /^([a-zA-Z]+)\s+/.exec(rest);
    if (fw && LEADING_DIRECTIVE_VERBS.has(fw[1]!.toLowerCase())) {
      rest = rest.slice(fw[0].length);
    }
  }

  const truncated = rest
    .replace(/[—–].*$/, '')
    .replace(/\s*\(.*$/, '')   // strip parenthetical noise (URLs, comments)
    .replace(/[,;:.].*$/, '')
    .trim();

  const tokens = subject.split(' ').filter(Boolean);
  let remaining = truncated;

  // Consume the subject tokens from remaining
  for (const tok of tokens) {
    const idx = remaining.toLowerCase().indexOf(tok);
    if (idx < 0) return false;
    remaining = remaining.slice(idx + tok.length).trimStart();
  }
  remaining = remaining.replace(/^[^a-zA-Z]+/, '');

  // The next word is whatever terminated the subject extraction
  const nextWord = /^([a-zA-Z]+)/.exec(remaining)?.[1]?.toLowerCase() ?? '';
  return QUALIFIER_STOP_WORDS.has(nextWord);
}

function normalizeSubject(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Return true if the subject is too generic to produce a meaningful conflict.
 * Subjects must have at least one word that is not in the generic set.
 */
function isGenericSubject(subject: string): boolean {
  if (!subject || subject.length < 2) return true;
  const words = subject.split(' ').filter(Boolean);
  if (words.length === 0) return true;
  // All words are generic → skip
  return words.every((w) => GENERIC_SUBJECTS.has(w));
}

/**
 * Word-overlap (Jaccard) similarity between two subject strings.
 * Returns 0–1.
 */
function subjectSimilarity(a: string, b: string): number {
  const wa = new Set(a.split(' ').filter(Boolean));
  const wb = new Set(b.split(' ').filter(Boolean));
  if (wa.size === 0 || wb.size === 0) return 0;

  let intersection = 0;
  for (const w of wa) {
    if (wb.has(w)) intersection++;
  }
  const union = wa.size + wb.size - intersection;
  return intersection / union;
}

/**
 * BUG-005: Extract subject words from BEFORE an anchor position.
 * Used for copula sentences like "Synchronous handlers are preferred" where the
 * subject precedes the predicate.
 *
 * Looks backward from `anchorIndex` to the nearest clause boundary (comma,
 * period, or start of string), then extracts the last N content words.
 */
function extractSubjectWordsBefore(line: string, anchorIndex: number, maxWords = 4): string {
  const before = line.slice(0, anchorIndex).trimEnd();
  if (!before) return '';

  // Find the nearest clause start (after a comma, period, semicolon, or start of line)
  let clauseStart = 0;
  for (let i = before.length - 1; i >= 0; i--) {
    if (/[,;.]/.test(before[i]!)) {
      clauseStart = i + 1;
      break;
    }
  }

  const clause = before.slice(clauseStart).trim();
  const words: string[] = [];

  // Work backwards through the clause words
  for (const raw of clause.split(/\s+/).reverse()) {
    const word = raw.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '').toLowerCase();
    if (!word) continue;
    if (STOP_WORDS.has(word)) continue;
    words.unshift(word);
    if (words.length >= maxWords) break;
  }

  return words.join(' ');
}

/**
 * C3: build "logical lines" from a section's raw text — consecutive physical
 * lines are merged into one logical line when the earlier line does NOT end
 * with sentence-terminal punctuation (`.`/`!`/`?`/`:`/`;`), which is a strong
 * signal of a hard line-wrap mid-directive ("Do not\nuse Cobra."). Blank
 * lines and markdown table rows ("| Avoid | Use Instead |") always end a
 * logical line and are never merged across, so unrelated paragraphs don't
 * bleed into each other.
 *
 * This replaces per-physical-line iteration entirely (rather than testing
 * both the original lines AND a joined version) so that a directive spanning
 * a wrap is extracted exactly once — testing both would let the second half
 * of a wrapped negative sentence ALSO be misread as an unrelated standalone
 * positive directive.
 */
function buildLogicalLines(section: InstructionSection): string[] {
  const rawLines = section.text.split('\n').map((l) => l.trim());
  const logical: string[] = [];
  let buffer = '';

  for (const line of rawLines) {
    // Headings never end with terminal punctuation, so without this check a
    // "## Heading" line would merge into the body text that follows it,
    // corrupting extractSubjectWordsBefore's backward clause scan (the
    // heading's words bleed into the extracted subject). Headings are still
    // tested as their own logical line — only merging into/out of them is
    // disallowed.
    const isHeading = /^ {0,3}#{1,6}\s/.test(line);
    const isListItem = /^(?:[-*+]\s+|\d+[.)]\s+)/.test(line);

    if (!line || line.startsWith('|') || isHeading) {
      if (buffer) {
        logical.push(buffer);
        buffer = '';
      }
      if (isHeading) logical.push(line);
      continue;
    }
    if (isListItem && buffer) {
      logical.push(buffer);
      buffer = '';
    }
    buffer = buffer ? `${buffer} ${line}` : line;
    if (/[.!?:;]$/.test(line)) {
      logical.push(buffer);
      buffer = '';
    }
  }
  if (buffer) logical.push(buffer);

  return logical;
}

function execAll(pattern: RegExp, line: string): Array<{ index: number; text: string }> {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  const matches: Array<{ index: number; text: string }> = [];
  let match: RegExpExecArray | null;

  while ((match = re.exec(line)) !== null) {
    matches.push({ index: match.index, text: match[0] });
    if (match[0].length === 0) re.lastIndex++;
  }

  return matches;
}

/** Extract all directive matches from a section (over its logical lines). */
function extractDirectives(section: InstructionSection): DirectiveMatch[] {
  const results: DirectiveMatch[] = [];
  const lines = buildLogicalLines({ ...section, text: stripCodeBlocks(section.text) });

  for (let pi = 0; pi < DIRECTIVE_PAIRS.length; pi++) {
    const pair = DIRECTIVE_PAIRS[pi];

    for (const line of lines) {
      const skip = pair.skipLeadingVerb ?? false;
      // extractSubjectBefore applies to both polarities (symmetric copula pairs)
      const beforeBoth = pair.extractSubjectBefore ?? false;

      // Try negative first (more specific — "do not use" is a superset of "use")
      const negMatches = execAll(pair.negativePattern, line);
      // C1: previously this branch `continue`d past the positive check, so a
      // line carrying BOTH polarities ("Use pandas, never use polars.") lost
      // its positive directive entirely. Now both checks always run; to keep
      // the positive check from re-matching text that's actually part of the
      // negative phrase (e.g. the "use" inside "do not use pandas"), the
      // negative match's span is masked out (replaced with spaces, same
      // length so all downstream indices stay valid) before the positive
      // pattern searches.
      let lineForPositiveSearch = line;
      for (const negMatch of negMatches) {
        const anchorEnd = negMatch.index + negMatch.text.length;
        // Negatives always extract AFTER the anchor unless the pair is fully symmetric
        const negBefore = beforeBoth;
        const subject = negBefore
          ? normalizeSubject(extractSubjectWordsBefore(line, negMatch.index, 4))
          : normalizeSubject(extractSubjectWords(line, anchorEnd, 3, skip));
        if (subject.length >= 2 && !isGenericSubject(subject)) {
          // BUG-011: detect scoped prohibition ("don't use X for Y")
          const hasQualifier = !negBefore && detectQualifierAfterSubject(line, anchorEnd, subject, skip);
          results.push({ section, pairIndex: pi, polarity: 'negative', subject, matchedLine: line, hasQualifier });
        }
        lineForPositiveSearch =
          lineForPositiveSearch.slice(0, negMatch.index) +
          ' '.repeat(negMatch.text.length) +
          lineForPositiveSearch.slice(anchorEnd);
      }

      const posMatches = execAll(pair.positivePattern, lineForPositiveSearch);
      for (const posMatch of posMatches) {
        // BUG-002: extractPositiveSubjectBefore allows copula patterns like "X is acceptable"
        // (positive extracts before) paired with verb negatives like "Never use X" (extracts after).
        const posBefore = beforeBoth || (pair.extractPositiveSubjectBefore ?? false);
        // Subject extraction reads from the ORIGINAL (unmasked) line — safe
        // because the mask only replaces characters with same-length spaces,
        // so posMatch's indices are valid positions in `line` too, and a
        // match can only land outside the masked span in the first place.
        const subject = posBefore
          ? normalizeSubject(extractSubjectWordsBefore(line, posMatch.index, 4))
          : normalizeSubject(extractSubjectWords(line, posMatch.index + posMatch.text.length, 3, skip));
        if (subject.length >= 2 && !isGenericSubject(subject)) {
          results.push({ section, pairIndex: pi, polarity: 'positive', subject, matchedLine: line });
        }
      }
    }
  }

  return results;
}

function conflictId(
  fileA: string,
  startA: number,
  fileB: string,
  startB: number,
  pairIndex: number,
  subject: string,
): string {
  const parts = [`${fileA}:${startA}`, `${fileB}:${startB}`].sort();
  const raw = `${parts[0]}|${parts[1]}|${pairIndex}|${subject}`;
  const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12);
  return `conflict-${hash}`;
}

/**
 * Detect conflicting directives across all instruction files.
 *
 * Confidence:
 *   0.8 — subjects are identical after normalisation
 *   0.5 — subjects share significant word overlap (Jaccard ≥ 0.5)
 *
 * Severity:
 *   confidence ≥ 0.7 → "high"
 *   confidence < 0.7  → "warning"
 */
export function detectConflicts(files: InstructionFile[]): PromptCiIssue[] {
  const sections: InstructionSection[] = [];
  for (const file of files) {
    for (const section of file.sections) {
      if (section.text.trim().length >= MIN_SECTION_LENGTH) {
        sections.push(section);
      }
    }
  }

  const directives: DirectiveMatch[] = [];
  for (const section of sections) {
    directives.push(...extractDirectives(section));
  }

  const issues: PromptCiIssue[] = [];
  const reported = new Set<string>();

  for (let i = 0; i < directives.length; i++) {
    for (let j = i + 1; j < directives.length; j++) {
      const a = directives[i];
      const b = directives[j];

      if (a.pairIndex !== b.pairIndex) continue;
      if (a.polarity === b.polarity) continue;

      const pos = a.polarity === 'positive' ? a : b;
      const neg = a.polarity === 'negative' ? a : b;

      const sim = pos.subject === neg.subject ? 1 : subjectSimilarity(pos.subject, neg.subject);
      let confidence: number;

      if (pos.subject === neg.subject) {
        // BUG-011: scoped prohibition ("don't use X for Y") is usually complementary,
        // not contradictory. Lower confidence significantly so it stays below the
        // firing threshold when the negative is qualified.
        //
        // BUG-008: When a single-token subject was extracted from a line that contains a
        // backtick-enclosed method call (e.g. `React.memo()`), the subject was likely
        // truncated at the dot — "react" came from "React.memo", not from the library name
        // being the whole intent. This creates false HIGH-severity conflicts between
        // directives about different React sub-features (React.memo vs React 18 APIs).
        //
        // Only apply the downgrade when BOTH conditions hold:
        //   1. The subject is a single token (e.g. "react")
        //   2. The matched line contains a backtick span whose content starts with that
        //      token followed by a dot (evidence that extraction was cut at a method call)
        //
        // This leaves legitimate single-token conflicts (e.g. "jest", "dapper") at full
        // confidence because their lines don't contain "`jest.something`" patterns.
        const subjectTokenCount = pos.subject.split(' ').filter(Boolean).length;
        const truncatedByMethodCall = subjectTokenCount === 1 && (
          new RegExp(`\`${pos.subject}\\.[a-z]`, 'i').test(pos.matchedLine) ||
          new RegExp(`\`${neg.subject}\\.[a-z]`, 'i').test(neg.matchedLine)
        );
        const pair = DIRECTIVE_PAIRS[a.pairIndex]!;
        const scopedButPositiveIsAbsoluteAlways =
          neg.hasQualifier && /\balways\b/i.test(pos.matchedLine) && pair.label.includes('always');
        confidence = scopedButPositiveIsAbsoluteAlways
          ? 0.5
          : (neg.hasQualifier ? 0.35 : (truncatedByMethodCall ? 0.5 : 0.8));
      } else if (sim >= 0.5) {
        const pair = DIRECTIVE_PAIRS[a.pairIndex]!;
        const posWords = pos.subject.split(' ').filter(Boolean);
        const negWords = neg.subject.split(' ').filter(Boolean);

        // BUG-010: Require ≥ 2 tokens on both sides for partial Jaccard matches.
        // A 1-word subject (e.g. "react") spuriously collides with "react query"
        // at Jaccard 0.5, conflating unrelated library directives.
        if (posWords.length < 2 || negWords.length < 2) {
          // BUG-001 exception: pairs that explicitly allow single-token Jaccard matches
          // (e.g. "use / migrating away from" where "redux toolkit" vs "redux" is valid).
          // Only allow if the shorter subject is a prefix of the longer one.
          if (!pair.allowSingleTokenMatch) continue;
          const shorter = posWords.length <= negWords.length ? posWords[0]! : negWords[0]!;
          const longerSubject = posWords.length > negWords.length ? pos.subject : neg.subject;
          if (!longerSubject.startsWith(shorter)) continue;
        }
        confidence = neg.hasQualifier ? 0.3 : 0.5;
      } else {
        continue;
      }

      // Below actionable threshold — skip
      if (confidence < 0.4) continue;

      const id = conflictId(
        pos.section.filePath,
        pos.section.startLine,
        neg.section.filePath,
        neg.section.startLine,
        a.pairIndex,
        pos.subject,
      );

      if (reported.has(id)) continue;
      reported.add(id);

      const severity: PromptCiIssue['severity'] = confidence >= 0.7 ? 'high' : 'warning';
      const pair = DIRECTIVE_PAIRS[a.pairIndex];
      const displaySubject = pos.subject.length <= neg.subject.length ? pos.subject : neg.subject;
      const filePaths = Array.from(new Set([pos.section.filePath, neg.section.filePath]));

      issues.push({
        id,
        severity,
        category: 'conflict',
        title: `Possible conflicting instruction: ${displaySubject}`,
        summary:
          `Possible conflict — review these together. ` +
          `A "${pair.label}" directive pattern was found pointing in opposite directions ` +
          `for the subject "${displaySubject}".`,
        filePaths,
        locations: [
          {
            filePath: pos.section.filePath,
            startLine: pos.section.startLine,
            endLine: pos.section.endLine,
          },
          {
            filePath: neg.section.filePath,
            startLine: neg.section.startLine,
            endLine: neg.section.endLine,
          },
        ],
        evidence: [pos.matchedLine, neg.matchedLine],
        recommendation:
          'Review these instructions together and consolidate into one clear directive.',
        confidence,
      });
    }
  }

  // ── BUG-001: Cross-pair subject conflict ────────────────────────────────────
  // If the SAME subject appears as a positive directive in one pair (e.g. "prefer
  // default exports") and as a negative directive in a DIFFERENT pair (e.g. "never
  // use default exports"), that is still a conflict — just missed by the pair-index
  // filter above. Fire at warning/confidence 0.5 to stay conservative.

  // Build subject → { positives, negatives } maps across all directives
  const subjectPos = new Map<string, DirectiveMatch[]>();
  const subjectNeg = new Map<string, DirectiveMatch[]>();

  for (const d of directives) {
    if (d.polarity === 'positive') {
      if (!subjectPos.has(d.subject)) subjectPos.set(d.subject, []);
      subjectPos.get(d.subject)!.push(d);
    } else {
      if (!subjectNeg.has(d.subject)) subjectNeg.set(d.subject, []);
      subjectNeg.get(d.subject)!.push(d);
    }
  }

  for (const [subject, posList] of subjectPos) {
    const negList = subjectNeg.get(subject);
    if (!negList) continue;

    for (const pos of posList) {
      for (const neg of negList) {
        // Same pair is already handled — skip
        if (pos.pairIndex === neg.pairIndex) continue;
        // Same section — skip
        if (
          pos.section.filePath === neg.section.filePath &&
          pos.section.startLine === neg.section.startLine
        ) continue;

        // BUG-010: enforce ≥ 2-token requirement for cross-pair matches too
        {
          const posWords = pos.subject.split(' ').filter(Boolean).length;
          const negWords = neg.subject.split(' ').filter(Boolean).length;
          if (posWords < 2 || negWords < 2) continue;
        }
        // BUG-011: scoped negatives are complementary — skip cross-pair too
        if (neg.hasQualifier) continue;

        // Use -1 as pairIndex sentinel to distinguish cross-pair IDs from within-pair IDs
        const id = conflictId(
          pos.section.filePath,
          pos.section.startLine,
          neg.section.filePath,
          neg.section.startLine,
          -1,
          subject,
        );
        if (reported.has(id)) continue;
        reported.add(id);

        const filePaths = Array.from(new Set([pos.section.filePath, neg.section.filePath]));

        issues.push({
          id,
          severity: 'warning',
          category: 'conflict',
          title: `Possible conflicting instruction: ${subject}`,
          summary:
            `Possible conflict — review these together. ` +
            `Opposing directives for "${subject}" were found across instruction files.`,
          filePaths,
          locations: [
            { filePath: pos.section.filePath, startLine: pos.section.startLine, endLine: pos.section.endLine },
            { filePath: neg.section.filePath, startLine: neg.section.startLine, endLine: neg.section.endLine },
          ],
          evidence: [pos.matchedLine, neg.matchedLine],
          recommendation: 'Review these instructions together and consolidate into one clear directive.',
          confidence: 0.5,
        });
      }
    }
  }

  return issues;
}

// ── BUG-002: Version conflict detector ───────────────────────────────────────

/**
 * Patterns to extract framework+version declarations from instruction file text.
 * Each entry captures the major-version string from a prose reference.
 * normalise() reduces the raw capture to a comparable form (usually major version).
 */
interface VersionExtractPattern {
  re: RegExp;
  name: string;
  /** Normalise the raw captured version string for comparison (e.g. "8.0" → "8"). */
  normalize: (raw: string) => string;
}

const VERSION_EXTRACT_PATTERNS: VersionExtractPattern[] = [
  {
    // BUG-002: No leading \b — ".NET" is often preceded by "(" or "—" which are
    // non-word chars, so \b\. would fail to match (.NET 8) or — .NET 8.
    re: /\.NET\s+v?(\d+)(?:\.\d+)*/gi,
    name: '.NET',
    normalize: (v) => v.split('.')[0]!,
  },
  {
    re: /ASP\.NET\s+Core\s+v?(\d+)/gi,
    name: 'ASP.NET Core',
    normalize: (v) => v.split('.')[0]!,
  },
  {
    re: /\bNode(?:\.?js)?\s+v?(\d+)/gi,
    name: 'Node.js',
    normalize: (v) => v.split('.')[0]!,
  },
  {
    re: /\bReact\s+v?(\d+)/gi,
    name: 'React',
    normalize: (v) => v.split('.')[0]!,
  },
  {
    re: /\bNext\.?js\s+v?(\d+)/gi,
    name: 'Next.js',
    normalize: (v) => v.split('.')[0]!,
  },
  {
    re: /\bPython\s+v?(\d+\.\d+|\d+)/gi,
    name: 'Python',
    normalize: (v) => v.split('.')[0]!,
  },
  {
    re: /\bGo\s+v?(\d+\.\d+)/gi,
    name: 'Go',
    normalize: (v) => v,  // keep major.minor for Go (1.17 vs 1.18 is significant)
  },
  {
    re: /\bUnity\s+v?(20\d{2}\.\d+|\d+)/gi,
    name: 'Unity',
    normalize: (v) => v.split('.')[0]!,
  },
  {
    re: /\bMirror(?:\s+Networking)?\s+v?(\d{2,4}(?:\.\d+)?)/gi,
    name: 'Mirror',
    normalize: (v) => v.split('.')[0]!,
  },
  {
    re: /\bTypeScript\s+v?(\d+)/gi,
    name: 'TypeScript',
    normalize: (v) => v.split('.')[0]!,
  },
  {
    re: /\bDjango\s+v?(\d+)/gi,
    name: 'Django',
    normalize: (v) => v.split('.')[0]!,
  },
  {
    re: /\bRails?\s+v?(\d+)/gi,
    name: 'Rails',
    normalize: (v) => v.split('.')[0]!,
  },
  {
    re: /\bLaravel\s+v?(\d+)/gi,
    name: 'Laravel',
    normalize: (v) => v.split('.')[0]!,
  },
  // BUG-005: Rust ecosystem — edition (2018/2021/2024) and popular async crates
  {
    // "Rust 2024 edition" / "Rust (2024 edition, MSRV 1.82)" / "edition = '2021'"
    // The \(? handles the parenthesised form: "Rust (2024 edition, ...)"
    re: /\bRust\s*\(?\s*v?(20\d{2})\s+edition\b/gi,
    name: 'Rust edition',
    normalize: (v) => v,  // keep full year — 2018 vs 2024 is significant
  },
  {
    re: /\bedition\s*=\s*["']?(20\d{2})["']?/gi,
    name: 'Rust edition',
    normalize: (v) => v,
  },
  {
    // tokio 0.2 vs tokio 1.x — major API break between 0.x and 1.x
    // The `? handles backtick-quoted crate names: `tokio` 1.x
    re: /\btokio`?\s+v?(\d+(?:\.\d+)?)/gi,
    name: 'tokio',
    normalize: (v) => {
      const [major, minor] = v.split('.');
      // For 0.x crates, major.minor is significant (0.2 vs 0.3 broke things)
      return major === '0' && minor ? `0.${minor}` : (major ?? v);
    },
  },
  {
    // axum 0.5 vs axum 0.7 — significant API differences even within 0.x
    // The `? handles backtick-quoted crate names: `axum` 0.7
    re: /\baxum`?\s+v?(\d+(?:\.\d+)?)/gi,
    name: 'axum',
    normalize: (v) => {
      const [major, minor] = v.split('.');
      return major === '0' && minor ? `0.${minor}` : (major ?? v);
    },
  },
  // BUG-005: Rust MSRV — "MSRV 1.82" / "minimum supported rust version 1.70"
  {
    re: /\b(?:MSRV|minimum\s+supported\s+rust\s+version)\s+v?(\d+\.\d+)/gi,
    name: 'Rust MSRV',
    normalize: (v) => v,  // keep full semver — 1.70 vs 1.82 is meaningful
  },
  // BUG-005: Elixir / Phoenix ecosystem
  {
    re: /\bPhoenix\s+v?(\d+(?:\.\d+)?)/gi,
    name: 'Phoenix',
    normalize: (v) => v.split('.')[0]!,
  },
  {
    re: /\bElixir\s+v?(\d+(?:\.\d+)?)/gi,
    name: 'Elixir',
    normalize: (v) => v.split('.')[0]!,
  },
  // BUG-005: JVM ecosystem
  {
    re: /\bSpring\s+Boot\s+v?(\d+)/gi,
    name: 'Spring Boot',
    normalize: (v) => v.split('.')[0]!,
  },
  {
    re: /\bJava\s+v?(\d+)/gi,
    name: 'Java',
    normalize: (v) => v.split('.')[0]!,
  },
  {
    re: /\bKotlin\s+v?(\d+)/gi,
    name: 'Kotlin',
    normalize: (v) => v.split('.')[0]!,
  },
];

/**
 * Determine whether the match at `index` in `content` is preceded by a negation
 * word or a historical-context phrase within ~50 characters.
 *
 * Exclusions:
 *   - "not .NET 8"           — explicit negation
 *   - "deprecated in Go 1.16" — historical deprecation note, not a version requirement
 *   - "removed in Go 1.16"    — same
 *   - "introduced in Go 1.16" — same
 *   - "added in Go 1.16"      — same
 *
 * BUG-009 fix: extend the window to 50 chars and add historical-context patterns.
 */
function isPrecededByNegation(content: string, index: number): boolean {
  const preceding = content.slice(Math.max(0, index - 50), index).toLowerCase();
  return (
    /\bnot\s+$|\bnot\s*\($|\(not\s/.test(preceding)
    || preceding.trimEnd().endsWith('not')
    // BUG-009: historical version anchors — "deprecated in X 1.16" is a fact, not a target
    || /\b(?:deprecated|removed|introduced|added)\s+in\s+\S*\s*$/.test(preceding)
  );
}

/** Extract {frameworkName → Set<normalizedVersion>} from a single file's content. */
function extractVersionDeclarations(content: string): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();

  for (const { re, name, normalize } of VERSION_EXTRACT_PATTERNS) {
    const cloned = new RegExp(re.source, re.flags);
    let m: RegExpExecArray | null;
    while ((m = cloned.exec(content)) !== null) {
      if (isPrecededByNegation(content, m.index)) continue;
      const version = normalize(m[1]!);
      if (!result.has(name)) result.set(name, new Set());
      result.get(name)!.add(version);
    }
  }

  return result;
}

/**
 * C6: strip fenced code blocks before extracting version declarations.
 * Without this, a fenced example quoting ".NET 6" in one file's
 * documentation reads as a real ".NET 6" declaration and conflicts with
 * genuine ".NET 8" prose elsewhere — the same fence character/length
 * tracking used in scanner.ts, vague-guidance.ts, and stale-instructions.ts.
 *
 * Deliberately does NOT also strip inline `code spans` like those other
 * detectors do: several VERSION_EXTRACT_PATTERNS entries (tokio, axum)
 * explicitly expect a backtick-quoted crate name (`` `tokio` 1.x ``) as a
 * legitimate version declaration, not documentation noise — stripping inline
 * spans would delete the exact text those patterns are designed to match.
 */
function stripCodeBlocks(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  let inBlock = false;
  let fenceChar: string | null = null;
  let fenceLen = 0;

  for (const line of lines) {
    if (!inBlock) {
      const openMatch = /^ {0,3}([`~]{3,})/.exec(line);
      if (openMatch) {
        inBlock = true;
        fenceChar = openMatch[1]![0] ?? null;
        fenceLen = openMatch[1]!.length;
        continue;
      }
      kept.push(line);
    } else {
      const closeMatch = /^ {0,3}([`~]{3,})\s*$/.exec(line);
      if (closeMatch && closeMatch[1]![0] === fenceChar && closeMatch[1]!.length >= fenceLen) {
        inBlock = false;
        fenceChar = null;
        fenceLen = 0;
      }
      // else: still inside the fence — drop the line
    }
  }

  return kept.join('\n');
}

function versionConflictId(framework: string, versions: string[]): string {
  const raw = `version-conflict:${framework}:${[...versions].sort().join('|')}`;
  const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12);
  return `version-conflict-${hash}`;
}

/**
 * Detect when different instruction files specify conflicting major versions of
 * the same framework or runtime (e.g. CLAUDE.md says ".NET 8", AGENTS.md says ".NET 6").
 *
 * Only fires when at least two files carry DIFFERENT positively-stated versions for
 * the same framework — negation references ("not .NET 8") are excluded.
 *
 * Confidence 0.75 → severity "high".
 */
export function detectVersionConflicts(files: InstructionFile[]): PromptCiIssue[] {
  if (files.length < 2) return [];

  // Per-file maps: filePath → (frameworkName → Set<version>)
  const perFile = files.map((f) => ({
    file: f,
    versions: extractVersionDeclarations(stripCodeBlocks(f.content)),
  }));

  // Aggregate: frameworkName → Map<version → filePath[]>
  const aggregate = new Map<string, Map<string, string[]>>();
  for (const { file, versions } of perFile) {
    for (const [framework, versionSet] of versions) {
      if (!aggregate.has(framework)) aggregate.set(framework, new Map());
      const verMap = aggregate.get(framework)!;
      for (const v of versionSet) {
        if (!verMap.has(v)) verMap.set(v, []);
        verMap.get(v)!.push(file.path);
      }
    }
  }

  const issues: PromptCiIssue[] = [];
  const import_path = (p: string) => p.split(/[\\/]/).pop() ?? p;

  for (const [framework, verMap] of aggregate) {
    if (verMap.size <= 1) continue; // all files agree (or only one version found)

    const allVersions = [...verMap.keys()];
    const allFilePaths = [...new Set([...verMap.values()].flat())];

    // Only flag when the conflict spans at least two different files
    const filesPerVersion = allVersions.map((v) => verMap.get(v)!);
    const allSameFile = filesPerVersion.every((fps) =>
      fps.every((fp) => fp === allFilePaths[0]),
    );
    if (allSameFile) continue;

    const id = versionConflictId(framework, allVersions);

    const evidence = allVersions.map(
      (v) => `${framework} ${v} referenced in: ${verMap.get(v)!.map(import_path).join(', ')}`,
    );

    issues.push({
      id,
      severity: 'high',
      category: 'conflict',
      title: `Version conflict: ${framework} (${allVersions.join(' vs ')})`,
      summary:
        `Possible conflict — review these together. ` +
        `Different instruction files specify different versions of ${framework}: ` +
        `${allVersions.join(' vs ')}.`,
      filePaths: allFilePaths,
      locations: allFilePaths.map((fp) => ({ filePath: fp })),
      evidence,
      recommendation:
        `Ensure all instruction files agree on which version of ${framework} this project targets. ` +
        `Remove or update whichever reference is out of date.`,
      confidence: 0.75,
    });
  }

  return issues;
}

// ── BUG-B1/B2/B3/B5/B6: Competing-technology conflict detector ───────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const COMPETING_TERM_ALIASES: Record<string, string[]> = {
  'kebab-case': ['kebab-case', 'kebab case', 'kebabcase'],
  camelcase: ['camelcase', 'camel case', 'camel-case'],
  pascalcase: ['pascalcase', 'pascal case', 'pascal-case'],
};

function competingTermRegex(term: string): RegExp {
  const aliases = COMPETING_TERM_ALIASES[term.toLowerCase()] ?? [term];
  return new RegExp(`\\b(?:${aliases.map(escapeRegex).join('|')})\\b`, 'i');
}

interface CompetingPairDef {
  termA: string;
  termB: string;
  dimension: string;
}

/**
 * Mutually-exclusive technology/pattern pairs. When different instruction files
 * recommend competing choices for the same dimension, agents cannot resolve the
 * contradiction on their own.
 *
 * BUG-B1: naming conventions
 * BUG-B2: ORM / data-access / state-management / package manager
 * BUG-B3: Next.js routing strategy
 * BUG-B5: export style
 * BUG-B6: Unity async patterns
 */
const COMPETING_PAIRS: CompetingPairDef[] = [
  // B1 — naming conventions
  { termA: 'kebab-case', termB: 'camelcase', dimension: 'file naming convention' },
  { termA: 'kebab-case', termB: 'pascalcase', dimension: 'file naming convention' },
  { termA: 'camelcase', termB: 'pascalcase', dimension: 'file naming convention' },
  // B2 — ORM / data-access
  { termA: 'ef core', termB: 'dapper', dimension: 'data access library' },
  // 'Entity Framework Core' / 'Entity Framework' are how instructions often spell it
  { termA: 'entity framework', termB: 'dapper', dimension: 'data access library' },
  // B2 — state management
  { termA: 'redux', termB: 'zustand', dimension: 'state management library' },
  { termA: 'redux', termB: 'mobx', dimension: 'state management library' },
  // B2 — Python package manager
  { termA: 'pip', termB: 'poetry', dimension: 'Python package manager' },
  // B3 — Next.js routing
  { termA: 'pages router', termB: 'app router', dimension: 'Next.js routing strategy' },
  // B5 — export style
  { termA: 'named exports', termB: 'default exports', dimension: 'module export style' },
  // B6 — Unity async patterns (singular and plural — instruction files usually use plural)
  { termA: 'coroutine', termB: 'unitask', dimension: 'Unity async pattern' },
  { termA: 'coroutine', termB: 'async/await', dimension: 'Unity async pattern' },
  { termA: 'coroutines', termB: 'unitask', dimension: 'Unity async pattern' },
  { termA: 'coroutines', termB: 'async/await', dimension: 'Unity async pattern' },
  // BUG-006: test scope — "unit tests only" vs "full integration suite" are opposing instructions
  { termA: 'unit tests only', termB: 'integration suite', dimension: 'test scope' },
  { termA: 'unit tests only', termB: 'full test suite', dimension: 'test scope' },
  { termA: 'lightweight unit tests', termB: 'integration suite', dimension: 'test scope' },
  // BUG-003: CLI framework pairs
  { termA: 'cobra', termB: 'urfave', dimension: 'Go CLI framework' },
  // BUG-003: Go ORM/data-access pairs
  { termA: 'gorm', termB: 'sqlx', dimension: 'Go data-access library' },
];

/** Directive verbs signalling a technology is being actively recommended. */
const TECH_DIRECTIVE_RE = /\b(?:use|prefer|always|must|should|follow|rely\s+on|stick\s+to|require)\b/i;

/**
 * C5: a directive verb and the tech term must co-occur, but requiring them on
 * the exact SAME physical line missed two common layouts:
 *   - a hard line-wrap ("Use\nZustand for all state")
 *   - a heading naming the term with the directive on the very next line
 *     ("## Zustand\nUse this for all state management.")
 * Checking each line AND each pair of adjacent lines joined by a space covers
 * both without needing full logical-line/paragraph segmentation — this is a
 * boolean co-occurrence check, not subject extraction, so the lower-fidelity
 * join is a safe, low-risk fit.
 */
function hasDirectiveNearTerm(content: string, termRe: RegExp): boolean {
  const lines = content.split('\n').map((l) => l.trim());

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (termRe.test(line) && TECH_DIRECTIVE_RE.test(line)) return true;

    const next = lines[i + 1];
    if (line && next) {
      const joined = `${line} ${next}`;
      if (termRe.test(joined) && TECH_DIRECTIVE_RE.test(joined)) return true;
    }
  }

  return false;
}

/**
 * Detect conflicts where different instruction files recommend mutually-exclusive
 * technologies or conventions for the same dimension.
 *
 * Fires only when at least one mention is in a directive context (use/prefer/must/…)
 * to avoid false-positives on casual mentions.
 *
 * Confidence: 0.6 (warning).
 */
export function detectCompetingTechConflicts(files: InstructionFile[]): PromptCiIssue[] {
  if (files.length < 2) return [];

  const issues: PromptCiIssue[] = [];
  const reported = new Set<string>();
  const strippedContentByPath = new Map(files.map((f) => [f.path, stripCodeBlocks(f.content)]));
  const searchableContent = (file: InstructionFile) => strippedContentByPath.get(file.path) ?? file.content;

  for (const pair of COMPETING_PAIRS) {
    const reA = competingTermRegex(pair.termA);
    const reB = competingTermRegex(pair.termB);

    const filesWithA = files.filter((f) => reA.test(searchableContent(f)));
    const filesWithB = files.filter((f) => reB.test(searchableContent(f)));

    if (filesWithA.length === 0 || filesWithB.length === 0) continue;

    // Only flag when the terms appear in DIFFERENT files — same-file coexistence is
    // likely an explicit comparison or migration note, not a real conflict.
    const pathsA = new Set(filesWithA.map((f) => f.path));
    const pathsB = new Set(filesWithB.map((f) => f.path));
    const fullyOverlapping =
      [...pathsA].every((p) => pathsB.has(p)) && [...pathsB].every((p) => pathsA.has(p));
    if (fullyOverlapping) continue;

    // At least one mention must be in a directive context to reduce noise.
    const hasDirectiveA = filesWithA.some((f) => hasDirectiveNearTerm(searchableContent(f), reA));
    const hasDirectiveB = filesWithB.some((f) => hasDirectiveNearTerm(searchableContent(f), reB));
    if (!hasDirectiveA && !hasDirectiveB) continue;

    const pairKey = [pair.termA.toLowerCase(), pair.termB.toLowerCase()].sort().join('|');
    if (reported.has(pairKey)) continue;
    reported.add(pairKey);

    const allFilePaths = [...new Set([...filesWithA, ...filesWithB].map((f) => f.path))];
    const id = `competing-tech-${crypto.createHash('sha1').update(pairKey).digest('hex').slice(0, 12)}`;

    issues.push({
      id,
      severity: 'warning',
      category: 'conflict',
      title: `Possible ${pair.dimension} conflict: "${pair.termA}" vs "${pair.termB}"`,
      summary:
        `Possible conflict — review these together. Different instruction files reference ` +
        `competing ${pair.dimension} choices: "${pair.termA}" and "${pair.termB}".`,
      filePaths: allFilePaths,
      locations: allFilePaths.map((fp) => ({ filePath: fp })),
      evidence: [
        `"${pair.termA}" referenced in: ${filesWithA.map((f) => path.basename(f.path)).join(', ')}`,
        `"${pair.termB}" referenced in: ${filesWithB.map((f) => path.basename(f.path)).join(', ')}`,
      ],
      recommendation:
        `Review both instruction files and decide which ${pair.dimension} is canonical. ` +
        `Remove or update whichever reference contradicts the team's actual choice.`,
      confidence: 0.6,
    });
  }

  return issues;
}
