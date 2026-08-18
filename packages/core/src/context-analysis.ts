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
  // `promptci context` reports what the instruction context costs, so it takes
  // the context_bloat findings out of the one detector set. This used to be a
  // DetectorGroup enum whose 'context' group had exactly one member — a
  // registry-level mechanism standing in for a category filter.
  const issues = runDetectors(context).filter((issue) => issue.category === 'context_bloat');

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
