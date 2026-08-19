/**
 * Issue #62: skill/agent bodies are load-on-demand config surfaces. They are
 * audited structurally by the ai_config detectors and must NOT be fed to the
 * always-loaded prose/bloat detectors (duplicates, vague-guidance, context
 * bloat, ...) — otherwise a skill body double-flags against the same file and
 * inflates the always-loaded context totals.
 *
 * These are end-to-end assertions over the real scan() pipeline.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { scan } from '../src/scan.js';

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-ondemand-'));
  cleanups.push(dir);
  return dir;
}

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

// A distinctive block reused verbatim to bait the duplicate detector.
const DUPLICATED_BLOCK = [
  '## Coding Standards',
  '',
  'Prefer explicit, well-named functions over clever one-liners. Keep modules',
  'small and cohesive. Write a regression test for every bug fix, and never',
  'commit commented-out code or leftover debug logging to the main branch.',
].join('\n');

const PROSE_CATEGORIES = new Set([
  'duplicate',
  'vague_guidance',
  'context_bloat',
  'conflict',
  'stale_instruction',
  'missing_context',
  'agent_practices',
]);

function skillPathsInIssue(issue: {
  filePaths: string[];
  locations: Array<{ filePath: string }>;
}): string[] {
  const all = [...issue.filePaths, ...issue.locations.map((l) => l.filePath)];
  return all.filter((p) => p.replace(/\\/g, '/').includes('/.claude/skills/'));
}

describe('scan() — load-on-demand skill bodies', () => {
  it('does not feed skill bodies to the prose detectors, but still audits them via ai_config', async () => {
    const dir = makeRepo();

    // Two ALWAYS-LOADED files sharing the block — this is the control that
    // proves the duplicate detector is active in this scan.
    write(dir, 'CLAUDE.md', `# Project\n\n${DUPLICATED_BLOCK}\n`);
    write(dir, 'AGENTS.md', `# Agents\n\n${DUPLICATED_BLOCK}\n`);

    // A skill whose body ALSO contains the block (duplicate bait) and which has
    // no YAML frontmatter (an ai_config problem the skills detector must catch).
    write(dir, '.claude/skills/standards/SKILL.md', `# Standards skill\n\n${DUPLICATED_BLOCK}\n`);

    const report = await scan({ repoPath: dir });

    // Control: the duplicate detector fired on the two always-loaded files.
    const dupes = report.issues.filter((i) => i.category === 'duplicate');
    expect(dupes.length).toBeGreaterThan(0);

    // Core assertion: no prose/bloat finding references the skill body, even
    // though it carries the exact duplicated block.
    const proseHits = report.issues
      .filter((i) => PROSE_CATEGORIES.has(i.category))
      .flatMap(skillPathsInIssue);
    expect(proseHits).toEqual([]);

    // ai_config coverage is retained: the frontmatter-less skill is flagged.
    const aiConfigOnSkill = report.issues.filter(
      (i) => i.category === 'ai_config' && skillPathsInIssue(i).length > 0,
    );
    expect(aiConfigOnSkill.length).toBeGreaterThan(0);

    // The skill still appears in the inventory, typed as a skill...
    const skillEntry = report.filesScanned.find((f) =>
      f.path.replace(/\\/g, '/').includes('/.claude/skills/'),
    );
    expect(skillEntry?.fileType).toBe('skill');

    // ...and its tokens are reported separately, not folded into the
    // always-loaded instruction total.
    expect(report.metrics?.onDemandFileCount).toBeGreaterThan(0);
    expect(report.metrics?.estimatedOnDemandTokens).toBeGreaterThan(0);
  });

  it('excludes on-demand skill tokens from the always-loaded instruction total', async () => {
    const dir = makeRepo();
    write(dir, 'CLAUDE.md', '# Project\n\nRun `pnpm test` before you say a task is done.\n');

    const withoutSkill = await scan({ repoPath: dir });

    // Add a sizeable skill body; the always-loaded total must not move.
    write(
      dir,
      '.claude/skills/big/SKILL.md',
      ['---', 'name: big', 'description: A skill with a large on-demand body used on request', '---', '']
        .join('\n') + 'word '.repeat(2000),
    );

    const withSkill = await scan({ repoPath: dir });

    expect(withSkill.metrics?.estimatedInstructionTokens).toBe(
      withoutSkill.metrics?.estimatedInstructionTokens,
    );
    expect(withSkill.metrics?.estimatedOnDemandTokens ?? 0).toBeGreaterThan(0);
  });
});
