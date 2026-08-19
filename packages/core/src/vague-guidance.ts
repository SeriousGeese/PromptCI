/**
 * Vague-guidance detector for PromptCI.
 *
 * Flags sections that contain non-actionable, vague guidance.
 * Emits at most one issue per section regardless of how many vague phrases
 * appear in it.
 *
 * Heuristic detector. Findings are tiered (FEAT-004): high-signal platitudes
 * ("write clean code", "best practices", "SOLID principles", …) are
 * warning 0.80; soft style/UX/paradigm phrases are info 0.75. A team can force
 * one severity for every finding via the `severityOverride` option (wired to
 * the `vagueGuidanceSeverity` config key).
 */

import * as crypto from 'node:crypto';
import type { InstructionFile, InstructionSection, IssueSeverity, PromptCiIssue } from './types.js';
import { stripCodeBlocks } from './markdown-fences.js';

const VAGUE_PHRASES = [
  'write clean code',
  'write clean',         // catches "write clean Go code", "write clean Python code", etc.
  'use best practices',
  'make it production ready',
  'production ready',       // no-hyphen variant: "keep it production ready"
  'production-ready',
  'be careful',
  'do the right thing',
  'follow good patterns',
  'write good tests',
  'keep it simple',
  'keep things simple',
  'best practices',           // catches "Follow best practices" (no "use" prefix)
  'production-quality',       // "Write production-quality code"
  'production quality',       // variant without hyphen
  'follow best practices',    // explicit form
  'idiomatic code',           // "write idiomatic code"
  'make sure everything works',
  'ensure quality',
  'write quality code',
  'industry standards',
  'generally accepted',
  // BUG-006: Software-quality buzzwords that are non-actionable in agent context
  'solid principles',         // "follow SOLID principles throughout"
  'follow solid',             // short form catch
  'self-documenting',         // "Good code is self-documenting"
  'make it maintainable',     // "Make it maintainable"
  'clean maintainable',       // "clean, maintainable code"
  'good engineering',         // "good engineering practices"
  // BUG-J1: Formal engineering jargon that sounds specific but provides no actionable constraint
  'clean architecture',       // "use clean architecture" — no concrete layer rules given
  'maintainable code',        // "write maintainable code" — what makes it maintainable?
  'readable code',            // "write readable code" — no concrete readability rules
  'high-quality code',        // "produce high-quality code" — what quality metric?
  'high quality code',        // variant without hyphen
  'follow industry standards', // "follow industry standards" — which standard?
  // BUG-004 (eval): Language-paradigm platitudes — sound like guidance but provide no
  // actionable constraint. Previously caught by a broader "idiomatic" trigger that was
  // narrowed in BUG-010, causing a regression for "write idiomatic Elixir code".
  'functional programming principles',  // "Follow functional programming principles"
  'write idiomatic',                    // "write idiomatic Elixir/Python/Rust code"
  // BUG-003: Subjective UI/UX language — not actionable without concrete criteria
  'polished and professional',    // "UI looks polished and professional"
  'looks polished',
  'feel smooth and native',       // "feel smooth and native"
  'smooth and native',
  'feels native',
  'feel native',
  'feel smooth',
  'accessible and usable',        // "accessible and usable by keyboard and screen reader users"
  'provide good defaults',        // "Provide good defaults"
  'great user experience',
  'good user experience',
  'seamless experience',
  'intuitive interface',
  'user-friendly',
  'easy to use',
  'delightful',
  // BUG-J2: Additional subjective UI quality adjectives
  'looks good',               // "the UI should look good"
  'visually appealing',       // "make it visually appealing"
  'native feel',              // "aim for a native feel"
  // BUG-003: Language-paradigm vague directives that don't specify concrete rules
  'follow go best practices', // "Follow Go best practices for idiomatic code"
  'follow rust best practices',
  'follow python best practices',
  'idiomatic go',             // "write idiomatic Go code"
  'idiomatic rust',
  'idiomatic python',
  'idiomatic elixir',
  'idiomatic typescript',
];

/**
 * Minimum surrounding context required to flag a vague phrase.
 * If the line containing the phrase is longer than this, it likely has
 * enough additional specifics to be actionable — skip it.
 */
const MAX_LINE_LENGTH_TO_FLAG = 120;

/**
 * V2: Auto-derive a no-hyphen twin for every hyphenated phrase instead of
 * hand-enumerating each one. Several phrases already had both forms listed
 * explicitly ("production ready" / "production-ready"), but others didn't
 * (e.g. "user-friendly" had no "user friendly" twin) — this closes that gap
 * for every current and future hyphenated entry in one place.
 */
function expandHyphenVariants(phrases: string[]): string[] {
  const expanded = new Set<string>();
  for (const phrase of phrases) {
    expanded.add(phrase);
    if (phrase.includes('-')) {
      expanded.add(phrase.replace(/-/g, ' '));
    }
  }
  return [...expanded];
}

const ALL_VAGUE_PHRASES = expandHyphenVariants(VAGUE_PHRASES);

/**
 * FEAT-004: High-signal platitudes. These are the phrases that most reliably
 * mark instruction rot — broad quality/effort exhortations that give an agent
 * no constraint at all. A section containing any of them is emitted at
 * `warning` (0.80); sections whose only matches are softer style/UX/paradigm
 * phrases stay `info` (0.75). Listed in the post-hyphen-expansion form so the
 * no-hyphen twins ("production ready" ↔ "production-ready") both qualify.
 */
const HIGH_SIGNAL_PHRASES = new Set<string>([
  'write clean code',
  'write clean',
  'use best practices',
  'best practices',
  'follow best practices',
  'make it production ready',
  'production ready',
  'production-ready',
  'production quality',
  'production-quality',
  'be careful',
  'solid principles',
  'follow solid',
  'clean architecture',
  'make it maintainable',
]);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * V3: Word-boundary-anchored phrase matcher. A naive substring match lets
 * 'be careful' match "must be carefully reviewed by QA" and 'write clean'
 * match "write cleanup scripts for temp files". Compiled once per phrase and
 * reused across every section/file.
 */
const PHRASE_PATTERNS = new Map<string, RegExp>(
  ALL_VAGUE_PHRASES.map((phrase) => [phrase, new RegExp(`\\b${escapeRegExp(phrase)}\\b`)]),
);


/**
 * V1: Find lines (or pairs of consecutive wrapped lines) containing `phraseRe`
 * within the per-line length budget. Hard-wrapped guidance like:
 *   Make it production
 *   ready before merging.
 * never matches on either individual line, so consecutive non-blank lines are
 * also checked joined by a single space.
 */
function findPhraseMatches(scanText: string, phraseRe: RegExp): string[] {
  const trimmedLines = scanText.split('\n').map((l) => l.trim());
  const matches: string[] = [];

  for (let i = 0; i < trimmedLines.length; i++) {
    const single = trimmedLines[i]!;
    if (single && phraseRe.test(single.toLowerCase()) && single.length <= MAX_LINE_LENGTH_TO_FLAG) {
      matches.push(single);
    }

    const next = trimmedLines[i + 1];
    if (single && next) {
      const joined = `${single} ${next}`;
      if (phraseRe.test(joined.toLowerCase()) && joined.length <= MAX_LINE_LENGTH_TO_FLAG) {
        matches.push(joined);
      }
    }
  }

  return matches;
}

function issueId(section: InstructionSection): string {
  const key = `${section.filePath}:${section.startLine}:vague`;
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
  return `vague-${hash}`;
}

export type VagueGuidanceOptions = {
  /**
   * FEAT-004: force every vague-guidance finding to this severity, overriding
   * the per-section high-signal/soft tiering. Wired to the `vagueGuidanceSeverity`
   * config key so teams can enforce a stricter (all-warning) or looser
   * (all-info) posture. Confidence still reflects the matched tier.
   */
  severityOverride?: 'info' | 'warning';
};

export function detectVagueGuidance(
  files: InstructionFile[],
  options: VagueGuidanceOptions = {},
): PromptCiIssue[] {
  const issues: PromptCiIssue[] = [];
  // One issue per section — collect all matching phrases and lines first
  const seen = new Set<string>();

  for (const file of files) {
    for (const section of file.sections) {
      const sectionKey = `${file.path}:${section.startLine}`;
      if (seen.has(sectionKey)) continue;

      const scanText = stripCodeBlocks(section.text, { stripInlineCode: true });
      // V1: collapse newlines to spaces for this fast pre-filter only, so a
      // phrase hard-wrapped across two lines still passes the gate. The actual
      // evidence extraction below (findPhraseMatches) independently re-checks
      // adjacency line-by-line, so this loosened gate can't manufacture a match
      // that findPhraseMatches wouldn't also find.
      const lowerTextCollapsed = scanText.toLowerCase().replace(/\n/g, ' ');
      const matchedPhrases: string[] = [];
      const matchedLines: string[] = [];

      for (const phrase of ALL_VAGUE_PHRASES) {
        const phraseRe = PHRASE_PATTERNS.get(phrase)!;
        if (!phraseRe.test(lowerTextCollapsed)) continue;

        for (const line of findPhraseMatches(scanText, phraseRe)) {
          if (!matchedPhrases.includes(phrase)) matchedPhrases.push(phrase);
          if (!matchedLines.includes(line)) matchedLines.push(line);
        }
      }

      if (matchedPhrases.length === 0) continue;
      seen.add(sectionKey);

      const phraseList = matchedPhrases.map((p) => `"${p}"`).join(', ');

      // FEAT-004: tier by the strongest phrase in the section. Any high-signal
      // platitude escalates the whole finding to warning; a config override,
      // when set, wins over the derived tier (but not the tier-based confidence).
      const isHighSignal = matchedPhrases.some((p) => HIGH_SIGNAL_PHRASES.has(p));
      const tierSeverity: IssueSeverity = isHighSignal ? 'warning' : 'info';
      const severity = options.severityOverride ?? tierSeverity;
      const confidence = isHighSignal ? 0.8 : 0.75;

      issues.push({
        id: issueId(section),
        severity,
        category: 'vague_guidance',
        title: 'Vague guidance detected',
        summary: `This section contains guidance that may be too vague to be actionable: ${phraseList}.`,
        filePaths: [file.path],
        locations: [{ filePath: file.path, startLine: section.startLine, endLine: section.endLine }],
        evidence: matchedLines.slice(0, 3).map((l) => `Line: "${l}"`),
        recommendation:
          'Replace vague guidance with concrete constraints — specific commands, forbidden ' +
          'patterns, or measurable criteria. For example, replace "write clean code" with ' +
          '"functions must be ≤ 50 lines; no unused variables".',
        confidence,
      });
    }
  }

  return issues;
}
