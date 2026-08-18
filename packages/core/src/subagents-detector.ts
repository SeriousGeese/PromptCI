/**
 * Subagents Detector (issue #23)
 *
 * Audits subagent definitions (`.claude/agents/*.md`) against known Claude Code
 * conventions and against each other:
 *
 *  - Frontmatter validity: present, closed, required `name`/`description`.
 *  - Unknown `model`: not a recognized Claude alias or `claude-*` id.
 *  - Unknown `tools`: names that are not built-in tools or `mcp__*` tools
 *    (a likely typo). Reported at low confidence — the tool set evolves.
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
  listFiles,
  shortHash,
  asStringList,
  toPosix,
  withScannerPaths,
} from './ai-config.js';

const AGENT_GLOBS = ['.claude/agents/**/*.md'];

/** Recognized model aliases accepted in agent frontmatter. Full `claude-*` ids also pass. */
const KNOWN_MODEL_ALIASES = new Set(['sonnet', 'opus', 'haiku', 'inherit', 'default', 'opusplan']);

/** Built-in Claude Code tool names an agent may grant. `mcp__*` tools also pass. */
const KNOWN_TOOLS = new Set([
  'Task', 'Bash', 'BashOutput', 'KillBash', 'KillShell', 'Glob', 'Grep', 'LS',
  'Read', 'Edit', 'MultiEdit', 'Write', 'NotebookRead', 'NotebookEdit',
  'WebFetch', 'WebSearch', 'TodoWrite', 'SlashCommand', 'ExitPlanMode', 'Agent',
]);

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

function base(issue: Omit<PromptCiIssue, 'severity' | 'category' | 'confidence'> &
  Partial<Pick<PromptCiIssue, 'severity' | 'category' | 'confidence'>>): PromptCiIssue {
  return {
    severity: 'warning',
    category: 'ai_config',
    confidence: 0.8,
    ...issue,
  };
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
  const agentFiles = listFiles(context.repoRoot, AGENT_GLOBS);
  const parsed: ParsedAgent[] = [];

  for (const filePath of agentFiles) {
    const content = readTextWithinRoot(context.repoRoot, filePath);
    if (content === undefined) continue;

    const fm = parseFrontmatter(content);

    if (!fm.present) {
      issues.push(base({
        id: id('no-frontmatter', filePath),
        severity: 'high',
        title: 'Subagent is missing YAML frontmatter',
        summary: `${filePath} has no \`---\` frontmatter block. A subagent needs \`name\` and \`description\` frontmatter to be registered.`,
        filePaths: [filePath],
        locations: [{ filePath, startLine: 1, endLine: 1 }],
        evidence: [`First line: ${content.split(/\r?\n/)[0]?.slice(0, 60) ?? '(empty)'}`],
        recommendation: 'Add frontmatter with `name` and `description` at the top of the agent file.',
        confidence: 0.85,
      }));
      continue;
    }

    if (!fm.closed) {
      issues.push(base({
        id: id('unterminated', filePath),
        severity: 'high',
        title: 'Subagent frontmatter is not closed',
        summary: `${filePath} opens a \`---\` frontmatter block that is never closed.`,
        filePaths: [filePath],
        locations: [{ filePath, startLine: 1, endLine: 1 }],
        evidence: ['Opening `---` on line 1 has no closing `---`.'],
        recommendation: 'Close the frontmatter block with a `---` line.',
        confidence: 0.9,
      }));
    }

    for (const err of fm.errors) {
      issues.push(base({
        id: id('fm-error', `${filePath}|${err}`),
        title: 'Subagent frontmatter has a structural problem',
        summary: `${filePath}: ${err}.`,
        filePaths: [filePath],
        locations: [{ filePath, startLine: 1, endLine: fm.fenceEndLine > 0 ? fm.fenceEndLine : 1 }],
        evidence: [err],
        recommendation: 'Fix the frontmatter so it is valid YAML with flat, unique keys.',
        confidence: 0.7,
      }));
    }

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
    if (model && !KNOWN_MODEL_ALIASES.has(model.toLowerCase()) && !/^claude-/i.test(model)) {
      issues.push(base({
        id: id('unknown-model', `${filePath}|${model}`),
        title: 'Subagent references an unrecognized model',
        summary: `${filePath}: \`model: ${model}\` is not a known alias (sonnet, opus, haiku, inherit) or a \`claude-*\` id.`,
        filePaths: [filePath],
        locations: [{ filePath, startLine: fm.keyLines.model ?? 1, endLine: fm.keyLines.model ?? 1 }],
        evidence: [`model: ${model}`],
        recommendation: 'Use a supported model alias or a full model id, or remove `model` to inherit the session model.',
        confidence: 0.5,
      }));
    }

    // Unknown tools (likely typos).
    const tools = asStringList(fm.data.tools);
    const unknownTools = tools.filter(
      (t) => t !== '*' && !t.startsWith('mcp__') && !KNOWN_TOOLS.has(t),
    );
    if (unknownTools.length > 0) {
      issues.push(base({
        id: id('unknown-tools', `${filePath}|${unknownTools.join(',')}`),
        severity: 'info',
        title: 'Subagent grants tools that may not exist',
        summary: `${filePath} lists ${unknownTools.length} tool name(s) that are not built-in tools or \`mcp__*\` tools: ${unknownTools.join(', ')}.`,
        filePaths: [filePath],
        locations: [{ filePath, startLine: fm.keyLines.tools ?? 1, endLine: fm.keyLines.tools ?? 1 }],
        evidence: [`Unrecognized: ${unknownTools.join(', ')}`, `Declared tools: ${tools.join(', ')}`],
        recommendation: 'Check the tool names against the built-in tool set (or your MCP server tool names) for typos.',
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
