import { buildRepoContext } from './repo-context.js';
import { runDetectors } from './detectors.js';
import type { PromptCiIssue, ScanInput, ScanMetrics } from './types.js';
import type { PackageJsonFacts, WorkflowFacts } from './repo-context.js';

export type ContextAnalysis = {
  generatedAt: string;
  repoPath: string;
  metrics: ScanMetrics;
  packageJson: Pick<PackageJsonFacts, 'packageManagerName' | 'packageManager' | 'enginesNode' | 'lockfiles'> & {
    scriptNames: string[];
    dependencyCount: number;
  };
  workflows: WorkflowFacts;
  issues: PromptCiIssue[];
};

export async function analyzeContext(input: ScanInput): Promise<ContextAnalysis> {
  const context = await buildRepoContext(input);
  const issues = runDetectors(context, 'context');

  return {
    generatedAt: new Date().toISOString(),
    repoPath: context.repoRoot,
    metrics: context.metrics,
    packageJson: {
      packageManagerName: context.packageJson.packageManagerName,
      packageManager: context.packageJson.packageManager,
      enginesNode: context.packageJson.enginesNode,
      lockfiles: context.packageJson.lockfiles,
      scriptNames: Object.keys(context.packageJson.scripts).sort(),
      dependencyCount:
        Object.keys(context.packageJson.dependencies).length +
        Object.keys(context.packageJson.devDependencies).length +
        Object.keys(context.packageJson.peerDependencies).length,
    },
    workflows: context.workflows,
    issues,
  };
}
