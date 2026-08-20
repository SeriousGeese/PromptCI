import { detectAgentPractices } from './agent-practices.js';
import { detectCanonicalOwner } from './canonical-owner.js';
import { detectCiAlignment } from './ci-alignment.js';
import { detectCompetingTechConflicts, detectConflicts, detectVersionConflicts } from './conflicts.js';
import { detectCommandValidity } from './command-validity.js';
import { detectContextBloat } from './context-bloat.js';
import { detectDeadReferences } from './dead-references.js';
import { detectDuplicates, detectDuplicateHeadings } from './duplicates.js';
import { detectManifestConsistency } from './manifest-consistency.js';
import { detectMissingContext } from './missing-context.js';
import { detectStaleInstructions } from './stale-instructions.js';
import { detectVagueGuidance } from './vague-guidance.js';
import { detectSecurityPack } from './security-pack.js';
import { runFrameworkPacks } from './framework-packs.js';
import { detectPromptCacheFriendliness } from './prompt-cache.js';
import { detectSkills } from './skills-detector.js';
import { detectSubagents } from './subagents-detector.js';
import { detectHooksSettings } from './hooks-settings-detector.js';
import { detectMcpConfig } from './mcp-config-detector.js';
import { detectCursorRules } from './cursor-rules-detector.js';
import { detectCopilotInstructions } from './copilot-instructions-detector.js';
import { detectWindsurfRules } from './windsurf-detector.js';
import type { PromptCiIssue } from './types.js';
import type { RepoContext } from './repo-context.js';

export type DetectorDefinition = {
  id: string;
  run: (context: RepoContext) => PromptCiIssue[];
};

export const DETECTORS: DetectorDefinition[] = [
  {
    id: 'duplicates',
    run: (context) => detectDuplicates(context.files),
  },
  {
    id: 'duplicate-headings',
    run: (context) => detectDuplicateHeadings(context.files),
  },
  {
    id: 'conflicts',
    run: (context) => detectConflicts(context.files),
  },
  {
    id: 'version-conflicts',
    run: (context) => detectVersionConflicts(context.files),
  },
  {
    id: 'competing-tech-conflicts',
    run: (context) => detectCompetingTechConflicts(context.files),
  },
  {
    id: 'context-bloat',
    run: (context) => detectContextBloat(context.files, {
      totalWarning: context.contextBudget,
      totalHigh: context.contextBudget ? context.contextBudget * 2 : undefined,
      fileWarning: context.fileContextBudget,
      fileHigh: context.fileContextBudget ? context.fileContextBudget * 2.5 : undefined,
    }),
  },
  {
    id: 'stale-instructions',
    run: (context) => detectStaleInstructions(context.files),
  },
  {
    id: 'command-validity',
    run: (context) => detectCommandValidity(context),
  },
  {
    id: 'missing-context',
    run: (context) => detectMissingContext(context.files, context.projectType),
  },
  {
    id: 'manifest-consistency',
    run: (context) => detectManifestConsistency(context),
  },
  {
    id: 'vague-guidance',
    run: (context) =>
      detectVagueGuidance(context.files, { severityOverride: context.vagueGuidanceSeverity }),
  },
  {
    id: 'dead-references',
    run: (context) => detectDeadReferences(context.files, context.repoRoot),
  },
  {
    id: 'agent-practices',
    run: (context) => detectAgentPractices(context.files),
  },
  {
    id: 'canonical-owner',
    run: (context) => detectCanonicalOwner(context.files),
  },
  {
    id: 'ci-alignment',
    run: (context) => detectCiAlignment(context),
  },
  {
    id: 'security-pack',
    run: (context) => detectSecurityPack(context),
  },
  {
    id: 'framework-packs',
    run: (context) => runFrameworkPacks(context),
  },
  {
    id: 'prompt-cache-friendliness',
    run: (context) => detectPromptCacheFriendliness(context.files),
  },
  {
    id: 'ai-config-skills',
    run: (context) => detectSkills(context),
  },
  {
    id: 'ai-config-subagents',
    run: (context) => detectSubagents(context),
  },
  {
    id: 'ai-config-hooks-settings',
    run: (context) => detectHooksSettings(context),
  },
  {
    id: 'ai-config-mcp',
    run: (context) => detectMcpConfig(context),
  },
  {
    id: 'ai-config-cursor-rules',
    run: (context) => detectCursorRules(context),
  },
  {
    id: 'ai-config-copilot-instructions',
    run: (context) => detectCopilotInstructions(context),
  },
  {
    id: 'ai-config-windsurf-rules',
    run: (context) => detectWindsurfRules(context),
  },
];

export function runDetectors(context: RepoContext): PromptCiIssue[] {
  return DETECTORS.flatMap((detector) => detector.run(context));
}
