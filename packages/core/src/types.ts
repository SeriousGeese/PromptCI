/** Core data types for PromptCI */

// 'skill' and 'agent' are load-on-demand Claude Code config surfaces
// (`.claude/skills/**`, `.claude/agents/**`). They are audited structurally by
// the ai_config detectors, so they are deliberately excluded from the always-
// loaded prose/bloat detectors — see isOnDemandFileType and buildRepoContext.
//
// 'gemini' (Gemini CLI's GEMINI.md), 'cline' (Cline's `.clinerules` file or
// `.clinerules/` rule directory) and 'persona' (repo-root SOUL.md, USER.md,
// TOOLS.md) are always-loaded instruction prose, handled like 'claude'.
export type FileType =
  | 'claude'
  | 'agents'
  | 'cursor'
  | 'windsurf'
  | 'copilot'
  | 'gemini'
  | 'cline'
  | 'persona'
  | 'readme'
  | 'docs'
  | 'prompt'
  | 'skill'
  | 'agent'
  | 'unknown';

/**
 * Persistent, always-loaded agent instruction file types: the allowlist the
 * prose detectors (negative-instruction overload, buried-critical, within-
 * section dedup, prompt-cache friendliness) target. `context optimize` uses it
 * minus 'persona', which it never rewrites.
 *
 * One shared definition on purpose (BUG-19): each detector used to carry its
 * own copy, so a newly discovered file type was scanned and counted toward
 * context cost but silently skipped by every copy nobody remembered to update.
 * README/docs are human-facing and deliberately excluded.
 */
export const INSTRUCTION_FILE_TYPES: ReadonlySet<FileType> = new Set<FileType>([
  'claude',
  'agents',
  'cursor',
  'windsurf',
  'copilot',
  'gemini',
  'cline',
  'persona',
  'prompt',
]);

/**
 * On-demand file types are loaded by an agent only when a skill/subagent is
 * invoked, not on every turn. They do not count toward always-loaded context
 * cost and are owned by the ai_config detectors, so the generic prose detectors
 * skip them.
 */
const ON_DEMAND_FILE_TYPES: ReadonlySet<FileType> = new Set<FileType>(['skill', 'agent']);

export function isOnDemandFileType(fileType: FileType): boolean {
  return ON_DEMAND_FILE_TYPES.has(fileType);
}

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
  | 'security'
  // Findings produced by the user's own `.promptci/custom-rules.json` rules.
  | 'custom';

export type InstructionSection = {
  id: string;
  filePath: string;
  /**
   * `filePath` relative to the scan root, forward slashes. Set by the scanner;
   * finding ids hash this instead of the absolute path so one repo scanned from
   * two checkout locations yields identical ids (see finding-id.ts).
   */
  relativePath?: string;
  heading?: string;
  startLine: number;
  endLine: number;
  text: string;
  normalizedText: string;
};

export type InstructionFile = {
  path: string;
  /**
   * `path` relative to the scan root, forward slashes. Set by the scanner;
   * finding ids hash this instead of the absolute path (see finding-id.ts).
   * Optional so hand-built test fixtures keep type-checking.
   */
  relativePath?: string;
  /**
   * Set only on a symlink ALIAS: the `relativePath` of the file this name is a
   * symlink to, which is the copy detectors scan (the alias is listed in the
   * report inventory but never scanned, so its content is not double-counted).
   */
  aliasOf?: string;
  fileType: FileType;
  content: string;
  sections: InstructionSection[];
  lineCount: number;
  charCount: number;
  estimatedTokens: number;
};

/**
 * pcic-oonz: one line-anchored text substitution a mechanical fix recipe
 * applies. The emitting detector computes it while it still has the parsed
 * command or link in hand; `applyFixRecipe` only applies it, so the fix engine
 * never re-derives detection logic (and never walks the repository again).
 *
 * `find` must occur EXACTLY ONCE on line `line` of `filePath`. Both the
 * detector and the fix engine check that: the detector so a finding is never
 * advertised as auto-applicable when the edit is ambiguous, the engine so an
 * edit computed against a file that has since changed is refused rather than
 * applied to the wrong text. An issue whose edits cannot all be applied
 * cleanly produces no change at all — never a partial rewrite.
 */
export type FixEdit = {
  /** File to edit, as written in the issue's `locations[].filePath`. */
  filePath: string;
  /** 1-based line the substitution applies to. */
  line: number;
  /** Exact text to replace; must occur exactly once on that line and contain no newline. */
  find: string;
  /** Text that replaces it. */
  replace: string;
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
  /** Advisory, human-readable "here's how to fix it" text. Not machine-applied. */
  fixRecipe?: string;
  /**
   * True only when `applyFixRecipe` implements a mechanical, reversible edit for
   * this issue and it is safe to auto-apply. Gates `promptci fix` (see
   * `isRepairable`). Detectors set this deliberately per recipe — it is never
   * inferred from the presence of `fixRecipe`, which is usually advisory prose.
   */
  autoApplySafe?: boolean;
  /**
   * pcic-oonz: the exact substitutions `applyFixRecipe` performs for this
   * finding, computed by the detector. Present only on the recipes that work
   * this way (a mistyped package script, a moved link target); the older
   * recipes (.gitignore stanzas, duplicate consolidation) are recomputed from
   * the issue inside the fix engine and carry none. Never set without
   * `autoApplySafe`.
   */
  fixEdits?: FixEdit[];
  confidence: number;
  /**
   * Stable identity for a finding whose evidence is a LIST of members (the
   * repository's missing agent practices, a workflow's unpinned actions). When
   * set, the baseline/SARIF fingerprint hashes `category` and this key instead
   * of the title, files and evidence, so pinning one action or adding one rule
   * keeps the finding's identity rather than reading as resolved plus new.
   * Detectors set it only on such grouped findings; every other finding's
   * fingerprint is unchanged.
   */
  fingerprintKey?: string;
  tags?: string[];
  impact?: 'high' | 'medium' | 'low';
  /**
   * Estimated tokens in the instruction-file lines this finding covers (same
   * chars/4 estimator as `InstructionFile.estimatedTokens`; whole-file findings
   * use the file's estimate). Set by `scan()`; absent when the finding points at
   * no scanned instruction file. Findings overlap, so do NOT sum this across
   * issues: use `ScanMetrics.estimatedAddressableTokens` for a de-duplicated total.
   */
  estimatedTokens?: number;
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
  // Load-on-demand skill/agent bodies, reported separately so they do not
  // inflate the always-loaded instruction totals above. Omitted when zero.
  onDemandFileCount?: number;
  estimatedOnDemandTokens?: number;
  /**
   * Upper bound on tokens that removing or condensing flagged text could save:
   * tokens in the lines flagged by duplicate, context_bloat, stale_instruction,
   * conflict, vague_guidance and structure findings, in always-loaded files only,
   * overlapping ranges counted once. Never exceeds `estimatedInstructionTokens`.
   * Whole-file findings (a location with no line range, such as total-size
   * bloat or a version conflict) contribute 0. For a duplicate or conflict with
   * several located sections the largest is excluded, since fixing keeps one
   * copy. Baselined findings count (the text is still there); suppressed
   * findings do not.
   * Set by `scan()`; absent from `context analyze`, which runs no detectors.
   */
  estimatedAddressableTokens?: number;
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
export type CompactFileSummary = Pick<InstructionFile, 'path' | 'fileType' | 'lineCount' | 'charCount' | 'estimatedTokens'> & {
  /** Repo-relative path of the file this entry is a symlink to (aliases only). */
  aliasOf?: string;
};

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
  /**
   * FEAT-012: a target-model preset name (e.g. `claude-opus-5`) that scales the
   * context-bloat thresholds to that model's context window. An explicit
   * `contextBudget`/`fileContextBudget` always overrides the preset. Surfaced
   * as the `targetModel` config key and `--target-model` flag.
   */
  targetModel?: string;
  /**
   * FEAT-004: force every vague-guidance finding to this severity, overriding
   * the detector's high-signal/soft tiering. Surfaced as the
   * `vagueGuidanceSeverity` config key.
   */
  vagueGuidanceSeverity?: 'info' | 'warning';
  /**
   * pcic-csf: the repo-relative POSIX paths the repository holds, as a file
   * inventory the scan consults BEFORE the filesystem for every existence
   * check (a documented command's script, a dead reference, a skill's bundled
   * file, `.env`, `supabase/migrations`, a build directory, `.gitignore`).
   *
   * For a caller that does not have the repository on disk: a hosted scan
   * fetches the instruction files into a temp directory and leaves everything
   * else unfetched, so without this every other path reads as missing and the
   * scan reports references and commands as broken that are merely absent from
   * the temp dir. Listing files is enough — every directory on the way to a
   * listed file is implied.
   *
   * Paths are normalized (backslashes read as separators, `./` dropped); an
   * absolute path, or one climbing out of the repository with `..`, is ignored.
   * An entry with a trailing slash names a directory that holds no files of its
   * own. Leave unset for an ordinary scan of a checkout.
   *
   * One caveat worth knowing: a file LISTED here but not fetched is "known to
   * exist, contents unavailable", and the checks that need its contents go
   * quiet rather than guess. For `.gitignore` that is every reference the
   * repository's ignore rules could have covered — so fetch `.gitignore`
   * alongside the instruction files rather than only listing it, or the
   * dead-reference findings go with it. The same holds for `package.json` and
   * `Makefile`: listed-and-fetched gives full checking, listed-only gives
   * silence, and omitted-from-a-complete-list means "absent".
   */
  knownPaths?: ReadonlySet<string> | readonly string[];
  /**
   * True when `knownPaths` is the WHOLE repository: a path it does not list is
   * then genuinely absent and the filesystem is never consulted for one.
   * False/unset treats the list as a partial view — a listed path is known to
   * exist, and an unlisted one is still looked for on disk. Ignored without
   * `knownPaths`.
   */
  knownPathsComplete?: boolean;
};
