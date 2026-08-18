import { buildRepoContext } from './repo-context.js';
import { DETECTORS } from './detectors.js';
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
  // `promptci context` reports what the instruction context costs to carry:
  // exactly the context-bloat detector, pulled from the registry so its
  // threshold wiring (contextBudget overrides) stays defined in one place.
  //
  // Not a category filter over runDetectors(): prompt-cache and security-pack
  // also emit category 'context_bloat', so filtering the full set would widen
  // this command's output beyond size/cost facts — and running every detector
  // (dead-references' filesystem sweeps included) is the full scan this
  // command exists to be cheaper than. This replaced the DetectorGroup enum,
  // whose 'context' group had exactly this one member.
  const contextBloat = DETECTORS.find((detector) => detector.id === 'context-bloat');
  const issues = contextBloat ? contextBloat.run(context) : [];

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
