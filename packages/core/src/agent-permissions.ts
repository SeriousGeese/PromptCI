/**
 * Agent permissions (pcic-k1t3.10): committed agent config that turns off the
 * prompts an agent shows before it runs a command.
 *
 * A project-level config file is shared with everyone who opens the repository,
 * so a setting in it decides how every teammate's agent behaves there, not only
 * the author's. Two shapes are checked, each as its vendor documents it:
 *
 *  - Claude Code `.claude/settings.json` (the shared project file; the personal
 *    `.claude/settings.local.json` is not read): `permissions.defaultMode` set to
 *    `bypassPermissions`, which skips permission prompts, and a
 *    `permissions.allow` rule of `Bash` or `Bash(*)`, which matches every
 *    shell command so none of them asks first.
 *  - Codex `.codex/config.toml` (read for trusted projects): top-level
 *    `approval_policy = "never"` together with `sandbox_mode =
 *    "danger-full-access"`, so commands run without approval and without the
 *    sandbox. Either one alone is an ordinary non-interactive or local setup and
 *    is not reported.
 *
 * Not checked, on purpose: the same flags written in instruction prose
 * (`--dangerously-skip-permissions`), because in instruction files they mostly
 * document how a tool launches agents rather than direct this one (a corpus
 * read on 2026-11-25 found few directives among about a hundred mentions); and
 * Gemini CLI, whose YOLO mode can only be enabled on the command line.
 *
 * Findings are `security` warnings with cautious wording: an isolated
 * container is a legitimate reason for any of these. Deterministic and offline;
 * the TOML read is a line walk of the top-level table.
 */

import * as path from 'node:path';
import type { RepoContext } from './repo-context.js';
import type { PromptCiIssue } from './types.js';
import { lineOf, shortHash } from './ai-config.js';
import { treeFor } from './repo-tree.js';

const CLAUDE_SETTINGS = '.claude/settings.json';
const CODEX_CONFIG = '.codex/config.toml';
const MAX_CONFIG_BYTES = 1_000_000;

/**
 * True for a `permissions.allow` rule that matches every shell command, as the Claude Code
 * permissions docs define the syntax: `Bash` and `Bash(*)` match all Bash commands; a `*`
 * matches any text, so a specifier of only `*` characters (`Bash(**)`) matches any command;
 * and `:*` is an equivalent trailing wildcard, so `Bash(:*)` is a wildcard with nothing
 * before it. Spaces inside the parentheses are part of the rule (the docs say the space
 * before a trailing `*` is), so `Bash( * )` is not read as allow-all. An unanchored `*`
 * allow rule is skipped by Claude Code and not reported.
 */
export function allowsEveryShellCommand(rule: string): boolean {
  const m = /^Bash(?:\((.*)\))?$/s.exec(rule.trim());
  if (!m) return false;
  const spec = m[1];
  return spec === undefined || /^\*+$/.test(spec) || spec === ':*';
}

function finding(
  repoRoot: string,
  rel: string,
  kind: string,
  line: number,
  fields: { title: string; summary: string; evidence: string[]; recommendation: string },
): PromptCiIssue {
  const abs = path.resolve(repoRoot, rel);
  return {
    id: `agent-permissions-${kind}-${shortHash(rel)}`,
    severity: 'warning',
    category: 'security',
    title: fields.title,
    summary: fields.summary,
    filePaths: [abs],
    locations: [{ filePath: abs, startLine: line, endLine: line }],
    evidence: fields.evidence,
    recommendation: fields.recommendation,
    confidence: 0.85,
    tags: ['agent-permissions', kind],
  };
}

function claudeIssues(repoRoot: string, raw: string): PromptCiIssue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^\u{FEFF}/u, ''));
  } catch {
    return []; // ai-config-hooks-settings reports invalid JSON
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
  const permissions = (parsed as Record<string, unknown>).permissions;
  if (typeof permissions !== 'object' || permissions === null || Array.isArray(permissions)) return [];
  const { defaultMode, allow } = permissions as Record<string, unknown>;
  const issues: PromptCiIssue[] = [];
  if (defaultMode === 'bypassPermissions') {
    issues.push(
      finding(repoRoot, CLAUDE_SETTINGS, 'claude-bypass-mode', lineOf(raw, 'bypassPermissions'), {
        title: 'Shared Claude Code settings skip permission prompts',
        summary:
          `${CLAUDE_SETTINGS} sets permissions.defaultMode to bypassPermissions. This file is shared with everyone who opens the repository, ` +
          'and in that mode Claude Code runs commands and edits files without asking first.',
        evidence: ['"defaultMode": "bypassPermissions"'],
        recommendation:
          'Consider moving the setting to .claude/settings.local.json (personal, not committed) or to a container-only config, and keep the shared ' +
          'file on a prompting mode with narrow allow rules for the commands the project needs.',
      }),
    );
  }
  const broad = Array.isArray(allow) ? allow.filter((rule): rule is string => typeof rule === 'string' && allowsEveryShellCommand(rule)) : [];
  if (broad.length > 0) {
    issues.push(
      finding(repoRoot, CLAUDE_SETTINGS, 'claude-allow-all-shell', lineOf(raw, `"${broad[0]!}"`), {
        title: 'Shared Claude Code settings allow every shell command',
        summary:
          `${CLAUDE_SETTINGS} allows ${broad.map((r) => `\`${r}\``).join(' and ')}, which matches every Bash command, so no shell command asks ` +
          'for approval, destructive ones included, for everyone who opens the repository.',
        evidence: broad.map((rule) => `"allow": [... "${rule}" ...]`),
        recommendation:
          'Consider replacing it with rules for the commands the project needs (`Bash(npm run test *)`, `Bash(git diff *)`), and add deny rules for ' +
          'destructive commands.',
      }),
    );
  }
  return issues;
}

/** A top-level `key = "value"` of a TOML file: before the first table header, comments stripped. */
function topLevelTomlStrings(raw: string): Map<string, { value: string; line: number }> {
  const values = new Map<string, { value: string; line: number }>();
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.startsWith('[')) break; // first table: the rest is not top level
    const m = /^([A-Za-z0-9_-]{1,64})[ \t]*=[ \t]*(?:"([^"\n]{0,200})"|'([^'\n]{0,200})')/.exec(line);
    if (m && !values.has(m[1]!)) values.set(m[1]!, { value: (m[2] ?? m[3])!, line: i + 1 });
  }
  return values;
}

function codexIssues(repoRoot: string, raw: string): PromptCiIssue[] {
  const values = topLevelTomlStrings(raw);
  const approval = values.get('approval_policy');
  const sandbox = values.get('sandbox_mode');
  if (approval?.value !== 'never' || sandbox?.value !== 'danger-full-access') return [];
  return [
    finding(repoRoot, CODEX_CONFIG, 'codex-no-approval-no-sandbox', approval.line, {
      title: 'Project Codex config runs commands without approval or sandbox',
      summary:
        `${CODEX_CONFIG} sets approval_policy = "never" and sandbox_mode = "danger-full-access". Codex reads this file for everyone who ` +
        'trusts the project, and with both set it runs every command unprompted with full filesystem and network access.',
      evidence: [`approval_policy = "never" (line ${approval.line})`, `sandbox_mode = "danger-full-access" (line ${sandbox.line})`],
      recommendation:
        'Consider keeping one safeguard in the shared file (`sandbox_mode = "workspace-write"`, or an interactive approval policy) and setting ' +
        'full access in a personal profile or a container-only config.',
    }),
  ];
}

export function detectAgentPermissions(context: RepoContext): PromptCiIssue[] {
  const tree = treeFor(context);
  const issues: PromptCiIssue[] = [];
  const claude = tree.readText(CLAUDE_SETTINGS, { maxBytes: MAX_CONFIG_BYTES });
  if (claude.state === 'found') issues.push(...claudeIssues(context.repoRoot, claude.content));
  const codex = tree.readText(CODEX_CONFIG, { maxBytes: MAX_CONFIG_BYTES });
  if (codex.state === 'found') issues.push(...codexIssues(context.repoRoot, codex.content));
  return issues;
}
