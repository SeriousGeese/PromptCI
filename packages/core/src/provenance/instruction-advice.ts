import type { CheckProvenance, ProvenanceSource, ProvenanceThreshold, SourceStance } from './types.js';

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
  anthContext: { url: 'https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents', title: 'Anthropic engineering: Effective context engineering for AI agents', readOn: '2026-11-14' },
  codex: { url: 'https://learn.chatgpt.com/docs/agent-configuration/agents-md', title: 'Codex docs: AGENTS.md (redirect target of developers.openai.com/codex/guides/agents-md)', readOn: '2026-11-13' },
  agentsMd: { url: 'https://agents.md/', title: 'agents.md: the AGENTS.md format', readOn: '2026-11-13' },
  cursor: { url: 'https://cursor.com/docs/context/rules', title: 'Cursor docs: Rules', readOn: '2026-11-13' },
  windsurf: { url: 'https://docs.devin.ai/desktop/cascade/memories', title: 'Windsurf Cascade memories and rules (redirect target of docs.windsurf.com)', readOn: '2026-11-13' },
  ghRepo: {
    url: 'https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions',
    title: 'GitHub Docs: Adding repository custom instructions for GitHub Copilot',
    readOn: '2026-11-13',
  },
  ghConcept: { url: 'https://docs.github.com/en/copilot/concepts/prompting/response-customization', title: 'GitHub Docs: About customizing GitHub Copilot responses', readOn: '2026-11-14' },
  ghGuide: {
    url: 'https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/configure-coding-guidelines',
    title: 'GitHub Docs: Configuring coding guidelines for Copilot code review',
    readOn: '2026-11-14',
  },
  gemini: { url: 'https://geminicli.com/docs/cli/gemini-md/', title: 'Gemini CLI docs: GEMINI.md context files', readOn: '2026-11-13' },
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
      src('windsurf', 'supports', 'Says rules are injected at the start of every session and advises short specific rules because they cost tokens on every message; the page states no character limit.'),
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
      heuristic('contextBudget high multiplier', 2, 'times the configured contextBudget', 'detectors.ts:DETECTORS context-bloat entry'),
      heuristic('fileContextBudget high multiplier', 2.5, 'times the configured fileContextBudget', 'detectors.ts:DETECTORS context-bloat entry'),
    ],
    lastVerified: V14,
  },
  {
    id: 'context-bloat/copilot-line-limit',
    detector: 'context-bloat',
    title: 'Copilot instructions file line limit',
    kind: 'tool-fact',
    claim: 'GitHub recommends keeping a Copilot instructions file under 1,000 lines and warns that a longer file may be truncated, degrading response quality.',
    appliesTo: ['copilot'],
    sources: [],
    unverified: true,
    thresholds: [heuristic('copilotLineWarning', 1000, 'lines per copilot-instructions file', 'context-bloat.ts:DEFAULTS.copilotLineWarning')],
    lastVerified: V13,
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
    detector: 'context-bloat',
    title: 'README carrying most of the agent context',
    kind: 'opinion',
    claim:
      'A README that makes up most of the scanned instruction text is carried into agent context on every turn although it is written for people, so AI-specific guidance is cheaper in a smaller canonical file such as AGENTS.md.',
    appliesTo: 'all',
    sources: [
      src('agentsMd', 'supports', 'Describes AGENTS.md as a README for agents and says the extra detail agents need, such as build steps and conventions, would clutter a README written for humans.'),
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
    title: 'Volatile content in always-loaded instructions',
    kind: 'tool-fact',
    claim:
      'A date, timestamp, branch name, current-task line or pasted scan report in an always-loaded instruction file changes the prompt prefix whenever it is edited, so the cached prefix is rebuilt and the next request is slower and costlier.',
    appliesTo: 'all',
    sources: [
      src('apiCache', 'supports', 'Says cache hits require 100 percent identical prompt segments up to the cache breakpoint and that a change at one level invalidates that level and all later levels.'),
      src('ccCache', 'supports', 'Says a change anywhere in the prefix recomputes everything after it and that CLAUDE.md sits in the project-context layer, but also that a mid-session CLAUDE.md edit does not invalidate the cache because the file is read once at session start and applies at the next /clear, /compact or restart.'),
      src('ghGuide', 'context', 'The prompt for generating a Copilot instructions file says instructions must not be task specific, which matches the current-task and branch lines but is not a caching claim.'),
    ],
    lastVerified: V14,
  },
  {
    id: 'prompt-cache-friendliness/local-paths',
    detector: 'prompt-cache-friendliness',
    title: 'Absolute local machine paths in instructions',
    kind: 'tool-fact',
    claim: 'Absolute local machine paths in an always-loaded instruction file differ between environments and so prevent prompt-cache reuse across them.',
    appliesTo: 'all',
    sources: [
      src(
        'ccCache',
        'contradicts',
        'Says that in Claude Code the cache is effectively scoped to one machine and directory because the system prompt embeds the auto memory paths and the conversation opens with the working directory, platform and shell, so sessions on different machines or directories already miss each other cache whatever paths CLAUDE.md contains.',
      ),
    ],
    lastVerified: V14,
  },
  {
    id: 'prompt-cache-friendliness/large-table',
    detector: 'prompt-cache-friendliness',
    title: 'Large table in always-loaded instructions',
    kind: 'opinion',
    claim:
      'A Markdown table of more than 15 rows in an always-loaded instruction file bloats context and makes the prompt less cache-friendly than the same facts kept in a separate document read on demand.',
    appliesTo: 'all',
    sources: [
      src(
        'apiCache',
        'contradicts',
        'Says to place static content such as system instructions and context at the beginning of the prompt and cache it, and makes cache hits depend on identical prefix text and not on its size, so a large stable table does not reduce cache hits; it only costs tokens.',
      ),
      src('ccMemory', 'supports', 'Advises moving entries that matter for only part of the codebase out of CLAUDE.md into skills or path-scoped rules because longer files consume more context.'),
    ],
    thresholds: [heuristic('maxTableRows', 15, 'table rows', 'prompt-cache.ts:detectPromptCacheFriendliness (maxTableRows > 15)')],
    lastVerified: V13,
  },

  // ───────────────────────────── negative-instructions ─────────────────────────────
  {
    id: 'negative-instructions',
    detector: 'negative-instructions',
    title: 'Mostly-prohibition instruction files',
    kind: 'opinion',
    claim: 'Models follow positive directives more reliably than prohibitions, so an instruction file whose directives are mostly prohibitions is harder to follow than the same guidance phrased positively.',
    appliesTo: 'all',
    sources: [
      src(
        'apiPrompt',
        'supports',
        'Advises telling Claude what to do instead of what not to do, but only in an output-formatting example (do not use markdown versus flowing prose), and its own sample prompt for limiting over-engineering is written as prohibitions.',
      ),
      src('ccBest', 'context', 'Its recommended sample CLAUDE.md contains prohibitions (never throw raw strings, do not copy legacy patterns), so the page does not treat a prohibition as a defect.'),
    ],
    thresholds: [
      heuristic('MIN_DIRECTIVES', 8, 'directive sentences', 'negative-instructions.ts:MIN_DIRECTIVES'),
      heuristic('NEGATIVE_RATIO_THRESHOLD', 0.4, 'share of directives that are prohibitions', 'negative-instructions.ts:NEGATIVE_RATIO_THRESHOLD'),
    ],
    lastVerified: V13,
  },

  // ───────────────────────────── buried-critical ─────────────────────────────
  {
    id: 'buried-critical',
    detector: 'buried-critical',
    title: 'Critical instructions near the bottom of a long file',
    kind: 'opinion',
    claim:
      'Models weight earlier context more heavily than later context, so high-stakes instructions placed in the bottom half of a long instruction file are applied less reliably than the same lines near the top.',
    appliesTo: 'all',
    sources: [
      src(
        'apiPrompt',
        'contradicts',
        'In long-context guidance (20k-plus-token prompts) it says to put long documents at the top above the query, instructions and examples, and that queries at the end can improve response quality by up to 30 percent, which favours later instructions and not earlier ones.',
      ),
      src('ccMemory', 'supports', 'Says that when an on-demand subdirectory CLAUDE.md or rules file is over a per-file size limit Claude receives only the start of it, so later instructions are not in context.'),
      src('ccContext', 'supports', 'Says truncation of an over-cap invoked skill keeps the start of the file, so the most important instructions belong near the top of SKILL.md.'),
      src('ccBest', 'context', 'Attributes a CLAUDE.md line that keeps being missed to the file having grown long and says to shorten the file, and says nothing about where in the file a line sits.'),
    ],
    thresholds: [
      heuristic('MIN_LINES', 100, 'lines in the file', 'buried-critical.ts:MIN_LINES'),
      heuristic('BOTTOM_HALF_RATIO_THRESHOLD', 0.6, 'share of high-severity lines in the bottom half', 'buried-critical.ts:BOTTOM_HALF_RATIO_THRESHOLD'),
    ],
    lastVerified: V14,
  },

  // ───────────────────────────── vague-guidance ─────────────────────────────
  {
    id: 'vague-guidance/platitudes',
    detector: 'vague-guidance',
    title: 'Non-actionable quality platitudes',
    kind: 'opinion',
    claim:
      'Broad exhortations such as write clean code or follow best practices give an agent no constraint to act on, whereas concrete commands and checkable rules are followed more consistently.',
    appliesTo: 'all',
    sources: [
      src('ccMemory', 'supports', 'Says the more specific and concise the instructions the more consistently Claude follows them and contrasts Use 2-space indentation with Format code properly.'),
      src('apiPrompt', 'supports', 'Says Claude responds well to clear explicit instructions and gives a test of whether a colleague with no context would be confused.'),
      src('anthContext', 'supports', 'Names vague high-level guidance that fails to give concrete signals as one of two failure modes for prompt altitude.'),
      src('cursor', 'supports', 'Says rules should be focused, actionable and scoped and should avoid vague guidance.'),
      src('windsurf', 'supports', 'Advises skipping generic rules such as write good code.'),
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
    claim: 'An instruction to run lint, typecheck and tests before reporting work done, or a documented command to run, makes an agent more likely to check its own work before it says it is finished.',
    appliesTo: 'all',
    sources: [
      src(
        'ccBest',
        'supports',
        'Says to give Claude a check it can run and that the single most useful CLAUDE.md line is the command that runs it, while noting that a line such as Always typecheck before you finish works most of the time and not every time and that a Stop hook enforces it.',
      ),
      src('ghRepo', 'supports', 'The onboarding prompt asks for build, test and lint steps with verified commands and the checks run before check-in.'),
    ],
    lastVerified: V13,
  },
  {
    id: 'agent-practices/grounding',
    detector: 'agent-practices',
    title: 'Read before edit and report failures honestly',
    kind: 'opinion',
    claim: 'Telling an agent to read a file before editing it and to report failures instead of claiming success reduces confidently wrong work and false completion reports.',
    appliesTo: 'all',
    sources: [
      src(
        'apiPrompt',
        'supports',
        'Its sample prompts say never to speculate about code that was not opened and to read the file before answering, and to inform the user rather than work around incorrect tests; they are suggested prompts and not measured results.',
      ),
      src('ccBest', 'context', 'Attributes a Claude that said it was done when it was not mainly to having no way to check its own work, and not to a missing instruction to report honestly.'),
    ],
    lastVerified: V13,
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
    lastVerified: V13,
  },
  {
    id: 'agent-practices/scope-control',
    detector: 'agent-practices',
    title: 'Keep diffs focused',
    kind: 'opinion',
    claim: 'Unconstrained agents often refactor or rewrite code they were not asked to touch, and an instruction to prefer small focused diffs prevents it.',
    appliesTo: 'all',
    sources: [
      src(
        'apiPrompt',
        'supports',
        'Its Overeagerness section says Claude Opus 4.5 and 4.6 tend to over-engineer with extra files and abstractions and gives a sample prompt to make only directly requested changes; the section names those two models.',
      ),
      src(
        'ccBest',
        'contradicts',
        'Says Claude tends to read a request conservatively and build the smallest thing that satisfies it and that lines telling it to keep going are more likely to cause over-work than fix a stall, which runs against the premise that current Claude Code needs guidance to avoid sweeping changes.',
      ),
    ],
    lastVerified: V13,
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
    detector: 'agent-practices',
    title: 'Outline the approach before coding',
    kind: 'opinion',
    claim: 'Asking an agent to outline its approach before writing code on a complex or multi-file task significantly reduces wasted implementation effort.',
    appliesTo: 'all',
    sources: [
      src(
        'ccBest',
        'supports',
        'Recommends having Claude interview you and write a SPEC.md before building from it in a fresh session, which is plan-before-implementing guidance, but gives no measurement of how much effort it saves.',
      ),
    ],
    lastVerified: V13,
  },
  {
    id: 'agent-practices/per-tool-file-gap',
    detector: 'agent-practices',
    title: 'Behavioural rules must be in the file each tool reads',
    kind: 'tool-fact',
    claim:
      'Each of Claude Code, Cursor, Windsurf, Copilot and Gemini CLI reads only its own tool-specific instruction file, so behavioural rules that live only in AGENTS.md or another tool file are invisible to it.',
    appliesTo: ['claude-code', 'cursor', 'windsurf', 'copilot', 'gemini-cli'],
    sources: [
      src('ccMemory', 'supports', 'Says Claude Code reads AGENTS.md by default only when there is no CLAUDE.md or CLAUDE.local.md in the working directory or above it, so a CLAUDE.md without the rules hides AGENTS.md.'),
      src('gemini', 'supports', 'Shows AGENTS.md only as a context.fileName configuration example and does not say it is read by default.'),
      src('cursor', 'contradicts', 'Says AGENTS.md in the project root or subdirectories is read as an alternative to .cursor/rules, so Cursor does see rules that exist only in AGENTS.md.'),
      src('windsurf', 'contradicts', 'Says AGENTS.md, AGENTS.local.md and AGENT.md are read as always-on rules at the workspace root and in directories down to the working directory, so Windsurf sees rules that exist only in AGENTS.md.'),
      src('ghRepo', 'contradicts', 'Says Copilot uses the nearest AGENTS.md in the directory tree and alternatively a root CLAUDE.md or GEMINI.md besides copilot-instructions.md, so Copilot sees rules that exist only in those files.'),
    ],
    lastVerified: V13,
  },
  {
    id: 'agent-practices/forwarding-pointer',
    detector: 'agent-practices',
    title: 'Prose forwarding pointer to AGENTS.md',
    kind: 'tool-fact',
    claim: 'A one-line prose pointer such as Follow AGENTS.md at the top of a tool-specific file makes that tool apply the rules in the file it points to.',
    appliesTo: ['claude-code'],
    sources: [
      src(
        'ccMemory',
        'contradicts',
        'Says a CLAUDE.md that tells Claude in words to read AGENTS.md works only if Claude decides to open the file, and recommends an @AGENTS.md import or a symlink so the content is actually loaded.',
      ),
    ],
    thresholds: [
      heuristic('forwarding pointer head window', 12, 'lines from the top of the file', 'agent-practices.ts:isForwardingFile (slice(0, 12))'),
      heuristic('legacy forwarding file length', 20, 'lines (file shorter than this may point anywhere in the file)', 'agent-practices.ts:isForwardingFile (lineCount < 20)'),
    ],
    lastVerified: V13,
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
    lastVerified: V13,
  },

  // ───────────────────────────── missing-context ─────────────────────────────
  {
    id: 'missing-context/setup-commands',
    detector: 'missing-context',
    title: 'Install, build, test commands and environment variables',
    kind: 'opinion',
    claim: 'Instruction files that omit install, build and test commands, or the environment variables a project needs, leave an agent unable to set up and verify the project reliably.',
    appliesTo: 'all',
    sources: [
      src('ccBest', 'supports', 'Lists the exact test, typecheck and lint commands as what CLAUDE.md should hold and its sample file notes that integration tests need DATABASE_URL set, see .env.example.'),
      src('agentsMd', 'supports', 'Suggests covering build and test commands in AGENTS.md.'),
      src('ghRepo', 'supports', 'The onboarding prompt asks for build, test and lint steps with verified commands and runtime versions.'),
    ],
    thresholds: [
      heuristic('distinct environment variable names before flagging', 3, 'names', 'missing-context.ts:checkEnvVarList (envVarNames.size < 3)'),
      heuristic('minimum environment variable name length', 4, 'characters', 'missing-context.ts:ENV_VAR_NAME_RE'),
    ],
    lastVerified: V13,
  },
  {
    id: 'missing-context/project-type-keywords',
    detector: 'missing-context',
    title: 'Stack-specific build and test context',
    kind: 'opinion',
    claim:
      'Instruction files for a detected Unity, TypeScript, .NET, Next.js, Python, Go or Rust project that mention none of that stack build, test or tooling terms give agents too little project-specific context.',
    appliesTo: 'all',
    sources: [
      src(
        'ccBest',
        'supports',
        'Says CLAUDE.md should hold the exact test, typecheck and lint commands, but its stop-doing table also says describing architecture and file layout in CLAUDE.md is advice to drop because Claude reads the repo itself, which is in tension with the recommendation to add common project patterns.',
      ),
      src('ccMemory', 'context', 'Says the /doctor checkup cuts directory layouts, dependency lists and architecture overviews that Claude can derive from the codebase and keeps pitfalls, rationale and conventions that differ from tool defaults.'),
    ],
    thresholds: [heuristic('minimumPresent', 1, 'matching keywords per project type', 'missing-context.ts:PROJECT_TYPE_RULES')],
    lastVerified: V13,
  },
  {
    id: 'missing-context/security-and-secrets',
    detector: 'missing-context',
    title: 'Security and secret-handling guidance',
    kind: 'opinion',
    claim:
      'Instruction files that never mention authentication, secrets or input validation, or that describe credential storage without scopes, validation, expiry or rotation, leave agents without the security rules they need.',
    appliesTo: 'all',
    sources: [src('agentsMd', 'supports', 'Lists security considerations among the content AGENTS.md can cover; the page says nothing about token scopes, expiry or rotation.')],
    lastVerified: V13,
  },
  {
    id: 'missing-context/copilot-topic-silence',
    detector: 'missing-context',
    title: 'Copilot reads only its own instruction files',
    kind: 'tool-fact',
    claim: 'GitHub Copilot reads only its own instruction files, so a naming convention documented in AGENTS.md or CLAUDE.md is invisible to it.',
    appliesTo: ['copilot'],
    sources: [
      src(
        'ghRepo',
        'contradicts',
        'Says Copilot uses the nearest AGENTS.md in the directory tree and alternatively a single CLAUDE.md or GEMINI.md in the repository root, and that all relevant instruction sets are provided to it, so a convention in AGENTS.md is visible to Copilot.',
      ),
    ],
    lastVerified: V13,
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
    detector: 'duplicates',
    title: 'Duplicate sections cost context and drift apart',
    kind: 'opinion',
    claim: 'Near-identical sections kept in several instruction files are loaded more than once and can drift apart, so one canonical copy with a pointer is better.',
    appliesTo: 'all',
    sources: [
      src(
        'ccMemory',
        'supports',
        'Says Claude Code skips an AGENTS.md it has already loaded so an imported or symlinked copy is not read twice, that a SessionStart hook printing AGENTS.md adds a second copy to the context, and that contradictory instructions across files may be resolved arbitrarily.',
      ),
      src(
        'ccMemory',
        'contradicts',
        'Says a CLAUDE.md that tells Claude in words to read AGENTS.md works only if Claude decides to open the file, which undercuts the detector recommendation of a forwarding pointer to save tokens; an @AGENTS.md import or a symlink is the documented way.',
      ),
      src('codex', 'context', 'Says Codex concatenates AGENTS.md files from the root downward into one prompt, with files nearer the working directory appearing later.'),
      src('ghRepo', 'context', 'Advises avoiding conflicting sets of instructions and says all relevant sets are provided to Copilot.'),
    ],
    lastVerified: V13,
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
    detector: 'canonical-owner',
    title: 'Several files claim to be the canonical source',
    kind: 'opinion',
    claim: 'When several instruction files each declare themselves the canonical source of truth, agents cannot tell which one takes precedence.',
    appliesTo: 'all',
    sources: [
      src('ccMemory', 'supports', 'Says that when two instructions contradict each other Claude may pick one arbitrarily and that conflicting files should be removed or reconciled.'),
      src('agentsMd', 'context', 'Says agents read the nearest AGENTS.md so the closest one takes precedence and explicit chat prompts override everything, which sets precedence by location and not by a canonical declaration inside a file.'),
      src('codex', 'context', 'Says files closer to the current directory override earlier guidance and an AGENTS.override.md replaces AGENTS.md in the same directory, so precedence is positional.'),
    ],
    lastVerified: V13,
  },
  {
    id: 'canonical-owner/duplicated-behavior',
    detector: 'canonical-owner',
    title: 'Large duplicated behaviour in a tool-specific file',
    kind: 'opinion',
    claim:
      'A section of more than 50 lines in a tool-specific instruction file that matches a section of AGENTS.md duplicates behaviour that a pointer could share, costing tokens every session and inviting drift.',
    appliesTo: 'all',
    sources: [
      src('ccMemory', 'supports', 'Documents keeping AGENTS.md as the one shared file and importing it with @AGENTS.md or symlinking so the content is read once, not twice.'),
      src(
        'ccMemory',
        'contradicts',
        'Says a CLAUDE.md that tells Claude in words to read AGENTS.md works only if Claude decides to open the file, which undercuts the detector recommendation of a forwarding pointer such as Follow AGENTS.md.',
      ),
    ],
    thresholds: [
      heuristic('tool-specific file minimum length', 50, 'lines (file.lineCount > 50)', 'canonical-owner.ts:detectCanonicalOwner'),
      heuristic('duplicated section minimum length', 50, 'lines (endLine - startLine > 50)', 'canonical-owner.ts:detectCanonicalOwner'),
      heuristic('long-section comparison prefix', 500, 'characters (bodies over 500 characters match on their first 500)', 'canonical-owner.ts:detectCanonicalOwner'),
    ],
    lastVerified: V13,
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
