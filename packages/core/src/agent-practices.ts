/**
 * Agent-practices detector for PromptCI.
 *
 * Checks whether instruction files include key behavioral guidelines that
 * reduce hallucination, silent failure, and scope creep in AI agents.
 * Each check scans the combined content of ALL instruction files — guidance
 * can legitimately live in any file, so we don't require it to be in a
 * specific one.
 *
 * Checks:
 *   - Verification loop     — "run lint/tests before saying done"
 *   - Honesty policy        — "report failures, don't fake success"
 *   - Ask-when-unsure       — "say so and ask when uncertain, don't guess"
 *   - Read-before-edit      — "read a file before editing it"
 *   - Scope control         — "prefer focused diffs, don't rewrite unrelated code"
 *   - Code preservation     — "preserve existing code, only change what's needed"
 *   - Plan-first guidance   — "outline the approach before coding"
 *   - No contradictory "do not edit" header in human-maintained files
 *
 * The seven practice checks yield ONE info-level finding per repository that
 * lists every practice not found, tagged unscored so it costs no health-score
 * points (pcic-1ik0.3). The per-file checks further down are warnings.
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type { InstructionFile, PromptCiIssue } from './types.js';
import { stripCodeBlocks } from './markdown-fences.js';
import { fileIdPath } from './finding-id.js';
import { aliasesWithNewType, groupAliasesByTarget } from './alias-files.js';
import { UNSCORED_TAG } from './health-score.js';
import { importingToolFor, resolvedImports } from './mirror-import.js';
import type { RepoTree } from './repo-tree.js';

// ── Practice checks ──────────────────────────────────────────────────────────

interface PracticeCheck {
  id: string;
  title: string;
  /** Short name listed in the repository-level "practices not found" finding. */
  label: string;
  summary: string;
  /** At least one pattern must match somewhere across all files to pass. */
  patterns: RegExp[];
  recommendation: string;
  confidence: number;
  fixRecipe?: string;
  /**
   * pcic-55dy: set on a practice whose recommended sentence made no measurable
   * difference in PromptCI's behaviour evals. The finding then lists it for
   * information only, states this evidence instead of the recommendation, and
   * offers no fix text. Not a "remove this sentence" finding: the evidence is one
   * harness, one model and a few runs on small tasks (pcic-7swz tests removal).
   */
  noMeasuredEffect?: string;
}

/** Where the behaviour-eval evidence comes from, and its limits (pcic-55dy). */
const BEHAVIOUR_EVAL_BASIS =
  "PromptCI behaviour evals, 2026-11-19, Claude Code 2.1.327 with Sonnet 5.5, 5 runs with and 5 without the sentence on small synthetic tasks. Other agents and models may differ.";

const CHECKS: PracticeCheck[] = [
  {
    id: 'no-verification-loop',
    title: 'No verification loop instruction',
    label: 'verification loop',
    summary:
      'No instruction found asking the agent to run lint, typecheck, or tests before marking work complete. ' +
      'Without this, agents commonly report "done" without validating that changes compile or pass tests.',
    patterns: [
      /run\s+(pnpm|npm|yarn)\s+(lint|test|build|typecheck)/i,
      // AP1: a bare command mention ("pnpm build outputs to dist/") describes
      // WHAT the command does, not an instruction to run it before finishing —
      // exclude when immediately followed by a descriptive verb.
      /pnpm\s+(lint|test|build|typecheck)\b(?!\s+(?:outputs?|generates?|creates?|produces?|writes?|emits?|runs?)\b)/i,
      // AP1: `\b` prevents "npm" from matching as a substring of "pnpm" —
      // "pnpm build outputs to dist/" would otherwise vacuously satisfy this
      // pattern via the embedded "npm build" substring.
      /\bnpm\s+(run\s+)?(lint|test|build)/i,
      /before\s+(you\s+)?(say|mark|call|consider|report)\s+(it\s+)?(done|complete|finished)/i,
      /before\s+(finishing|completing|submitting|pushing|closing)/i,
      /work\s+is\s+not\s+complete\s+until/i,
    ],
    recommendation:
      'Add an explicit rule such as: "Before saying done, run pnpm lint && pnpm typecheck && pnpm test && pnpm build. ' +
      'Work is not complete until all checks pass."',
    confidence: 0.75,
    fixRecipe: 'Before saying work is complete, run pnpm lint, pnpm typecheck, pnpm test, and pnpm build. If any command fails, report the failure and stop.',
  },
  {
    id: 'no-honesty-policy',
    title: 'No "report failures honestly" instruction',
    label: 'report failures honestly',
    summary:
      'No instruction found requiring the agent to report test failures, errors, or build breakage honestly. ' +
      'Without this, agents may claim success when commands actually fail.',
    patterns: [
      /report\s+(the\s+)?(fail|error|break)/i,
      /don.?t\s+(fake|claim|pretend)\s+success/i,
      // AP1: word-boundary + exclude the common filler idiom "to be honest,
      // ..." (a conversational hedge, not a directive about reporting truth),
      // and no longer accidentally matches inside "dishonestly".
      /(?<!to\s+be\s+)\bhonestly?\b/i,
      /if\s+(a\s+)?(test|build|check)s?\s+(fail|break|error)/i,
      /never\s+skip\s+(failing\s+)?test/i,
      /never\s+hide\s+(error|fail)/i,
    ],
    recommendation:
      'Add a rule such as: "If tests fail, report the failure. Never claim success when commands error or tests are skipped."',
    confidence: 0.75,
    noMeasuredEffect:
      'Claude Code already reported a failing test instead of claiming success in our tests, with or without this sentence (5 of 5 runs each): it made no measurable difference',
    fixRecipe: 'If tests or commands fail, report the failure honestly. Never claim success when checks are skipped or error.',
  },
  {
    // FEAT-005: uncertainty handling. Arguably the single most impactful missing
    // instruction — an agent that guesses instead of asking produces confidently
    // wrong work. Distinct from the honesty policy above: honesty is about
    // reporting failures *after* a command runs; this is about surfacing doubt
    // *before* acting, so a file can satisfy one and miss the other.
    id: 'no-ask-when-unsure',
    title: 'No "ask when unsure" instruction',
    label: 'ask when unsure',
    summary:
      'No instruction found telling the agent to surface uncertainty — to ask or say so when it is unsure — ' +
      'instead of guessing. Without this, agents may proceed on assumptions and produce confidently wrong work.',
    patterns: [
      /\bif\s+(?:you(?:'|’)?re\s+|you\s+are\s+|ever\s+)?unsure\b/i,
      /\bif\s+in\s+(?:any\s+)?doubt\b/i,
      /\bwhen\s+(?:you(?:'|’)?re\s+|you\s+are\s+)?(?:unsure|uncertain)\b/i,
      /\bif\s+(?:you(?:'|’)?re\s+|you\s+are\s+|it(?:'|’)?s\s+)?uncertain\b/i,
      /\bif\s+you\s+(?:don(?:'|’)?t|do\s+not|dont)\s+know\b/i,
      /\bask\s+(?:before|first|for\s+clarification|the\s+user|a\s+question|questions)\b/i,
      /\bclarify\s+(?:before|first|with)\b/i,
      /\b(?:don(?:'|’)?t|do\s+not|dont)\s+guess\b/i,
      /\bsay\s+(?:you|that\s+you)\s+(?:don(?:'|’)?t|do\s+not|dont)\s+know\b/i,
      /\breport\s+uncertainty\b/i,
      /\backnowledge\s+(?:when|uncertainty|any\s+uncertainty)\b/i,
    ],
    recommendation:
      'Add a rule such as: "If you are uncertain about the correct approach, say so and ask before proceeding rather than guessing."',
    confidence: 0.75,
    noMeasuredEffect:
      'Claude Code did not ask about an ambiguous request in our tests, with or without this sentence (0 of 5 runs each): the sentence did not change what it did',
    fixRecipe:
      'If you are uncertain about the correct approach, say so before proceeding rather than guessing.',
  },
  {
    id: 'no-read-before-edit',
    title: 'No "read before edit" instruction',
    label: 'read before edit',
    summary:
      "No instruction found requiring the agent to read a file before editing it. " +
      "Agents that edit files they haven't read may clobber context or introduce inconsistencies.",
    patterns: [
      /read\s+(the\s+|a\s+|any\s+)?file\s+(fully\s+|first\s+)?before\s+(edit|modif|chang)/i,
      /read\s+(the\s+|a\s+)?file.*before\s+(edit|modif|chang)/i,
      /must\s+(first\s+)?read\s+(the\s+|a\s+|any\s+)?(file|source|code)/i,
      /always\s+read\s+(the\s+|a\s+)?(file|source|code)/i,
      /inspect\s+(the\s+|a\s+)?file\s+before/i,
      /read.*before.*edit/i,
      // AP5: reversed word order — "Before editing, read the relevant files."
      // The rule reads before/edit FIRST and "read" second, so the read.*edit
      // patterns above never matched this common phrasing.
      /before\s+(?:you\s+)?(?:edit|modif|chang)\w*\b[^.\n]{0,40}\bread(?:ing)?\b/i,
    ],
    recommendation:
      'Add a rule such as: "Always read a file fully before editing it."',
    confidence: 0.75,
    noMeasuredEffect:
      'Claude Code already read files before editing in our tests, with or without this sentence (5 of 5 runs each; its Edit tool may itself require a read first): it made no measurable difference',
    fixRecipe: 'Read a file before editing it. Preserve unrelated user changes.',
  },
  {
    id: 'no-scope-control',
    title: 'No scope-control instruction',
    label: 'scope control',
    summary:
      'No instruction found telling the agent to avoid rewriting unrelated systems or making sweeping changes. ' +
      'Unconstrained agents often refactor things they were not asked to touch.',
    patterns: [
      /focused\s+(diff|change|edit|pr|commit)/i,
      /don.?t\s+rewrite\s+unrelated/i,
      /do\s+not\s+rewrite\s+unrelated/i,
      /avoid\s+unrelated\s+(change|edit|refactor)/i,
      /minimal\s+(change|diff|edit)/i,
      /small\s+(change|diff|edit|pr|commit)/i,
      /targeted\s+(change|edit|fix)/i,
      /prefer\s+(small|focused|minimal)\s+(diff|change|pr)/i,
    ],
    recommendation:
      'Add a rule such as: "Prefer focused, minimal diffs. Do not rewrite or refactor code unrelated to the current task."',
    confidence: 0.7,
    noMeasuredEffect:
      'Claude Code already kept its edit inside the code the task was about in our tests, with or without this sentence (5 of 5 runs each): it made no measurable difference',
    fixRecipe: 'Prefer focused, minimal diffs. Do not rewrite or refactor code unrelated to the current task.',
  },
  {
    // FEAT-006: code preservation. Deliberately kept DISTINCT from
    // `no-scope-control` above, which constrains the *breadth* of new changes
    // ("prefer small, focused diffs"). This check constrains *destruction* of
    // what already exists — deleting working code, dropping tests, or clobbering
    // the user's uncommitted edits. An agent can honor one and violate the other
    // (a tightly-scoped diff can still delete a working function), so the two
    // behaviors are covered by two checks. The patterns are intentionally
    // non-overlapping: scope-control keys on "focused/minimal/unrelated", this
    // keys on "preserve/keep existing/only change what/don't delete".
    id: 'no-preserve-scope',
    title: 'No code-preservation instruction',
    label: 'code preservation',
    summary:
      'No instruction found telling the agent to preserve existing code and only change what the task requires. ' +
      'Without this, agents may delete working code, drop tests, or overwrite unrelated edits to reach a passing state.',
    patterns: [
      /\bpreserve\s+(?:existing|unrelated|the\s+existing|current|working|any\s+existing)\b/i,
      /\bpreserve\s+(?:unrelated\s+changes|the\s+user(?:'|’)?s?\s+(?:changes|edits|work))\b/i,
      /\b(?:don(?:'|’)?t|do\s+not|dont|never)\s+(?:delete|remove|drop|strip)\s+(?:existing|working|unrelated|any)\b/i,
      /\bkeep\s+(?:existing|the\s+existing|current|working)\s+(?:code|behaviou?r|functionality|logic|tests?)\b/i,
      /\bonly\s+(?:change|modify|touch|edit|update)\s+(?:what|the\s+code\s+(?:that|you)|files?\s+(?:that|you)|lines?)\b/i,
      /\b(?:don(?:'|’)?t|do\s+not|dont)\s+(?:modify|change|touch)\s+code\s+outside\b/i,
      /\bleave\s+(?:unrelated|existing|working|other)\s+(?:code|files?|logic|behaviou?r)\s+(?:untouched|alone|intact|as[- ]is)\b/i,
    ],
    recommendation:
      'Add a rule such as: "Preserve existing code and only change what the task requires. Do not delete working code, tests, or unrelated edits."',
    confidence: 0.7,
    fixRecipe:
      'Preserve existing code and only change what the task requires. Do not delete working code, tests, or unrelated edits.',
  },
  {
    id: 'no-plan-first',
    title: 'No "plan before implementing" instruction',
    label: 'plan before implementing',
    summary:
      'No instruction found asking the agent to outline an approach for complex tasks before writing code. ' +
      'Planning prompts significantly reduce wasted implementation effort on multi-file changes.',
    patterns: [
      /plan\s+(first|before|ahead)/i,
      /outline\s+(the\s+)?(approach|plan|design|steps)\s+before/i,
      /think\s+(?:through|it\s+through)\s+(?:the\s+)?(?:approach|plan|design|steps|task|problem)/i,
      /propose\s+(a\s+)?(plan|approach|design)/i,
      /before\s+implement\w+.*\b(plan|outline|design)\b/i,
      /design\s+before\s+(implement|cod)/i,
    ],
    recommendation:
      'Add a rule such as: "For complex or multi-file tasks, outline the approach and get confirmation before writing code."',
    confidence: 0.65,
    fixRecipe: 'For complex or multi-file tasks, outline the approach and get confirmation before writing code.',
  },
];

// ── Do-not-edit header check ──────────────────────────────────────────────────

// BUG-007: Broadened to match "DO NOT EDIT" anywhere in a line (not just at line
// start) so "<!-- AUTO-GENERATED — DO NOT EDIT MANUALLY -->" is caught.
const DO_NOT_EDIT_RE = /\bdo\s+not\s+(edit|modify|change)\b/im;

// BUG-H1: Also explicitly match HTML-comment auto-generated headers:
//   <!-- AUTO-GENERATED — DO NOT EDIT -->
//   <!-- auto-generated -->
// The existing DO_NOT_EDIT_RE handles "DO NOT EDIT" inside comments, but the
// auto-generated marker alone (without "DO NOT EDIT" text) was not matched.
const AUTO_GENERATED_RE =
  /<!--\s*auto[- ]?generated|auto[- ]?generated|<!--\s*generated\s*(?:by\s+\w+)?|this\s+file\s+is\s+generated|generated\s+by\s+\w+/i;

/**
 * BUG-003 / BUG-K1: Detect Claude-specific XML tags/blocks embedded in non-Claude
 * instruction files.
 *
 * Covers:
 *   1. <claude:thinking> / <claude:…> — namespaced XML (Claude 3 tool-use format)
 *   2. </claude:thinking> — closing tags of the same form
 *   3. <instructions-for-claude> — outer wrapper block format
 *
 * All forms are only meaningful to Claude; other tools treat them as literal text.
 *
 * BUG-K1: Broadened from `/<claude:[a-z]/` to `/<\/?claude:[\w-]+/` to reliably
 * catch all `<claude:*>` namespace variants regardless of tag-name length or case.
 */
const CLAUDE_XML_TAG_RE = /<\/?claude:[\w-]+|<instructions-for-claude[\s>]/i;

// AP6: a forwarding pointer only counts when it delegates to a *canonical
// instruction file* (AGENTS.md / CLAUDE.md), so a stub can defer its behavioral
// rules there. The target is restricted to those filenames (with an optional
// `./` or `.github/` prefix and surrounding backtick/quote) — a pointer to an
// arbitrary doc like `CONTRIBUTING.md` is NOT a behavioral-guidance delegation
// and must not exempt the file. The `.md` extension is required so prose like
// "use Claude to review" cannot match the bare word.
const FORWARDING_RE =
  /(?:follow|use|see|refer\s+to|canonical\s+(?:source|instructions?)|pointer\s+to)\s+[`'"*]*(?:\.?\/)?(?:\.github\/)?(AGENTS|CLAUDE)\.md\b/i;

// The same delegation phrased subject-first: "`AGENTS.md` is the single source
// of truth for all agents" / "AGENTS.md is canonical". Common in the tool stubs
// (GEMINI.md, .clinerules) that rule-sync setups generate next to AGENTS.md.
// Same-line only, so an unrelated "canonical" further down cannot pair up; and
// a file naming ITSELF as the source of truth is not delegating (see caller).
const SOURCE_OF_TRUTH_RE =
  /\b(AGENTS|CLAUDE)\.md\b[^\n]{0,60}?\b(?:single\s+source\s+of\s+truth|canonical)\b/i;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** The one repository-level finding's id; stable whichever practices are missing. */
export const MISSING_PRACTICES_ISSUE_ID = `agent-practice-${crypto
  .createHash('sha1')
  .update('missing-practices')
  .digest('hex')
  .slice(0, 12)}`;

/** The evidence line for a practice with no measured effect, ending in the eval basis (pcic-55dy). */
function noMeasuredEffectNote(check: PracticeCheck): string {
  return `${check.label}: ${check.noMeasuredEffect} (${BEHAVIOUR_EVAL_BASIS})`;
}

/**
 * One info-level finding for the whole repository listing the practices no
 * instruction file mentions. Tagged unscored: these are suggestions, and
 * nothing yet shows that the sentences change agent behaviour, so they do not
 * cost health-score points (see UNSCORED_TAG in health-score.ts).
 *
 * pcic-55dy: a practice whose sentence made no measurable difference in the
 * behaviour evals is still listed, for information, but the finding states the
 * evidence for it instead of recommending the sentence, and its fix text leaves
 * it out.
 */
function missingPracticesIssue(missing: PracticeCheck[], fileCount: number, filePaths: string[]): PromptCiIssue {
  const labels = missing.map((check) => check.label);
  const suggested = missing.filter((check) => check.noMeasuredEffect === undefined);
  const informational = missing.filter((check) => check.noMeasuredEffect !== undefined);
  const fixRecipe = suggested.map((check) => check.fixRecipe).filter(Boolean).join('\n');
  const evidenceNote =
    informational.length > 0
      ? ` For ${informational.length === 1 ? 'one of them' : `${informational.length} of them`} (${informational.map((c) => c.label).join(', ')}), ` +
        "PromptCI's behaviour evals found the sentence made no measurable difference to what Claude Code did, so " +
        `${informational.length === 1 ? 'it is' : 'they are'} listed for information only.`
      : '';
  const suggestion =
    suggested.length > 0
      ? 'Consider adding the rules that fit how you want agents to work, for example: ' +
        suggested.map((check) => check.recommendation.replace(/^Add (?:an explicit |a )?rule such as: /, '')).join(' ')
      : '';
  const information =
    informational.length > 0
      ? `${suggested.length > 0 ? ' ' : ''}No sentence is suggested for ${informational.map((c) => c.label).join(', ')}: ` +
        informational.map(noMeasuredEffectNote).join('; ') +
        '.'
      : '';
  return {
    id: MISSING_PRACTICES_ISSUE_ID,
    severity: 'info',
    category: 'agent_practices',
    title: 'Some common agent-practice guidance was not found',
    summary:
      `No instruction found for ${missing.length} of the ${CHECKS.length} agent practices PromptCI looks for ` +
      `(${labels.join(', ')}). These are suggestions that often help agents, not defects, so this finding ` +
      'does not count toward the health score.' +
      evidenceNote,
    filePaths,
    locations: [],
    // One line per missing practice, in a fixed order.
    evidence: [
      `Searched ${fileCount} instruction file(s).`,
      ...labels.map((label) => `Not found: ${label}`),
    ],
    recommendation: suggestion + information,
    ...(fixRecipe ? { fixRecipe } : {}),
    confidence: Math.min(...missing.map((check) => check.confidence)),
    // One identity per repository: adding a rule, or another instruction
    // file, changes the evidence and file list but is the same finding
    // getting better, not "resolved + new" (baseline, review-diff, SARIF).
    fingerprintKey: 'agent-practice:missing-practices',
    tags: [UNSCORED_TAG],
  };
}

function doNotEditIssueId(filePath: string): string {
  const hash = crypto.createHash('sha1').update(`do-not-edit:${filePath}`).digest('hex').slice(0, 12);
  return `do-not-edit-${hash}`;
}

function perFileBehaviorIssueId(filePath: string): string {
  const hash = crypto.createHash('sha1').update(`per-file-behavior:${filePath}`).digest('hex').slice(0, 12);
  return `per-file-behavior-${hash}`;
}

/**
 * B1: canonical-owner.ts independently derives an id via the exact same
 * `behavior-duplication:${filePath}` hash input for a conceptually similar
 * (but distinct) finding — the two detectors collide on id for the same
 * file. Namespacing the hash input per-detector keeps the ids distinct even
 * for the same file path; the public id PREFIX is unchanged so existing
 * baselines/tooling that pattern-match on `behavior-duplication-` still work.
 */
function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

/** AP2: 1-indexed line number containing character offset `index` in `content`. */
function lineNumberAtOffset(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

/**
 * BUG-002: Strip human-facing checklist items from content before running
 * agent-practice pattern checks.
 *
 * Lines like "- [ ] Run pnpm test" or "* [ ] npm run build" are PR / human
 * checklists, not agent behavioral rules. Matching them causes the
 * verification-loop check to incorrectly conclude the rule is present.
 *
 * Strips lines that:
 *   - start with optional whitespace + list marker (-, *, +, or digit.)
 *   - followed by a GitHub-style checkbox `[ ]` or `[x]`
 */
function stripChecklistLines(content: string): string {
  return content
    .split('\n')
    .filter((line) => !/^\s*(?:[-*+]|\d+\.)\s+/.test(line) || !/\[[ x?]\]/.test(line))
    .join('\n');
}


// BUG-006: classify by the scanner-computed `fileType` (derived from the repo-
// RELATIVE path in deriveFileType) plus the location-independent basename.
// Never substring-match a directory like `/.claude/` against the ABSOLUTE
// `file.path`: the checkout location leaks in, so a repo checked out under a
// Claude Code worktree (`.../.claude/worktrees/<branch>/`) misclassifies every
// file — README.md included — as a Claude instruction file. deriveFileType
// already maps the in-repo `.claude/`, `.cursor/rules/`, and
// `.github/instructions/` directories, so `fileType` is the authoritative,
// checkout-location-independent signal.

function isCopilotInstructionsFile(file: InstructionFile): boolean {
  return (
    file.fileType === 'copilot' ||
    path.basename(file.path).toLowerCase() === 'copilot-instructions.md'
  );
}

function isCursorRulesFile(file: InstructionFile): boolean {
  return file.fileType === 'cursor' || path.basename(file.path).toLowerCase() === '.cursorrules';
}

function isWindsurfRulesFile(file: InstructionFile): boolean {
  return file.fileType === 'windsurf' || path.basename(file.path).toLowerCase() === '.windsurfrules';
}

function isClaudeInstructionsFile(file: InstructionFile): boolean {
  return file.fileType === 'claude' || path.basename(file.path).toLowerCase() === 'claude.md';
}

function perFileBehaviorTarget(file: InstructionFile): { label: string; agent: string } | undefined {
  if (isCursorRulesFile(file)) {
    return { label: 'Cursor rules file', agent: 'Cursor agents' };
  }

  // BUG-19: `.windsurfrules` is scanned but previously typed 'unknown', so it
  // never matched a per-agent target and the per-file behavior checks skipped it.
  if (isWindsurfRulesFile(file)) {
    return { label: '.windsurfrules', agent: 'Windsurf agents' };
  }

  if (isClaudeInstructionsFile(file)) {
    return { label: 'CLAUDE.md', agent: 'Claude' };
  }

  if (isCopilotInstructionsFile(file)) {
    return { label: '.github/copilot-instructions.md', agent: 'GitHub Copilot' };
  }

  // GEMINI.md and a single-file `.clinerules` are read standalone by their
  // tool, exactly like the files above — the same BUG-19 reasoning as
  // `.windsurfrules`. Files inside a `.clinerules/` DIRECTORY are not targets:
  // Cline concatenates the whole directory, so one rule file lacking guidance
  // that a sibling provides is not a gap. Persona files (SOUL.md etc.) are not
  // tool-specific rule files, so they are not per-agent targets either.
  if (file.fileType === 'gemini') {
    return { label: 'GEMINI.md', agent: 'Gemini CLI' };
  }

  if (file.fileType === 'cline' && path.basename(file.path) === '.clinerules') {
    return { label: '.clinerules', agent: 'Cline' };
  }

  return undefined;
}

/**
 * How a file forwards its behavioral rules to another instruction file.
 *  - `import`: an `@path` import line that Claude Code / Gemini CLI load with
 *    the file. `unread` names the imported file when the repository holds it
 *    but this scan could not read it (#205), so its guidance was not checked.
 *  - `prose`: a sentence such as "Follow AGENTS.md". Claude Code's docs say
 *    Claude sees the file only if it decides to open it (#184); `pointsTo` is
 *    the file name the sentence gives.
 */
type Forwarding =
  | { kind: 'import'; unread?: string }
  | { kind: 'prose'; pointsTo?: 'AGENTS' | 'CLAUDE' };

/** Per-scan memo of whether an imported file the scan did not read can be read (one read per file, size-capped). */
const READABLE_IMPORTS = new WeakMap<RepoTree, Map<string, boolean>>();
const MAX_IMPORT_BYTES = 1_000_000;

function importReadable(tree: RepoTree, target: string): boolean {
  let memo = READABLE_IMPORTS.get(tree);
  if (!memo) READABLE_IMPORTS.set(tree, (memo = new Map()));
  let readable = memo.get(target);
  if (readable === undefined) {
    readable = tree.readText(target, { maxBytes: MAX_IMPORT_BYTES }).state === 'found';
    memo.set(target, readable);
  }
  return readable;
}

function forwardingOf(
  file: InstructionFile,
  files: InstructionFile[],
  tree?: RepoTree,
  hasGuidance: (f: InstructionFile) => boolean = () => false,
): Forwarding | undefined {
  // pcic-1ik0.10: an import line in a file whose tool loads imports (CLAUDE.md,
  // GEMINI.md) that resolves, from that file's directory, to a scanned
  // AGENTS.md or CLAUDE.md puts that file's guidance in the tool's context:
  // the file forwards. #205: so does an import of any file the repository
  // holds, scanned or not (a scan that excludes AGENTS.md, a hosted scan that
  // did not fetch it); the scan's tree answers whether it exists. Not counted:
  // a markdown link (no tool loads it), an import inside fenced code or an
  // HTML comment (not loaded), an import whose path reaches no file (a wrong
  // path loads nothing), and an import line in a file whose tool documents no
  // import syntax.
  if (importingToolFor(file.path) !== undefined) {
    const self = fileIdPath(file);
    const targets = resolvedImports(self, file.content);
    const canonical = new Set(
      files
        .filter((f) => f !== file && /^(?:AGENTS|CLAUDE)\.md$/.test(path.basename(f.path)))
        .map((f) => fileIdPath(f)),
    );
    if (targets.some((t) => canonical.has(t))) return { kind: 'import' };
    if (tree) {
      // A scanned target forwards only when it holds behavioral guidance (the
      // canonical AGENTS.md/CLAUDE.md case is handled above). Only a file that
      // exists but was not scanned gets the benefit of the doubt.
      const scanned = new Map(files.map((f) => [fileIdPath(f), f]));
      for (const t of targets) {
        const scannedFile = scanned.get(t);
        if (scannedFile) {
          if (scannedFile !== file && hasGuidance(scannedFile)) return { kind: 'import' };
          continue;
        }
        if (!tree.isFile(t)) continue;
        return importReadable(tree, t) ? { kind: 'import' } : { kind: 'import', unread: t };
      }
    }
  }
  // AP6: A header forwarding pointer near the top ("Follow AGENTS.md for the
  // canonical instructions") delegates behavioral rules to the canonical file
  // regardless of the stub's total length. It still exempts a file from the
  // "missing guidance" advice, but for CLAUDE.md the import is the better
  // recommendation (see the prose-pointer finding).
  const head = file.content.split(/\r?\n/).slice(0, 12).join('\n');
  const pointer = FORWARDING_RE.exec(head);
  if (pointer) return { kind: 'prose', pointsTo: pointer[1]!.toUpperCase() as 'AGENTS' | 'CLAUDE' };
  const sourceOfTruth = SOURCE_OF_TRUTH_RE.exec(head);
  if (sourceOfTruth && `${sourceOfTruth[1]!.toLowerCase()}.md` !== path.basename(file.path).toLowerCase()) {
    return { kind: 'prose', pointsTo: sourceOfTruth[1]!.toUpperCase() as 'AGENTS' | 'CLAUDE' };
  }
  // Legacy: a short file with a forwarding pointer anywhere.
  const anywhere = file.lineCount < 20 ? FORWARDING_RE.exec(file.content) : null;
  return anywhere ? { kind: 'prose', pointsTo: anywhere[1]!.toUpperCase() as 'AGENTS' | 'CLAUDE' } : undefined;
}

function isForwardingFile(
  file: InstructionFile,
  files: InstructionFile[] = [],
  tree?: RepoTree,
  hasGuidance?: (f: InstructionFile) => boolean,
): boolean {
  return forwardingOf(file, files, tree, hasGuidance) !== undefined;
}

/** Repo-relative POSIX import path from `from`'s directory to `to` (`AGENTS.md`, `../AGENTS.md`). */
function importPathBetween(from: InstructionFile, to: InstructionFile): string {
  return path.posix.relative(path.posix.dirname(fileIdPath(from)), fileIdPath(to)) || path.basename(to.path);
}

/**
 * How to bring another file's rules into a tool file. Claude Code loads an
 * `@path` import with the file; a sentence telling Claude to read the file
 * works only if Claude decides to open it (#184), so CLAUDE.md gets the import.
 */
function forwardingAdvice(file: InstructionFile, target: { label: string }, source: InstructionFile): string {
  if (importingToolFor(file.path) === 'claude-code') {
    return (
      `put \`@${importPathBetween(file, source)}\` on a line of its own in ${target.label}: Claude Code loads an ` +
      `imported file along with the file that imports it, whereas a sentence telling Claude to read ` +
      `${path.basename(source.path)} works only if Claude decides to open it`
    );
  }
  return `have ${target.label} point to ${path.basename(source.path)}, if that tool is set up to read it`;
}

// ── Detector ─────────────────────────────────────────────────────────────────

/**
 * Symlink aliases whose OWN tool-specific name adds a per-agent target the real
 * file does not have: `CLAUDE.md -> AGENTS.md` means Claude reads AGENTS.md's
 * content, so the per-file behavior checks apply to it as the CLAUDE.md it is.
 * An alias whose target is the same kind of file as the real one adds nothing.
 */
function aliasesWithNewTarget(files: InstructionFile[], aliases: InstructionFile[]): InstructionFile[] {
  return aliases.filter((alias) => {
    const target = perFileBehaviorTarget(alias);
    if (!target) return false;
    const canonical = files.find((f) => f.relativePath === alias.aliasOf);
    return canonical === undefined || perFileBehaviorTarget(canonical)?.label !== target.label;
  });
}

/** A Claude XML tag is only meaningful in a CLAUDE.md; README files document the tags as examples. */
function isClaudeTagTarget(fileType: InstructionFile['fileType']): boolean {
  return fileType !== 'claude' && fileType !== 'readme';
}

/**
 * BUG-007: Claude-specific XML tags in a non-Claude instruction file.
 * <claude:thinking> and similar tags are Claude-specific features; embedding them
 * in .cursorrules or AGENTS.md is tool-specific syntax in the wrong file type.
 * Skip README files — they often document Claude XML tags as examples rather than using them
 * Skip if the tag only appears inside fenced code blocks (documentation, not real usage)
 */
function claudeXmlTagIssue(names: InstructionFile[]): PromptCiIssue | undefined {
  // `names` is one real file, or every link to one real file (one finding listing them all, id from the first).
  const file = names[0]!;
  if (!isClaudeTagTarget(file.fileType)) return undefined;
  const contentOutsideCode = stripCodeBlocks(file.content).replace(/`[^`\n]+`/g, '');
  if (!CLAUDE_XML_TAG_RE.test(contentOutsideCode)) return undefined;
  const hash = crypto.createHash('sha1').update(`claude-xml-tag:${fileIdPath(file)}`).digest('hex').slice(0, 12);
  // AP3: search contentOutsideCode (the same text the gate above tested),
  // not the raw file.content — otherwise an earlier occurrence of the
  // tag that exists ONLY inside a code fence (documentation, not real
  // usage) could be picked as evidence instead of the real match that
  // actually made the gate fire.
  const firstTag = (/<\/?claude:[\w-]+/i).exec(contentOutsideCode)?.[0] ?? '<claude:...>';
  return {
    id: `claude-xml-tag-${hash}`,
    severity: 'warning',
    category: 'structure',
    title: 'Claude-specific XML tag in non-Claude instruction file',
    summary:
      `This file contains a Claude-specific XML tag (${firstTag}) but is not a CLAUDE.md file. ` +
      `Claude XML tags are only interpreted by Claude; other AI tools (Cursor, Copilot, etc.) ` +
      `will treat them as literal text or ignore them.`,
    filePaths: names.map((f) => f.path),
    locations: names.map((f) => ({ filePath: f.path })),
    evidence: [`Found: ${firstTag} in ${[...new Set(names.map((f) => f.fileType))].join(', ')} file`],
    recommendation:
      'Move Claude-specific directives to CLAUDE.md, or replace this tag with a plain-text ' +
      'instruction that all tools can understand.',
    confidence: 0.85,
  };
}

function pointsToAgents(forwarding: Forwarding): boolean {
  return forwarding.kind === 'prose' && forwarding.pointsTo === 'AGENTS';
}

/** The scanned AGENTS.md a CLAUDE.md would import: the one in its own directory, else the shallowest. */
function agentsFileFor(file: InstructionFile, files: InstructionFile[]): InstructionFile | undefined {
  const agents = files.filter((f) => path.basename(f.path) === 'AGENTS.md');
  const dir = path.posix.dirname(fileIdPath(file));
  const depth = (f: InstructionFile) => fileIdPath(f).split('/').length;
  return (
    agents.find((f) => path.posix.dirname(fileIdPath(f)) === dir) ??
    [...agents].sort((a, b) => depth(a) - depth(b) || (fileIdPath(a) < fileIdPath(b) ? -1 : 1))[0]
  );
}

/**
 * #184: a CLAUDE.md that only tells Claude in words to read AGENTS.md. Claude
 * Code's memory docs say Claude then sees the file only if it decides to open
 * it, and recommend an `@AGENTS.md` import. Advice, left out of the score.
 */
function prosePointerIssue(file: InstructionFile, agents: InstructionFile): PromptCiIssue {
  const hash = crypto.createHash('sha1').update(`prose-pointer:${fileIdPath(file)}`).digest('hex').slice(0, 12);
  const importLine = `@${importPathBetween(file, agents)}`;
  return {
    id: `prose-pointer-${hash}`,
    severity: 'info',
    category: 'agent_practices',
    title: `${path.basename(file.path)} points to AGENTS.md in words only`,
    summary:
      `${path.basename(file.path)} tells the reader to follow ${path.basename(agents.path)} in a sentence. Claude Code's ` +
      `docs say that works only if Claude decides to open the file, while an import line loads the file with ` +
      `${path.basename(file.path)}. This is a suggestion, and it does not count toward the health score.`,
    filePaths: [file.path],
    locations: [{ filePath: file.path }],
    evidence: [`No import line that reaches ${path.basename(agents.path)} was found in ${path.basename(file.path)}.`],
    recommendation:
      `Consider replacing the sentence with \`${importLine}\` on a line of its own, so Claude Code loads ` +
      `${path.basename(agents.path)} with this file.`,
    confidence: 0.6,
    tags: [UNSCORED_TAG],
  };
}

/** #205: the file imports a file the repository holds but this scan could not read. */
function unreadImportIssue(file: InstructionFile, target: string): PromptCiIssue {
  const hash = crypto.createHash('sha1').update(`unread-import:${fileIdPath(file)}:${target}`).digest('hex').slice(0, 12);
  return {
    id: `unread-import-${hash}`,
    severity: 'info',
    category: 'agent_practices',
    title: `Imported file of ${path.basename(file.path)} was not read`,
    summary:
      `${path.basename(file.path)} imports ${target}, which the repository holds, but this scan did not read it, ` +
      `so whether it carries behavioral guidance was not checked. No guidance gap is reported for ${path.basename(file.path)}.`,
    filePaths: [file.path],
    locations: [{ filePath: file.path }],
    evidence: [`Import: @${target} (exists, content not read)`],
    recommendation: 'No action needed unless the imported file lacks behavioral rules.',
    confidence: 0.5,
    tags: [UNSCORED_TAG],
  };
}

export function detectAgentPractices(
  files: InstructionFile[],
  aliases: InstructionFile[] = [],
  /** The scan's view of the repository, to resolve an `@` import of a file outside the scanned set (#205). */
  tree?: RepoTree,
): PromptCiIssue[] {
  if (files.length === 0) return [];
  // Files the per-agent checks run over: every scanned file plus the symlink aliases that are a different tool's file.
  const targetFiles = [...files, ...aliasesWithNewTarget(files, aliases)];

  const issues: PromptCiIssue[] = [];
  const combinedContent = files.map((f) => f.content).join('\n');
  // BUG-002: For the verification-loop check, strip human-facing checklist items
  // (lines like "- [ ] Run pnpm test") so that a PR checklist doesn't satisfy the
  // requirement for an agent behavioral directive.
  const combinedContentNoChecklists = stripChecklistLines(combinedContent);
  const allFilePaths = files.map((f) => f.path);

  // ── Per-practice checks (scan combined content) ───────────────────────────
  // pcic-1ik0.3 (PromptCI#158): one info finding per repository listing every
  // practice not found, left out of the health score. In a 43-repository corpus
  // each practice was missing from nearly every repository, so seven separate
  // findings said little about any one repository and set its score.
  const missing = CHECKS.filter((check) => {
    // BUG-002: Verification loop requires an imperative agent directive, not a checklist item.
    const contentToSearch = check.id === 'no-verification-loop'
      ? combinedContentNoChecklists
      : combinedContent;
    return !matchesAny(contentToSearch, check.patterns);
  });
  if (missing.length > 0) issues.push(missingPracticesIssue(missing, files.length, allFilePaths));

  // ── Per-file behavioral gap check for tool-specific files ──────────────────
  // Tool-specific files must stand alone. If CLAUDE.md has no behavioral rules
  // while AGENTS.md has them, combined-content checks pass but Claude still lacks
  // those instructions. Fires only when ALL key behavioral patterns are absent
  // from the tool-specific file and present in at least one other file.

  const KEY_BEHAVIORAL_PATTERNS = [
    ...CHECKS.find((c) => c.id === 'no-verification-loop')!.patterns,
    ...CHECKS.find((c) => c.id === 'no-honesty-policy')!.patterns,
    ...CHECKS.find((c) => c.id === 'no-scope-control')!.patterns,
    ...CHECKS.find((c) => c.id === 'no-read-before-edit')!.patterns,
  ];

  const hasBehavioralGuidance = (file: InstructionFile) =>
    matchesAny(stripChecklistLines(file.content), KEY_BEHAVIORAL_PATTERNS);

  // AP4: files that already get the coarse "no behavioral guidance at all"
  // finding below. The per-check loop further down skips these — without
  // this, a file missing ALL guidance got the coarse warning PLUS up to 5
  // granular "missing critical guidance" issues (one per CHECKS entry),
  // inflating the health-score penalty ~6x for a single underlying gap.
  const filesWithNoGuidanceFinding = new Set<string>();

  for (const file of targetFiles) {
    const target = perFileBehaviorTarget(file);
    if (!target) continue;
    // #184: one prose-pointer hint per CLAUDE.md, whether or not it also has rules of its own.
    const forwarding = forwardingOf(file, files, tree, hasBehavioralGuidance);
    const agentsFile = forwarding && pointsToAgents(forwarding) ? agentsFileFor(file, files) : undefined;
    if (importingToolFor(file.path) === 'claude-code' && agentsFile) {
      const hint = prosePointerIssue(file, agentsFile);
      if (!issues.some((i) => i.id === hint.id)) issues.push(hint);
    }
    if (hasBehavioralGuidance(file)) {
      // ── Duplication vs Forwarding Check ────────────────────────────────────
      continue;
    }

    // It lacks behavioral guidance. Is it a forwarding file?
    if (forwarding) {
      if (forwarding.kind === 'import' && forwarding.unread !== undefined) {
        issues.push(unreadImportIssue(file, forwarding.unread));
      }
      continue;
    }

    // At least one OTHER file must have behavioral guidance — otherwise the
    // combined-content check already fires and we'd be duplicating the finding.
    const fileWithGuidance = files.find((f) => f !== file && hasBehavioralGuidance(f));
    if (!fileWithGuidance) continue;

    filesWithNoGuidanceFinding.add(file.path);
    // #199: a tool-specific file without rules is advice, not a defect. Several
    // tools read AGENTS.md (or another tool's file) themselves, so whether this
    // file is the only one a tool reads is the author's call.
    issues.push({
      id: perFileBehaviorIssueId(fileIdPath(file)),
      severity: 'info',
      category: 'agent_practices',
      title: `No behavioral guidance in ${target.label}`,
      summary:
        `The ${target.label} contains none of the behavioral rules PromptCI looks for (verification loop, honesty ` +
        `policy, scope control, read-before-edit), while ${path.basename(fileWithGuidance.path)} has some. If ` +
        `${target.agent} reads only this file it may work without them. Several tools also read AGENTS.md ` +
        `themselves, so this is a suggestion to check, not a defect, and it does not count toward the health score.`,
      filePaths: [file.path],
      locations: [{ filePath: file.path }],
      evidence: [
        `No behavioral patterns found in ${path.basename(file.path)}.`,
        `Some behavioral guidance appears in ${path.basename(fileWithGuidance.path)}.`,
      ],
      recommendation:
        `Consider making the rules reach ${target.agent}: either ${forwardingAdvice(file, target, fileWithGuidance)}, ` +
        `or add the rules to ${target.label} itself, a verification rule above all: in PromptCI's behaviour evals ` +
        `(2026-11-19, Claude Code 2.1.327 with Sonnet 5.5) naming the verification command changed what the agent did, while ` +
        `scope-control, read-before-edit and honesty sentences made no measurable difference.`,
      confidence: 0.5,
      tags: [UNSCORED_TAG],
    });
  }

  // ── Specific guidance cross-file gap check ──────────────────────────────────
  // For each check in CHECKS, if the guidance exists in some file (like AGENTS.md),
  // but is missing in a tool-specific file (which is not a forwarding file),
  // emit a warning.
  for (const check of CHECKS) {
    const sourceFile = files.find((f) => matchesAny(stripChecklistLines(f.content), check.patterns));
    if (!sourceFile) continue;

    for (const file of targetFiles) {
      if (file === sourceFile) continue;
      const target = perFileBehaviorTarget(file);
      if (!target) continue;
      if (isForwardingFile(file, files, tree, hasBehavioralGuidance)) continue;
      // AP4: already covered by the coarser "no behavioral guidance at all"
      // finding above — don't also pile on a granular per-check issue.
      if (filesWithNoGuidanceFinding.has(file.path)) continue;

      const hasThisGuidance = matchesAny(stripChecklistLines(file.content), check.patterns);
      if (!hasThisGuidance) {
        const checkName = check.title.toLowerCase().replace('no ', '').replace(' instruction', '');
        const hash = crypto.createHash('sha1').update(`behavior-gap:${fileIdPath(file)}:${check.id}`).digest('hex').slice(0, 12);
        issues.push({
          id: `per-file-behavioral-gap-${hash}`,
          severity: 'info',
          category: 'agent_practices',
          title: `Missing critical guidance "${check.title.replace('No ', '').replace(' instruction', '')}" in ${target.label}`,
          summary: check.noMeasuredEffect !== undefined
            ? `The ${target.label} lacks the "${checkName}" guidance which is defined in ${path.basename(sourceFile.path)}. ` +
              `Listed for information only: PromptCI's behaviour evals found this sentence made no measurable difference ` +
              `to what Claude Code did, and the finding does not count toward the health score.`
            : `The ${target.label} lacks the critical behavioral guidance regarding "${checkName}" ` +
            `which is defined in ${path.basename(sourceFile.path)}. If ${target.agent} reads only ${target.label}, ` +
            `it may miss this rule. Several tools also read AGENTS.md themselves, so this is a suggestion to ` +
            `check, not a defect, and it does not count toward the health score.`,
          filePaths: [file.path, sourceFile.path],
          locations: [{ filePath: file.path }],
          evidence: [
            `Guidance pattern not found in ${path.basename(file.path)}.`,
            `Guidance defined in ${path.basename(sourceFile.path)}.`,
          ],
          // pcic-55dy: a practice whose sentence made no measurable difference is
          // reported for information, with the evidence and no fix text.
          recommendation:
            check.noMeasuredEffect !== undefined
              ? `No change suggested: ${noMeasuredEffectNote(check)}.`
              : `Consider adding the missing guidance to ${target.label} (e.g., "${check.recommendation.replace('Add a rule such as: ', '').replace(/"/g, '')}") ` +
                `or ${forwardingAdvice(file, target, sourceFile)}.`,
          ...(check.noMeasuredEffect === undefined && check.fixRecipe ? { fixRecipe: check.fixRecipe } : {}),
          confidence: 0.5,
          tags: [UNSCORED_TAG],
        });
      }
    }
  }

  // ── BUG-007: Agent-behavior section in copilot-instructions.md ──────────────
  // Copilot-instructions.md is scoped to GitHub Copilot. When it contains a
  // section heading like "## Agent Behavior" or "## Behavior Rules", the author
  // likely intended it as an AGENTS.md-style file and mis-placed it. Flag this
  // so the content can be moved or the structure clarified.
  //
  // Only fires when the section ALSO contains at least one agent-practice pattern —
  // a heading alone could be a coincidence ("Behavior" in a broader context).
  const AGENT_BEHAVIOR_HEADING_RE =
    /^#{1,4}\s+(?:agent\s+behavior|ai\s+behavior|agent\s+rules|behavior\s+rules|agent\s+instructions)\b/im;

  const copilotAgentBehaviorId = (p: string) => {
    const h = crypto.createHash('sha1').update(`copilot-agent-behavior:${p}`).digest('hex').slice(0, 12);
    return `copilot-agent-behavior-${h}`;
  };

  const hasGeneralBehaviorOnlyInCopilot = () => {
    const copilotFiles = files.filter(isCopilotInstructionsFile);
    if (copilotFiles.length === 0) return false;

    const hasGuidanceInCopilot = copilotFiles.some(hasBehavioralGuidance);
    if (!hasGuidanceInCopilot) return false;

    const otherFiles = files.filter(f => !isCopilotInstructionsFile(f) && f.fileType !== 'readme' && f.fileType !== 'docs');
    return !otherFiles.some(hasBehavioralGuidance);
  };

  if (hasGeneralBehaviorOnlyInCopilot()) {
    const copilotFile = files.find(isCopilotInstructionsFile)!;
    issues.push({
      id: copilotAgentBehaviorId(fileIdPath(copilotFile)),
      severity: 'warning',
      category: 'structure',
      title: 'General behavioral guidance placed only in Copilot instructions',
      summary:
        'General agent behavioral rules (verification loop, honesty policy, etc.) appear only in ' +
        'Copilot-specific instruction files. Other agents (Claude, Cursor, etc.) will likely ' +
        'not see these rules.',
      filePaths: [copilotFile.path],
      locations: [{ filePath: copilotFile.path }],
      evidence: ['Behavioral directives found only in Copilot-specific files.'],
      recommendation:
        'Move general agent behavior rules to AGENTS.md or CLAUDE.md so all agents benefit. ' +
        'Keep copilot-instructions.md focused on Copilot-specific context.',
      confidence: 0.7,
    });
  }

  for (const file of files) {
    if (file.fileType !== 'copilot') continue;
    if (!AGENT_BEHAVIOR_HEADING_RE.test(file.content)) continue;
    if (!matchesAny(file.content, KEY_BEHAVIORAL_PATTERNS)) continue;

    // Check if we already flagged this via general-behavior-only check
    if (issues.some(i => i.id === copilotAgentBehaviorId(fileIdPath(file)))) continue;

    issues.push({
      id: copilotAgentBehaviorId(fileIdPath(file)),
      severity: 'warning',
      category: 'structure',
      title: 'Agent-behavior section in copilot-instructions.md',
      summary:
        'copilot-instructions.md contains an "Agent Behavior" (or similar) heading with ' +
        'agent-practice directives. This file is scoped to GitHub Copilot; agent behavioral ' +
        'rules are typically placed in AGENTS.md or CLAUDE.md where all agents can read them.',
      filePaths: [file.path],
      locations: [{ filePath: file.path }],
      evidence: ['Agent behavioral directives found inside a Copilot-specific instruction file.'],
      recommendation:
        'Move agent behavior rules to AGENTS.md or CLAUDE.md, or copy them there so all agents ' +
        'benefit. Keep copilot-instructions.md focused on Copilot-specific context (repo structure, ' +
        'technology stack, Copilot feature preferences).',
      confidence: 0.65,
    });
  }

  // ── "Do not edit" in human-maintained files ───────────────────────────────
  // Flag instruction files that contain a "do not edit" / "auto-generated"
  // header but are clearly human-maintained (no generator comment nearby).
  for (const file of files) {
    const first500 = file.content.slice(0, 500);
    const doNotEditMatch = DO_NOT_EDIT_RE.exec(first500);
    const hasDoNotEdit = !!doNotEditMatch;
    const hasGeneratorNote = AUTO_GENERATED_RE.test(first500);
    // AP2: DO_NOT_EDIT_RE searches the first 500 chars of the file, not just
    // the first line — a header on line 8 was previously always reported at
    // the hardcoded lines 1-3. Compute the REAL line the match landed on.
    const doNotEditLine = doNotEditMatch ? lineNumberAtOffset(file.content, doNotEditMatch.index) : 1;

    if (hasDoNotEdit && !hasGeneratorNote) {
      // Case 1 (original): "do not edit" present but NO generator note.
      issues.push({
        id: doNotEditIssueId(fileIdPath(file)),
        severity: 'warning',
        category: 'agent_practices',
        title: '"Do not edit" header in human-maintained instruction file',
        summary:
          `This instruction file starts with a "do not edit" directive but does not appear to be auto-generated. ` +
          `Humans and agents need to update instruction files regularly — this header may prevent necessary edits.`,
        filePaths: [file.path],
        locations: [{ filePath: file.path, startLine: doNotEditLine, endLine: doNotEditLine }],
        evidence: [doNotEditMatch![0].trim()],
        recommendation:
          'Remove the "do not edit" header, or add a clear generator comment explaining which tool generates this file.',
        confidence: 0.8,
      });
    } else if (hasDoNotEdit && hasGeneratorNote && file.lineCount > 5) {
      // BUG-007 / BUG-H1: File claims to be AUTO-GENERATED + DO-NOT-EDIT, but is clearly
      // long enough to be human-maintained (runbooks, conventions, etc.).
      // Threshold lowered from 20 → 5 lines: even short instruction files (e.g. a brief
      // QA.md) are human-maintained and should not carry a misleading auto-gen header.
      const autoGenId = (p: string) => {
        const hash = crypto.createHash('sha1').update(`auto-gen-header:${p}`).digest('hex').slice(0, 12);
        return `auto-gen-header-${hash}`;
      };
      issues.push({
        id: autoGenId(fileIdPath(file)),
        severity: 'warning',
        category: 'agent_practices',
        title: 'Misleading auto-generated header on human-maintained instruction file',
        summary:
          `This instruction file has an "AUTO-GENERATED — DO NOT EDIT" header, but with ${file.lineCount} lines ` +
          `of hand-written content it is clearly human-maintained. The header may prevent agents and humans ` +
          `from updating the file when needed.`,
        filePaths: [file.path],
        locations: [{ filePath: file.path, startLine: doNotEditLine, endLine: doNotEditLine }],
        evidence: [doNotEditMatch![0].trim()],
        recommendation:
          'Remove the auto-generated header. If this file is genuinely generated, add a clear generator ' +
          'comment that names the tool and the source template so the origin is unambiguous.',
        confidence: 0.75,
      });
    }

    const claudeTag = claudeXmlTagIssue([file]);
    if (claudeTag) issues.push(claudeTag);
  }

  // The Claude-tag check is gated by file type, and `AGENTS.md -> CLAUDE.md` is an AGENTS.md to every
  // tool that reads that name: run it for such an alias, against the real content. (An alias of a file
  // that is already "not Claude" would only repeat the real file's finding, so it is left out.) The
  // other per-type content checks above are not repeated for aliases: "do not edit" is type-independent,
  // and the Copilot agent-behavior check assumes copilot-instructions.md is Copilot-only, which a link
  // to AGENTS.md is not. Several links to one file give ONE finding that lists every link.
  for (const group of groupAliasesByTarget(aliasesWithNewType(files, aliases, isClaudeTagTarget))) {
    const claudeTag = claudeXmlTagIssue(group);
    if (claudeTag) issues.push(claudeTag);
  }

  return issues;
}
