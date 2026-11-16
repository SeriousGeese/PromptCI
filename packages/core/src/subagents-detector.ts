/**
 * Subagents Detector (issue #23)
 *
 * Audits subagent definitions (`.claude/agents/*.md`) against known Claude Code
 * conventions and against each other:
 *
 *  - Frontmatter validity: present, closed, required `name`/`description`.
 *    Nested maps (`hooks`, `mcpServers`, `experimental`) are documented
 *    subagent frontmatter and are never reported.
 *  - Unknown `model`: not one of the values the subagents docs list (sonnet,
 *    opus, haiku, fable, inherit, a full model id).
 *  - Unknown `tools`: names that are not tools the Claude Code tools reference
 *    lists, a legacy name, or an `mcp__*` tool (a likely typo). Reported at low
 *    confidence — the tool set evolves.
 *  - Duplicated system prompts: two agents whose bodies are near-identical,
 *    which usually means a copy-paste that should be one agent.
 *
 * Deterministic and offline; findings are cautiously worded.
 */

import * as path from 'node:path';
import type { RepoContext } from './repo-context.js';
import type { PromptCiIssue } from './types.js';
import {
  parseFrontmatter,
  readTextWithinRoot,
  shortHash,
  asStringList,
  toPosix,
  withScannerPaths,
  aiConfigIssue as base,
  frontmatterStructureIssues,
} from './ai-config.js';
import type { FrontmatterSurface } from './ai-config.js';

const SURFACE: FrontmatterSurface = {
  idPrefix: 'agent',
  noun: 'Subagent',
  why: 'A subagent needs `name` and `description` frontmatter to be registered.',
  recommendation: 'Add frontmatter with `name` and `description` at the top of the agent file.',
};

/**
 * Values accepted for `model`. The subagents page lists `sonnet`, `opus`, `haiku`, `fable`,
 * `inherit` and "a full model ID ... a value the `--model` flag accepts", so `default` and
 * `opusplan` (also `--model` values) pass silently.
 */
const KNOWN_MODEL_ALIASES = new Set(['sonnet', 'opus', 'haiku', 'fable', 'inherit', 'default', 'opusplan']);

/** A `--model` style id: `claude-*` (also Vertex `claude-…@date`), Bedrock `[us.]anthropic.claude-…` or an ARN. */
const PROVIDER_MODEL_ID_RE = /^(?:claude-|(?:[a-z]{2,4}\.)?anthropic\.claude-|arn:aws[\w-]*:bedrock:)/i;

/** Drops a context-window suffix such as `[1m]` (`opus[1m]`, `claude-opus-5-5[1m]`). */
function stripModelSuffix(model: string): string {
  return model.replace(/\[[^\]]*\]$/, '');
}

function isKnownModel(model: string): boolean {
  const base = stripModelSuffix(model.trim());
  return KNOWN_MODEL_ALIASES.has(base.toLowerCase()) || PROVIDER_MODEL_ID_RE.test(base);
}

/**
 * Tool names the Claude Code tools reference lists (code.claude.com/docs/en/tools-reference).
 * `mcp__*` tools and `*` also pass, and a parenthesised entry such as `Agent(worker)` or
 * `Bash(git *)` is checked by its base name.
 */
const CURRENT_TOOLS = [
  'Agent', 'Artifact', 'AskUserQuestion', 'Bash', 'CronCreate', 'CronDelete', 'CronList', 'Edit',
  'EndConversation', 'EnterPlanMode', 'EnterWorktree', 'ExitPlanMode', 'ExitWorktree', 'Glob', 'Grep',
  'ListAgents', 'ListMcpResourcesTool', 'LSP', 'Monitor', 'NotebookEdit', 'PowerShell', 'PushNotification',
  'Read', 'ReadMcpResourceTool', 'RemoteTrigger', 'ReportFindings', 'ScheduleWakeup', 'SendFeedback',
  'SendMessage', 'SendUserFile', 'ShareOnboardingGuide', 'Skill', 'SubagentHandback', 'TaskCreate',
  'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop', 'TaskUpdate', 'TodoWrite', 'ToolSearch',
  'WaitForMcpServers', 'WebFetch', 'WebSearch', 'Workflow', 'Write',
];

/**
 * Names older Claude Code releases used. `Task` is documented as a still-working alias of `Agent`;
 * the rest no longer have a row in the tools reference but exist in real configs, so they are
 * accepted silently rather than reported as typos.
 */
const LEGACY_TOOLS = [
  'Task', 'BashOutput', 'KillBash', 'KillShell', 'LS', 'MultiEdit', 'NotebookRead', 'SlashCommand',
];

const KNOWN_TOOLS: ReadonlySet<string> = new Set([...CURRENT_TOOLS, ...LEGACY_TOOLS]);

/** `Agent(worker, researcher)` -> `Agent`: a parenthesised specifier does not change which tool is named. */
function toolBaseName(entry: string): string {
  const paren = entry.indexOf('(');
  return (paren > 0 ? entry.slice(0, paren) : entry).trim();
}

/** The parser's error for a nested mapping, e.g. `Nested frontmatter key "hooks" ...`. */
function isNestedKeyError(error: string): boolean {
  return error.startsWith('Nested frontmatter key');
}

/** Jaccard similarity at or above this over normalized body lines flags a near-duplicate. */
const DUP_SIMILARITY = 0.8;
/** Ignore trivially-short agent bodies when comparing for duplication. */
const MIN_BODY_LINES = 5;

type ParsedAgent = {
  filePath: string;
  bodyLines: Set<string>;
};

function id(kind: string, key: string): string {
  return `ai-config-agent-${kind}-${shortHash(key)}`;
}

function normalizeBodyLines(body: string): Set<string> {
  const set = new Set<string>();
  for (const raw of body.split(/\r?\n/)) {
    const norm = raw.trim().toLowerCase().replace(/\s+/g, ' ');
    if (norm.length >= 8) set.add(norm);
  }
  return set;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of small) if (large.has(item)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function detectSubagents(context: RepoContext): PromptCiIssue[] {
  const issues: PromptCiIssue[] = [];
  const parsed: ParsedAgent[] = [];

  for (const filePath of context.aiConfig.agents) {
    const content = readTextWithinRoot(context.repoRoot, filePath);
    if (content === undefined) continue;

    const parsedFm = parseFrontmatter(content);
    // `hooks`, `mcpServers` and `experimental` are documented nested maps in subagent
    // frontmatter, so the parser's "nested key" errors are not findings here.
    const fm = { ...parsedFm, errors: parsedFm.errors.filter((e) => !isNestedKeyError(e)) };

    issues.push(...frontmatterStructureIssues(filePath, content, fm, SURFACE));
    if (!fm.present) continue;

    const name = typeof fm.data.name === 'string' ? fm.data.name.trim() : undefined;
    const description = typeof fm.data.description === 'string' ? fm.data.description.trim() : undefined;

    if (!name) {
      issues.push(base({
        id: id('missing-name', filePath),
        title: 'Subagent frontmatter is missing `name`',
        summary: `${filePath} has no \`name\` field, so it cannot be invoked by name.`,
        filePaths: [filePath],
        locations: [{ filePath, startLine: 1, endLine: fm.fenceEndLine > 0 ? fm.fenceEndLine : 1 }],
        evidence: [`Keys present: ${Object.keys(fm.data).join(', ') || '(none)'}`],
        recommendation: 'Add a `name` field to the frontmatter.',
        confidence: 0.85,
      }));
    }

    if (!description) {
      issues.push(base({
        id: id('missing-description', filePath),
        title: 'Subagent frontmatter is missing `description`',
        summary: `${filePath} has no \`description\`. The description tells the orchestrator when to delegate to this agent.`,
        filePaths: [filePath],
        locations: [{ filePath, startLine: 1, endLine: fm.fenceEndLine > 0 ? fm.fenceEndLine : 1 }],
        evidence: [`Keys present: ${Object.keys(fm.data).join(', ') || '(none)'}`],
        recommendation: 'Add a `description` explaining what the agent is for and when to use it.',
        confidence: 0.85,
      }));
    }

    // Unknown model alias.
    const model = typeof fm.data.model === 'string' ? fm.data.model.trim() : undefined;
    if (model && !isKnownModel(model)) {
      issues.push(base({
        severity: 'info',
        id: id('unknown-model', `${filePath}|${model}`),
        title: 'Subagent references an unrecognized model',
        summary: `${filePath}: \`model: ${model}\` is not an alias the Claude Code subagents docs list (sonnet, opus, haiku, fable, inherit) or a model id this check recognises (\`claude-*\`, Bedrock or Vertex ids), so it may be a typo.`,
        filePaths: [filePath],
        locations: [{ filePath, startLine: fm.keyLines.model ?? 1, endLine: fm.keyLines.model ?? 1 }],
        evidence: [`model: ${model}`],
        recommendation: 'If this is not an intended custom model id, use sonnet, opus, haiku, fable, inherit or a full model id, or remove `model` to use the default subagent model order.',
        confidence: 0.4,
      }));
    }

    // Unknown tools (likely typos).
    const tools = asStringList(fm.data.tools);
    const unknownTools = tools.filter(
      (t) => t !== '*' && !t.startsWith('mcp__') && !KNOWN_TOOLS.has(toolBaseName(t)),
    );
    if (unknownTools.length > 0) {
      issues.push(base({
        id: id('unknown-tools', `${filePath}|${unknownTools.join(',')}`),
        severity: 'info',
        title: 'Subagent grants tools that may not exist',
        summary: `${filePath} lists ${unknownTools.length} tool name(s) that are not tools Claude Code documents or \`mcp__*\` tools: ${unknownTools.join(', ')}.`,
        filePaths: [filePath],
        locations: [{ filePath, startLine: fm.keyLines.tools ?? 1, endLine: fm.keyLines.tools ?? 1 }],
        evidence: [`Unrecognized: ${unknownTools.join(', ')}`, `Declared tools: ${tools.join(', ')}`],
        recommendation: 'Check the tool names against the Claude Code tools reference (or your MCP server tool names) for typos.',
        confidence: 0.4,
      }));
    }

    const body = content.split(/\r?\n/).slice(Math.max(0, fm.bodyStartLine - 1)).join('\n');
    const bodyLines = normalizeBodyLines(body);
    parsed.push({ filePath, bodyLines });
  }

  // Duplicated system-prompt content across agents.
  const comparable = parsed.filter((a) => a.bodyLines.size >= MIN_BODY_LINES);
  for (let i = 0; i < comparable.length; i++) {
    for (let j = i + 1; j < comparable.length; j++) {
      const a = comparable[i]!;
      const b = comparable[j]!;
      const sim = jaccard(a.bodyLines, b.bodyLines);
      if (sim >= DUP_SIMILARITY) {
        const pair = [a.filePath, b.filePath].sort();
        issues.push(base({
          id: id('dup-prompt', pair.join('|')),
          title: 'Two subagents share near-identical system prompts',
          summary: `${toPosix(path.basename(pair[0]!))} and ${toPosix(path.basename(pair[1]!))} have ${Math.round(sim * 100)}% identical prompt bodies, which usually means a copy-paste that should be consolidated.`,
          filePaths: pair,
          locations: pair.map((p) => ({ filePath: p, startLine: 1, endLine: 1 })),
          evidence: [`Body similarity: ${Math.round(sim * 100)}%`, `Agents: ${pair.join(', ')}`],
          recommendation: 'Differentiate the agents\' instructions, or merge them into one agent if they do the same job.',
          confidence: sim === 1 ? 0.8 : 0.55,
        }));
      }
    }
  }

  // Scanner-form paths so inline suppressions can match (see withScannerPaths).
  return withScannerPaths(context.repoRoot, issues);
}
