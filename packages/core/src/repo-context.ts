import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { resolveWithinRoot as safeResolveWithinRoot } from './ai-config.js';
import { detectProjectType, detectProjectTypeFromContent } from './project-type.js';
import { scanFiles } from './scanner.js';
import type { ManifestData } from './manifest-consistency.js';
import type { InstructionFile, ProjectType, ScanInput, ScanMetrics } from './types.js';

export type PackageManagerName = 'pnpm' | 'npm' | 'yarn' | 'bun' | 'unknown';

export type PackageJsonFacts = {
  raw?: string;
  packageManager?: string;
  packageManagerName: PackageManagerName;
  enginesNode?: string;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  lockfiles: string[];
};

export type WorkflowCommand = {
  filePath: string;
  command: string;
  line: number;
};

export type WorkflowFacts = {
  files: string[];
  commands: WorkflowCommand[];
};

export type RepoContext = {
  repoRoot: string;
  files: InstructionFile[];
  projectType: ProjectType;
  manifests: ManifestData;
  packageJson: PackageJsonFacts;
  workflows: WorkflowFacts;
  metrics: ScanMetrics;
  contextBudget?: number;
  fileContextBudget?: number;
};

const LOCKFILES = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
];

function emptyPackageJsonFacts(): PackageJsonFacts {
  return {
    packageManagerName: 'unknown',
    scripts: {},
    dependencies: {},
    devDependencies: {},
    peerDependencies: {},
    lockfiles: [],
  };
}

// Throwing wrapper over the shared null-returning guard in ai-config.ts — one
// implementation of the path-traversal check, two failure styles.
function resolveWithinRoot(repoRoot: string, relativePath: string): string {
  const resolved = safeResolveWithinRoot(repoRoot, relativePath);
  if (resolved === null) {
    throw new Error(`Path escapes repo root: ${relativePath}`);
  }
  return resolved;
}

async function readRootFile(repoRoot: string, relativePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(resolveWithinRoot(repoRoot, relativePath), 'utf-8');
  } catch {
    return undefined;
  }
}

async function existingRootFiles(repoRoot: string, relativePaths: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const rel of relativePaths) {
    try {
      const stat = await fs.stat(resolveWithinRoot(repoRoot, rel));
      if (stat.isFile()) found.push(rel);
    } catch {
      // absent file
    }
  }
  return found;
}

function packageManagerFromString(packageManager: string | undefined): PackageManagerName {
  if (!packageManager) return 'unknown';
  if (packageManager.startsWith('pnpm@')) return 'pnpm';
  if (packageManager.startsWith('npm@')) return 'npm';
  if (packageManager.startsWith('yarn@')) return 'yarn';
  if (packageManager.startsWith('bun@')) return 'bun';
  return 'unknown';
}

function packageManagerFromLockfiles(lockfiles: string[]): PackageManagerName {
  if (lockfiles.includes('pnpm-lock.yaml')) return 'pnpm';
  if (lockfiles.includes('package-lock.json')) return 'npm';
  if (lockfiles.includes('yarn.lock')) return 'yarn';
  if (lockfiles.some((f) => f.startsWith('bun.lock'))) return 'bun';
  return 'unknown';
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(value)) {
    if (typeof v === 'string') out[key] = v;
  }
  return out;
}

export function parsePackageJsonFacts(raw: string | undefined, lockfiles: string[]): PackageJsonFacts {
  const facts = emptyPackageJsonFacts();
  facts.raw = raw;
  facts.lockfiles = lockfiles;

  if (!raw) {
    facts.packageManagerName = packageManagerFromLockfiles(lockfiles);
    return facts;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    facts.packageManagerName = packageManagerFromLockfiles(lockfiles);
    return facts;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    facts.packageManagerName = packageManagerFromLockfiles(lockfiles);
    return facts;
  }

  const obj = parsed as Record<string, unknown>;
  facts.packageManager = typeof obj.packageManager === 'string' ? obj.packageManager : undefined;
  facts.packageManagerName =
    packageManagerFromString(facts.packageManager) !== 'unknown'
      ? packageManagerFromString(facts.packageManager)
      : packageManagerFromLockfiles(lockfiles);
  facts.scripts = stringRecord(obj.scripts);
  facts.dependencies = stringRecord(obj.dependencies);
  facts.devDependencies = stringRecord(obj.devDependencies);
  facts.peerDependencies = stringRecord(obj.peerDependencies);

  if (typeof obj.engines === 'object' && obj.engines !== null && !Array.isArray(obj.engines)) {
    const engines = obj.engines as Record<string, unknown>;
    facts.enginesNode = typeof engines.node === 'string' ? engines.node : undefined;
  }

  return facts;
}

function extractWorkflowCommands(filePath: string, content: string): WorkflowCommand[] {
  const lines = content.split(/\r?\n/);
  const commands: WorkflowCommand[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const match = /^(\s*)(?:-\s*)?run:\s*(.*)$/.exec(line);
    if (!match) continue;

    const indent = match[1]!.length;
    const rest = match[2]!.trim();
    if (rest && !/^[|>][+-]?$/.test(rest)) {
      commands.push({ filePath, command: rest, line: i + 1 });
      continue;
    }

    const block: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]!;
      if (next.trim() === '') {
        block.push('');
        continue;
      }
      const nextIndent = next.match(/^\s*/)?.[0].length ?? 0;
      if (nextIndent <= indent) break;
      block.push(next.trim());
    }
    const command = block.filter(Boolean).join('\n').trim();
    if (command) commands.push({ filePath, command, line: i + 1 });
  }

  return commands;
}

async function readWorkflowFacts(repoRoot: string): Promise<WorkflowFacts> {
  const workflowDir = resolveWithinRoot(repoRoot, path.join('.github', 'workflows'));
  let entries: Array<{ name: string; isFile: () => boolean }>;
  try {
    entries = await fs.readdir(workflowDir, { withFileTypes: true });
  } catch {
    return { files: [], commands: [] };
  }

  const files = entries
    .filter((entry) => entry.isFile() && /\.(ya?ml)$/i.test(entry.name))
    .map((entry) => path.join(workflowDir, entry.name))
    .sort();
  const commands: WorkflowCommand[] = [];
  for (const file of files) {
    const relative = path.relative(repoRoot, file);
    const content = await fs.readFile(file, 'utf-8');
    commands.push(...extractWorkflowCommands(relative, content));
  }

  return {
    files: files.map((file) => path.relative(repoRoot, file)),
    commands,
  };
}

function buildMetrics(files: InstructionFile[]): ScanMetrics {
  return {
    estimatedInstructionTokens: files.reduce((sum, file) => sum + file.estimatedTokens, 0),
    instructionFileCount: files.length,
    largestInstructionFiles: [...files]
      .sort((a, b) => b.estimatedTokens - a.estimatedTokens)
      .slice(0, 5)
      .map((file) => ({ path: file.path, estimatedTokens: file.estimatedTokens })),
  };
}

export async function buildRepoContext(input: ScanInput): Promise<RepoContext> {
  const repoRoot = path.resolve(input.repoPath);
  const files = await scanFiles({ ...input, repoPath: repoRoot });

  let projectType =
    input.projectType && input.projectType !== 'auto'
      ? input.projectType
      : await detectProjectType(repoRoot);

  if (projectType === 'unknown') {
    projectType = detectProjectTypeFromContent(files);
  }

  const [packageJson, pyproject, lockfiles, workflows] = await Promise.all([
    readRootFile(repoRoot, 'package.json'),
    readRootFile(repoRoot, 'pyproject.toml'),
    existingRootFiles(repoRoot, LOCKFILES),
    readWorkflowFacts(repoRoot),
  ]);

  const manifests: ManifestData = {};
  if (packageJson) manifests.packageJson = packageJson;
  if (pyproject) manifests.pyproject = pyproject;

  return {
    repoRoot,
    files,
    projectType,
    manifests,
    packageJson: parsePackageJsonFacts(packageJson, lockfiles),
    workflows,
    metrics: buildMetrics(files),
    contextBudget: input.contextBudget,
    fileContextBudget: input.fileContextBudget,
  };
}
