import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { discoverAiConfigFiles } from '../src/ai-config.js';
import type { RepoContext } from '../src/repo-context.js';

/** Create an isolated temp repo directory for a detector test. */
export function makeTempRepo(prefix = 'promptci-aiconfig-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Write a file under `root`, creating parent directories as needed. */
export function writeFile(root: string, relativePath: string, content: string): void {
  const abs = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

/**
 * Minimal RepoContext — the ai_config detectors read `repoRoot` and the
 * pre-discovered `aiConfig` file lists. `policy` mirrors the scan's
 * include/exclude so tests can exercise scoping.
 */
export function ctx(repoRoot: string, policy?: { include?: string[]; exclude?: string[] }): RepoContext {
  return {
    repoRoot,
    files: [],
    projectType: 'unknown',
    manifests: {},
    packageJson: {
      packageManagerName: 'unknown',
      scripts: {},
      dependencies: {},
      devDependencies: {},
      peerDependencies: {},
      lockfiles: [],
    },
    workflows: { files: [], commands: [] },
    aiConfig: discoverAiConfigFiles(repoRoot, policy),
    metrics: {
      estimatedInstructionTokens: 0,
      instructionFileCount: 0,
      largestInstructionFiles: [],
    },
    onDemandFiles: [],
  };
}

/** Create a file symlink, or return false where the OS refuses (Windows without the privilege). */
export function trySymlink(target: string, linkPath: string): boolean {
  try {
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.symlinkSync(target, linkPath, 'file');
    return true;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') return false;
    throw err;
  }
}

function symlinksSupported(): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-symlink-probe-'));
  try {
    fs.writeFileSync(path.join(dir, 'target'), '');
    return trySymlink(path.join(dir, 'target'), path.join(dir, 'link'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** True where this OS lets the test process create file symlinks (CI on Linux; not default Windows). */
export const canSymlink = symlinksSupported();
