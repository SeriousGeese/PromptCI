import { detectAgentPractices } from './agent-practices.js';
import { detectCanonicalOwner } from './canonical-owner.js';
import { detectCiAlignment } from './ci-alignment.js';
import { detectProductBoundary } from './product-boundary.js';
import { detectCompetingTechConflicts, detectConflicts, detectVersionConflicts } from './conflicts.js';
import { detectCommandValidity } from './command-validity.js';
import { detectContextBloat } from './context-bloat.js';
import { detectContextCost } from './context-cost.js';
import { detectDeadReferences } from './dead-references.js';
import { detectDuplicates, detectDuplicateHeadings } from './duplicates.js';
import { detectManifestConsistency } from './manifest-consistency.js';
import { detectMissingContext } from './missing-context.js';
import { detectStaleInstructions } from './stale-instructions.js';
import { detectVagueGuidance } from './vague-guidance.js';
import { detectSecurityPack } from './security-pack.js';
import { runFrameworkPacks } from './framework-packs.js';
import { detectPromptCacheFriendliness } from './prompt-cache.js';
import { detectCheapModelRouting } from './cheap-model-routing.js';
import { detectOutputVerbosity } from './output-verbosity.js';
import { detectMcpTooling } from './mcp-detector.js';
import { detectCliOutputFilter } from './cli-output-filter.js';
import { detectNativeToolPreference } from './native-tool-preference.js';
import type { PromptCiIssue } from './types.js';
import type { RepoContext } from './repo-context.js';

export type DetectorGroup = 'scan' | 'context';

export type DetectorDefinition = {
  id: string;
  group: DetectorGroup;
  run: (context: RepoContext) => PromptCiIssue[];
};

export const DETECTORS: DetectorDefinition[] = [
  {
    id: 'duplicates',
    group: 'scan',
    run: (context) => detectDuplicates(context.files),
  },
  {
    id: 'duplicate-headings',
    group: 'scan',
    run: (context) => detectDuplicateHeadings(context.files),
  },
  {
    id: 'conflicts',
    group: 'scan',
    run: (context) => detectConflicts(context.files),
  },
  {
    id: 'version-conflicts',
    group: 'scan',
    run: (context) => detectVersionConflicts(context.files),
  },
  {
    id: 'competing-tech-conflicts',
    group: 'scan',
    run: (context) => detectCompetingTechConflicts(context.files),
  },
  {
    id: 'context-bloat',
    group: 'scan',
    run: (context) => detectContextBloat(context.files, {
      totalWarning: context.contextBudget,
      totalHigh: context.contextBudget ? context.contextBudget * 2 : undefined,
      fileWarning: context.fileContextBudget,
      fileHigh: context.fileContextBudget ? context.fileContextBudget * 2.5 : undefined,
    }),
  },
  {
    id: 'stale-instructions',
    group: 'scan',
    run: (context) => detectStaleInstructions(context.files),
  },
  {
    id: 'command-validity',
    group: 'scan',
    run: (context) => detectCommandValidity(context),
  },
  {
    id: 'missing-context',
    group: 'scan',
    run: (context) => detectMissingContext(context.files, context.projectType),
  },
  {
    id: 'manifest-consistency',
    group: 'scan',
    run: (context) => detectManifestConsistency(context),
  },
  {
    id: 'vague-guidance',
    group: 'scan',
    run: (context) => detectVagueGuidance(context.files),
  },
  {
    id: 'dead-references',
    group: 'scan',
    run: (context) => detectDeadReferences(context.files, context.repoRoot),
  },
  {
    id: 'agent-practices',
    group: 'scan',
    run: (context) => detectAgentPractices(context.files),
  },
  {
    id: 'canonical-owner',
    group: 'scan',
    run: (context) => detectCanonicalOwner(context.files),
  },
  {
    id: 'ci-alignment',
    group: 'scan',
    run: (context) => detectCiAlignment(context),
  },
  {
    id: 'product-boundary',
    group: 'scan',
    run: (context) => detectProductBoundary(context),
  },
  {
    id: 'security-pack',
    group: 'scan',
    run: (context) => detectSecurityPack(context),
  },
  {
    id: 'framework-packs',
    group: 'scan',
    run: (context) => runFrameworkPacks(context),
  },
  {
    id: 'prompt-cache-friendliness',
    group: 'scan',
    run: (context) => detectPromptCacheFriendliness(context.files),
  },
  {
    id: 'cheap-model-routing',
    group: 'scan',
    run: (context) => detectCheapModelRouting(context),
  },
  {
    id: 'output-verbosity',
    group: 'scan',
    run: (context) => detectOutputVerbosity(context.files),
  },
  {
    id: 'mcp-tooling',
    group: 'scan',
    run: (context) => detectMcpTooling(context),
  },
  {
    id: 'cli-output-filter',
    group: 'scan',
    run: (context) => detectCliOutputFilter(context),
  },
  {
    id: 'native-tool-preference',
    group: 'scan',
    run: (context) => detectNativeToolPreference(context.files),
  },
  {
    id: 'context-cost',
    group: 'context',
    run: detectContextCost,
  },
];

export function runDetectors(context: RepoContext, group: DetectorGroup): PromptCiIssue[] {
  return DETECTORS
    .filter((detector) => detector.group === group)
    .flatMap((detector) => detector.run(context));
}
