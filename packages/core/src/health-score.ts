/**
 * Health score computation and top-fix selection for PromptCI.
 *
 * Both functions are pure and deterministic — no randomness, same output
 * for the same input regardless of call order.
 */

import type { IssueCategory, IssueSeverity, PromptCiIssue, TopFix } from './types.js';

const SEVERITY_WEIGHT: Record<IssueSeverity, number> = {
  critical: 18,
  high: 10,
  warning: 4,
  info: 1,
};

/**
 * BUG-D1: Per-category maximum deduction caps.
 *
 * Without these, a repo with 30+ dead-reference warnings (structure category)
 * accumulates >100 points of penalty and bottoms out at 0 even when all other
 * detectors are clean. Caps prevent a single noisy category from dominating the
 * score while still penalising repos that genuinely have many issues.
 */
const CATEGORY_DEDUCTION_CAP: Partial<Record<IssueCategory, number>> = {
  structure: 30,          // dead references
  stale_instruction: 15,
  duplicate: 20,
  vague_guidance: 10,
  ai_config: 25,          // skills/subagents/hooks/mcp/cursor config checks
};

/**
 * Compute a health score from 0–100 based on issue severity and confidence.
 *
 * Starts at 100. Each issue subtracts (severityWeight × confidence), subject to
 * per-category caps so a single noisy detector cannot drive the score to zero on
 * its own.
 *
 * Result is clamped to [0, 100] and rounded to the nearest integer.
 */
export function computeHealthScore(issues: PromptCiIssue[]): number {
  let score = 100;
  const categoryDeductions = new Map<string, number>();

  for (const issue of issues) {
    const deduction = (SEVERITY_WEIGHT[issue.severity] ?? 0) * issue.confidence;
    const cap = CATEGORY_DEDUCTION_CAP[issue.category];

    if (cap !== undefined) {
      const soFar = categoryDeductions.get(issue.category) ?? 0;
      const allowed = Math.max(0, cap - soFar);
      const actual = Math.min(deduction, allowed);
      categoryDeductions.set(issue.category, soFar + actual);
      score -= actual;
    } else {
      score -= deduction;
    }
  }

  return Math.round(Math.max(0, Math.min(100, score)));
}

const IMPACT_WEIGHT: Record<'high' | 'medium' | 'low', number> = {
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * Classify the likely blast-radius impact of an issue.
 */
export function getIssueImpact(issue: PromptCiIssue): 'high' | 'medium' | 'low' {
  if (issue.impact) return issue.impact;

  const cat = issue.category;
  const title = issue.title.toLowerCase();

  // 1. Security & Privacy -> High
  if (
    cat === 'security' ||
    title.includes('secret') ||
    title.includes('auth') ||
    title.includes('supabase') ||
    title.includes('service role') ||
    title.includes('upload')
  ) {
    return 'high';
  }

  // 2. Build Validation & Commands -> High
  if (
    cat === 'command_validity' ||
    title.includes('build') ||
    title.includes('test') ||
    title.includes('lint') ||
    title.includes('run script') ||
    title.includes('package manager') ||
    title.includes('workflow')
  ) {
    return 'high';
  }

  // 3. Deployment -> High
  if (title.includes('deploy') || title.includes('vercel') || title.includes('ci/cd') || title.includes('release')) {
    return 'high';
  }

  // 4. Architecture & Framework choices -> High
  if (
    title.includes('framework') ||
    title.includes('router') ||
    title.includes('database') ||
    title.includes('version conflict') ||
    title.includes('package manager mismatch')
  ) {
    return 'high';
  }

  // 5. Tool Behavior / Agent Practices -> High
  if (
    cat === 'agent_practices' ||
    title.includes('verification') ||
    title.includes('scope') ||
    title.includes('read-before-edit') ||
    title.includes('honesty') ||
    title.includes('plan-first')
  ) {
    return 'high';
  }

  // 6. Style & Low-Risk Duplication -> Low
  if (cat === 'vague_guidance' || cat === 'duplicate' || title.includes('duplicate') || title.includes('vague')) {
    return 'low';
  }

  return 'medium';
}

/**
 * Select up to 3 top fixes from the issue list.
 *
 * Priority order (descending):
 *   1. Severity weight (critical → high → warning → info)
 *   2. Confidence (higher first)
 *   3. Blast-radius impact (high → medium → low)
 *   4. Number of files affected (more files = higher priority)
 *   5. Category string (alphabetical, for stable tie-breaking)
 *   6. Issue id (alphabetical, final stable tie-breaker)
 *
 * At most one fix per category is included to keep top-fixes diverse and
 * actionable — the highest-priority issue per category wins.
 */
export function selectTopFixes(issues: PromptCiIssue[]): TopFix[] {
  const sorted = [...issues].sort((a, b) => {
    const weightDiff =
      (SEVERITY_WEIGHT[b.severity] ?? 0) - (SEVERITY_WEIGHT[a.severity] ?? 0);
    if (weightDiff !== 0) return weightDiff;

    const confDiff = b.confidence - a.confidence;
    if (confDiff !== 0) return confDiff;

    const impactDiff =
      IMPACT_WEIGHT[getIssueImpact(b)] - IMPACT_WEIGHT[getIssueImpact(a)];
    if (impactDiff !== 0) return impactDiff;

    const filesDiff = b.filePaths.length - a.filePaths.length;
    if (filesDiff !== 0) return filesDiff;

    const catDiff = a.category.localeCompare(b.category);
    if (catDiff !== 0) return catDiff;

    return a.id.localeCompare(b.id);
  });

  const fixes: TopFix[] = [];
  const seenCategories = new Set<string>();

  for (const issue of sorted) {
    if (fixes.length >= 3) break;
    // One fix per category — avoids flooding top-fixes with e.g. 3 duplicate issues
    if (seenCategories.has(issue.category)) continue;
    seenCategories.add(issue.category);

    fixes.push({
      title: issue.title,
      reason: issue.summary,
      suggestedAction: issue.recommendation,
    });
  }

  return fixes;
}
