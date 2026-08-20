/**
 * Within-section semantic dedup detector (FEAT-013).
 *
 * The cross-file `detectDuplicates` detector works at section granularity and
 * misses a single section that restates the same point several ways. This
 * detector looks *inside* a section: for sections with more than five
 * paragraphs, it computes pairwise Jaccard similarity on the paragraphs and
 * flags any pair that is ≥ 0.65 similar, naming the paragraph numbers.
 *
 * Info severity only — near-duplicate prose within one section is worth a
 * gentle nudge, not a hard failure. Deterministic: no clock, network, or
 * randomness.
 */

import * as crypto from 'node:crypto';
import type { InstructionFile, InstructionSection, PromptCiIssue } from './types.js';
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

const MIN_PARAGRAPHS = 6; // "> 5 paragraphs"
const PARAGRAPH_JACCARD_THRESHOLD = 0.65;
const MIN_PARAGRAPH_CHARS = 40; // normalised; shorter paragraphs are too noisy
const MIN_PARAGRAPH_TOKENS = 8;

type Paragraph = {
  /** 1-based position among the section's paragraphs (all splits, not just qualifying). */
  number: number;
  text: string;
  startLine: number;
  tokens: Set<string>;
};

/** Normalise paragraph text for comparison: lowercase, strip markdown, collapse ws. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[\s]*[-*+]\s+/gm, '')
    .replace(/^[\s]*\d+[.)]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text: string): Set<string> {
  return new Set(text.match(/\b\w+\b/g) ?? []);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

/**
 * Split a section into paragraphs (blank-line separated), tracking each
 * paragraph's 1-based number and its start line within the file. Code-fence
 * paragraphs are skipped entirely — a repeated code block is the concern of the
 * duplicate-section detector, not prose dedup.
 */
function splitParagraphs(section: InstructionSection): Paragraph[] {
  const lines = section.text.split('\n');
  const paragraphs: Paragraph[] = [];
  let current: string[] = [];
  let currentStart = section.startLine;
  let paragraphNumber = 0;

  const flush = () => {
    if (current.length === 0) return;
    paragraphNumber++;
    const text = current.join('\n');
    if (!text.includes('```') && !text.includes('~~~')) {
      const norm = normalize(text);
      const tokens = tokenize(norm);
      if (norm.length >= MIN_PARAGRAPH_CHARS && tokens.size >= MIN_PARAGRAPH_TOKENS) {
        paragraphs.push({ number: paragraphNumber, text, startLine: currentStart, tokens });
      }
    }
    current = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      flush();
    } else {
      if (current.length === 0) currentStart = section.startLine + i;
      current.push(line);
    }
  }
  flush();

  return paragraphs;
}

function issueId(filePath: string, startLine: number): string {
  const hash = crypto
    .createHash('sha1')
    .update(`within-section-dup:${filePath}:${startLine}`)
    .digest('hex')
    .slice(0, 12);
  return `within-section-dup-${hash}`;
}

export function detectWithinSectionDedup(files: InstructionFile[]): PromptCiIssue[] {
  const issues: PromptCiIssue[] = [];

  for (const file of files) {
    if (!TARGET_FILE_TYPES.has(file.fileType)) continue;

    for (const section of file.sections) {
      const paragraphs = splitParagraphs(section);
      // "> 5 paragraphs" is measured against the qualifying (comparable)
      // paragraphs — trivial one-liners never counted toward the section total.
      if (paragraphs.length < MIN_PARAGRAPHS) continue;

      // Find the single strongest similar pair (and how many pairs cross the bar).
      let best: { a: Paragraph; b: Paragraph; sim: number } | null = null;
      let pairCount = 0;

      for (let i = 0; i < paragraphs.length; i++) {
        for (let j = i + 1; j < paragraphs.length; j++) {
          const sim = jaccard(paragraphs[i]!.tokens, paragraphs[j]!.tokens);
          if (sim >= PARAGRAPH_JACCARD_THRESHOLD) {
            pairCount++;
            if (!best || sim > best.sim) best = { a: paragraphs[i]!, b: paragraphs[j]!, sim };
          }
        }
      }

      if (!best) continue;

      const heading = section.heading ?? '(untitled section)';
      const pct = Math.round(best.sim * 100);
      const morePairs = pairCount > 1 ? ` (${pairCount} similar pairs in total)` : '';

      issues.push({
        id: issueId(file.path, section.startLine),
        severity: 'info',
        category: 'duplicate',
        title: `Possible repetition within section: ${heading}`,
        summary:
          `Within "${heading}", paragraphs ${best.a.number} and ${best.b.number} are about ` +
          `${pct}% similar${morePairs}. The section may be restating the same point several ` +
          `ways — consider consolidating.`,
        filePaths: [file.path],
        locations: [
          { filePath: file.path, startLine: best.a.startLine, endLine: best.a.startLine },
          { filePath: file.path, startLine: best.b.startLine, endLine: best.b.startLine },
        ],
        evidence: [
          `Paragraph ${best.a.number}: "${snippet(best.a.text, 120)}"`,
          `Paragraph ${best.b.number}: "${snippet(best.b.text, 120)}"`,
        ],
        recommendation:
          'Merge the near-duplicate paragraphs into one clear statement. If both are ' +
          'intentional (e.g. a summary and a detailed version), make the distinction explicit.',
        confidence: 0.5,
      });
    }
  }

  return issues;
}
