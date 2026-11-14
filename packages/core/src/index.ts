/** Root export for @promptci/core */
export * from './types.js';
export { scanFiles, scanFilesWithAliases, parseSections } from './scanner.js';
export type { ScanFilesResult } from './scanner.js';
export { detectProjectType, detectProjectTypeFromContent } from './project-type.js';
export { detectDuplicates, detectDuplicateHeadings, normalizeSection } from './duplicates.js';
export { detectConflicts, detectVersionConflicts, detectCompetingTechConflicts } from './conflicts.js';
export { detectDeadReferences } from './dead-references.js';
export { detectAgentPractices, MISSING_PRACTICES_ISSUE_ID } from './agent-practices.js';
export { parseSuppressions, buildValidationIssues, applySuppressions } from './suppression.js';
export type { SuppressionAnnotation } from './suppression.js';
export { computeHealthScore, selectTopFixes, isScored, UNSCORED_TAG } from './health-score.js';
export { generateMarkdownReport, generateJsonReport, writeReport, readHistoryIndex, archiveExistingReport, historyIndexPath, scoreLabel } from './report.js';
export type { WriteReportOptions, HistoryEntry } from './report.js';
export { generateSarifReport } from './sarif.js';
export { detectManifestConsistency } from './manifest-consistency.js';
export { detectDependencyStaleness } from './dependency-staleness.js';
export type { ManifestData } from './manifest-consistency.js';
export { buildRepoContext, parsePackageJsonFacts } from './repo-context.js';
export type { RepoContext, PackageJsonFacts, WorkflowFacts, WorkflowCommand, WorkflowSource } from './repo-context.js';
export type { MakefileFacts } from './makefile.js';
export { detectActionPinning, extractActionUses } from './action-pinning.js';export { runDetectors } from './detectors.js';
export type { DetectorDefinition } from './detectors.js';
export { detectSkills } from './skills-detector.js';
export { detectSkillSupplyChain } from './skill-supply-chain.js';
export type { SkillSupplyChainRule } from './skill-supply-chain.js';
export { detectSubagents } from './subagents-detector.js';
export { detectHooksSettings } from './hooks-settings-detector.js';
export { detectMcpConfig } from './mcp-config-detector.js';
export { detectCursorRules } from './cursor-rules-detector.js';
export { detectCopilotInstructions } from './copilot-instructions-detector.js';
export { detectWindsurfRules } from './windsurf-detector.js';
export { detectNegativeInstructionOverload } from './negative-instructions.js';
export { detectBuriedCriticalInstructions } from './buried-critical.js';
export { detectWithinSectionDedup } from './within-section-dedup.js';
export { parseFrontmatter, discoverAiConfigFiles, emptyAiConfigFiles } from './ai-config.js';
export type { Frontmatter, FrontmatterValue, AiConfigFiles } from './ai-config.js';
export { analyzeContext } from './context-analysis.js';
export type { ContextAnalysis } from './context-analysis.js';
export { scan } from './scan.js';
export { ADDRESSABLE_CATEGORIES, estimateTokens, annotateIssueTokens, computeAddressableTokens } from './token-estimates.js';
export { computeFingerprint, createBaseline, filterNewIssues, assertValidBaseline } from './baseline.js';
export { applyFixRecipe, resolveSafePath, isRepairable, isOptInRecipe, planMirrorImport } from './fix-engine.js';
export type { MirrorImportPlan } from './fix-engine.js';
export {
  closestUniqueMatch,
  isMechanicalRename,
  damerauLevenshtein,
  CLOSE_MATCH_MAX_DISTANCE,
  CLOSE_MATCH_MIN_LENGTH,
  MECHANICAL_TWO_EDIT_MIN_LENGTH,
  MECHANICAL_SEGMENT_MIN_LENGTH,
} from './close-match.js';
export type { FileChange } from './fix-engine.js';
export { isWithinRoot, resolveWithinRoot, realPathWithinRoot, resolveReadableWithinRoot, writeTargetWithinRoot } from './path-containment.js';
// pcic-csf: a consumer needs only to BUILD a `knownPaths` list and hand it to
// `scan()` — `KnownPaths` names its shape and `normalizeKnownPath` is the same
// normalization the scan applies, so a caller can canonicalize and de-duplicate
// its own list first. `RepoTree`, `PathInventory` and their types stay internal:
// they are how the scan answers existence questions, not API anyone outside
// calls, and exporting them would freeze that shape. Tests import them from
// `../src/...` directly.
export { normalizeKnownPath } from './known-paths.js';
export type { KnownPaths } from './known-paths.js';
export { optimizeContext } from './context-optimizer.js';
export type { OptimizeOptions, OptimizeResult } from './context-optimizer.js';
export {
  TARGET_MODELS,
  MODEL_BUDGETS_REVIEW_BY,
  resolveTargetModel,
  modelBudget,
  budgetForTargetModel,
} from './model-budgets.js';
export type { TargetModel, ModelBudget } from './model-budgets.js';
export {
  loadCustomRules,
  parseCustomRules,
  runCustomRules,
  CustomRulesError,
  CUSTOM_RULE_TYPES,
  CUSTOM_RULES_FILE,
} from './custom-rules.js';
export type { CustomRule, CustomRuleType } from './custom-rules.js';


export {
  PROMPTCI_GITIGNORE_LINES,
  PROMPTCI_GITIGNORE_BLOCK,
  renderPromptCiGitignore,
} from './promptci-gitignore.js';

export { selectScanPaths } from './discovery.js';
export type { ScanPathEntry, SelectScanPathsOptions, SelectScanPathsResult } from './discovery.js';

// pcic-kvv3.1: provenance of every check family (kind, claim, sources, appliesTo, lastVerified).
export * from './provenance/index.js';
