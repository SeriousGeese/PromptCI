/**
 * Negative-instruction overload detector (FEAT-010).
 *
 * Models follow positive directives ("use const") more reliably than
 * prohibitions ("don't use var"). A file whose directive sentences are
 * overwhelmingly phrased as prohibitions is harder to follow than the same
 * guidance framed positively.
 *
 * Heuristic: split the file into candidate sentences, classify each as a
 * positive directive, a negative directive, or neither, and — when there are
 * enough directives to be meaningful — flag files where more than 40% of the
 * directives are negative. Info severity only; the wording is deliberately
 * cautious and the recommendation offers a positive-rewrite hint.
 *
 * Deterministic and rule-based: no clock, network, or randomness.
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type { InstructionFile, PromptCiIssue } from './types.js';
import { snippet } from './evidence.js';

/** Persistent, always-loaded instruction files this detector applies to. */
const TARGET_FILE_TYPES: ReadonlySet<InstructionFile['fileType']> = new Set([
  'claude',
  'agents',
  'cursor',
  'windsurf',
  'copilot',
  'prompt',
]);

/**
 * A sentence is a NEGATIVE directive when it contains one of these prohibition
 * markers. Negative markers take precedence over positive ones, so "always
 * avoid mutation" counts as negative — its operative instruction is a
 * prohibition.
 */
const NEGATIVE_MARKERS: RegExp[] = [
  // Second-person imperative prohibitions only. Third-person "does not" /
  // "doesn't" is descriptive narration ("this file does not repeat it"), not a
  // directive, so it is deliberately excluded to avoid inflating the count.
  /\bdo\s+not\b/i,
  /\bdon['’]?t\b/i,
  /\bnever\b/i,
  /\bavoid\b/i,
  /\brefrain\s+from\b/i,
  /\bmust\s+not\b/i,
  /\bmustn['’]?t\b/i,
  /\bshould\s+not\b/i,
  /\bshouldn['’]?t\b/i,
  /\bcannot\b/i,
  /\bcan['’]?t\b/i,
  /\bwon['’]?t\b/i,
  /\bno\s+longer\b/i,
];

/**
 * A sentence is a POSITIVE directive when it starts with an imperative verb or
 * carries a positive modal ("must"/"should"/"always" not already caught as
 * negative above). This intentionally under-counts rather than over-counts:
 * only clearly directive sentences enter the denominator.
 */
const POSITIVE_IMPERATIVE_START =
  /^(use|always|prefer|ensure|make\s+sure|keep|run|write|add|follow|call|set|return|check|verify|read|ask|include|place|put|store|document|test|update|create|define|import|export|name|group|split|choose|pick|apply|treat|surface|confirm|report|explain|favor|favour|default\s+to|stick\s+to|remember\s+to|be\s+sure\s+to)\b/i;
const POSITIVE_MODAL = /\b(must|should|always|shall)\b/i;

const MIN_DIRECTIVES = 8; // below this the ratio is too noisy to be meaningful
const NEGATIVE_RATIO_THRESHOLD = 0.4; // > 40% negative → finding

type Classification = 'negative' | 'positive' | 'none';

/** Strip a leading markdown list bullet / ordered-list marker / heading hash. */
function stripLeadingMarkers(line: string): string {
  return line
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*\d+[.)]\s+/, '')
    .replace(/^\s*>\s+/, '')
    .trim();
}

/**
 * Strip leading markdown emphasis (`**bold**`, `*italic*`, `` `code` ``) so the
 * operative verb is visible to the imperative test — otherwise "**Report** ..."
 * hides the "Report" that makes the sentence a positive directive.
 */
function stripLeadingEmphasis(text: string): string {
  return text.replace(/^[*_`]+/, '').trimStart();
}

/**
 * Split file content into candidate directive sentences. Fenced code blocks are
 * dropped (a bash comment is not an instruction sentence). Each non-blank line
 * is stripped of list/heading markers, then split on sentence terminators so a
 * line holding two clauses is counted as two.
 */
export function splitSentences(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const sentences: string[] = [];
  let inFence = false;

  for (const raw of lines) {
    const fenceToggle = /^\s*(```|~~~)/.test(raw);
    if (fenceToggle) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const cleaned = stripLeadingMarkers(raw);
    if (!cleaned) continue;

    for (const part of cleaned.split(/(?<=[.!?])\s+/)) {
      const trimmed = part.trim();
      // Require a few words so table cells / fragments don't count as sentences.
      if (trimmed.split(/\s+/).length >= 3) sentences.push(trimmed);
    }
  }

  return sentences;
}

function classify(sentence: string): Classification {
  const lead = stripLeadingEmphasis(sentence);
  // The LEADING imperative governs: a positively-framed instruction that also
  // mentions a prohibition ("Keep diffs focused; do not refactor unrelated
  // code") is a positive directive, not a negative one. Only sentences whose
  // primary verb is not a positive imperative fall through to the prohibition
  // markers.
  if (POSITIVE_IMPERATIVE_START.test(lead)) return 'positive';
  for (const re of NEGATIVE_MARKERS) {
    if (re.test(sentence)) return 'negative';
  }
  if (POSITIVE_MODAL.test(sentence)) return 'positive';
  return 'none';
}

function issueId(filePath: string): string {
  const hash = crypto.createHash('sha1').update(`negative-overload:${filePath}`).digest('hex').slice(0, 12);
  return `negative-overload-${hash}`;
}

export function detectNegativeInstructionOverload(files: InstructionFile[]): PromptCiIssue[] {
  const issues: PromptCiIssue[] = [];

  for (const file of files) {
    if (!TARGET_FILE_TYPES.has(file.fileType)) continue;

    const sentences = splitSentences(file.content);
    const negatives: string[] = [];
    let positiveCount = 0;

    for (const sentence of sentences) {
      const kind = classify(sentence);
      if (kind === 'negative') negatives.push(sentence);
      else if (kind === 'positive') positiveCount++;
    }

    const total = negatives.length + positiveCount;
    if (total < MIN_DIRECTIVES) continue;

    const ratio = negatives.length / total;
    if (ratio <= NEGATIVE_RATIO_THRESHOLD) continue;

    const fileName = path.basename(file.path);
    const pct = Math.round(ratio * 100);
    const examples = negatives.slice(0, 3).map((s) => snippet(s, 100));

    issues.push({
      id: issueId(file.path),
      severity: 'info',
      category: 'agent_practices',
      title: 'High proportion of negative instructions',
      summary:
        `About ${pct}% of the directive sentences in "${fileName}" are phrased as prohibitions ` +
        `(${negatives.length} of ${total}). Models tend to follow positive directives more ` +
        `reliably than prohibitions, so heavily negative guidance can be harder to apply.`,
      filePaths: [file.path],
      locations: [],
      evidence: examples.map((e) => `Negative directive: "${e}"`),
      recommendation:
        'Where practical, rephrase prohibitions as positive directives — e.g. instead of ' +
        '"don\'t use var", write "always use const or let". Keep prohibitions for the cases ' +
        'where no positive form is possible.',
      confidence: 0.5,
    });
  }

  return issues;
}
