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
  cursorRules: { url: 'https://cursor.com/docs/context/rules', title: 'Cursor: Rules', readOn: D2 },
  ghRepoInstructions: {
    url: 'https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions',
    title: 'GitHub Docs: Adding repository custom instructions for Copilot',
    readOn: D2,
  },
  vscodeInstructionsRef: {
    url: 'https://code.visualstudio.com/docs/agents/reference/custom-instructions-reference',
    title: 'VS Code: Custom instructions reference',
    readOn: D2,
  },
  vscodeInstructions: {
    url: 'https://code.visualstudio.com/docs/copilot/customization/custom-instructions',
    title: 'VS Code: Custom instructions',
    readOn: D2,
  },
  windsurfRules: { url: 'https://docs.devin.ai/desktop/cascade/memories', title: 'Windsurf (docs.devin.ai): Rules and memories', readOn: D2 },
  rfc8259: { url: 'https://www.rfc-editor.org/rfc/rfc8259', title: 'RFC 8259: The JSON Data Interchange Format', readOn: D2 },
} as const satisfies Record<string, Page>;

const cite = (page: Page, stance: SourceStance, note: string): ProvenanceSource => ({ ...page, stance, note });

const VERIFIED = { date: D2, by: 'Claude agent backfill (pcic-kvv3.1), pending human review' } as const;

const unverified = (
  name: string,
  value: number | string,
  where: string,
  unit?: string,
): ProvenanceThreshold => ({ name, value, ...(unit ? { unit } : {}), where, source: 'unverified' });

export const TOOL_CONFIG_PROVENANCE: readonly CheckProvenance[] = [
  // ── ai-config-skills ────────────────────────────────────────────────────────
  {
    id: 'ai-config-skills/frontmatter-fields',
    detector: 'ai-config-skills',
    title: 'Skill frontmatter fields',
    kind: 'tool-fact',
    claim:
      'A SKILL.md without `name` and `description` frontmatter is skipped by strict loaders such as Codex, Claude Code needs `name` to identify and invoke a skill, and nested maps in the frontmatter are unsupported.',
    appliesTo: ['claude-code', 'codex'],
    sources: [
      cite(
        PAGES.ccSkills,
        'contradicts',
        'Says every frontmatter field is optional and that `name` defaults to the directory name, so Claude Code does not need `name` to identify the skill and the missing-name finding overstates it.',
      ),
      cite(
        PAGES.ccSkills,
        'contradicts',
        'Documents `hooks` and `metadata` as nested YAML maps in skill frontmatter and says an unrecognised key is ignored without error, so the finding that a nested key is unsupported is wrong for Claude Code.',
      ),
      cite(
        PAGES.agentSkillsSpec,
        'supports',
        'Marks `name` and `description` as required frontmatter fields, which is why a portable skill needs both.',
      ),
      cite(
        PAGES.codexSkills,
        'supports',
        'States that SKILL.md must include `name` and `description`, but does not say what Codex does with a skill that lacks them, so "skipped" is not confirmed.',
      ),
    ],
    lastVerified: VERIFIED,
  },
  {
    id: 'ai-config-skills/name-matches-directory',
    detector: 'ai-config-skills',
    title: 'Skill name matches its directory',
    kind: 'tool-fact',
    claim: 'Claude resolves a skill by its directory name, so a frontmatter `name` that differs from the skill directory is a mistake.',
    appliesTo: ['claude-code', 'codex'],
    sources: [
      cite(
        PAGES.ccSkills,
        'contradicts',
        'Describes `name` as the command name shown in the `/` menu that only defaults to the directory name, and does not require the two to match, so the page does not say Claude resolves skills by directory name.',
      ),
      cite(
        PAGES.agentSkillsSpec,
        'supports',
        'The portable spec says `name` must match the parent directory name, which supports the check for the open format but is not Claude Code behaviour.',
      ),
      cite(PAGES.codexSkills, 'context', 'Does not say whether `name` must match the directory.'),
    ],
    lastVerified: VERIFIED,
  },
  {
    id: 'ai-config-skills/description-trigger',
    detector: 'ai-config-skills',
    title: 'Skill description is the trigger text',
    kind: 'tool-fact',
    claim:
      "A skill's `description` is the text the agent matches against a request to decide whether to invoke it, so an empty or very short description rarely triggers and two identical descriptions compete for the same triggers.",
    appliesTo: ['claude-code', 'codex'],
    sources: [
      cite(
        PAGES.skillsOverview,
        'supports',
        'Says the description is what Claude matches a request against to decide whether to trigger the skill, and requires it to be non-empty and at most 1,024 characters.',
      ),
      cite(
        PAGES.ccSkills,
        'contradicts',
        'Says an omitted description falls back to the first non-empty line of the body, so a missing description does not always leave a skill untriggerable, and truncates description plus when_to_use at 1,536 characters in the listing.',
      ),
      cite(
        PAGES.codexSkills,
        'supports',
        'Says Codex can select a skill when a task matches its description and advises front-loading the key use case.',
      ),
      cite(
        PAGES.agentSkillsSpec,
        'context',
        'Requires a description of 1 to 1,024 characters that says what the skill does and when to use it, with no 12-character minimum.',
      ),
    ],
    thresholds: [unverified('MIN_DESCRIPTION_CHARS', 12, 'skills-detector.ts:MIN_DESCRIPTION_CHARS', 'characters')],
    lastVerified: VERIFIED,
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
      'Claude Code registers a subagent from a Markdown file under `.claude/agents/` only when its frontmatter has `name` and `description`, and nested maps in that frontmatter are unsupported.',
    appliesTo: ['claude-code'],
    sources: [
      cite(
        PAGES.ccSubagents,
        'supports',
        'Says only `name` and `description` are required and that .claude/agents/ is scanned recursively.',
      ),
      cite(
        PAGES.ccSubagents,
        'contradicts',
        'Documents `hooks`, `mcpServers` and `experimental` as nested YAML maps in subagent frontmatter, so the finding that a nested key is unsupported is wrong for Claude Code.',
      ),
    ],
    lastVerified: VERIFIED,
  },
  {
    id: 'ai-config-subagents/model-values',
    detector: 'ai-config-subagents',
    title: 'Subagent model values',
    kind: 'tool-fact',
    claim:
      "A subagent's `model` frontmatter accepts only the aliases sonnet, opus, haiku, inherit, default or opusplan, or a full `claude-*` model id.",
    appliesTo: ['claude-code'],
    sources: [
      cite(
        PAGES.ccSubagents,
        'contradicts',
        'Lists the accepted values as sonnet, opus, haiku, fable, a full model ID or inherit, so `fable` is valid but missing from the detector alias set, and `default` and `opusplan` are not listed as valid values.',
      ),
    ],
    lastVerified: VERIFIED,
  },
  {
    id: 'ai-config-subagents/tool-names',
    detector: 'ai-config-subagents',
    title: 'Subagent tool names',
    kind: 'tool-fact',
    claim:
      'A subagent `tools` entry must be one of a fixed list of built-in tool names, an `mcp__` tool name or `*`, and any other name is a likely typo.',
    appliesTo: ['claude-code'],
    sources: [
      cite(
        PAGES.ccSubagents,
        'contradicts',
        'Documents `Agent(agent_type)` parenthesised entries (honoured for a main-thread agent, ignored in a subagent definition), the legacy `Task(...)` alias, and built-in tools such as Skill, LSP, PowerShell, ToolSearch and Monitor that the detector list omits, so valid entries are reported as typos.',
      ),
      cite(
        PAGES.ccTools,
        'contradicts',
        'Its tool table lists current tools such as Skill, LSP, PowerShell, Monitor, TaskStop, SendMessage and ToolSearch that the detector list omits, and has no row for LS, MultiEdit, NotebookRead, BashOutput, KillBash, KillShell or SlashCommand, which the detector list still accepts.',
      ),
    ],
    lastVerified: VERIFIED,
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
    claim: 'An unquoted `$CLAUDE_PROJECT_DIR` path in a hook command breaks when the project path contains a space.',
    appliesTo: ['claude-code'],
    sources: [
      cite(
        PAGES.ccHooks,
        'supports',
        'Says that in shell form the command string is tokenized by a shell and each path placeholder should be wrapped in double quotes.',
      ),
      cite(
        PAGES.ccHooks,
        'contradicts',
        'Says a hook with `args` set runs in exec form with no shell, so a placeholder needs no quotes there, and its own example passes an unquoted ${CLAUDE_PROJECT_DIR} path with `"args": []`, which the detector would still flag.',
      ),
    ],
    lastVerified: VERIFIED,
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
      'Claude Code reads project MCP servers from `.mcp.json` under a top-level `mcpServers` key, where a stdio server needs a `command` and a remote server needs only a `url`.',
    appliesTo: ['claude-code'],
    sources: [
      cite(
        PAGES.ccMcp,
        'supports',
        'Shows project servers in .mcp.json under a top-level mcpServers key, with command, args and env for stdio servers and type plus url for http or sse servers.',
      ),
      cite(
        PAGES.ccMcp,
        'contradicts',
        'Says an entry with a `url` but no `type` is read as a stdio server and skipped with a configuration error, so the detector accepting any `url` as a valid remote server is too lax.',
      ),
    ],
    lastVerified: VERIFIED,
  },
  {
    id: 'ai-config-mcp/duplicate-names',
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
    claim: 'A Cursor rule with no `description`, no `globs` and `alwaysApply` unset has no signal for when to apply and can never activate.',
    appliesTo: ['cursor'],
    sources: [
      cite(
        PAGES.cursorRules,
        'contradicts',
        'Says a rule with alwaysApply false and neither globs nor a description is included when you @-mention it in chat, so it can activate manually rather than never.',
      ),
    ],
    lastVerified: VERIFIED,
  },
  {
    id: 'ai-config-cursor-rules/glob-semantics',
    detector: 'ai-config-cursor-rules',
    title: 'Cursor rule glob matching',
    kind: 'tool-fact',
    claim:
      'Cursor matches a slashless glob such as `*.tsx` at any depth, and a rule whose `globs` match no file in the repository is auto-attached to nothing.',
    appliesTo: ['cursor'],
    sources: [
      cite(
        PAGES.cursorRules,
        'contradicts',
        'Documents `*.ts` as the .ts files in the root and `**/*.ts` as .ts files in any directory, so a slashless glob is root-level only and the detector any-depth fallback hides rules that never fire.',
      ),
      cite(PAGES.cursorRules, 'supports', 'Says a rule with globs is auto-attached when a matching file is in context.'),
    ],
    lastVerified: VERIFIED,
  },

  // ── ai-config-copilot-instructions ──────────────────────────────────────────
  {
    id: 'ai-config-copilot-instructions/path-specific-files',
    detector: 'ai-config-copilot-instructions',
    title: 'Copilot path-specific instruction files',
    kind: 'tool-fact',
    claim:
      'Copilot reads path-specific instructions from `.md` files under `.github/instructions/` that scope themselves with an `applyTo` frontmatter glob, while `.github/copilot-instructions.md` is always on and has no `applyTo`.',
    appliesTo: ['copilot'],
    sources: [
      cite(
        PAGES.ghRepoInstructions,
        'contradicts',
        'Says a path-specific instructions file name must end with .instructions.md, whereas discovery audits every .md file under .github/instructions/.',
      ),
      cite(
        PAGES.ghRepoInstructions,
        'supports',
        'Says .github/copilot-instructions.md is repository-wide and automatically added to requests.',
      ),
      cite(
        PAGES.vscodeInstructionsRef,
        'supports',
        'Places targeted instructions at .github/instructions/**/*.instructions.md with an optional applyTo glob and says copilot-instructions.md needs no frontmatter.',
      ),
    ],
    lastVerified: VERIFIED,
  },
  {
    id: 'ai-config-copilot-instructions/apply-to-default',
    detector: 'ai-config-copilot-instructions',
    title: 'Copilot instructions without applyTo',
    kind: 'tool-fact',
    claim: 'A path-specific Copilot instructions file with no `applyTo` glob is applied to every request by default.',
    appliesTo: ['copilot'],
    sources: [
      cite(
        PAGES.vscodeInstructionsRef,
        'contradicts',
        'Says that in Local sessions a file omitting both description and applyTo is left available for manual attachment rather than automatic activation, and that applyTo has no default pattern.',
      ),
      cite(PAGES.ghRepoInstructions, 'context', 'Does not say what happens when applyTo is omitted.'),
      cite(PAGES.vscodeInstructions, 'context', 'Does not describe a file without applyTo.'),
    ],
    lastVerified: VERIFIED,
  },
  {
    id: 'ai-config-copilot-instructions/glob-semantics',
    detector: 'ai-config-copilot-instructions',
    title: 'Copilot applyTo glob matching',
    kind: 'tool-fact',
    claim: 'An `applyTo` glob such as `*.ts` without a slash matches files at any depth, and a glob that matches no file never applies.',
    appliesTo: ['copilot'],
    sources: [
      cite(
        PAGES.ghRepoInstructions,
        'contradicts',
        'Gives `*.py` as matching the .py files in the current directory only, and `**` or `**/*` as matching all files in all directories.',
      ),
      cite(
        PAGES.vscodeInstructionsRef,
        'contradicts',
        'Says patterns are relative to the project root and that `*.py` matches only root-level files.',
      ),
    ],
    lastVerified: VERIFIED,
  },

  // ── ai-config-windsurf-rules ────────────────────────────────────────────────
  {
    id: 'ai-config-windsurf-rules/legacy-always-on',
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
    detector: 'ai-config-windsurf-rules',
    title: 'Windsurf scoped rule files',
    kind: 'tool-fact',
    claim: 'Windsurf supports scoped rule files in `.windsurf/rules/*.md` that activate by glob, manually or by model decision.',
    appliesTo: ['windsurf'],
    sources: [
      cite(
        PAGES.windsurfRules,
        'supports',
        'Lists always_on, glob, model_decision and manual triggers for rule files with globs set in frontmatter, and says legacy .windsurf/rules/*.md files are still imported.',
      ),
    ],
    lastVerified: VERIFIED,
  },
  {
    id: 'ai-config-windsurf-rules/language-scoping',
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
    detector: 'skill-supply-chain',
    title: 'Code patterns typical of a malicious or fragile skill',
    kind: 'opinion',
    claim:
      'Piping fetched content into a shell or eval, decoding then executing a payload, reading credential stores next to network calls and installing unpinned remote dependencies are characteristic of a malicious or fragile skill.',
    appliesTo: ['claude-code', 'codex'],
    sources: [
      cite(
        PAGES.skillsOverview,
        'supports',
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
