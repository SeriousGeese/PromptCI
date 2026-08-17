/**
 * Stale-instruction detector for PromptCI.
 *
 * Flags sections that likely reference outdated content:
 *   - Years 2019–2023 that appear outside code blocks
 *   - Cleanup keywords: "TODO remove", "remove later", "temporary fix", "workaround"
 *   - "deprecated" near a version number or tool name
 *   - Known old framework versions (React 16, Next.js 9, Unity 2019, etc.)
 *
 * Findings are heuristic — wording is intentionally cautious.
 */

import * as crypto from 'node:crypto';
import type { InstructionFile, InstructionSection, PromptCiIssue } from './types.js';

// ─── Pattern definitions ──────────────────────────────────────────────────────

/**
 * Years likely stale in an AI instruction context.
 * 2023 is now included since the current year is 2026.
 * Must not be immediately preceded by "/" or "-" (avoids ISO dates like 2022-01-01
 * or paths like /2022/report) — those are not year references.
 */
const STALE_YEAR_RE = /(?<![/-])\b(2019|2020|2021|2022|2023|2024|2025)\b(?![/-])/g;

/**
 * BUG-A1: Section headings that indicate historical records rather than active
 * instructions. Old year references in changelogs and release notes are expected
 * and must not be flagged as stale instructions.
 */
const HISTORY_SECTION_RE =
  /\b(?:history|changelog|change\s*log|release\s+notes?|releases?|versions?|what.?s\s+new|for\s+reference)\b/i;

/** Explicit cleanup markers. */
const CLEANUP_KEYWORD_RE =
  /\b(TODO\s*:?\s*remove|remove\s+later|temporary\s+fix|workaround)\b/gi;

/**
 * BUG-004: Dated TODO/FIXME/WORKAROUND markers inside HTML comments.
 * The main STALE_YEAR_RE intentionally excludes ISO-formatted dates like 2022-03-10
 * (using a negative lookahead on "/"). This separate pattern catches years that appear
 * inside parenthesised dates in HTML comments, e.g.:
 *   <!-- TODO (2022-03-10): migrate NextAuth v3 callbacks -->
 *   <!-- WORKAROUND (2021-08-14): ... -->
 * Groups: [1]=keyword, [2]=year
 *
 * ST1: Both `(?:(?!-->)[\s\S])*?` spans use a "tempered dot" — match anything
 * (including newlines) as long as it's not the start of the comment's closing
 * `-->`. This allows the keyword and its date to be split across lines
 * (`<!-- TODO\n(2022-03-10): ... -->`) and allows ordinary `>` characters
 * before the keyword (`<!-- if retries > 3 TODO (2022-01-01): remove -->`),
 * neither of which the old `[^>]*?` / `[^(>\n]*` classes permitted, while
 * still stopping at the actual end of the same comment.
 */
const HTML_COMMENT_DATED_TODO_RE =
  /<!--(?:(?!-->)[\s\S])*?\b(TODO|FIXME|WORKAROUND|HACK|NOTE)\b(?:(?!-->)[\s\S])*?\(\s*(\d{4})[-–\d]/gi;

/**
 * "deprecated" within ~10 words of a version number or recognisable tool name.
 */
const DEPRECATED_NEAR_VERSION_RE =
  /deprecated[\w\s,.()\\\-:`]{0,60}(v?\d+[\w.]+|react|next\.?js|angular|vue|webpack|babel|unity|jest|mocha)/gi;

/**
 * Known old framework/library versions that signal stale instructions.
 *
 * ST2: Every numeric version is prefixed with an optional `v?` so aliases
 * like "React v16", "Node v12", "Angular v8" are caught too — the old
 * patterns only matched the bare-number form, which was inconsistent with
 * manifest-consistency.ts's checkNodeVersionMismatch (which already accepts
 * `v?`).
 */
const OLD_VERSION_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\breact\s+v?1[0-6]\b/gi, label: 'React 16 or earlier' },
  { re: /\bnext\.?js\s+v?[1-9]\b/gi, label: 'Next.js 9 or earlier' },
  { re: /\bunity\s+v?201[0-9]\b/gi, label: 'Unity 2019 or earlier' },
  { re: /\bangular\s+v?[1-9]\b/gi, label: 'Angular 9 or earlier' },
  { re: /\bvue\s+v?[12]\b/gi, label: 'Vue 2 or earlier' },
  { re: /\bwebpack\s+v?[1-3]\b/gi, label: 'Webpack 3 or earlier' },
  { re: /\bbabel\s+v?[1-6]\b/gi, label: 'Babel 6 or earlier' },
  // BUG-005: Fixed — original pattern required "node.js" (with .js); bare "Node 12" was missed.
  //          Extended range to 16 since Node 14 & 16 are also EOL.
  { re: /\bnode(?:\.js?)?\s+v?(1[0-6]|[1-9])\b/gi, label: 'Node.js 16 or earlier' },
  { re: /\btypescript\s+v?[1-3]\b/gi, label: 'TypeScript 3 or earlier' },
  // BUG-005: Added Go — Go 1.17 and earlier pre-date generics (1.18) and are commonly stale.
  { re: /\bgo\s+v?1\.(1[0-7]|[0-9])\b/gi, label: 'Go 1.17 or earlier' },
  // BUG-005: Added Python 2 — Python 2 reached EOL in 2020.
  { re: /\bpython\s+v?2\./gi, label: 'Python 2' },
  // BUG-G2: Python 3.9 and earlier are EOL (3.9 EOL Oct 2025, 3.8 Oct 2024, earlier all prior).
  // Catches "Python 3.6", "Python 3.8", etc. without a 4-digit year.
  { re: /\bpython\s+v?3\.[0-9]\b/gi, label: 'Python 3.9 or earlier' },
  // BUG-005: Added .NET 5 and earlier (non-LTS / EOL versions).
  { re: /\.NET\s+v?[1-5]\b/gi, label: '.NET 5 or earlier' },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function issueId(section: InstructionSection, tag: string): string {
  const key = `${section.filePath}:${section.startLine}:${tag}`;
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
  return `stale-${hash}`;
}

function snippet(text: string, maxLen = 120): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= maxLen ? clean : `${clean.slice(0, maxLen)}…`;
}

function collectMatches(text: string, re: RegExp): string[] {
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  const cloned = new RegExp(re.source, re.flags);
  while ((m = cloned.exec(text)) !== null) {
    matches.push(m[0]);
  }
  return matches;
}

/**
 * BUG-013: Returns {match, index} pairs so we can check whether each match
 * occurs in a negation / avoidance context before flagging it as stale.
 */
function collectMatchesWithIndex(text: string, re: RegExp): Array<{ match: string; index: number }> {
  const results: Array<{ match: string; index: number }> = [];
  let m: RegExpExecArray | null;
  const cloned = new RegExp(re.source, re.flags);
  while ((m = cloned.exec(text)) !== null) {
    results.push({ match: m[0], index: m.index });
  }
  return results;
}

function collectOldHtmlTodoMatches(text: string): string[] {
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  const cloned = new RegExp(HTML_COMMENT_DATED_TODO_RE.source, HTML_COMMENT_DATED_TODO_RE.flags);
  while ((m = cloned.exec(text)) !== null) {
    const year = Number(m[2]);
    if (year <= 2025) {
      matches.push(m[0]);
    }
  }
  return matches;
}

/**
 * BUG-013: Detect whether an old-version reference is in a negation / avoidance
 * context (e.g. "do not add Vue 2 compat", "avoid Vue 2", "dropped Vue 2 support").
 *
 * If so, the mention is a CURRENT rule ("don't use the old version") rather than
 * a stale instruction, and should not be flagged.
 *
 * Looks at up to 80 chars before the match index for negation keywords.
 *
 * ST4: the trailing window only excludes sentence-ending punctuation
 * (`.`/`!`/`?`), not newlines — a single hard-wrap ("Do not\nadd Vue 2...")
 * no longer hides the negation keyword from the match. A BLANK line (a real
 * paragraph break) still ends the window, via the `(?!\n[ \t]*\n)` tempered
 * repetition, so negation from an unrelated earlier paragraph can't leak in.
 */
function isVersionInNegationContext(text: string, index: number): boolean {
  const preceding = text.slice(Math.max(0, index - 80), index).toLowerCase();
  return /\b(?:do\s+not|don['']?t|avoid|never|no\s+longer|drop(?:ped|ping)?|remov(?:ed?|ing)|deprecat(?:ed?|ing)|stop(?:ped|ping)?\s+(?:using|support(?:ing)?))\b(?:(?!\n[ \t]*\n)[^.!?])*$/.test(preceding);
}

/**
 * Strip fenced code blocks from text before scanning for stale years.
 * Code blocks often contain version pins or changelog entries that are
 * expected to reference specific years and should not trigger the detector.
 *
 * ST3: tracks fence character + length (matching scanner.ts's S1 fix and
 * vague-guidance.ts's V4 fix) instead of a `` ```...``` `` regex, so ~~~
 * fences are also stripped and an unclosed fence correctly swallows the
 * remainder of the text (rather than leaving it unstripped, as
 * `/```[\s\S]*?```/` did when no closing fence existed).
 */
function stripCodeBlocks(text: string, stripInlineCode = true): string {
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

  const noFences = kept.join('\n');
  return stripInlineCode ? noFences.replace(/`[^`\n]+`/g, '') : noFences;
}

// ─── Main detector ────────────────────────────────────────────────────────────

/**
 * Detect sections that may contain stale or outdated instructions.
 *
 * Returns one issue per offending section (multiple patterns in the same
 * section are merged into a single issue).
 */
export function detectStaleInstructions(files: InstructionFile[]): PromptCiIssue[] {
  const issues: PromptCiIssue[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    for (const section of file.sections) {
      // BUG-A1: Skip history/changelog/release-notes sections — old year references
      // in these sections are historical records, not actionable instructions.
      if (section.heading && HISTORY_SECTION_RE.test(section.heading)) continue;

      const text = section.text;
      const textNoCode = stripCodeBlocks(text);
      const textNoFencedCode = stripCodeBlocks(text, false);
      const evidence: string[] = [];
      let confidence = 0;
      const sectionKey = `${file.path}:${section.startLine}`;

      // 1. Stale years — only in prose, not inside code blocks (confidence 0.6)
      const yearMatches = collectMatches(textNoCode, STALE_YEAR_RE);
      if (yearMatches.length > 0) {
        evidence.push(`Year reference(s) that may be outdated: ${[...new Set(yearMatches)].join(', ')}`);
        confidence = Math.max(confidence, 0.6);
      }

      // 2. Cleanup keywords (confidence 0.6)
      const cleanupMatches = collectMatches(textNoFencedCode, CLEANUP_KEYWORD_RE);
      if (cleanupMatches.length > 0) {
        evidence.push(
          `Cleanup keyword(s): ${[...new Set(cleanupMatches.map((m) => m.trim()))].join(', ')}`,
        );
        confidence = Math.max(confidence, 0.6);
      }

      // 3. "deprecated" near version/tool (confidence 0.7)
      const deprecatedMatches = collectMatches(textNoFencedCode, DEPRECATED_NEAR_VERSION_RE);
      if (deprecatedMatches.length > 0) {
        evidence.push(`"deprecated" near version/tool: ${snippet(deprecatedMatches[0] ?? '', 80)}`);
        confidence = Math.max(confidence, 0.7);
      }

      // 4. Old framework versions (confidence 0.7)
      // BUG-013: Skip matches that appear in a negation context
      // ("do not add Vue 2 compat", "avoid Vue 2", etc.) — those are current rules,
      // not stale instructions.
      for (const { re, label } of OLD_VERSION_PATTERNS) {
        const hits = collectMatchesWithIndex(textNoCode, re);
        const relevantHits = hits.filter(({ index }) => !isVersionInNegationContext(textNoCode, index));
        if (relevantHits.length > 0) {
          evidence.push(`Old version reference: ${label} ("${relevantHits[0]!.match}")`);
          confidence = Math.max(confidence, 0.7);
        }
      }

      // 5. BUG-004: Dated TODO/FIXME/WORKAROUND in HTML comments.
      // The main STALE_YEAR_RE skips ISO dates (2022-03-10) by design; this catches them
      // specifically when they appear as a timestamp inside an HTML comment keyword.
      const htmlTodoMatches = collectOldHtmlTodoMatches(textNoFencedCode);
      if (htmlTodoMatches.length > 0) {
        evidence.push(
          `Dated ${htmlTodoMatches[0]!.match(/TODO|FIXME|WORKAROUND|HACK|NOTE/i)?.[0] ?? 'TODO'} ` +
          `marker in HTML comment: ${snippet(htmlTodoMatches[0] ?? '', 80)}`,
        );
        confidence = Math.max(confidence, 0.65);
      }

      if (evidence.length === 0) continue;
      if (seen.has(sectionKey)) continue;
      seen.add(sectionKey);

      issues.push({
        id: issueId(section, 'stale'),
        severity: 'warning',
        category: 'stale_instruction',
        title: 'Instruction may reference outdated content',
        summary:
          'This instruction may reference outdated content. Review and update or remove it.',
        filePaths: [file.path],
        locations: [{ filePath: file.path, startLine: section.startLine, endLine: section.endLine }],
        evidence: [`Section: "${snippet(text, 100)}"`, ...evidence],
        recommendation:
          'Review this section for accuracy. Update any outdated version numbers, tool references, ' +
          'or remove temporary notes that are no longer relevant.',
        confidence,
      });
    }
  }

  return issues;
}
