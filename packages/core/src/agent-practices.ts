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
 *   - Read-before-edit      — "read a file before editing it"
 *   - Scope control         — "prefer focused diffs, don't rewrite unrelated code"
 *   - Plan-first guidance   — "outline the approach before coding"
 *   - No contradictory "do not edit" header in human-maintained files
 *
 * All findings are info/warning severity — these are guidance gaps, not errors.
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type { InstructionFile, PromptCiIssue } from './types.js';
import { stripCodeBlocks } from './markdown-fences.js';

// ── Practice checks ──────────────────────────────────────────────────────────

interface PracticeCheck {
  id: string;
  title: string;
  summary: string;
  /** At least one pattern must match somewhere across all files to pass. */
  patterns: RegExp[];
  recommendation: string;
  severity: PromptCiIssue['severity'];
  confidence: number;
  fixRecipe?: string;
}

const CHECKS: PracticeCheck[] = [
  {
    id: 'no-verification-loop',
    title: 'No verification loop instruction',
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
    severity: 'warning',
    confidence: 0.75,
    fixRecipe: 'Before saying work is complete, run pnpm lint, pnpm typecheck, pnpm test, and pnpm build. If any command fails, report the failure and stop.',
  },
  {
    id: 'no-honesty-policy',
    title: 'No "report failures honestly" instruction',
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
    // An AI that doesn't report uncertainty or failures is a production risk,
    // not a style suggestion — elevated from info 0.70 (roadmap FEAT-003).
    severity: 'warning',
    confidence: 0.75,
    fixRecipe: 'If tests or commands fail, report the failure honestly. Never claim success when checks are skipped or error.',
  },
  {
    id: 'no-read-before-edit',
    title: 'No "read before edit" instruction',
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
    // Editing files without reading them is the #1 source of AI coding
    // mistakes — elevated from info 0.70 (roadmap FEAT-003).
    severity: 'warning',
    confidence: 0.75,
    fixRecipe: 'Read a file before editing it. Preserve unrelated user changes.',
  },
  {
    id: 'no-scope-control',
    title: 'No scope-control instruction',
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
    // Unconstrained scope produces sweeping unrelated diffs that are hard to
    // review — elevated from info 0.65 (roadmap FEAT-003).
    severity: 'warning',
    confidence: 0.7,
    fixRecipe: 'Prefer focused, minimal diffs. Do not rewrite or refactor code unrelated to the current task.',
  },
  {
    id: 'no-plan-first',
    title: 'No "plan before implementing" instruction',
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
    severity: 'info',
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
  /(?:follow|use|see|refer\s+to|canonical\s+(?:source|instructions?)|pointer\s+to)\s+[`'"*]*(?:\.?\/)?(?:\.github\/)?(?:AGENTS|CLAUDE)\.md\b/i;

// ── Helpers ───────────────────────────────────────────────────────────────────

function issueId(checkId: string): string {
  const hash = crypto.createHash('sha1').update(checkId).digest('hex').slice(0, 12);
  return `agent-practice-${hash}`;
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


function normalizedFilePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').toLowerCase();
}

function isCopilotInstructionsFile(file: InstructionFile): boolean {
  const normalizedPath = normalizedFilePath(file.path);
  return (
    file.fileType === 'copilot' ||
    normalizedPath === '.github/copilot-instructions.md' ||
    normalizedPath.endsWith('/.github/copilot-instructions.md') ||
    normalizedPath.includes('/.github/instructions/')
  );
}

function isCursorRulesFile(file: InstructionFile): boolean {
  const normalizedPath = normalizedFilePath(file.path);
  const baseName = path.basename(file.path).toLowerCase();
  return (
    file.fileType === 'cursor' ||
    baseName === '.cursorrules' ||
    normalizedPath.includes('/.cursor/rules/')
  );
}

function isWindsurfRulesFile(file: InstructionFile): boolean {
  return file.fileType === 'windsurf' || path.basename(file.path).toLowerCase() === '.windsurfrules';
}

function isClaudeInstructionsFile(file: InstructionFile): boolean {
  const normalizedPath = normalizedFilePath(file.path);
  const baseName = path.basename(file.path).toLowerCase();
  return (
    file.fileType === 'claude' ||
    baseName === 'claude.md' ||
    normalizedPath.includes('/.claude/')
  );
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

  return undefined;
}

function isForwardingFile(file: InstructionFile): boolean {
  // AP6: A header forwarding pointer near the top ("Follow AGENTS.md for the
  // canonical instructions") delegates behavioral rules to the canonical file
  // regardless of the stub's total length — this is the exact remedy the
  // per-check gap findings recommend, so a file that already does it should not
  // be flagged for "missing" guidance it forwards to.
  const head = file.content.split(/\r?\n/).slice(0, 12).join('\n');
  if (FORWARDING_RE.test(head)) return true;
  // Legacy: a short file with a forwarding pointer anywhere.
  return file.lineCount < 20 && FORWARDING_RE.test(file.content);
}

// ── Detector ─────────────────────────────────────────────────────────────────

export function detectAgentPractices(files: InstructionFile[]): PromptCiIssue[] {
  if (files.length === 0) return [];

  const issues: PromptCiIssue[] = [];
  const combinedContent = files.map((f) => f.content).join('\n');
  // BUG-002: For the verification-loop check, strip human-facing checklist items
  // (lines like "- [ ] Run pnpm test") so that a PR checklist doesn't satisfy the
  // requirement for an agent behavioral directive.
  const combinedContentNoChecklists = stripChecklistLines(combinedContent);
  const allFilePaths = files.map((f) => f.path);

  // ── Per-practice checks (scan combined content) ───────────────────────────
  for (const check of CHECKS) {
    // BUG-002: Verification loop requires an imperative agent directive, not a checklist item.
    const contentToSearch = check.id === 'no-verification-loop'
      ? combinedContentNoChecklists
      : combinedContent;
    if (matchesAny(contentToSearch, check.patterns)) continue;

    issues.push({
      id: issueId(check.id),
      severity: check.severity,
      category: 'agent_practices',
      title: check.title,
      summary: check.summary,
      filePaths: allFilePaths,
      locations: [],
      evidence: [`Pattern not found across ${files.length} instruction file(s).`],
      recommendation: check.recommendation,
      fixRecipe: check.fixRecipe,
      confidence: check.confidence,
    });
  }

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

  for (const file of files) {
    const target = perFileBehaviorTarget(file);
    if (!target) continue;
    if (hasBehavioralGuidance(file)) {
      // ── Duplication vs Forwarding Check ────────────────────────────────────
      continue;
    }

    // It lacks behavioral guidance. Is it a forwarding file?
    if (isForwardingFile(file)) continue;

    // At least one OTHER file must have behavioral guidance — otherwise the
    // combined-content check already fires and we'd be duplicating the finding.
    const fileWithGuidance = files.find((f) => f !== file && hasBehavioralGuidance(f));
    if (!fileWithGuidance) continue;

    filesWithNoGuidanceFinding.add(file.path);
    issues.push({
      id: perFileBehaviorIssueId(file.path),
      severity: 'warning',
      category: 'agent_practices',
      title: `No behavioral guidance in ${target.label}`,
      summary:
        `The ${target.label} contains no agent behavioral rules (verification loop, honesty policy, ` +
        `scope control, read-before-edit). ${target.agent} may rely on this file, so they will have no behavioral ` +
        `guidance even though another instruction file in the repo contains related rules.`,
      filePaths: [file.path],
      locations: [{ filePath: file.path }],
      evidence: [
        `No behavioral patterns found in ${path.basename(file.path)}.`,
        `Some behavioral guidance appears in ${path.basename(fileWithGuidance.path)}.`,
      ],
      recommendation:
        `Add at minimum: a verification rule ("run tests before saying done"), a scope-control rule ` +
        `("prefer focused diffs"), a read-before-edit rule, and an honesty policy directly to ` +
        `${target.label} so behavioral guidance is available in the file this tool reads. ` +
        `Alternatively, use a forwarding pointer if the tool supports it (e.g., "Follow AGENTS.md").`,
      confidence: 0.8,
    });
  }

  // ── Specific guidance cross-file gap check ──────────────────────────────────
  // For each check in CHECKS, if the guidance exists in some file (like AGENTS.md),
  // but is missing in a tool-specific file (which is not a forwarding file),
  // emit a warning.
  for (const check of CHECKS) {
    const sourceFile = files.find((f) => matchesAny(stripChecklistLines(f.content), check.patterns));
    if (!sourceFile) continue;

    for (const file of files) {
      if (file === sourceFile) continue;
      const target = perFileBehaviorTarget(file);
      if (!target) continue;
      if (isForwardingFile(file)) continue;
      // AP4: already covered by the coarser "no behavioral guidance at all"
      // finding above — don't also pile on a granular per-check issue.
      if (filesWithNoGuidanceFinding.has(file.path)) continue;

      const hasThisGuidance = matchesAny(stripChecklistLines(file.content), check.patterns);
      if (!hasThisGuidance) {
        const checkName = check.title.toLowerCase().replace('no ', '').replace(' instruction', '');
        const hash = crypto.createHash('sha1').update(`behavior-gap:${file.path}:${check.id}`).digest('hex').slice(0, 12);
        issues.push({
          id: `per-file-behavioral-gap-${hash}`,
          severity: 'warning',
          category: 'agent_practices',
          title: `Missing critical guidance "${check.title.replace('No ', '').replace(' instruction', '')}" in ${target.label}`,
          summary:
            `The ${target.label} lacks the critical behavioral guidance regarding "${checkName}" ` +
            `which is defined in ${path.basename(sourceFile.path)}. Since ${target.agent} reads ${target.label}, ` +
            `they will miss this rule.`,
          filePaths: [file.path, sourceFile.path],
          locations: [{ filePath: file.path }],
          evidence: [
            `Guidance pattern not found in ${path.basename(file.path)}.`,
            `Guidance defined in ${path.basename(sourceFile.path)}.`,
          ],
          recommendation:
            `Add the missing guidance to ${target.label} (e.g., "${check.recommendation.replace('Add a rule such as: ', '').replace(/"/g, '')}") ` +
            `or use a forwarding pointer (e.g., "Follow ${path.basename(sourceFile.path)}").`,
          fixRecipe: check.fixRecipe,
          confidence: 0.8,
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
      id: copilotAgentBehaviorId(copilotFile.path),
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
    if (issues.some(i => i.id === copilotAgentBehaviorId(file.path))) continue;

    issues.push({
      id: copilotAgentBehaviorId(file.path),
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
        id: doNotEditIssueId(file.path),
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
        id: autoGenId(file.path),
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

    // BUG-007: Detect Claude-specific XML tags in non-Claude instruction files.
    // <claude:thinking> and similar tags are Claude-specific features; embedding them
    // in .cursorrules or AGENTS.md is tool-specific syntax in the wrong file type.
    // Skip README files — they often document Claude XML tags as examples rather than using them
    // Skip if the tag only appears inside fenced code blocks (documentation, not real usage)
    const contentOutsideCode = stripCodeBlocks(file.content).replace(/`[^`\n]+`/g, '');
    if (file.fileType !== 'claude' && file.fileType !== 'readme' && CLAUDE_XML_TAG_RE.test(contentOutsideCode)) {
      const claudeTagId = (p: string) => {
        const hash = crypto.createHash('sha1').update(`claude-xml-tag:${p}`).digest('hex').slice(0, 12);
        return `claude-xml-tag-${hash}`;
      };
      // AP3: search contentOutsideCode (the same text the gate above tested),
      // not the raw file.content — otherwise an earlier occurrence of the
      // tag that exists ONLY inside a code fence (documentation, not real
      // usage) could be picked as evidence instead of the real match that
      // actually made the gate fire.
      const firstTag = (/<\/?claude:[\w-]+/i).exec(contentOutsideCode)?.[0] ?? '<claude:...>';
      issues.push({
        id: claudeTagId(file.path),
        severity: 'warning',
        category: 'structure',
        title: 'Claude-specific XML tag in non-Claude instruction file',
        summary:
          `This file contains a Claude-specific XML tag (${firstTag}) but is not a CLAUDE.md file. ` +
          `Claude XML tags are only interpreted by Claude; other AI tools (Cursor, Copilot, etc.) ` +
          `will treat them as literal text or ignore them.`,
        filePaths: [file.path],
        locations: [{ filePath: file.path }],
        evidence: [`Found: ${firstTag} in ${file.fileType} file`],
        recommendation:
          'Move Claude-specific directives to CLAUDE.md, or replace this tag with a plain-text ' +
          'instruction that all tools can understand.',
        confidence: 0.85,
      });
    }
  }

  return issues;
}
