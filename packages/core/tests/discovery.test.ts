/**
 * selectScanPaths (pcic-zg3): a pure, filesystem-free discovery API a server
 * with only a GitHub tree listing can use to decide what a real scan would
 * read, without a checkout. These tests prove it agrees with a real scan of
 * the same files on disk, for the `examples/` fixtures that exercise each
 * discovery surface (plain instruction files, `.clinerules`, skills,
 * workflows/composite actions, manifests read for resolution).
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

const here = path.dirname(fileURLToPath(import.meta.url));
const examplesRoot = path.resolve(here, '../../../examples');

/** Every file under `root`, as sorted repo-relative POSIX paths (skips `.git`). */
function listRepoFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push(path.relative(root, abs).replace(/\\/g, '/'));
    }
  };
  walk(root);
  return out.sort();
}

/** Ground truth for the instruction-file class: scanner.ts's own glob match. */
async function realInstructionFiles(root: string, include?: string[]): Promise<Set<string>> {
  const { files, aliases } = await scanFilesWithAliases({ repoPath: root, ...(include ? { include } : {}) });
  return new Set([...files, ...aliases].map((f) => f.relativePath!));
}

/** Ground truth for the skill-file class: ai-config.ts's own discovery. */
function realSkillFiles(root: string): Set<string> {
  const aiConfig = discoverAiConfigFiles(root);
  return new Set([...(aiConfig.allSkills ?? []), ...(aiConfig.skillFiles ?? [])]);
}

/** Ground truth for the workflow/composite-action class: repo-context.ts's own reads. */
async function realWorkflowFiles(root: string): Promise<Set<string>> {
  const context = await buildRepoContext({ repoPath: root });
  return new Set((context.workflows.sources ?? []).map((s) => s.filePath));
}

describe('selectScanPaths vs. a real scan', () => {
  const fixtures = [
    'fixture-basic',
    'fixture-clean',
    'fixture-agent-formats',
    'fixture-monorepo-scripts',
    'fixture-custom-rules',
    'fixture-skill-supply-chain',
  ];

  for (const name of fixtures) {
    it(`matches scanner/ai-config/repo-context discovery for ${name}`, async () => {
      const root = path.join(examplesRoot, name);
      const paths = listRepoFiles(root);
      const result = selectScanPaths(paths);

      expect(new Set(result.instructionFiles)).toEqual(await realInstructionFiles(root));
      expect(new Set(result.skillFiles)).toEqual(realSkillFiles(root));
      expect(new Set(result.workflowFiles)).toEqual(await realWorkflowFiles(root));
    });
  }

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

  it('separates root package.json (context) from skill files (fixture-skill-supply-chain)', () => {
    const root = path.join(examplesRoot, 'fixture-skill-supply-chain');
    const result = selectScanPaths(listRepoFiles(root));
    expect(result.skillFiles).toContain('.claude/skills/deploy-helper/SKILL.md');
    expect(result.skillFiles).toContain('.claude/skills/deploy-helper/scripts/setup.sh');
    expect(result.skillFiles).toContain('.claude/skills/pdf-forms/package.json');
    expect(result.contextFiles).not.toContain('.claude/skills/pdf-forms/package.json');
  });
});

describe('selectScanPaths: config-driven extra patterns', () => {
  const cleanups: string[] = [];
  afterEach(() => {
    for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('honours an `include` override the same way ScanInput.include does (docs/** opt-in)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-discovery-'));
    cleanups.push(root);
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# agents');
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'guide.md'), '# guide');

    const patterns = ['docs/**/*.md'];
    const paths = listRepoFiles(root);
    const result = selectScanPaths(paths, { patterns });

    // `include` REPLACES the default patterns on a real scan (scanner.ts), so
    // AGENTS.md drops out and only the opted-in docs/ file is discovered.
    expect(result.instructionFiles).toEqual(['docs/guide.md']);
    expect(new Set(result.instructionFiles)).toEqual(await realInstructionFiles(root, patterns));
  });
});

describe('selectScanPaths: determinism', () => {
  it('returns every class sorted', () => {
    const root = path.join(examplesRoot, 'fixture-skill-supply-chain');
    const result = selectScanPaths(listRepoFiles(root));
    for (const key of ['instructionFiles', 'skillFiles', 'workflowFiles', 'contextFiles'] as const) {
      const list = result[key];
      expect(list).toEqual([...list].sort());
    }
  });

  it('accepts entries with sizes without changing the result', () => {
    const root = path.join(examplesRoot, 'fixture-basic');
    const plain = selectScanPaths(listRepoFiles(root));
    const withSizes = selectScanPaths(listRepoFiles(root).map((p) => ({ path: p, size: 10 })));
    expect(withSizes).toEqual(plain);
  });
});
