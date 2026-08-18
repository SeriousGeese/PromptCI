/** Root export for @promptci/core */
export * from './types.js';
export { scanFiles, parseSections } from './scanner.js';
export { detectProjectType, detectProjectTypeFromContent } from './project-type.js';
export { detectDuplicates, detectDuplicateHeadings, normalizeSection } from './duplicates.js';
export { detectConflicts, detectVersionConflicts, detectCompetingTechConflicts } from './conflicts.js';
export { detectDeadReferences } from './dead-references.js';
export { detectAgentPractices } from './agent-practices.js';
export { parseSuppressions, buildValidationIssues, applySuppressions } from './suppression.js';
export type { SuppressionAnnotation } from './suppression.js';
export { computeHealthScore, selectTopFixes } from './health-score.js';
export { generateMarkdownReport, generateJsonReport, writeReport, readHistoryIndex, archiveExistingReport, historyIndexPath, scoreLabel } from './report.js';
export type { WriteReportOptions, HistoryEntry } from './report.js';
export { detectManifestConsistency } from './manifest-consistency.js';
export type { ManifestData } from './manifest-consistency.js';
export { buildRepoContext, parsePackageJsonFacts } from './repo-context.js';
export type { RepoContext, PackageJsonFacts, WorkflowFacts, WorkflowCommand } from './repo-context.js';
export { runDetectors } from './detectors.js';
export type { DetectorDefinition } from './detectors.js';
export { detectSkills } from './skills-detector.js';
export { detectSubagents } from './subagents-detector.js';
export { detectHooksSettings } from './hooks-settings-detector.js';
export { detectMcpConfig } from './mcp-config-detector.js';
export { detectCursorRules } from './cursor-rules-detector.js';
export { parseFrontmatter, discoverAiConfigFiles, emptyAiConfigFiles } from './ai-config.js';
export type { Frontmatter, FrontmatterValue, AiConfigFiles } from './ai-config.js';
export { analyzeContext } from './context-analysis.js';
export type { ContextAnalysis } from './context-analysis.js';
export { scan } from './scan.js';
export { computeFingerprint, createBaseline, filterNewIssues, assertValidBaseline } from './baseline.js';
export { applyFixRecipe, resolveSafePath } from './fix-engine.js';
export type { FileChange } from './fix-engine.js';
export { callLlm } from './llm.js';
export { optimizeContext } from './context-optimizer.js';
export type { OptimizeOptions, OptimizeResult } from './context-optimizer.js';


export {
  PROMPTCI_GITIGNORE_LINES,
  PROMPTCI_GITIGNORE_BLOCK,
  renderPromptCiGitignore,
} from './promptci-gitignore.js';
