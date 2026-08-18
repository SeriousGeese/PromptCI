/**
 * Regression tests for ai_config file discovery policy.
 *
 * The detectors used to discover their files themselves via listFiles(),
 * ignoring ScanInput.include/exclude and the scanner's size/binary guards — so
 * `--exclude '.claude/templates/**'` silenced the markdown detectors while the
 * ai_config detectors kept flagging the excluded files. Discovery now happens
 * in buildRepoContext with the same policy the markdown scanner applies.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { discoverAiConfigFiles } from '../src/ai-config.js';
import { buildRepoContext } from '../src/repo-context.js';
import { detectSkills } from '../src/skills-detector.js';
import { detectMcpConfig } from '../src/mcp-config-detector.js';
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

/** A SKILL.md with no frontmatter — always produces a finding when scanned. */
function writeBrokenSkill(dir: string, rel = '.claude/skills/pdf/SKILL.md'): void {
  writeFile(dir, rel, '# no frontmatter');
}

describe('discoverAiConfigFiles', () => {
  it('discovers each surface with default policy', () => {
    const dir = repo();
    writeBrokenSkill(dir);
    writeFile(dir, '.claude/agents/reviewer.md', 'body');
    writeFile(dir, '.claude/settings.json', '{}');
    writeFile(dir, '.mcp.json', '{}');
    writeFile(dir, '.cursor/rules/style.mdc', 'body');
    expect(discoverAiConfigFiles(dir)).toEqual({
      skills: ['.claude/skills/pdf/SKILL.md'],
      agents: ['.claude/agents/reviewer.md'],
      settings: ['.claude/settings.json'],
      mcp: ['.mcp.json'],
      cursorRules: ['.cursor/rules/style.mdc'],
    });
  });

  it('honors exclude patterns', () => {
    const dir = repo();
    writeBrokenSkill(dir, '.claude/templates/pdf/SKILL.md');
    writeBrokenSkill(dir, '.claude/skills/real/SKILL.md');
    const files = discoverAiConfigFiles(dir, { exclude: ['.claude/templates/**'] });
    expect(files.skills).toEqual(['.claude/skills/real/SKILL.md']);
  });

  it('treats an explicit include list as the scan scope', () => {
    const dir = repo();
    writeBrokenSkill(dir);
    writeFile(dir, '.mcp.json', 'not json');
    const files = discoverAiConfigFiles(dir, { include: ['.claude/**'] });
    expect(files.skills).toEqual(['.claude/skills/pdf/SKILL.md']);
    expect(files.mcp).toEqual([]);
  });

  it('skips files larger than the scanner size cap', () => {
    const dir = repo();
    writeFile(dir, '.claude/skills/pdf/SKILL.md', 'x'.repeat(500 * 1024 + 1));
    expect(discoverAiConfigFiles(dir).skills).toEqual([]);
  });

  it('skips binary files', () => {
    const dir = repo();
    writeFile(dir, '.claude/skills/pdf/SKILL.md', String.fromCharCode(0) + 'binary');
    expect(discoverAiConfigFiles(dir).skills).toEqual([]);
  });
});

describe('detectors honor the discovery policy', () => {
  it('an excluded skill file produces no ai_config findings', () => {
    const dir = repo();
    writeBrokenSkill(dir, '.claude/templates/pdf/SKILL.md');
    expect(detectSkills(ctx(dir)).length).toBeGreaterThan(0);
    expect(detectSkills(ctx(dir, { exclude: ['.claude/templates/**'] }))).toEqual([]);
  });

  it('an excluded .mcp.json produces no ai_config findings', () => {
    const dir = repo();
    writeFile(dir, '.mcp.json', 'not json');
    expect(detectMcpConfig(ctx(dir)).length).toBeGreaterThan(0);
    expect(detectMcpConfig(ctx(dir, { exclude: ['.mcp.json'] }))).toEqual([]);
  });
});

describe('buildRepoContext', () => {
  it('exposes aiConfig facts honoring ScanInput.exclude', async () => {
    const dir = repo();
    writeBrokenSkill(dir, '.claude/templates/pdf/SKILL.md');
    writeBrokenSkill(dir, '.claude/skills/real/SKILL.md');
    const context = await buildRepoContext({
      repoPath: dir,
      exclude: ['.claude/templates/**'],
    });
    expect(context.aiConfig.skills).toEqual(['.claude/skills/real/SKILL.md']);
  });
});
