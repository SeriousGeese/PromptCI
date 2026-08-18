/** Core data types for PromptCI */

export type FileType = 'claude' | 'agents' | 'cursor' | 'windsurf' | 'copilot' | 'readme' | 'docs' | 'prompt' | 'unknown';

export type IssueSeverity = 'info' | 'warning' | 'high' | 'critical';

export type IssueCategory =
  | 'duplicate'
  | 'conflict'
  | 'context_bloat'
  | 'missing_context'
  | 'stale_instruction'
  | 'vague_guidance'
  | 'structure'
  | 'command_validity'
  | 'agent_practices'
  | 'ai_config'
  | 'security';

export type InstructionSection = {
  id: string;
  filePath: string;
  heading?: string;
  startLine: number;
  endLine: number;
  text: string;
  normalizedText: string;
};

export type InstructionFile = {
  path: string;
  fileType: FileType;
  content: string;
  sections: InstructionSection[];
  lineCount: number;
  charCount: number;
  estimatedTokens: number;
};

export type PromptCiIssue = {
  id: string;
  severity: IssueSeverity;
  category: IssueCategory;
  title: string;
  summary: string;
  filePaths: string[];
  locations: Array<{ filePath: string; startLine?: number; endLine?: number }>;
  evidence: string[];
  recommendation: string;
  fixRecipe?: string;
  confidence: number;
  tags?: string[];
  impact?: 'high' | 'medium' | 'low';
};

export type TopFix = {
  title: string;
  reason: string;
  suggestedAction: string;
};

// Single source of truth: consumers that need to *validate* a project type at
// runtime (the CLI's config loader, `promptci init`) import this array rather
// than keeping their own copy, which is how `python`/`go`/`rust` previously
// ended up writable by `init` but rejected by `loadConfig`.
export const PROJECT_TYPES = [
  'auto',
  'typescript',
  'nextjs',
  'unity',
  'dotnet',
  'python',
  'go',
  'rust',
  'unknown',
] as const;

export type ProjectType = (typeof PROJECT_TYPES)[number];

export type ScanTrend = {
  previousScanDate?: string;
  scoreDelta: number;
  newIssuesCount: number;
  resolvedIssuesCount: number;
  severityDeltas: Record<string, number>;
  categoryDeltas: Record<string, number>;
  newIssueIds: string[];
  resolvedIssueIds: string[];
  streak: number;
};

export type ScanReport = {
  schemaVersion: '0.1';
  generatedAt: string;
  repoPath: string;
  projectType: ProjectType;
  healthScore: number;
  metrics?: ScanMetrics;
  filesScanned: InstructionFile[];
  issues: PromptCiIssue[];
  topFixes: TopFix[];
  newIssues?: PromptCiIssue[];
  baselinedIssues?: PromptCiIssue[];
  trend?: ScanTrend;
  /**
   * Issues silenced by inline `promptci-ignore` annotations.
   * Not counted in healthScore or topFixes.
   * Absent when there are no suppressions.
   */
  suppressedIssues?: PromptCiIssue[];
};

export type ScanMetrics = {
  estimatedInstructionTokens: number;
  instructionFileCount: number;
  largestInstructionFiles: Array<{
    path: string;
    estimatedTokens: number;
  }>;
};

/**
 * R1: report.json intentionally omits InstructionFile's `content` and
 * `sections` fields for each scanned file (they'd bloat the JSON with
 * duplicated file content). The old JSON serializer built this compact shape
 * ad hoc while still stamping `schemaVersion: '0.1'` (ScanReport's version),
 * so any consumer that parsed report.json and typed it as `ScanReport` got
 * `undefined` for `.filesScanned[i].content`/`.sections` despite TypeScript
 * saying those fields are required strings/arrays.
 *
 * This type names the ACTUAL compact shape `generateJsonReport` produces, so
 * consumers (the web dashboard, eval tooling) can import and use the type
 * that matches what's really on disk, instead of the full in-memory
 * `ScanReport`/`InstructionFile` types.
 */
export type CompactFileSummary = Pick<InstructionFile, 'path' | 'fileType' | 'lineCount' | 'charCount' | 'estimatedTokens'>;

export type ScanReportJson = Omit<ScanReport, 'filesScanned'> & {
  filesScanned: CompactFileSummary[];
};

export type BaselineEntry = {
  id: string;
  category: string;
  title: string;
  filePaths: string[];
  /**
   * Severity recorded when the issue was baselined.
   * If the current scan produces the same fingerprint but a higher severity,
   * the issue is treated as worsened (i.e. new).
   */
  severity: string;
  fingerprint: string;
};

export type Baseline = BaselineEntry[];

export type ScanInput = {
  repoPath: string;
  projectType?: ProjectType;
  include?: string[];
  exclude?: string[];
  baseline?: Baseline;
  contextBudget?: number;
  fileContextBudget?: number;
};
