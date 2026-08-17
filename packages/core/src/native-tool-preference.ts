/**
 * Native tool preference detector for PromptCI.
 *
 * Checks whether Claude-targeted instruction files guide agents to prefer
 * Claude Code's built-in tools (Read, Grep, Glob) over equivalent Bash
 * commands (cat, grep, find).
 *
 * Why it matters:
 * - Built-in tools are faster (dedicated implementation, no subprocess overhead)
 * - They use fewer tokens — Glob returns compact path lists, Grep returns
 *   matched lines only, Read returns file content without shell noise
 * - They bypass the PreToolUse hook entirely, so no RTK rewrite is needed
 * - They respect Claude Code's permission model without separate Bash approval
 *
 * Only fires when Claude-targeted instruction files exist but contain no
 * guidance about preferring these tools.
 */

import * as path from 'node:path';
import type { InstructionFile, PromptCiIssue } from './types.js';

// Positive signals — guidance about preferring native/built-in tools already exists.
// Tool names (Read, Grep, Glob) are matched case-sensitively — they are always
// capitalized when referring to Claude Code built-ins, unlike shell commands.
const NATIVE_TOOL_SIGNALS = [
  /\bRead\s+tool\b/,
  /\bGrep\s+tool\b/,
  /\bGlob\s+tool\b/,
  /\b[Uu]se\s+Read\b/,
  /\b[Uu]se\s+Grep\b/,
  /\b[Uu]se\s+Glob\b/,
  /\b[Pp]refer\s+Read\b/,
  /\b[Pp]refer\s+Grep\b/,
  /\b[Pp]refer\s+Glob\b/,
  /\bdedicated\s+tools?\b.*\binstead\s+of\s+(cat|grep|find)\b/i,
  /\b(avoid|instead\s+of|not)\b.*\b(cat|grep|find)\b.*\b(Read|Grep|Glob)\b/,
  /\b(Read|Grep|Glob)\b.*\b(instead\s+of|not|avoid)\b.*\b(cat|grep|find)\b/i,
  /built[- ]in\s+tools?\s+(over|instead\s+of|not|vs\.?)\s+(bash|shell|cat|grep|find)/i,
];

function isClaudeFile(file: InstructionFile): boolean {
  const p = file.path.replace(/\\/g, '/').toLowerCase();
  const base = path.basename(file.path).toLowerCase();
  return (
    file.fileType === 'claude' ||
    base === 'claude.md' ||
    p.includes('/.claude/') ||
    base === 'claude.local.md'
  );
}

export function detectNativeToolPreference(files: InstructionFile[]): PromptCiIssue[] {
  const claudeFiles = files.filter(isClaudeFile);
  if (claudeFiles.length === 0) return [];

  const combinedClaudeContent = claudeFiles.map((f) => f.content).join('\n');
  const hasGuidance = NATIVE_TOOL_SIGNALS.some((pat) => pat.test(combinedClaudeContent));
  if (hasGuidance) return [];

  // Also check all instruction files — guidance in AGENTS.md counts if Claude reads it.
  const combinedAll = files.map((f) => f.content).join('\n');
  const hasGuidanceAnywhere = NATIVE_TOOL_SIGNALS.some((pat) => pat.test(combinedAll));
  if (hasGuidanceAnywhere) return [];

  return [
    {
      id: 'native-tool-preference-missing',
      severity: 'info',
      category: 'agent_practices',
      title: 'No guidance to prefer built-in tools over Bash equivalents (Claude Code)',
      summary:
        "Claude Code's built-in Read, Grep, and Glob tools are faster and more token-efficient " +
        'than their Bash equivalents (cat/head/tail, grep/rg, find). Instructions that explicitly ' +
        'prefer these tools reduce context noise and bypass the Bash permission prompt entirely. ' +
        'No such guidance was found in Claude-targeted instruction files.',
      filePaths: claudeFiles.map((f) => f.path),
      locations: [],
      evidence: [
        `No Read/Grep/Glob preference guidance found in: ${claudeFiles.map((f) => path.basename(f.path)).join(', ')}.`,
      ],
      recommendation:
        'Add a rule to Claude-targeted files instructing agents to prefer Read over cat/head/tail, ' +
        'Grep over grep/rg, and Glob over find when working with local files. Reserve Bash for ' +
        'operations that have no dedicated tool (e.g. git commands, running tests).',
      fixRecipe: [
        '## Tool Selection (Claude Code)',
        '',
        'Prefer dedicated tools over Bash for file operations — they are faster, more token-efficient,',
        'and bypass the Bash permission prompt:',
        '',
        '- **File search**: Use `Glob` (not `find` or `ls`)',
        '- **Content search**: Use `Grep` (not `grep` or `rg`)',
        '- **Read files**: Use `Read` (not `cat`/`head`/`tail`)',
        '',
        'Reserve Bash for operations without a dedicated tool: git commands, running builds/tests,',
        'package manager commands, and other shell-only operations.',
      ].join('\n'),
      confidence: 0.7,
      impact: 'medium',
    },
  ];
}
