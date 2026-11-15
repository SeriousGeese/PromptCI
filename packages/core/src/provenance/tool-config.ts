import type { CheckProvenance, ProvenanceSource, ProvenanceThreshold, SourceStance } from './types.js';

/**
 * Provenance for the checks that rest on what the AI tools read: skills, subagents,
 * hooks and settings, MCP config, Cursor rules, Copilot instructions, Windsurf rules
 * and the skill supply-chain scan (pcic-kvv3.1, issue #162).
 *
 * Every source below is a page an agent fetched and read (2026-11-13 and 2026-11-14);
 * nothing is filled in from memory. Where a page disagrees with what a detector assumes
 * the source carries `contradicts` and the note says how. This is an agent backfill and
 * is pending human review.
 */

const D1 = '2026-11-13';
const D2 = '2026-11-14';

type Page = { url: string; title: string; readOn: string };

const PAGES = {
  ccSkills: { url: 'https://code.claude.com/docs/en/skills', title: 'Claude Code: Skills', readOn: D1 },
  agentSkillsSpec: { url: 'https://agentskills.io/specification', title: 'Agent Skills specification', readOn: D1 },
  ccSubagents: { url: 'https://code.claude.com/docs/en/sub-agents', title: 'Claude Code: Subagents', readOn: D1 },
  ccHooks: { url: 'https://code.claude.com/docs/en/hooks', title: 'Claude Code: Hooks reference', readOn: D2 },
  ccSettings: { url: 'https://code.claude.com/docs/en/settings', title: 'Claude Code: Settings files and precedence', readOn: D2 },
  ccMcp: { url: 'https://code.claude.com/docs/en/mcp', title: 'Claude Code: Connect to tools via MCP', readOn: D2 },
  ccCli: { url: 'https://code.claude.com/docs/en/cli-reference', title: 'Claude Code: CLI reference', readOn: D2 },
  ccTools: { url: 'https://code.claude.com/docs/en/tools-reference', title: 'Claude Code: Tools reference', readOn: D2 },
  skillsOverview: {
    url: 'https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview',
    title: 'Anthropic: Agent Skills overview',
    readOn: D2,
  },
  codexSkills: { url: 'https://learn.chatgpt.com/docs/build-skills', title: 'OpenAI Codex: Build skills', readOn: D2 },
  codexCli: {
    url: 'https://learn.chatgpt.com/docs/developer-commands?surface=cli',
    title: 'OpenAI Codex: CLI command reference',
    readOn: D2,
  },
  geminiCli: { url: 'https://geminicli.com/docs/cli/cli-reference/', title: 'Gemini CLI: CLI reference', readOn: D2 },
  copilotCli: {
    url: 'https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference',
    title: 'GitHub Copilot CLI: command reference',
    readOn: D2,
  },
  cursorRules: { url: 'https://cursor.com/docs/rules', title: 'Cursor: Rules', readOn: D2 },
  ghRepoInstructions: {
    url: 'https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions',
    title: 'GitHub Docs: Adding repository custom instructions for Copilot',
    readOn: D2,
  },
  vscodeInstructionsRef: {
    url: 'https://code.visualstudio.com/docs/agents/reference/custom-instructions-reference',
    title: 'VS Code: Custom instructions reference',
    readOn: D2,
  },
  vscodeInstructions: {
    url: 'https://code.visualstudio.com/docs/agent-customization/custom-instructions',
    title: 'VS Code: Custom instructions',
    readOn: D2,
  },
  windsurfRules: { url: 'https://docs.devin.ai/desktop/devin-local/customizations', title: 'Devin Local docs: Customizations (docs.windsurf.com redirects here; Windsurf has no docs of its own to read, so this is another product\'s documentation)', readOn: D2 },
  rfc8259: { url: 'https://www.rfc-editor.org/info/rfc8259/', title: 'RFC 8259: The JSON Data Interchange Format', readOn: D2 },
} as const satisfies Record<string, Page>;

const cite = (page: Page, stance: SourceStance, note: string): ProvenanceSource => ({ ...page, stance, note });

const VERIFIED = { date: D2, by: 'Claude agent backfill (pcic-kvv3.1), pending human review' } as const;

const unverified = (
  name: string,
  value: number | string,
  where: string,
  unit?: string,
): ProvenanceThreshold => ({ name, value, ...(unit ? { unit } : {}), where, source: 'unverified' });

/** Pages re-read on 2026-11-15 for the issue #176-#196 fixes (vendor docs alignment). */
const READ_1115 = '2026-11-15';
const reread = (page: Page): Page => ({ ...page, readOn: READ_1115 });
const VERIFIED_1115 = (issue: string) => ({ date: READ_1115, by: `agent run 2026-11-15 (issue ${issue})` }) as const;

export const TOOL_CONFIG_PROVENANCE: readonly CheckProvenance[] = [
  // ── ai-config-skills ────────────────────────────────────────────────────────
  {
    id: 'ai-config-skills/frontmatter-fields',
    detector: 'ai-config-skills',
    title: 'Skill frontmatter fields',
    kind: 'tool-fact',
    claim:
      'Claude Code treats every SKILL.md frontmatter field as optional (`name` defaults to the directory name, `description` to the first non-empty body line, nested maps such as `hooks` and `metadata` are valid and unknown keys are ignored), while the Agent Skills specification and OpenAI Codex docs both say a SKILL.md must include `name` and `description`.',
    appliesTo: ['claude-code', 'codex'],
    sources: [
      cite(
        reread(PAGES.ccSkills),
        'supports',
        'Says all frontmatter fields are optional, that `name` defaults to the directory name and `description` falls back to the first non-empty line of the body, that `hooks` and `metadata` are nested maps, and that a field Claude Code does not recognise is ignored without an error.',
      ),
      cite(
        reread(PAGES.agentSkillsSpec),
        'supports',
        'Marks `name` and `description` as required frontmatter fields and `metadata` as an optional map, which is why a portable skill needs both fields.',
      ),
      cite(
        reread(PAGES.codexSkills),
        'supports',
        'States that SKILL.md must include `name` and `description`; it does not say what Codex does with a skill that lacks them, so the detector only words the missing-field finding as a Codex-and-spec portability hint.',
      ),
    ],
    lastVerified: VERIFIED_1115('#191'),
  },
  {
    id: 'ai-config-skills/name-matches-directory',
    detector: 'ai-config-skills',
    title: 'Skill name matches its directory',
    kind: 'tool-fact',
    claim:
      "In Claude Code a skill's `name` sets its command and defaults to the directory name, so a `name` that differs from the directory is valid there, while the Agent Skills specification requires `name` to match the parent directory name.",
    appliesTo: ['claude-code', 'codex'],
    sources: [
      cite(
        reread(PAGES.ccSkills),
        'supports',
        'Says `name` sets the command shown in the `/` menu and typed by the user, defaults to the directory name, and that the directory name also invokes the skill, so the two need not match.',
      ),
      cite(
        reread(PAGES.agentSkillsSpec),
        'supports',
        'Says `name` must match the parent directory name, which is why a difference is reported as a portability hint (info, unscored) for other Agent Skills tools.',
      ),
      cite(reread(PAGES.codexSkills), 'context', 'Does not say whether `name` must match the directory.'),
    ],
    lastVerified: VERIFIED_1115('#192'),
  },
  {
    id: 'ai-config-skills/description-trigger',
    detector: 'ai-config-skills',
    title: 'Skill description is the trigger text',
    kind: 'opinion',
    claim:
      "A skill's `description` is the text the agent reads to decide when to use it, so a missing, very short or duplicated description makes it harder for the agent to pick the right skill.",
    appliesTo: ['claude-code', 'codex'],
    sources: [
      cite(
        reread(PAGES.ccSkills),
        'context',
        'Says an omitted description falls back to the first non-empty line of the body and that description plus `when_to_use` is truncated at 1,536 characters in the skill listing, so the key use case belongs first; it sets no minimum length and does not discuss duplicate descriptions.',
      ),
      cite(
        reread(PAGES.codexSkills),
        'context',
        'Says Codex can choose a skill when a task matches its description and advises front-loading the key use case; it does not measure how length or duplication changes selection.',
      ),
      cite(
        reread(PAGES.agentSkillsSpec),
        'context',
        'Requires a description of 1 to 1,024 characters that says what the skill does and when to use it, with no 12-character minimum.',
      ),
    ],
    unverified: true,
    caveat:
      'Reported as an info-level, unscored hint: no page or eval shows that a short or duplicated description changes whether a skill is chosen, and the 12-character cut-off is the author\'s own.',
    thresholds: [unverified('MIN_DESCRIPTION_CHARS', 12, 'skills-detector.ts:MIN_DESCRIPTION_CHARS', 'characters')],
    lastVerified: VERIFIED_1115('#193'),
  },
  {
    id: 'ai-config-skills/locations-and-bundled-refs',
    detector: 'ai-config-skills',
    title: 'Where skills live and how bundled files resolve',
    kind: 'tool-fact',
    claim:
      "Agent Skills are discovered under `.claude/skills/`, `.agents/skills/` and plugin `skills/<name>/` directories, and files a skill references by relative path resolve from the skill's own directory.",
    appliesTo: ['claude-code', 'codex'],
    sources: [
      cite(
        PAGES.ccSkills,
        'supports',
        'Lists .claude/skills/<name>/SKILL.md for projects and <plugin>/skills/<name>/SKILL.md for plugins, and shows supporting files linked by relative path from SKILL.md; it never mentions .agents/skills.',
      ),
      cite(
        PAGES.codexSkills,
        'supports',
        'Lists .agents/skills in the working directory, its parents and the repository root as Codex repository skill locations, and does not list .codex/skills.',
      ),
      cite(PAGES.agentSkillsSpec, 'supports', 'Says file references inside a skill use relative paths from the skill root.'),
    ],
    lastVerified: VERIFIED,
  },

  // ── ai-config-subagents ─────────────────────────────────────────────────────
  {
    id: 'ai-config-subagents/frontmatter-and-location',
    detector: 'ai-config-subagents',
    title: 'Subagent file and frontmatter',
    kind: 'tool-fact',
    claim:
      'Claude Code requires `name` and `description` in subagent frontmatter, scans `.claude/agents/` recursively, and documents nested maps (`hooks`, `mcpServers`, `experimental`) as valid frontmatter.',
    appliesTo: ['claude-code'],
    sources: [
      cite(
        reread(PAGES.ccSubagents),
        'supports',
        'Says only `name` and `description` are required and that .claude/agents/ is scanned recursively.',
      ),
      cite(
        reread(PAGES.ccSubagents),
        'supports',
        'Documents `hooks`, `mcpServers` and `experimental` as nested maps in subagent frontmatter and says an unrecognised field is ignored without an error, so the detector reports none of them.',
      ),
    ],
    lastVerified: VERIFIED_1115('#194'),
  },
  {
    id: 'ai-config-subagents/model-values',
    detector: 'ai-config-subagents',
    title: 'Subagent model values',
    kind: 'tool-fact',
    claim:
      "A subagent's `model` frontmatter accepts `sonnet`, `opus`, `haiku`, `fable`, `inherit` or a full model ID, which the page defines as a value the `--model` flag accepts.",
    appliesTo: ['claude-code'],
    sources: [
      cite(
        reread(PAGES.ccSubagents),
        'supports',
        'Lists the accepted values as sonnet, opus, haiku, fable, a full model ID such as claude-opus-5-5, or inherit, and describes a full model ID as "a value the --model flag accepts".',
      ),
    ],
    caveat:
      'The detector also accepts `default` and `opusplan`, a `[1m]` suffix and Bedrock or Vertex style ids (`anthropic.claude-…`, `arn:aws:bedrock:…`, `claude-…@date`) silently as `--model` values; the subagents page does not enumerate them, and no page read here lists the `--model` values. Anything else is reported at info.',
    lastVerified: VERIFIED_1115('#176'),
  },
  {
    id: 'ai-config-subagents/tool-names',
    detector: 'ai-config-subagents',
    title: 'Subagent tool names',
    kind: 'tool-fact',
    claim:
      'A subagent `tools` entry is a tool name from the Claude Code tools reference, the `Task` alias of `Agent`, a parenthesised form such as `Agent(worker)`, an `mcp__` tool name or `*`, so any other name (apart from legacy names the detector still accepts silently) is a likely typo.',
    appliesTo: ['claude-code'],
    sources: [
      cite(
        reread(PAGES.ccSubagents),
        'supports',
        'Documents `Agent(agent_type)` parenthesised entries, the `Task(...)` alias that still works after the rename to Agent, and `mcp__server__*` entries in `tools`; it does not say how a name that matches no tool is handled when other entries resolve.',
      ),
      cite(
        reread(PAGES.ccTools),
        'supports',
        'Its tool table lists the names the detector accepts, including Skill, LSP, PowerShell, Monitor, TaskStop, SendMessage and ToolSearch, and says the names are the exact strings used in subagent tool lists.',
      ),
    ],
    caveat:
      'LS, MultiEdit, NotebookRead, BashOutput, KillBash, KillShell and SlashCommand have no row in the tools reference but are accepted silently because real configs still use them.',
    lastVerified: VERIFIED_1115('#177'),
  },
  {
    id: 'ai-config-subagents/duplicate-prompts',
    detector: 'ai-config-subagents',
    title: 'Near-identical subagent prompts',
    kind: 'opinion',
    claim:
      'Two subagents whose prompt bodies are at least 80 percent identical are usually a copy-paste that should be consolidated or differentiated.',
    appliesTo: ['claude-code'],
    sources: [],
    unverified: true,
    thresholds: [
      unverified('DUP_SIMILARITY', 0.8, 'subagents-detector.ts:DUP_SIMILARITY', 'Jaccard similarity'),
      unverified('MIN_BODY_LINES', 5, 'subagents-detector.ts:MIN_BODY_LINES', 'normalized lines'),
      unverified('minimum normalized line length', 8, 'subagents-detector.ts:normalizeBodyLines', 'characters'),
    ],
    lastVerified: VERIFIED,
  },

  // ── ai-config-hooks-settings ────────────────────────────────────────────────
  {
    id: 'ai-config-hooks-settings/settings-files',
    detector: 'ai-config-hooks-settings',
    title: 'Hooks in Claude Code settings files',
    kind: 'tool-fact',
    claim:
      'Claude Code reads `hooks` from `.claude/settings.json` and `.claude/settings.local.json` as event-keyed groups of `{type: command, command}` entries, and a file that is not valid strict JSON is not loaded.',
    appliesTo: ['claude-code'],
    sources: [
      cite(
        PAGES.ccHooks,
        'supports',
        'Lists .claude/settings.json and .claude/settings.local.json as hook locations and shows event, matcher group and hooks array nesting with `type: command` handlers, alongside http, mcp_tool, prompt and agent handler types the detector does not audit.',
      ),
      cite(
        PAGES.ccSettings,
        'supports',
        'Says settings files are strict JSON so a comment or trailing comma is a syntax error, and that an invalid project or local file raises a Settings Error and is skipped in a -p run.',
      ),
    ],
    lastVerified: VERIFIED,
  },
  {
    id: 'ai-config-hooks-settings/project-dir-quoting',
    detector: 'ai-config-hooks-settings',
    title: 'Quoting the project directory in hook commands',
    kind: 'tool-fact',
    claim:
      'In a shell-form command hook (no `args`) an unquoted `$CLAUDE_PROJECT_DIR` path is split by the shell when the project path contains a space, while a hook with `args` set runs in exec form with no shell, needs no quoting, and has the braced `${CLAUDE_PROJECT_DIR}` placeholder substituted into `command` and `args`.',
    appliesTo: ['claude-code'],
    sources: [
      cite(
        reread(PAGES.ccHooks),
        'supports',
        'Says a command hook runs in shell form when `args` is omitted, where the shell tokenizes the string and each path placeholder should be wrapped in double quotes.',
      ),
      cite(
        reread(PAGES.ccHooks),
        'supports',
        'Says a hook with `args` set runs in exec form with no shell and each element is passed as one argument with no quoting, so the quoting hint is not raised for exec-form hooks.',
      ),
      cite(
        reread(PAGES.ccHooks),
        'supports',
        'Documents `${CLAUDE_PROJECT_DIR}` (braced) as the path placeholder, substituted as plain strings into `command` and each `args` element in exec form; the unbraced `$CLAUDE_PROJECT_DIR` appears only as an environment variable or shell expansion, so the detector reports an unbraced use in exec form as an info hint.',
      ),
    ],
    lastVerified: VERIFIED_1115('#195'),
  },
  {
    id: 'ai-config-hooks-settings/remote-pipe',
    detector: 'ai-config-hooks-settings',
    title: 'Hook that pipes a download into a shell',
    kind: 'opinion',
    claim:
      "A hook command that pipes curl or wget output straight into a shell runs whatever the remote host serves with the user's own permissions.",
    appliesTo: ['claude-code'],
    sources: [],
    unverified: true,
    lastVerified: VERIFIED,
  },
  {
    id: 'ai-config-hooks-settings/missing-script',
    detector: 'ai-config-hooks-settings',
    title: 'Hook script missing from the repository',
    kind: 'repo-fact',
    claim: 'A repo-relative script that a hook command runs is not present in the scanned repository.',
    appliesTo: 'all',
    sources: [],
    lastVerified: VERIFIED,
  },

  // ── ai-config-mcp ───────────────────────────────────────────────────────────
  {
    id: 'ai-config-mcp/file-format',
    detector: 'ai-config-mcp',
    title: 'Project MCP config format',
    kind: 'tool-fact',
    claim:
      'Claude Code reads project MCP servers from `.mcp.json` under a top-level `mcpServers` key, where a stdio server is defined by a `command` (with `args` and `env`) and a remote server by a `url` plus a `type`; an entry with a `url` but no `type` is read as a stdio server and skipped with a configuration error.',
    appliesTo: ['claude-code'],
    sources: [
      cite(
        reread(PAGES.ccMcp),
        'supports',
        'Shows project servers in .mcp.json under a top-level mcpServers key, with command, args and env for stdio servers and a url (with a type) for remote servers.',
      ),
      cite(
        reread(PAGES.ccMcp),
        'supports',
        'Says an entry with a `url` but no `type` is read as a stdio server and skipped with a configuration error, which is why the detector reports it as an info-level, unscored hint rather than a scored warning.',
      ),
    ],
    lastVerified: VERIFIED_1115('#196'),
  },
  {
    id: 'ai-config-mcp/duplicate-names',
    unverified: true,
    detector: 'ai-config-mcp',
    title: 'Duplicate MCP server names',
    kind: 'tool-fact',
    claim: 'When `.mcp.json` defines the same server name twice, JSON parsing keeps only the last definition and silently drops the earlier one.',
    appliesTo: ['claude-code'],
    sources: [
      cite(
        PAGES.rfc8259,
        'context',
        'Says behaviour for non-unique object names is unpredictable and that many implementations report only the last pair, while others reject the text or keep every pair.',
      ),
      cite(
        PAGES.ccMcp,
        'context',
        'Says duplicate server names across scopes resolve to the highest-precedence source, and does not say how a duplicate key inside one .mcp.json file is handled.',
      ),
    ],
    lastVerified: VERIFIED,
  },
  {
    id: 'ai-config-mcp/placeholders-and-paths',
    detector: 'ai-config-mcp',
    title: 'MCP placeholders and local paths',
    kind: 'repo-fact',
    claim:
      'An `env` value in `.mcp.json` that is empty or a placeholder was never filled in, and a local command or script path in it does not exist in the repository.',
    appliesTo: 'all',
    sources: [
      cite(
        PAGES.ccMcp,
        'context',
        'Documents ${VAR} expansion in env values, which is what the detector recommends in place of a placeholder, and says an unset ${VAR} is passed through unexpanded.',
      ),
    ],
    lastVerified: VERIFIED,
  },

  // ── ai-config-cursor-rules ──────────────────────────────────────────────────
  {
    id: 'ai-config-cursor-rules/rule-files',
    detector: 'ai-config-cursor-rules',
    title: 'Cursor rule files and frontmatter',
    kind: 'tool-fact',
    claim: 'Cursor project rules are `.mdc` files under `.cursor/rules/` whose frontmatter holds `description`, `globs` and `alwaysApply`.',
    appliesTo: ['cursor'],
    sources: [
      cite(
        PAGES.cursorRules,
        'supports',
        'Says project rules live in .cursor/rules, must use the .mdc extension, may sit in subfolders and carry description, globs and alwaysApply frontmatter.',
      ),
    ],
    lastVerified: VERIFIED,
  },
  {
    id: 'ai-config-cursor-rules/no-trigger',
    detector: 'ai-config-cursor-rules',
    title: 'Cursor rule with no trigger',
    kind: 'tool-fact',
    claim: 'A Cursor rule with no `description`, no `globs` and `alwaysApply` false is a manual rule that Cursor includes only when it is @-mentioned in chat.',
    appliesTo: ['cursor'],
    sources: [
      cite(
        { ...PAGES.cursorRules, readOn: '2026-11-15' },
        'supports',
        'Lists alwaysApply false with neither globs nor a description as included only when you @-mention the rule in chat (Apply Manually).',
      ),
    ],
    lastVerified: { date: '2026-11-15', by: 'agent run 2026-11-15 (issue #178)' },
  },
  {
    id: 'ai-config-cursor-rules/glob-semantics',
    detector: 'ai-config-cursor-rules',
    title: 'Cursor rule glob matching',
    kind: 'tool-fact',
    claim:
      'Cursor documents a slashless glob such as `*.ts` as matching .ts files in the root only (`**/*.ts` matches any directory), and a rule whose `globs` match no file is auto-attached to nothing.',
    appliesTo: ['cursor'],
    sources: [
      cite(
        { ...PAGES.cursorRules, readOn: '2026-11-15' },
        'supports',
        'Documents `*.ts` as all .ts files in the root and `**/*.ts` as all .ts files in any directory.',
      ),
      cite({ ...PAGES.cursorRules, readOn: '2026-11-15' }, 'supports', 'Lists a rule with globs as applied when a file matches the specified pattern.'),
    ],
    lastVerified: { date: '2026-11-15', by: 'agent run 2026-11-15 (issue #197)' },
  },

  // ── ai-config-copilot-instructions ──────────────────────────────────────────
  {
    id: 'ai-config-copilot-instructions/path-specific-files',
    detector: 'ai-config-copilot-instructions',
    title: 'Copilot path-specific instruction files',
    kind: 'tool-fact',
    claim:
      'Copilot reads path-specific instructions only from files under `.github/instructions/` (subdirectories allowed) whose name ends with `.instructions.md` and that scope themselves with an `applyTo` frontmatter glob, while `.github/copilot-instructions.md` is repository-wide and has no `applyTo`.',
    appliesTo: ['copilot'],
    sources: [
      cite(
        { ...PAGES.ghRepoInstructions, readOn: '2026-11-15' },
        'supports',
        'Says a path-specific file name must end with .instructions.md, may sit in subdirectories of .github/instructions, uses an applyTo frontmatter keyword, and that .github/copilot-instructions.md is repository-wide without applyTo.',
      ),
      cite(
        { ...PAGES.vscodeInstructionsRef, readOn: '2026-11-15' },
        'supports',
        'Places project instructions at .github/instructions/**/*.instructions.md with an optional YAML header and says copilot-instructions.md does not require frontmatter.',
      ),
    ],
    lastVerified: { date: '2026-11-15', by: 'agent run 2026-11-15 (issue #198)' },
  },
  {
    id: 'ai-config-copilot-instructions/apply-to-default',
    detector: 'ai-config-copilot-instructions',
    title: 'Copilot instructions without applyTo',
    kind: 'tool-fact',
    claim: 'In VS Code a path-specific Copilot instructions file with neither `description` nor `applyTo` is left available for manual attachment rather than applied automatically, and `applyTo` has no default pattern.',
    appliesTo: ['copilot'],
    sources: [
      cite(
        { ...PAGES.vscodeInstructionsRef, readOn: '2026-11-15' },
        'supports',
        'Says that in Local sessions a file omitting both description and applyTo is left available for manual attachment rather than automatic activation, and that there is no default pattern.',
      ),
      cite({ ...PAGES.ghRepoInstructions, readOn: '2026-11-15' }, 'context', 'Does not say what happens when applyTo is omitted.'),
    ],
    caveat: 'Stated for VS Code Local sessions; other Copilot surfaces may treat a file without applyTo differently, so the finding is informational.',
    lastVerified: { date: '2026-11-15', by: 'agent run 2026-11-15 (issue #179)' },
  },
  {
    id: 'ai-config-copilot-instructions/glob-semantics',
    detector: 'ai-config-copilot-instructions',
    title: 'Copilot applyTo glob matching',
    kind: 'tool-fact',
    claim: 'An `applyTo` glob such as `*.py` without a slash matches only the current (root) directory, `**` or `**/*` matches all files, and a glob that matches no file never applies.',
    appliesTo: ['copilot'],
    sources: [
      cite(
        { ...PAGES.ghRepoInstructions, readOn: '2026-11-15' },
        'supports',
        'Gives `*.py` as matching the .py files in the current directory only, `**/*.py` as matching recursively, and `**` or `**/*` as matching all files in all directories.',
      ),
      cite(
        { ...PAGES.vscodeInstructionsRef, readOn: '2026-11-15' },
        'supports',
        'Says patterns are relative to the project root and that `*.py` matches only root-level files.',
      ),
    ],
    lastVerified: { date: '2026-11-15', by: 'agent run 2026-11-15 (issue #180)' },
  },

  // ── ai-config-windsurf-rules ────────────────────────────────────────────────
  {
    id: 'ai-config-windsurf-rules/legacy-always-on',
    unverified: true,
    detector: 'ai-config-windsurf-rules',
    title: 'Windsurf legacy rules file',
    kind: 'tool-fact',
    claim: '`.windsurfrules` is Windsurf\'s legacy workspace-wide rules file and every rule in it is fed to the model on every request.',
    appliesTo: ['windsurf'],
    sources: [
      cite(
        PAGES.windsurfRules,
        'context',
        'Says the legacy .windsurf/rules/*.md, .windsurf/global_rules.md and .windsurfrules files are imported by default and names global_rules.md as always-on, but does not describe .windsurfrules as always-on, and the page has moved to docs.devin.ai with .devin/rules as the primary location.',
      ),
    ],
    lastVerified: VERIFIED,
  },
  {
    id: 'ai-config-windsurf-rules/scoped-rules',
    unverified: true,
    detector: 'ai-config-windsurf-rules',
    title: 'Windsurf scoped rule files',
    kind: 'tool-fact',
    claim: 'Windsurf supports scoped rule files in `.windsurf/rules/*.md` that activate by glob, manually or by model decision.',
    appliesTo: ['windsurf'],
    sources: [
      cite(
        PAGES.windsurfRules,
        'context',
        'Documents Devin Local, not Windsurf: lists always_on, glob, model_decision and manual triggers for rule files with globs set in frontmatter, and says legacy .windsurf/rules/*.md files are still imported.',
      ),
    ],
    lastVerified: VERIFIED,
  },
  {
    id: 'ai-config-windsurf-rules/language-scoping',
    unverified: true,
    detector: 'ai-config-windsurf-rules',
    title: 'Language-specific rules belong in scoped files',
    kind: 'opinion',
    claim:
      'An always-on rules file with headings for two or more distinct languages or frameworks mixes rule sets that are cheaper as glob-scoped rules.',
    appliesTo: ['windsurf'],
    sources: [
      cite(
        PAGES.windsurfRules,
        'context',
        'Says rules cost tokens on every message and should be short and specific, with a skill preferred for occasional needs, but does not recommend splitting language-specific rules into glob-triggered files.',
      ),
    ],
    thresholds: [unverified('MIN_DISTINCT_TOPICS', 2, 'windsurf-detector.ts:MIN_DISTINCT_TOPICS', 'distinct topics')],
    lastVerified: VERIFIED,
  },

  // ── skill-supply-chain ──────────────────────────────────────────────────────
  {
    id: 'skill-supply-chain/trust-model',
    detector: 'skill-supply-chain',
    title: 'A skill is untrusted code',
    kind: 'tool-fact',
    claim:
      "An installed Agent Skill is instructions plus bundled scripts that the agent loads on demand and runs with the user's own permissions, so a third-party skill is untrusted code.",
    appliesTo: ['claude-code', 'codex'],
    sources: [
      cite(
        PAGES.skillsOverview,
        'supports',
        "Says to use skills only from trusted sources, that a malicious skill can direct Claude to call tools or run code, and that in Claude Code skills have the same network access as any other program on the user's computer.",
      ),
      cite(
        PAGES.ccSkills,
        'supports',
        'Warns that a project skill can grant itself broad tool access through allowed-tools even in an untrusted folder so repository skills need review, but does not state in so many words that scripts run with user permissions.',
      ),
      cite(PAGES.agentSkillsSpec, 'context', 'Defines scripts/ as executable code agents can run and says the SKILL.md body loads when the skill activates.'),
      cite(
        PAGES.codexSkills,
        'context',
        'Says Codex loads the full SKILL.md only when it uses the skill and that scripts are optional, and says nothing about approval or sandboxing of skill scripts.',
      ),
    ],
    lastVerified: VERIFIED,
  },
  {
    id: 'skill-supply-chain/code-abuse-patterns',
    unverified: true,
    detector: 'skill-supply-chain',
    title: 'Code patterns typical of a malicious or fragile skill',
    kind: 'opinion',
    claim:
      'Piping fetched content into a shell or eval, decoding then executing a payload, reading credential stores next to network calls and installing unpinned remote dependencies are characteristic of a malicious or fragile skill.',
    appliesTo: ['claude-code', 'codex'],
    sources: [
      cite(
        PAGES.skillsOverview,
        'context',
        'Tells reviewers to look for unexpected network calls and file access, and says skills that fetch external URLs pose particular risk and can be compromised if their dependencies change; it names no specific pipe-to-shell or encoding pattern.',
      ),
    ],
    lastVerified: VERIFIED,
  },
  {
    id: 'skill-supply-chain/hidden-and-injected-text',
    detector: 'skill-supply-chain',
    title: 'Hidden and injected text in a skill',
    kind: 'tool-fact',
    claim:
      'An agent reads a skill\'s raw text including HTML comments, hidden-element markup and invisible Unicode characters that rendered Markdown hides from a human reviewer, so such text can carry instructions.',
    appliesTo: ['claude-code', 'codex'],
    sources: [],
    unverified: true,
    thresholds: [unverified('BLOB_RE minimum run', 200, 'skill-supply-chain.ts:BLOB_RE', 'base64 characters')],
    lastVerified: VERIFIED,
  },
  {
    id: 'skill-supply-chain/permission-bypass-flags',
    detector: 'skill-supply-chain',
    title: 'Flags that switch off agent permission prompts',
    kind: 'tool-fact',
    claim:
      '`--dangerously-skip-permissions`, `bypassPermissions`, `--dangerously-bypass-approvals-and-sandbox`, `--yolo` and `--allow-all-tools` each switch off an AI coding tool permission prompts or sandbox.',
    appliesTo: ['claude-code', 'codex', 'gemini-cli', 'copilot'],
    sources: [
      cite(
        PAGES.ccCli,
        'supports',
        'Describes --dangerously-skip-permissions as skipping permission prompts and equivalent to --permission-mode bypassPermissions.',
      ),
      cite(
        PAGES.codexCli,
        'supports',
        'Lists --dangerously-bypass-approvals-and-sandbox with the alias --yolo as running every command without approvals or sandboxing, for use only in a hardened environment.',
      ),
      cite(
        PAGES.geminiCli,
        'supports',
        'Lists --yolo as a deprecated auto-approve flag replaced by --approval-mode=yolo, a newer spelling the detector flag list does not match.',
      ),
      cite(
        PAGES.copilotCli,
        'supports',
        'Says --allow-all-tools grants blanket tool permissions without a model safety review or approval prompts; --yolo appears only as a slash-command alias in the part of the page read.',
      ),
    ],
    caveat:
      'geminicli.com carries a banner (read 2026-11-14): Gemini CLI was replaced by Antigravity CLI on June 18th, 2026 for unpaid-tier and Google One users, and it has not been optimized for Gemini 4 Argon; a claim about gemini-cli may not hold for the replacement.',
    lastVerified: VERIFIED,
  },
  {
    id: 'skill-supply-chain/bundle-completeness',
    detector: 'skill-supply-chain',
    title: 'Skill content the scan could not review',
    kind: 'repo-fact',
    claim:
      'Skill content past the scan caps, such as binaries, archives, oversized files and bundles of more than 200 files, was not inspected, and a SKILL.md that runs a script found nowhere cannot be reviewed.',
    appliesTo: 'all',
    sources: [],
    thresholds: [
      unverified('MAX_BUNDLED_FILES_PER_SKILL', 200, 'discovery.ts:MAX_BUNDLED_FILES_PER_SKILL', 'files'),
      unverified('MAX_SCAN_BYTES', 20 * 1024 * 1024, 'skill-supply-chain.ts:MAX_SCAN_BYTES', 'bytes'),
      unverified('MAX_SCAN_FILES', 2000, 'skill-supply-chain.ts:MAX_SCAN_FILES', 'files'),
      unverified('MAX_SCAN_LINES', 3_000_000, 'skill-supply-chain.ts:MAX_SCAN_LINES', 'lines'),
      unverified('MAX_FILE_SIZE', 500 * 1024, 'discovery.ts:MAX_FILE_SIZE', 'bytes'),
      unverified('oversized file head and tail window', 500 * 1024, 'skill-supply-chain.ts:loadDocs (MAX_FILE_SIZE)', 'bytes'),
      unverified('BINARY_CHECK_BYTES', 512, 'discovery.ts:BINARY_CHECK_BYTES', 'bytes'),
      unverified('MAX_SCAN_WINDOW', 2000, 'skill-supply-chain.ts:MAX_SCAN_WINDOW', 'characters'),
      unverified('WINDOW_OVERLAP', 600, 'skill-supply-chain.ts:WINDOW_OVERLAP', 'characters'),
      unverified('MAX_HITS_PER_RULE_FILE', 25, 'skill-supply-chain.ts:MAX_HITS_PER_RULE_FILE', 'hits'),
      unverified('MAX_EVIDENCE', 5, 'skill-supply-chain.ts:MAX_EVIDENCE', 'evidence lines'),
      unverified('MAX_FS_CHECKS_PER_DOC', 200, 'skill-supply-chain.ts:MAX_FS_CHECKS_PER_DOC', 'lookups'),
      unverified('MAX_PIPE_HOPS', 16, 'skill-supply-chain.ts:MAX_PIPE_HOPS', 'pipe stages'),
      unverified('MAX_JOINED_LINES', 20, 'skill-supply-chain.ts:MAX_JOINED_LINES', 'lines'),
      unverified('MAX_JOINED_CHARS', 4000, 'skill-supply-chain.ts:MAX_JOINED_CHARS', 'characters'),
      unverified('MAX_LOOP_JOINED_LINES', 200, 'skill-supply-chain.ts:MAX_LOOP_JOINED_LINES', 'lines'),
      unverified('MAX_LOOP_JOINED_CHARS', 20000, 'skill-supply-chain.ts:MAX_LOOP_JOINED_CHARS', 'characters'),
      unverified('MAX_BUNDLE_LISTING', 20_000, 'ai-config.ts:MAX_BUNDLE_LISTING', 'directory entries'),
      unverified('MAX_OVER_CAP_NAMES', 1000, 'ai-config.ts:MAX_OVER_CAP_NAMES', 'file names'),
    ],
    lastVerified: VERIFIED,
  },
];
