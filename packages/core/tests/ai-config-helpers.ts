import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

/** Minimal RepoContext — the ai_config detectors only read `repoRoot`. */
export function ctx(repoRoot: string): RepoContext {
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
    metrics: {
      estimatedInstructionTokens: 0,
      instructionFileCount: 0,
      largestInstructionFiles: [],
    },
  };
}
