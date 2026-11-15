import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectSubagents } from '../src/subagents-detector.js';
import { detectSkills } from '../src/skills-detector.js';
import { detectHooksSettings } from '../src/hooks-settings-detector.js';
import { detectMcpConfig } from '../src/mcp-config-detector.js';
import type { PromptCiIssue } from '../src/types.js';
import { ctx } from './ai-config-helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '../../..');
const CLEAN = path.join(REPO_ROOT, 'examples/fixture-ai-config-vendor-docs');
const HINTS = path.join(REPO_ROOT, 'examples/fixture-ai-config-vendor-docs-hints');

function all(root: string): PromptCiIssue[] {
  const c = ctx(root);
  return [...detectSubagents(c), ...detectSkills(c), ...detectHooksSettings(c), ...detectMcpConfig(c)];
}

describe('ai-config vendor-docs fixtures (issues #176, #177, #191-#196)', () => {
  it('stays clean on configuration the Claude Code docs describe as valid', () => {
    // fable model, Agent(...)/Task(...)/Skill/LSP/... tools, nested hooks/mcpServers/experimental/metadata,
    // an unknown skill key, an exec-form hook with an unquoted placeholder, and url-only and typed MCP entries.
    expect(all(CLEAN).map((i) => `${i.id} ${i.title}`)).toEqual([]);
  });

  it('still reports what remains a finding or a hint', () => {
    const titles = all(HINTS).map((i) => i.title).sort();
    expect(titles).toEqual([
      'MCP server has neither a command nor a url',
      'Hook uses an unquoted $CLAUDE_PROJECT_DIR path',
      'Skill `description` is too short to trigger reliably',
      'Skill `name` does not match its directory',
      'Skill is missing YAML frontmatter',
      'Subagent grants tools that may not exist',
      'Subagent references an unrecognized model',
    ].sort());
  });

  it('reports the skill hints at info severity and unscored', () => {
    const skills = all(HINTS).filter((i) => i.id.startsWith('ai-config-skill-'));
    expect(skills.length).toBe(3);
    for (const issue of skills) {
      expect(issue.severity).toBe('info');
      expect(issue.tags).toContain('unscored');
    }
  });
});
