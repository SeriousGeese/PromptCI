import type { BehaviourEvalResult, CheckProvenance, ProvenanceSource, ProvenanceThreshold, SourceStance } from './types.js';

/**
 * Provenance for the instruction-advice checks (pcic-kvv3.1, issue #162): context-bloat,
 * prompt-cache-friendliness, negative-instructions, buried-critical, vague-guidance,
 * agent-practices, missing-context, within-section-dedup, duplicates, duplicate-headings,
 * canonical-owner and custom-rules.
 *
 * Every source below is a page an agent fetched and read on the stated date; nothing is
 * filled in from memory. A record with no source and `unverified: true` is a result: it
 * means no page was found that supports the claim.
 */

const BY = 'Claude agent backfill (pcic-kvv3.1), pending human review';
/** Verified on the day the first pages were read. */
const V13 = { date: '2026-11-13', by: BY };
/** Records that cite a page read on the following day. */
const V14 = { date: '2026-11-14', by: BY };
/** Records reworded and re-read on 2026-11-15. */
const V15 = (issue: number) => ({ date: '2026-11-15', by: `agent run 2026-11-15 (issue #${issue})` });
/** Records changed by the eval demotions and the contradiction review (pcic-55dy, pcic-kvv3.12). */
const V21 = { date: '2026-11-21', by: 'agent run 2026-11-21 (pcic-55dy, pcic-kvv3.12), pending human review' };
/**
 * pcic-55dy: a check whose recommended sentence made no measurable difference in the first
 * behaviour-eval run (pcic-kvv3.3, 2026-11-19: Claude Code 2.1.327 with Sonnet 5.5, 5 runs per arm on
 * small synthetic tasks), copied from the report's `--provenance-out` fragment.
 */
const noEffect = (check: string, ci95: readonly [number, number] = [-0.4344824686593929, 0.4344824686593929]): BehaviourEvalResult => ({
  check,
  harness: 'claude-code',
  harnessVersion: '2.1.327',
  model: 'claude-sonnet-5-5',
  verdict: 'no measurable difference',
  effect: 0,
  ci95,
  runs: 10,
  lastRun: '2026-11-19',
});
/** Records changed by promoting the verify-names-lint research hypothesis (pcic-7swz), approved 2026-11-22. */
const V22 = { date: '2026-11-22', by: 'agent run 2026-11-22 (pcic-7swz), promotion approved by Zach' };
/** The verify-names-lint research hypothesis: a rule naming lint as well as the tests, against one naming the tests alone (2026-11-22, 10 runs per arm). */
const verifyNamesLint = (model: string, effect: number, ci95: readonly [number, number]): BehaviourEvalResult => ({
  check: 'no-verification-loop',
  harness: 'claude-code',
  harnessVersion: '2.1.330',
  model,
  verdict: 'helps',
  effect,
  ci95,
  runs: 20,
  lastRun: '2026-11-22',
});
/** What every demoted check's caveat says about the evidence and its limits (pcic-55dy). */
const EVAL_DEMOTION =
  'Demoted to information (pcic-55dy): in the 2026-11-19 behaviour evals (Claude Code 2.1.327 with Sonnet 5.5, 5 runs per arm on small synthetic tasks) the recommended change made no measurable difference, so the finding states that evidence instead of recommending the change. One harness, one model and few runs: other agents may differ, and whether removing such a sentence hurts is not yet tested (pcic-7swz).';
/** Tools other than Claude Code: where the volatile-content and local-path hints still apply. */
const GEMINI_NOTICE =
  ' geminicli.com carries a banner (read 2026-11-14): Gemini CLI was replaced by Antigravity CLI on June 18th, 2026 for unpaid-tier and Google One users; a claim about gemini-cli may not hold for the replacement.';
const NON_CLAUDE_TOOLS = ['codex', 'cursor', 'copilot', 'gemini-cli', 'windsurf'] as const;

/** Pages read for this file. `readOn` is the day the page was actually fetched. */
const PAGES = {
  ccMemory: { url: 'https://code.claude.com/docs/en/memory', title: 'Claude Code docs: How Claude remembers your project', readOn: '2026-11-13' },
  ccBest: { url: 'https://code.claude.com/docs/en/best-practices', title: 'Claude Code docs: Best practices', readOn: '2026-11-13' },
  ccCache: { url: 'https://code.claude.com/docs/en/prompt-caching', title: 'Claude Code docs: How Claude Code uses prompt caching', readOn: '2026-11-14' },
  ccContext: { url: 'https://code.claude.com/docs/en/context-window', title: 'Claude Code docs: Explore the context window', readOn: '2026-11-14' },
  apiCache: { url: 'https://platform.claude.com/docs/en/build-with-claude/prompt-caching', title: 'Claude API docs: Prompt caching', readOn: '2026-11-13' },
  apiPrompt: {
    url: 'https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices',
    title: 'Claude API docs: Prompting best practices',
    readOn: '2026-11-13',
  },
  anthContext: { url: 'https://www.anthropic.com/research/effective-context-engineering-for-ai-agents', title: 'Anthropic engineering: Effective context engineering for AI agents', readOn: '2026-11-14' },
  codex: { url: 'https://learn.chatgpt.com/docs/agent-configuration/agents-md', title: 'Codex docs: AGENTS.md (redirect target of developers.openai.com/codex/guides/agents-md)', readOn: '2026-11-13' },
  agentsMd: { url: 'https://agents.md/', title: 'agents.md: the AGENTS.md format', readOn: '2026-11-13' },
  cursor: { url: 'https://cursor.com/docs/rules', title: 'Cursor docs: Rules', readOn: '2026-11-13' },
  windsurf: { url: 'https://docs.devin.ai/desktop/devin-local/customizations', title: 'Devin Local docs: Customizations (docs.windsurf.com redirects here; Windsurf has no docs of its own to read, so this is another product\'s documentation)', readOn: '2026-11-13' },
  ghRepo: {
    url: 'https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions',
    title: 'GitHub Docs: Adding repository custom instructions for GitHub Copilot',
    readOn: '2026-11-13',
  },
  ghConcept: { url: 'https://docs.github.com/en/copilot/concepts/prompting-and-context/custom-instructions', title: 'GitHub Docs: About customizing GitHub Copilot responses', readOn: '2026-11-14' },
  gemini: { url: 'https://geminicli.com/docs/cli/gemini-md/', title: 'Gemini CLI docs: GEMINI.md context files', readOn: '2026-11-13' },
  // Re-read on 2026-11-14 for the import recipe (pcic-1ik0.10).
  ccMemoryImports: { url: 'https://code.claude.com/docs/en/memory', title: 'Claude Code docs: How Claude remembers your project (imports)', readOn: '2026-11-14' },
  geminiImports: { url: 'https://geminicli.com/docs/cli/gemini-md', title: 'Gemini CLI docs: GEMINI.md context files (imports)', readOn: '2026-11-14' },
  geminiMemport: { url: 'https://geminicli.com/docs/reference/memport/', title: 'Gemini CLI docs: Memory Import Processor', readOn: '2026-11-14' },
  cursorRules14: { url: 'https://cursor.com/docs/rules', title: 'Cursor docs: Rules (file references)', readOn: '2026-11-14' },
  ghRepoInstr14: {
    url: 'https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions',
    title: 'GitHub Docs: Adding repository custom instructions for GitHub Copilot',
    readOn: '2026-11-14',
  },
  ccMemoryExternal: { url: 'https://code.claude.com/docs/en/memory', title: 'Claude Code docs: How Claude remembers your project (external imports, load order)', readOn: '2026-11-14' },
  antigravityRules: { url: 'https://antigravity.google/docs/rules.md', title: 'Antigravity docs: Rules', readOn: '2026-11-14' },
  windsurfMemories14: { url: 'https://docs.devin.ai/desktop/cascade/memories', title: 'Devin Local docs: Memories and rules (docs.windsurf.com/windsurf/cascade/memories redirects here)', readOn: '2026-11-14' },
  // Re-read on 2026-11-15 for the instruction-advice demotions (issues #181, #182, #183, #185, #189).
  ccCache15: { url: 'https://code.claude.com/docs/en/prompt-caching', title: 'Claude Code docs: How Claude Code uses prompt caching', readOn: '2026-11-15' },
  apiCache15: { url: 'https://platform.claude.com/docs/en/build-with-claude/prompt-caching', title: 'Claude API docs: Prompt caching', readOn: '2026-11-15' },
  apiPrompt15: {
    url: 'https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices',
    title: 'Claude API docs: Prompting best practices',
    readOn: '2026-11-15',
  },
  ghRepo15: {
    url: 'https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions',
    title: 'GitHub Docs: Adding repository custom instructions for GitHub Copilot',
    readOn: '2026-11-15',
  },
} as const;

const src = (page: keyof typeof PAGES, stance: SourceStance, note: string): ProvenanceSource => ({ ...PAGES[page], stance, note });

/** A numeric cut-off that is the author's own heuristic: declared, not sourced. */
const heuristic = (name: string, value: number | string, unit: string, where: string): ProvenanceThreshold => ({
  name,
  value,
  unit,
  where,
  source: 'unverified',
});

export const INSTRUCTION_ADVICE_PROVENANCE: readonly CheckProvenance[] = [
  // ───────────────────────────── context-bloat ─────────────────────────────
  {
    id: 'context-bloat/always-loaded-cost',
    detector: 'context-bloat',
    title: 'Instruction file size is a per-turn context cost',
    kind: 'tool-fact',
    claim:
      'Instruction files are loaded into the model context at the start of every session or on every request, so each added line costs context on every turn and a long file reduces how well the rules in it are followed.',
    appliesTo: ['claude-code', 'codex', 'cursor', 'copilot', 'gemini-cli', 'windsurf'],
    sources: [
      src('ccMemory', 'supports', 'Says CLAUDE.md is read at the start of every session and advises under 200 lines per file because longer files consume more context and reduce adherence, and that imports do not reduce the cost.'),
      src('ccBest', 'supports', 'Says every CLAUDE.md line takes a little of the attention on every task and that a line gets lost once the file has grown long.'),
      src('cursor', 'supports', 'Says rule contents are included at the start of the model context and advises keeping rules under 500 lines.'),
      src('windsurf', 'context', 'Devin Local docs, not Windsurf docs: Says rules are injected at the start of every session and advises short specific rules because they cost tokens on every message; the page states no character limit.'),
      src('ghConcept', 'supports', 'Says custom instructions are sent with every chat message, so they should be broadly applicable to most requests; the page states no length limit.'),
      src('gemini', 'supports', 'Says the CLI concatenates all found context files and sends them to the model with every prompt; the page states no size limit.'),
      src('codex', 'supports', 'Says Codex stops adding AGENTS.md files once their combined size reaches project_doc_max_bytes, 32 KiB by default.'),
      src('anthContext', 'context', 'Treats context as a finite resource with diminishing marginal returns and a limited attention budget, which is the general mechanism behind the claim.'),
    ],
    thresholds: [
      heuristic('fileWarning', 8000, 'characters per instruction file', 'context-bloat.ts:DEFAULTS.fileWarning'),
      heuristic('fileHigh', 20000, 'characters per instruction file', 'context-bloat.ts:DEFAULTS.fileHigh'),
      heuristic('totalWarning', 30000, 'characters across all instruction files', 'context-bloat.ts:DEFAULTS.totalWarning'),
      heuristic('totalHigh', 60000, 'characters across all instruction files', 'context-bloat.ts:DEFAULTS.totalHigh'),
      heuristic('contextBudget high multiplier', 2, 'times the configured contextBudget', 'detectors.ts:DETECTORS'),
      heuristic('fileContextBudget high multiplier', 2.5, 'times the configured fileContextBudget', 'detectors.ts:DETECTORS'),
    ],
    caveat:
      'geminicli.com carries a banner (read 2026-11-14): Gemini CLI was replaced by Antigravity CLI on June 18th, 2026 for unpaid-tier and Google One users, and it has not been optimized for Gemini 4 Argon; a claim about gemini-cli may not hold for the replacement.',
    lastVerified: V14,
  },
  {
    id: 'context-bloat/copilot-line-limit',
    detector: 'context-bloat',
    title: 'Copilot instructions file length hint',
    kind: 'opinion',
    unverified: true,
    claim: 'A Copilot instructions file of more than 1,000 lines is long enough that splitting it or linking out to documents is worth considering, because a long file adds context to every request.',
    appliesTo: ['copilot'],
    sources: [
      src('ghRepo15', 'context', "States no limit on the size of an instructions file in lines, pages or characters; the only length statement is in a sample prompt for generating the file, which says instructions must be no longer than 2 pages. The 1,000-line number is PromptCI's own, not GitHub's."),
    ],
    caveat: "The finding is worded as a generic size hint from PromptCI's own heuristic and no longer attributes the number to GitHub (#189).",
    thresholds: [heuristic('copilotLineWarning', 1000, "lines per copilot-instructions file (PromptCI's own heuristic; nothing supports the number)", 'context-bloat.ts:DEFAULTS.copilotLineWarning')],
    lastVerified: V15(189),
  },
  {
    id: 'context-bloat/windsurf-truncation',
    detector: 'context-bloat',
    title: 'Windsurf rules file truncation',
    kind: 'tool-fact',
    claim: 'Windsurf silently truncates a rules file past about 6,000 characters and its combined global and workspace rules budget is about 12,000 characters.',
    appliesTo: ['windsurf'],
    sources: [],
    unverified: true,
    thresholds: [
      heuristic('windsurfFileWarning', 6000, 'characters per .windsurfrules file', 'context-bloat.ts:DEFAULTS.windsurfFileWarning'),
      heuristic('windsurfFileHigh', 12000, 'characters per .windsurfrules file', 'context-bloat.ts:DEFAULTS.windsurfFileHigh'),
    ],
    lastVerified: V13,
  },
  {
    id: 'context-bloat/readme-dominance',
    unverified: true,
    detector: 'context-bloat',
    title: 'README carrying most of the agent context',
    kind: 'opinion',
    claim:
      'A README that makes up most of the scanned instruction text is carried into agent context on every turn although it is written for people, so AI-specific guidance is cheaper in a smaller canonical file such as AGENTS.md.',
    appliesTo: 'all',
    sources: [
      src('agentsMd', 'context', 'Describes AGENTS.md as a README for agents and says the extra detail agents need, such as build steps and conventions, would clutter a README written for humans.'),
      src('ccMemory', 'context', 'Lists the files Claude Code loads at start (CLAUDE.md, AGENTS.md, rules, auto memory) and mentions README only as an @README import example, so a README is not shown to be loaded on every turn; this is inferred from the page listing, not stated.'),
    ],
    thresholds: [
      heuristic('README_DOMINANCE_RATIO', 0.5, 'share of scanned instruction tokens', 'context-bloat.ts:README_DOMINANCE_RATIO'),
      heuristic('README_DOMINANCE_MIN_TOKENS', 1000, 'estimated tokens', 'context-bloat.ts:README_DOMINANCE_MIN_TOKENS'),
      heuristic('readmeFileWarning', 15000, 'characters per README', 'context-bloat.ts:DEFAULTS.readmeFileWarning'),
      heuristic('readmeFileHigh', 30000, 'characters per README', 'context-bloat.ts:DEFAULTS.readmeFileHigh'),
    ],
    lastVerified: V13,
  },

  // ───────────────────────── prompt-cache-friendliness ─────────────────────────
  {
    id: 'prompt-cache-friendliness/volatile-content',
    detector: 'prompt-cache-friendliness',
    title: 'Volatile content in always-loaded instructions (tools other than Claude Code)',
    kind: 'opinion',
    unverified: true,
    claim:
      'For an AI tool other than Claude Code, a date, timestamp, branch name, current-task line or pasted scan report in an always-loaded instruction file may change the prompt prefix when edited, so a cached prefix may be rebuilt.',
    appliesTo: NON_CLAUDE_TOOLS,
    sources: [
      src('ccCache15', 'context', 'Why the check does not apply to Claude Code: the project-root and user CLAUDE.md are read once at session start and held in memory, so editing one mid-session does not invalidate the cache (the edit applies after /clear, /compact or a restart).'),
      src('apiCache15', 'context', 'The underlying API needs a 100 percent identical prompt segment up to the cache breakpoint and a change at one level invalidates that level and later ones; whether another tool re-sends its instruction files that way is not documented here.'),
    ],
    caveat: 'Reported as an info hint that costs no health-score points. CLAUDE.md-family files (scanner fileType claude) get no finding (#181).' + GEMINI_NOTICE,
    lastVerified: V15(181),
  },
  {
    id: 'prompt-cache-friendliness/volatile-content-api',
    detector: 'prompt-cache-friendliness',
    title: 'A changed prompt prefix invalidates the Claude API cache',
    kind: 'tool-fact',
    claim:
      'On the Claude API a cache hit requires every segment of the prompt up to the cache breakpoint to be identical, and a change at one level invalidates that level and every later one.',
    appliesTo: 'n/a',
    sources: [
      src('apiCache', 'supports', 'Says cache hits require 100 percent identical prompt segments up to the cache breakpoint and that a change at one level invalidates that level and all later levels.'),
    ],
    lastVerified: V14,
  },
  {
    id: 'prompt-cache-friendliness/local-paths',
    detector: 'prompt-cache-friendliness',
    title: 'Absolute local machine paths in instructions (tools other than Claude Code)',
    kind: 'opinion',
    unverified: true,
    claim:
      'For an AI tool other than Claude Code, an absolute local machine path in an always-loaded instruction file differs between environments and so may reduce prompt-cache reuse across them.',
    appliesTo: NON_CLAUDE_TOOLS,
    sources: [
      src(
        'ccCache15',
        'context',
        'Why the check is retired for Claude Code: its cache is effectively scoped to one machine and directory (the system prompt embeds the auto memory paths and the conversation opens with the working directory, platform and shell), so sessions on different machines already miss each other whatever paths CLAUDE.md contains.',
      ),
    ],
    caveat: 'Reported as an info hint that costs no health-score points, decided by the scanner fileType: CLAUDE.md-family files get no finding (#182).' + GEMINI_NOTICE,
    lastVerified: V15(182),
  },
  {
    id: 'prompt-cache-friendliness/large-table',
    unverified: true,
    detector: 'prompt-cache-friendliness',
    title: 'Large table in always-loaded instructions',
    kind: 'opinion',
    claim:
      'A Markdown table of more than 15 rows in an always-loaded instruction file costs context tokens on every request, which the same facts kept in a separate document read on demand would not.',
    appliesTo: 'all',
    sources: [
      src(
        'apiCache',
        'context',
        'Says to place static content such as system instructions and context at the beginning of the prompt and cache it, and makes cache hits depend on identical prefix text and not on its size, so a large stable table does not reduce cache hits; it only costs tokens. (Stance re-judged on 2026-11-21 against the reworded claim, from this note; the page was not re-read.)',
      ),
      src('ccMemory', 'context', 'Advises moving entries that matter for only part of the codebase out of CLAUDE.md into skills or path-scoped rules because longer files consume more context.'),
    ],
    caveat:
      'The page above contradicted the earlier claim that a large table makes the prompt less cache-friendly. Decision (pcic-kvv3.12, 2026-11-17): demoted to an info hint that costs no health-score points, and the finding and claim now say only that the table costs tokens on every request.',
    thresholds: [heuristic('maxTableRows', 15, 'table rows', 'prompt-cache.ts:detectPromptCacheFriendliness (maxTableRows > 15)')],
    lastVerified: V21,
  },

  // ───────────────────────────── negative-instructions ─────────────────────────────
  {
    id: 'negative-instructions',
    unverified: true,
    detector: 'negative-instructions',
    title: 'Mostly-prohibition instruction files',
    kind: 'opinion',
    claim: 'Models follow positive directives more reliably than prohibitions, so an instruction file whose directives are mostly prohibitions is harder to follow than the same guidance phrased positively.',
    appliesTo: 'all',
    sources: [
      src(
        'apiPrompt',
        'context',
        'Advises telling Claude what to do instead of what not to do, but only in an output-formatting example (do not use markdown versus flowing prose), and its own sample prompt for limiting over-engineering is written as prohibitions.',
      ),
      src('ccBest', 'context', 'Its recommended sample CLAUDE.md contains prohibitions (never throw raw strings, do not copy legacy patterns), so the page does not treat a prohibition as a defect.'),
    ],
    thresholds: [
      heuristic('MIN_DIRECTIVES', 8, 'directive sentences', 'negative-instructions.ts:MIN_DIRECTIVES'),
      heuristic('NEGATIVE_RATIO_THRESHOLD', 0.4, 'share of directives that are prohibitions', 'negative-instructions.ts:NEGATIVE_RATIO_THRESHOLD'),
    ],
    behaviourEval: [noEffect('negative-overload')],
    caveat: `${EVAL_DEMOTION} Reported as an info hint that costs no health-score points; the positive-rewrite advice is kept as information only.`,
    lastVerified: V21,
  },

  // ───────────────────────────── buried-critical ─────────────────────────────
  {
    id: 'buried-critical',
    unverified: true,
    detector: 'buried-critical',
    title: 'Critical instructions near the bottom of a long file',
    kind: 'opinion',
    claim:
      'Some prompt-writing advice holds that high-stakes instructions in the bottom half of a long instruction file are applied less reliably than the same lines near the top; other guidance favours instructions at the end, so the effect is not established.',
    appliesTo: 'all',
    sources: [
      src(
        'apiPrompt15',
        'context',
        'In long-context guidance (20k-plus-token prompts) it says to put long documents and inputs at the top above the query, instructions and examples, and that queries at the end can improve response quality by up to 30 percent in tests; it does not say where rules inside an instruction file should sit, and its advice cuts against putting instructions first.',
      ),
      src('ccMemory', 'context', 'About truncation, not weighting: says that when an on-demand subdirectory CLAUDE.md or rules file is over a per-file size limit Claude receives only the start of it, so later instructions are not in context.'),
      src('ccContext', 'context', 'About truncation, not weighting: says truncation of an over-cap invoked skill keeps the start of the file, so the most important instructions belong near the top of SKILL.md.'),
      src('ccBest', 'context', 'Attributes a CLAUDE.md line that keeps being missed to the file having grown long and says to shorten the file, and says nothing about where in the file a line sits.'),
    ],
    behaviourEval: [noEffect('buried-critical')],
    caveat: `Opinion-grade: reported as an info hint with low confidence that costs no health-score points (#183). ${EVAL_DEMOTION} The move-it-up advice is kept as information only.`,
    thresholds: [
      heuristic('MIN_LINES', 100, 'lines in the file', 'buried-critical.ts:MIN_LINES'),
      heuristic('BOTTOM_HALF_RATIO_THRESHOLD', 0.6, 'share of high-severity lines in the bottom half', 'buried-critical.ts:BOTTOM_HALF_RATIO_THRESHOLD'),
    ],
    lastVerified: V21,
  },

  // ───────────────────────────── vague-guidance ─────────────────────────────
  {
    id: 'vague-guidance/platitudes',
    unverified: true,
    detector: 'vague-guidance',
    title: 'Non-actionable quality platitudes',
    kind: 'opinion',
    claim:
      'Broad exhortations such as write clean code or follow best practices give an agent no constraint to act on, whereas concrete commands and checkable rules are followed more consistently.',
    appliesTo: 'all',
    sources: [
      src('ccMemory', 'context', 'Says the more specific and concise the instructions the more consistently Claude follows them and contrasts Use 2-space indentation with Format code properly.'),
      src('apiPrompt', 'context', 'Says Claude responds well to clear explicit instructions and gives a test of whether a colleague with no context would be confused.'),
      src('anthContext', 'context', 'Names vague high-level guidance that fails to give concrete signals as one of two failure modes for prompt altitude.'),
      src('cursor', 'context', 'Says rules should be focused, actionable and scoped and should avoid vague guidance.'),
      src('windsurf', 'context', 'Devin Local docs, not Windsurf docs: Advises skipping generic rules such as write good code.'),
    ],
    thresholds: [heuristic('MAX_LINE_LENGTH_TO_FLAG', 120, 'characters in the matching line', 'vague-guidance.ts:MAX_LINE_LENGTH_TO_FLAG')],
    lastVerified: V14,
  },
  {
    id: 'vague-guidance/subjective-ui',
    detector: 'vague-guidance',
    title: 'Subjective UI and paradigm wording',
    kind: 'opinion',
    claim: 'Subjective UI and paradigm wording such as looks polished, feels native or idiomatic code names no criterion an agent could check, so it does not change what the agent produces.',
    appliesTo: 'all',
    sources: [],
    unverified: true,
    lastVerified: V13,
  },

  // ───────────────────────────── agent-practices ─────────────────────────────
  {
    id: 'agent-practices/verification-loop',
    detector: 'agent-practices',
    title: 'Verification loop before reporting done',
    kind: 'opinion',
    claim:
      'An instruction to run lint, typecheck and tests before reporting work done, or a documented command to run, makes an agent more likely to check its own work before it says it is finished; naming every gate the repository has (lint, typecheck) in that step, not the tests alone, makes it run those gates too.',
    appliesTo: 'all',
    sources: [
      src(
        'ccBest',
        'context',
        'Says to give Claude a check it can run and that the single most useful CLAUDE.md line is the command that runs it, while noting that a line such as Always typecheck before you finish works most of the time and not every time and that a Stop hook enforces it.',
      ),
      src('ghRepo', 'context', 'The onboarding prompt asks for build, test and lint steps with verified commands and the checks run before check-in.'),
    ],
    evals: [
      "promptci-cloud scripts/behaviour-evals/research-results.json: research hypothesis verify-names-lint (pcic-7swz), 2026-11-22, Claude Code 2.1.330, 10 runs per arm per model; promoted to this check's fix text on Zach's go-ahead",
    ],
    behaviourEval: [
      verifyNamesLint('claude-sonnet-5-5', 0.7, [0.2889428873072139, 0.892208733443606]),
      verifyNamesLint('claude-opus-5-5', 0.5, [0.11736746412254095, 0.7634069109885206]),
    ],
    caveat:
      'The fix text names every gate the repository has (lint, typecheck, tests), not the tests alone (research hypothesis verify-names-lint, 2026-11-22): a rule naming only the tests, in a file that lists the linter, led Claude Code to run the linter after its last edit in 3 of 10 runs on Sonnet 5.5 and 0 of 10 on Opus 5.5; naming both led to 10 of 10 and 5 of 10. One harness, two models and one small synthetic task: other agents and larger repositories may differ.',
    lastVerified: V22,
  },
  {
    id: 'agent-practices/grounding',
    unverified: true,
    detector: 'agent-practices',
    title: 'Read before edit and report failures honestly',
    kind: 'opinion',
    claim: 'Telling an agent to read a file before editing it and to report failures instead of claiming success reduces confidently wrong work and false completion reports.',
    appliesTo: 'all',
    sources: [
      src(
        'apiPrompt',
        'context',
        'Its sample prompts say never to speculate about code that was not opened and to read the file before answering, and to inform the user rather than work around incorrect tests; they are suggested prompts and not measured results.',
      ),
      src('ccBest', 'context', 'Attributes a Claude that said it was done when it was not mainly to having no way to check its own work, and not to a missing instruction to report honestly.'),
    ],
    behaviourEval: [noEffect('no-read-before-edit'), noEffect('no-honesty-policy')],
    caveat: `${EVAL_DEMOTION} Claude Code read before editing and reported the failing test in every run, with or without the sentence; its Edit tool may itself require a read first.`,
    lastVerified: V21,
  },
  {
    id: 'agent-practices/ask-when-unsure',
    detector: 'agent-practices',
    title: 'Ask when unsure instead of guessing',
    kind: 'opinion',
    claim: 'An agent told to say so and ask when it is unsure produces fewer confidently wrong results than one left to guess.',
    appliesTo: 'all',
    sources: [],
    unverified: true,
    behaviourEval: [noEffect('no-ask-when-unsure', [-0.43448246865939283, 0.43448246865939283])],
    caveat: `${EVAL_DEMOTION} Claude Code asked about the ambiguous request in none of the runs, with or without the sentence.`,
    lastVerified: V21,
  },
  {
    id: 'agent-practices/scope-control',
    unverified: true,
    detector: 'agent-practices',
    title: 'Keep diffs focused',
    kind: 'opinion',
    claim: 'Unconstrained agents often refactor or rewrite code they were not asked to touch, and an instruction to prefer small focused diffs prevents it.',
    appliesTo: 'all',
    sources: [
      src(
        'apiPrompt',
        'context',
        'Its Overeagerness section says Claude Opus 4.5 and 4.6 tend to over-engineer with extra files and abstractions and gives a sample prompt to make only directly requested changes; the section names those two models.',
      ),
      src(
        'ccBest',
        'contradicts',
        'Says Claude tends to read a request conservatively and build the smallest thing that satisfies it and that lines telling it to keep going are more likely to cause over-work than fix a stall, which runs against the premise that current Claude Code needs guidance to avoid sweeping changes.',
      ),
    ],
    behaviourEval: [noEffect('no-scope-control')],
    caveat: `The contradicting page above (Claude Code docs: Best practices) is answered by the demotion (pcic-kvv3.12, decided 2026-11-17, and pcic-55dy), and the eval agrees with it: Claude Code kept its edit in scope in every run, with or without the sentence. ${EVAL_DEMOTION}`,
    lastVerified: V21,
  },
  {
    id: 'agent-practices/code-preservation',
    detector: 'agent-practices',
    title: 'Preserve existing code and unrelated edits',
    kind: 'opinion',
    claim: 'Without an instruction to preserve existing code, agents delete working code, drop tests or overwrite unrelated edits to reach a passing state.',
    appliesTo: 'all',
    sources: [],
    unverified: true,
    lastVerified: V13,
  },
  {
    id: 'agent-practices/plan-first',
    unverified: true,
    detector: 'agent-practices',
    title: 'Outline the approach before coding',
    kind: 'opinion',
    claim: 'Asking an agent to outline its approach before writing code on a complex or multi-file task significantly reduces wasted implementation effort.',
    appliesTo: 'all',
    sources: [
      src(
        'ccBest',
        'context',
        'Recommends having Claude interview you and write a SPEC.md before building from it in a fresh session, which is plan-before-implementing guidance, but gives no measurement of how much effort it saves.',
      ),
    ],
    lastVerified: V13,
  },
  {
    id: 'agent-practices/per-tool-file-gap',
    detector: 'agent-practices',
    title: 'Behavioural rules may need to be in the file each tool reads',
    kind: 'opinion',
    claim:
      'A tool-specific instruction file that holds none of the behavioural rules, while another instruction file has them, may leave that tool without the rules, so it is worth putting the rules in that file or importing them into it.',
    appliesTo: ['claude-code', 'cursor', 'windsurf', 'copilot', 'gemini-cli'],
    sources: [
      src('ccMemory', 'context', 'Says Claude Code reads AGENTS.md by default only when there is no CLAUDE.md or CLAUDE.local.md in the working directory or above it, so a CLAUDE.md without the rules can hide AGENTS.md from Claude.'),
      src('gemini', 'context', 'Shows AGENTS.md only as a context.fileName configuration example and does not say it is read by default.'),
      src('cursor', 'context', 'Says AGENTS.md in the project root or subdirectories is read as an alternative to .cursor/rules, so Cursor can see rules that exist only in AGENTS.md: for Cursor the gap may not exist.'),
      src('windsurf', 'context', 'Devin Local docs, not Windsurf docs: Says AGENTS.md, AGENTS.local.md and AGENT.md are read as always-on rules at the workspace root and in directories down to the working directory, so Windsurf may see rules that exist only in AGENTS.md.'),
      src('ghRepo', 'context', 'Says Copilot uses the nearest AGENTS.md in the directory tree and alternatively a root CLAUDE.md or GEMINI.md besides copilot-instructions.md, so Copilot can see rules that exist only in those files: for Copilot the gap may not exist.'),
    ],
    unverified: true,
    caveat:
      'Demoted to an unscored info finding (#199): the vendor pages show Cursor, Copilot and Windsurf read AGENTS.md themselves, so whether a tool file is the only one a tool reads depends on the setup. geminicli.com carries a banner (read 2026-11-14): Gemini CLI was replaced by Antigravity CLI on June 18th, 2026 for unpaid-tier and Google One users, and it has not been optimized for Gemini 4 Argon; a claim about gemini-cli may not hold for the replacement.',
    lastVerified: { date: '2026-11-15', by: 'agent run 2026-11-15 (issue #199)' },
  },
  {
    id: 'agent-practices/forwarding-pointer',
    detector: 'agent-practices',
    title: 'An @AGENTS.md import, not a prose pointer, makes Claude Code load AGENTS.md',
    kind: 'tool-fact',
    claim:
      'Claude Code loads the file named by an @path import line in a CLAUDE.md together with that CLAUDE.md, whereas a CLAUDE.md that only tells Claude in words to read AGENTS.md makes Claude see the file only if it decides to open it.',
    appliesTo: ['claude-code'],
    sources: [
      {
        ...PAGES.ccMemory,
        readOn: '2026-11-15',
        stance: 'supports',
        note: 'Says CLAUDE.md files can import additional files with @path/to/import, which are expanded and loaded into context alongside the CLAUDE.md that references them, with relative paths resolved from the importing file; says a CLAUDE.md that tells Claude in words to read AGENTS.md means Claude sees AGENTS.md only if it decides to open the file, and to replace the sentence with an @AGENTS.md import.',
      },
    ],
    thresholds: [
      heuristic('forwarding pointer head window', 12, 'lines from the top of the file', 'agent-practices.ts:forwardingOf (slice(0, 12))'),
      heuristic('legacy forwarding file length', 20, 'lines (file shorter than this may point anywhere in the file)', 'agent-practices.ts:forwardingOf (lineCount < 20)'),
    ],
    lastVerified: { date: '2026-11-15', by: 'agent run 2026-11-15 (issue #184)' },
  },
  {
    id: 'agent-practices/do-not-edit-header',
    detector: 'agent-practices',
    title: 'Do not edit header on a human-maintained file',
    kind: 'opinion',
    claim: 'A do not edit or auto-generated header on a hand-written instruction file stops the agents and people who must keep it current from updating it.',
    appliesTo: 'all',
    sources: [],
    unverified: true,
    thresholds: [
      heuristic('header search window', 500, 'characters from the top of the file', 'agent-practices.ts:detectAgentPractices (content.slice(0, 500))'),
      heuristic('auto-generated header misleading above', 5, 'lines in the file', 'agent-practices.ts:detectAgentPractices (lineCount > 5)'),
    ],
    lastVerified: V13,
  },
  {
    id: 'agent-practices/claude-xml-tags',
    unverified: true,
    detector: 'agent-practices',
    title: 'Claude-specific XML tags in other tools files',
    kind: 'tool-fact',
    claim: 'Claude-specific XML tags such as claude:thinking are meaningful only to Claude, so other tools treat them as literal text or ignore them.',
    appliesTo: ['claude-code', 'cursor', 'copilot', 'windsurf', 'gemini-cli', 'codex'],
    sources: [
      src(
        'apiPrompt',
        'context',
        'Presents XML tags as an author-chosen structuring technique with consistent descriptive names such as instructions, context and input, and mentions no claude: namespaced tag vocabulary; this is inferred from the page text, not stated.',
      ),
    ],
    caveat:
      'geminicli.com carries a banner (read 2026-11-14): Gemini CLI was replaced by Antigravity CLI on June 18th, 2026 for unpaid-tier and Google One users, and it has not been optimized for Gemini 4 Argon; a claim about gemini-cli may not hold for the replacement.',
    lastVerified: V13,
  },

  // ───────────────────────────── missing-context ─────────────────────────────
  {
    id: 'missing-context/setup-commands',
    unverified: true,
    detector: 'missing-context',
    title: 'Install, build, test commands and environment variables',
    kind: 'opinion',
    claim: 'Instruction files that omit install, build and test commands, or the environment variables a project needs, leave an agent unable to set up and verify the project reliably.',
    appliesTo: 'all',
    sources: [
      src('ccBest', 'context', 'Lists the exact test, typecheck and lint commands as what CLAUDE.md should hold and its sample file notes that integration tests need DATABASE_URL set, see .env.example.'),
      src('agentsMd', 'context', 'Suggests covering build and test commands in AGENTS.md.'),
      src('ghRepo', 'context', 'The onboarding prompt asks for build, test and lint steps with verified commands and runtime versions.'),
    ],
    thresholds: [
      heuristic('distinct environment variable names before flagging', 3, 'names', 'missing-context.ts:checkEnvVarList (envVarNames.size < 3)'),
      heuristic('minimum environment variable name length', 4, 'characters', 'missing-context.ts:ENV_VAR_NAME_RE'),
    ],
    lastVerified: V13,
  },
  {
    id: 'missing-context/project-type-keywords',
    unverified: true,
    detector: 'missing-context',
    title: 'Stack-specific build and test context',
    kind: 'opinion',
    claim:
      'Instruction files for a detected Unity, TypeScript, .NET, Next.js, Python, Go or Rust project that mention none of that stack build, test or tooling terms give agents too little project-specific context.',
    appliesTo: 'all',
    sources: [
      src(
        'ccBest',
        'context',
        'Says CLAUDE.md should hold the exact test, typecheck and lint commands, but its stop-doing table also says describing architecture and file layout in CLAUDE.md is advice to drop because Claude reads the repo itself, which is in tension with the recommendation to add common project patterns.',
      ),
      src('ccMemory', 'context', 'Says the /doctor checkup cuts directory layouts, dependency lists and architecture overviews that Claude can derive from the codebase and keeps pitfalls, rationale and conventions that differ from tool defaults.'),
    ],
    thresholds: [heuristic('minimumPresent', 1, 'matching keywords per project type', 'missing-context.ts:PROJECT_TYPE_RULES')],
    lastVerified: V13,
  },
  {
    id: 'missing-context/security-and-secrets',
    unverified: true,
    detector: 'missing-context',
    title: 'Security and secret-handling guidance',
    kind: 'opinion',
    claim:
      'Instruction files that never mention authentication, secrets or input validation, or that describe credential storage without scopes, validation, expiry or rotation, leave agents without the security rules they need.',
    appliesTo: 'all',
    sources: [src('agentsMd', 'context', 'Lists security considerations among the content AGENTS.md can cover; the page says nothing about token scopes, expiry or rotation.')],
    lastVerified: V13,
  },
  {
    id: 'missing-context/copilot-topic-silence',
    detector: 'missing-context',
    title: 'Copilot topic silence',
    kind: 'tool-fact',
    unverified: true,
    claim:
      'GitHub Copilot does not read Cursor or Windsurf rule files, so a convention documented only there is not visible to it.',
    appliesTo: ['copilot'],
    sources: [
      src(
        'ghRepo15',
        'context',
        'Lists the files Copilot reads: .github/copilot-instructions.md, path-specific .instructions.md files, AGENTS.md stored anywhere in the repository (the nearest one wins) and a single CLAUDE.md or GEMINI.md in the repository root. It does not mention Cursor or Windsurf rule files, but that silence is not a statement that Copilot ignores them.',
      ),
    ],
    caveat:
      'The suppression is sourced by the page above: the check stays silent when AGENTS.md, a root CLAUDE.md or a root GEMINI.md exists, because Copilot reads those (#185). What the finding itself asserts, that Copilot does not read the rule files of other tools, is not sourced.',
    lastVerified: V15(185),
  },

  // ───────────────────────────── within-section-dedup ─────────────────────────────
  {
    id: 'within-section-dedup',
    detector: 'within-section-dedup',
    title: 'Same point restated within one section',
    kind: 'opinion',
    claim: 'A section that restates the same point in two near-identical paragraphs costs context and can drift out of sync, so merging them helps an agent.',
    appliesTo: 'all',
    sources: [],
    unverified: true,
    thresholds: [
      heuristic('MIN_PARAGRAPHS', 6, 'comparable paragraphs in the section', 'within-section-dedup.ts:MIN_PARAGRAPHS'),
      heuristic('PARAGRAPH_JACCARD_THRESHOLD', 0.65, 'Jaccard similarity of word sets', 'within-section-dedup.ts:PARAGRAPH_JACCARD_THRESHOLD'),
      heuristic('MIN_PARAGRAPH_CHARS', 40, 'normalised characters', 'within-section-dedup.ts:MIN_PARAGRAPH_CHARS'),
      heuristic('MIN_PARAGRAPH_TOKENS', 8, 'distinct words', 'within-section-dedup.ts:MIN_PARAGRAPH_TOKENS'),
    ],
    lastVerified: V13,
  },

  // ───────────────────────────── duplicates ─────────────────────────────
  {
    id: 'duplicates/identical-sections',
    detector: 'duplicates',
    title: 'Sections repeated across instruction files',
    kind: 'repo-fact',
    claim: 'Two or more sections of the scanned instruction files have identical text or heavily overlapping word sets once markdown and whitespace are normalised.',
    appliesTo: 'all',
    sources: [],
    thresholds: [
      heuristic('MIN_SECTION_LENGTH', 150, 'normalised characters (cross-file)', 'duplicates.ts:MIN_SECTION_LENGTH'),
      heuristic('WITHIN_FILE_MIN_SECTION_LENGTH', 80, 'normalised characters (same file)', 'duplicates.ts:WITHIN_FILE_MIN_SECTION_LENGTH'),
      heuristic('MIN_TOKEN_COUNT', 10, 'distinct words', 'duplicates.ts:MIN_TOKEN_COUNT'),
      heuristic('CROSS_FILE_JACCARD_THRESHOLD', 0.8, 'Jaccard similarity (warning)', 'duplicates.ts:CROSS_FILE_JACCARD_THRESHOLD'),
      heuristic('CROSS_FILE_JACCARD_THRESHOLD_INFO', 0.6, 'Jaccard similarity (info)', 'duplicates.ts:CROSS_FILE_JACCARD_THRESHOLD_INFO'),
      heuristic('WITHIN_FILE_JACCARD_THRESHOLD', 0.6, 'Jaccard similarity (same file)', 'duplicates.ts:WITHIN_FILE_JACCARD_THRESHOLD'),
    ],
    lastVerified: V13,
  },
  {
    id: 'duplicates/cost-and-drift',
    unverified: true,
    detector: 'duplicates',
    title: 'Duplicate sections cost context and drift apart',
    kind: 'opinion',
    claim:
      'Near-identical sections kept in several instruction files are loaded more than once and can drift apart, so one canonical copy that the other files load (an @AGENTS.md import in CLAUDE.md, or a symlink) is better.',
    appliesTo: 'all',
    sources: [
      src(
        'ccMemory',
        'context',
        'Says Claude Code skips an AGENTS.md it has already loaded so an imported or symlinked copy is not read twice, that a SessionStart hook printing AGENTS.md adds a second copy to the context, and that contradictory instructions across files may be resolved arbitrarily.',
      ),
      src(
        'ccMemory',
        'context',
        'Says a CLAUDE.md that tells Claude in words to read AGENTS.md works only if Claude decides to open the file, and documents an @AGENTS.md import or a symlink instead. This contradicted the earlier forwarding-pointer advice; the advice now recommends the import or a symlink and says a sentence works only if the agent opens the file (pcic-kvv3.12, the fix #184 made for agent-practices). Stance re-judged on 2026-11-21 against the reworded claim, from this note.',
      ),
      src('codex', 'context', 'Says Codex concatenates AGENTS.md files from the root downward into one prompt, with files nearer the working directory appearing later.'),
      src('ghRepo', 'context', 'Advises avoiding conflicting sets of instructions and says all relevant sets are provided to Copilot.'),
    ],
    lastVerified: V21,
  },

  {
    id: 'duplicates/mirror-import',
    detector: 'duplicates',
    title: 'A repo-root CLAUDE.md can import AGENTS.md, with a subdirectory caveat',
    kind: 'tool-fact',
    claim:
      'Claude Code loads the content of a file named on an `@path` line of a CLAUDE.md, resolving a relative path from ' +
      'the importing file, so a repository-root CLAUDE.md with `@AGENTS.md` loads AGENTS.md in a session started at the ' +
      'repository root; an import that resolves outside the session\'s working directory (the same line, in a session ' +
      'started in a subdirectory) is external and needs a one-time approval, and stays disabled when declined, while a ' +
      'markdown link is not loaded at all.',
    appliesTo: ['claude-code'],
    sources: [
      src(
        'ccMemoryImports',
        'supports',
        'Says CLAUDE.md files can import files with @path/to/import syntax, relative paths resolve from the importing file, ' +
          'imports nest up to four hops and are skipped inside code spans and fences, and suggests @AGENTS.md in a CLAUDE.md to share AGENTS.md.',
      ),
      src(
        'ccMemoryExternal',
        'supports',
        'Says Claude Code loads CLAUDE.md from the working directory and every directory above it, that the first external ' +
          'import in a project shows an approval dialog, and that declined imports stay disabled; it does not document a headless session.',
      ),
    ],
    caveat:
      'A reviewer observed (Claude Code 2.1.270, headless, 2026-11-14) that a root CLAUDE.md with @AGENTS.md is not loaded ' +
      'when the session starts in a subdirectory, while the same text inline is. That is why the import edit is opt-in only.',
    lastVerified: { date: '2026-11-14', by: 'Claude agent (pcic-1ik0.10), pending human review' },
  },
  {
    id: 'duplicates/gemini-import-varies',
    detector: 'duplicates',
    title: 'Whether an @ line in GEMINI.md loads the file depends on the Gemini tool',
    kind: 'tool-fact',
    claim:
      'Gemini CLI documents inlining a file named on an `@file.md` line of GEMINI.md (relative to the importing file, ' +
      'five levels by default); Antigravity CLI, which replaced Gemini CLI for unpaid and Google One users, reads GEMINI.md ' +
      'and AGENTS.md but documents that an `@filename` reference does not inline the file, so the import edit never ' +
      'touches GEMINI.md.',
    appliesTo: ['gemini-cli'],
    sources: [
      src('geminiImports', 'supports', 'Says GEMINI.md can import content from other files with the @file.md syntax.'),
      src(
        'geminiMemport',
        'supports',
        'Documents @./file.md and @../file.md imports resolved from the importing file\'s directory, a default nesting limit of five, ' +
          'and imports inside code blocks and inline code ignored.',
      ),
      src(
        'antigravityRules',
        'supports',
        'Says a plain @filename reference does not inline file contents (a separate @[label](path) form does), and that ' +
          'rules include AGENTS.md and GEMINI.md from the workspace folder up to the repository root.',
      ),
    ],
    caveat: 'The Gemini CLI page carries a banner that Antigravity CLI replaced Gemini CLI for unpaid and Google One users on 2026-06-18.',
    lastVerified: { date: '2026-11-14', by: 'Claude agent (pcic-1ik0.10), pending human review' },
  },
  {
    id: 'duplicates/no-import-elsewhere',
    detector: 'duplicates',
    title: 'Cursor, Copilot and Windsurf rule files have no import that loads another file',
    kind: 'tool-fact',
    claim:
      'A Cursor rule, a Copilot instructions file or a Windsurf rule does not load another file\'s content from an `@path` line, ' +
      'so the import edit never touches one of these files.',
    appliesTo: ['cursor', 'copilot', 'windsurf'],
    sources: [
      src('cursorRules14', 'supports', 'Says a rule may mention a file with @filename but its contents are not inlined into the prompt; the agent reads it with its tools when needed.'),
      src('ghRepoInstr14', 'context', 'Documents copilot-instructions.md, path-specific .instructions.md files and root AGENTS.md / CLAUDE.md / GEMINI.md, and no import or include syntax.'),
      src('windsurfMemories14', 'context', 'Documents AGENTS.md, .devin/rules and the legacy .windsurfrules and .windsurf/rules files, and no @ import syntax.'),
    ],
    lastVerified: { date: '2026-11-14', by: 'Claude agent (pcic-1ik0.10), pending human review' },
  },

  // ───────────────────────────── duplicate-headings ─────────────────────────────
  {
    id: 'duplicate-headings',
    detector: 'duplicate-headings',
    title: 'Same heading twice in one instruction file',
    kind: 'opinion',
    claim: 'The same heading appearing twice at one level in an instruction file, or one heading being a whole-word prefix of another, almost always marks an accidental duplicate that should be merged.',
    appliesTo: 'all',
    sources: [],
    unverified: true,
    thresholds: [
      heuristic('minimum normalised heading length', 3, 'characters', 'duplicates.ts:detectDuplicateHeadings (key.length < 3)'),
      heuristic('minimum prefix heading length', 4, 'characters', 'duplicates.ts:detectDuplicateHeadings (shorter.length < 4)'),
    ],
    lastVerified: V13,
  },

  // ───────────────────────────── canonical-owner ─────────────────────────────
  {
    id: 'canonical-owner/ambiguous-authority',
    unverified: true,
    detector: 'canonical-owner',
    title: 'Several files claim to be the canonical source',
    kind: 'opinion',
    claim: 'When several instruction files each declare themselves the canonical source of truth, agents cannot tell which one takes precedence.',
    appliesTo: 'all',
    sources: [
      src('ccMemory', 'context', 'Says that when two instructions contradict each other Claude may pick one arbitrarily and that conflicting files should be removed or reconciled.'),
      src('agentsMd', 'context', 'Says agents read the nearest AGENTS.md so the closest one takes precedence and explicit chat prompts override everything, which sets precedence by location and not by a canonical declaration inside a file.'),
      src('codex', 'context', 'Says files closer to the current directory override earlier guidance and an AGENTS.override.md replaces AGENTS.md in the same directory, so precedence is positional.'),
    ],
    lastVerified: V13,
  },
  {
    id: 'canonical-owner/duplicated-behavior',
    unverified: true,
    detector: 'canonical-owner',
    title: 'Large duplicated behaviour in a tool-specific file',
    kind: 'opinion',
    claim:
      'A section of more than 50 lines in a tool-specific instruction file that matches a section of AGENTS.md duplicates behaviour that an @AGENTS.md import or a symlink could share, costing tokens every session and inviting drift.',
    appliesTo: 'all',
    sources: [
      src('ccMemory', 'context', 'Documents keeping AGENTS.md as the one shared file and importing it with @AGENTS.md or symlinking so the content is read once, not twice.'),
      src(
        'ccMemory',
        'context',
        'Says a CLAUDE.md that tells Claude in words to read AGENTS.md works only if Claude decides to open the file. This contradicted the earlier advice of a forwarding pointer such as Follow AGENTS.md; the advice now recommends an @AGENTS.md import (for CLAUDE.md) or a symlink and says such a sentence works only if the agent opens the file (pcic-kvv3.12). Stance re-judged on 2026-11-21 against the reworded claim, from this note.',
      ),
    ],
    thresholds: [
      heuristic('tool-specific file minimum length', 50, 'lines (file.lineCount > 50)', 'canonical-owner.ts:detectCanonicalOwner'),
      heuristic('duplicated section minimum length', 50, 'lines (endLine - startLine > 50)', 'canonical-owner.ts:detectCanonicalOwner'),
      heuristic('long-section comparison prefix', 500, 'characters (bodies over 500 characters match on their first 500)', 'canonical-owner.ts:detectCanonicalOwner'),
    ],
    lastVerified: V21,
  },

  // ───────────────────────────── custom-rules ─────────────────────────────
  {
    id: 'custom-rules',
    detector: 'custom-rules',
    title: 'User-defined rules run as written',
    kind: 'repo-fact',
    claim: 'A rule in .promptci/custom-rules.json matched, or failed to match, the scanned instruction files exactly as its pattern, heading or targeted file globs state.',
    appliesTo: 'all',
    sources: [],
    lastVerified: V13,
  },
];
