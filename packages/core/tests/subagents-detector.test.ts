import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { detectSubagents } from '../src/subagents-detector.js';
import { makeTempRepo, writeFile, ctx } from './ai-config-helpers.js';

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function repo(): string {
  const dir = makeTempRepo();
  cleanups.push(dir);
  return dir;
}

function agent(name: string, front: string[], body: string): string {
  return ['---', ...front, '---', body].join('\n');
}

describe('detectSubagents', () => {
  it('is silent with no agents', () => {
    expect(detectSubagents(ctx(repo()))).toEqual([]);
  });

  it('accepts a well-formed agent', () => {
    const dir = repo();
    writeFile(dir, '.claude/agents/reviewer.md',
      agent('reviewer', ['name: reviewer', 'description: Reviews diffs for bugs', 'model: opus', 'tools: Read, Grep, Bash'],
        'You are a careful code reviewer. Do the review thoroughly and report findings.'));
    expect(detectSubagents(ctx(dir))).toEqual([]);
  });

  it('flags missing name/description', () => {
    const dir = repo();
    writeFile(dir, '.claude/agents/x.md', agent('x', ['foo: bar'], 'body body body body body'));
    const issues = detectSubagents(ctx(dir));
    expect(issues.some((i) => i.title.includes('missing `name`'))).toBe(true);
    expect(issues.some((i) => i.title.includes('missing `description`'))).toBe(true);
  });

  it('flags an unrecognized model but accepts claude-* ids', () => {
    const dir = repo();
    writeFile(dir, '.claude/agents/a.md',
      agent('a', ['name: a', 'description: does a thing', 'model: gpt-5'], 'body text here for the agent'));
    writeFile(dir, '.claude/agents/b.md',
      agent('b', ['name: b', 'description: does b thing', 'model: claude-opus-4-8'], 'different body text for agent b'));
    const issues = detectSubagents(ctx(dir));
    const model = issues.filter((i) => i.title.includes('unrecognized model'));
    expect(model.length).toBe(1);
    expect(model[0]!.evidence.join(' ')).toContain('gpt-5');
  });

  it('flags unknown tool names at info severity but accepts mcp__ tools', () => {
    const dir = repo();
    writeFile(dir, '.claude/agents/a.md',
      agent('a', ['name: a', 'description: does a thing', 'tools: Read, Bananas, mcp__foo__bar'], 'body text here for the agent'));
    const issues = detectSubagents(ctx(dir));
    const t = issues.find((i) => i.title.includes('tools that may not exist'));
    expect(t).toBeDefined();
    expect(t!.severity).toBe('info');
    // The "Unrecognized:" line lists only the offending tools — mcp__ tools pass.
    const unrecognized = t!.evidence.find((e) => e.startsWith('Unrecognized:'))!;
    expect(unrecognized).toContain('Bananas');
    expect(unrecognized).not.toContain('mcp__foo__bar');
  });

  it('flags two agents with near-identical system prompts', () => {
    const dir = repo();
    const sharedBody = [
      'You are a specialized agent.',
      'Always read files before editing them.',
      'Report your findings clearly and concisely.',
      'Never fabricate results.',
      'Prefer small, focused changes.',
      'Ask before doing anything destructive.',
    ].join('\n');
    writeFile(dir, '.claude/agents/one.md', agent('one', ['name: one', 'description: agent one'], sharedBody));
    writeFile(dir, '.claude/agents/two.md', agent('two', ['name: two', 'description: agent two'], sharedBody));
    const issues = detectSubagents(ctx(dir));
    const dup = issues.find((i) => i.title.includes('near-identical system prompts'));
    expect(dup).toBeDefined();
    expect(dup!.filePaths.length).toBe(2);
  });

  it('does not flag distinct agents as duplicates', () => {
    const dir = repo();
    writeFile(dir, '.claude/agents/one.md',
      agent('one', ['name: one', 'description: agent one'], 'Completely unique instructions about databases and migrations only.'));
    writeFile(dir, '.claude/agents/two.md',
      agent('two', ['name: two', 'description: agent two'], 'Totally different guidance about frontend styling and accessibility work.'));
    const issues = detectSubagents(ctx(dir));
    expect(issues.some((i) => i.title.includes('near-identical'))).toBe(false);
  });

  it('accepts every model value the subagents docs list, plus claude-* ids', () => {
    const dir = repo();
    for (const model of ['sonnet', 'opus', 'haiku', 'fable', 'inherit', 'Fable', 'claude-opus-5-5']) {
      writeFile(dir, `.claude/agents/m-${model.toLowerCase()}.md`,
        agent('m', [`name: m-${model.toLowerCase()}`, 'description: does a thing', `model: ${model}`], `unique body for ${model}`));
    }
    expect(detectSubagents(ctx(dir)).filter((i) => i.title.includes('unrecognized model'))).toEqual([]);
  });

  it('flags model values the docs do not list for subagents (default, opusplan)', () => {
    const dir = repo();
    for (const model of ['default', 'opusplan']) {
      writeFile(dir, `.claude/agents/${model}.md`,
        agent(model, [`name: ${model}`, 'description: does a thing', `model: ${model}`], `unique body for ${model}`));
    }
    const flagged = detectSubagents(ctx(dir)).filter((i) => i.title.includes('unrecognized model'));
    expect(flagged.length).toBe(2);
  });

  it('accepts current, parenthesised and legacy tool names', () => {
    const dir = repo();
    writeFile(dir, '.claude/agents/a.md',
      agent('a', [
        'name: a',
        'description: does a thing',
        'tools: Agent(worker, researcher), Task(reviewer), Skill, LSP, PowerShell, Monitor, ToolSearch, TaskStop, SendMessage, Bash(git *), LS, MultiEdit, mcp__github__*, *',
      ], 'body text here for the agent'));
    expect(detectSubagents(ctx(dir)).filter((i) => i.title.includes('tools that may not exist'))).toEqual([]);
  });

  it('still flags a name that is not a tool even when parenthesised', () => {
    const dir = repo();
    writeFile(dir, '.claude/agents/a.md',
      agent('a', ['name: a', 'description: does a thing', 'tools: Read, Bananas(x)'], 'body text here for the agent'));
    const t = detectSubagents(ctx(dir)).find((i) => i.title.includes('tools that may not exist'));
    expect(t?.evidence.join(' ')).toContain('Bananas(x)');
  });

  it('does not report documented nested maps (hooks, mcpServers, experimental)', () => {
    const dir = repo();
    writeFile(dir, '.claude/agents/a.md', [
      '---',
      'name: a',
      'description: does a thing',
      'hooks:',
      '  PreToolUse:',
      '    - matcher: "Bash"',
      '      hooks:',
      '        - type: command',
      '          command: "./scripts/validate.sh"',
      'mcpServers:',
      '  - slack',
      '  - playwright:',
      '      type: stdio',
      '      command: npx',
      'experimental:',
      '  cacheTtl: 1h',
      '---',
      'body text here for the agent',
    ].join('\n'));
    expect(detectSubagents(ctx(dir))).toEqual([]);
  });

  it('still reports a duplicate frontmatter key', () => {
    const dir = repo();
    writeFile(dir, '.claude/agents/a.md', agent('a', ['name: a', 'name: b', 'description: does a thing'], 'body text here for the agent'));
    expect(detectSubagents(ctx(dir)).some((i) => i.title.includes('structural problem') || i.summary.includes('Duplicate'))).toBe(true);
  });
});
