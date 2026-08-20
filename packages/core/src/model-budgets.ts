/**
 * Model-aware context budgets (FEAT-012).
 *
 * The context-bloat detector measures always-loaded instruction cost in
 * characters. A fixed default threshold is a blunt instrument: 30k characters
 * of instructions is a large fraction of a small context window but a rounding
 * error in a 1M-token one. A `targetModel` preset scales the warning/high
 * thresholds to the model that will actually carry the instructions each turn.
 *
 * The presets are DERIVED from one small, maintainable table — each model's
 * approximate context window — via a documented formula, so the only thing that
 * can rot is the window map, and {@link MODEL_BUDGETS_REVIEW_BY} forces a
 * periodic review before it does. Everything here is deterministic; nothing
 * reads the clock (the staleness guard lives in a test, which may).
 */

/**
 * Review-by date for the model table below. A test asserts the current date is
 * before this — when it fails, the window map and this date must be refreshed
 * so the presets cannot silently rot the way hard-coded model tables have
 * before. Kept ~6 months out from the last refresh.
 *
 * Last refreshed: 2026-08-20 (windows from the @promptci/core `claude-api`
 * reference snapshot dated 2026-06-24).
 */
export const MODEL_BUDGETS_REVIEW_BY = '2027-02-28';

/**
 * Approximate context windows in tokens, used ONLY to scale instruction-budget
 * heuristics — these are not exact spec sheets and are intentionally coarse.
 * Refresh alongside {@link MODEL_BUDGETS_REVIEW_BY}.
 *
 * Claude windows are from the in-repo claude-api reference; the OpenAI and
 * Google entries are rounded, conservative approximations for the coding
 * assistants that consume these instruction files (Copilot, Gemini Code Assist).
 */
const MODEL_CONTEXT_WINDOWS = {
  // Anthropic Claude
  'claude-opus-5': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-haiku-4-5': 200_000,
  'claude-fable-5': 1_000_000,
  // OpenAI (GitHub Copilot)
  'gpt-5': 400_000,
  'gpt-5-mini': 400_000,
  // Google Gemini (Gemini Code Assist)
  'gemini-2.5-pro': 1_000_000,
  'gemini-2.5-flash': 1_000_000,
} as const satisfies Record<string, number>;

export type TargetModel = keyof typeof MODEL_CONTEXT_WINDOWS;

/** Every recognised targetModel id, for validation and docs. */
export const TARGET_MODELS = Object.keys(MODEL_CONTEXT_WINDOWS) as TargetModel[];

/**
 * Short family aliases → a representative current model, so users can write a
 * friendly `targetModel: "claude"` instead of pinning an exact version.
 */
const MODEL_ALIASES: Record<string, TargetModel> = {
  claude: 'claude-opus-5',
  'claude-opus': 'claude-opus-5',
  'claude-sonnet': 'claude-sonnet-5',
  'claude-haiku': 'claude-haiku-4-5',
  gpt: 'gpt-5',
  openai: 'gpt-5',
  copilot: 'gpt-5',
  gemini: 'gemini-2.5-pro',
};

// ── Budget formula ──────────────────────────────────────────────────────────
// Warn when always-loaded instructions exceed a small fraction of the window.
// Chosen conservatively; tune here rather than per-model so the table stays a
// pure window map. Rationale for the constants:
//   - CHARS_PER_TOKEN 4: PromptCI's repo-wide token estimate (chars / 4).
//   - TOTAL_BUDGET_FRACTION 3%: instructions carried every turn should be a
//     small slice of the window; 3% of 200k tokens ≈ the old 24k-char bar.
//   - FILE_BUDGET_SHARE 35%: a single file past ~a third of the total budget is
//     the dominant cost even when the total is fine.
const CHARS_PER_TOKEN = 4;
const TOTAL_BUDGET_FRACTION = 0.03;
const FILE_BUDGET_SHARE = 0.35;

export type ModelBudget = {
  /** The approximate context window (tokens) the budget was derived from. */
  contextWindowTokens: number;
  /** Total instruction-char budget (context-bloat total warning threshold). */
  contextBudget: number;
  /** Per-file instruction-char budget (context-bloat per-file warning threshold). */
  fileContextBudget: number;
};

/** Round to the nearest 1,000 chars so budgets read as tidy round numbers. */
function roundChars(n: number): number {
  return Math.round(n / 1_000) * 1_000;
}

/** Resolve a raw targetModel string (case-insensitive, alias-aware) to a known model, or undefined. */
export function resolveTargetModel(name: string): TargetModel | undefined {
  const key = name.trim().toLowerCase();
  // hasOwnProperty, not `in`: the `in` operator checks the prototype chain
  // too, so "constructor"/"toString"/"__proto__" would match and return an
  // invalid model id, producing NaN budgets downstream.
  if (Object.prototype.hasOwnProperty.call(MODEL_CONTEXT_WINDOWS, key))
    return key as TargetModel;
  if (Object.prototype.hasOwnProperty.call(MODEL_ALIASES, key)) return MODEL_ALIASES[key];
  return undefined;
}

/** Derive the char budgets for a known model from its context window. */
export function modelBudget(model: TargetModel): ModelBudget {
  const contextWindowTokens = MODEL_CONTEXT_WINDOWS[model];
  const contextBudget = roundChars(contextWindowTokens * TOTAL_BUDGET_FRACTION * CHARS_PER_TOKEN);
  const fileContextBudget = roundChars(contextBudget * FILE_BUDGET_SHARE);
  return { contextWindowTokens, contextBudget, fileContextBudget };
}

/**
 * Resolve a targetModel string to its budget, or undefined when the name is not
 * recognised. Callers that need to reject unknown names (the CLI config loader)
 * should validate against {@link resolveTargetModel} first for a clear error.
 */
export function budgetForTargetModel(name: string): ModelBudget | undefined {
  const model = resolveTargetModel(name);
  return model ? modelBudget(model) : undefined;
}
