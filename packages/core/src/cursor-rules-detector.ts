/**
 * Cursor Rules Detector (issue #23)
 *
 * Audits Cursor project rules (`.cursor/rules/**\/*.mdc`):
 *
 *  - Frontmatter validity: present, closed, structurally sound.
 *  - `globs` that match zero files in the repo — an Auto-Attached rule keyed to
 *    a path that no longer exists never fires.
 *  - Rules with no trigger at all (no `description`, no `globs`, not
 *    `alwaysApply`) which can never activate.
 *
 * Deterministic and offline; findings are cautiously worded.
 */

import micromatch from 'micromatch';
import type { RepoContext } from './repo-context.js';
import type { PromptCiIssue } from './types.js';
import {
  parseFrontmatter,
  readTextWithinRoot,
  listFiles,
  shortHash,
  asStringList,
  withScannerPaths,
  aiConfigIssue as base,
  frontmatterStructureIssues,
} from './ai-config.js';
import type { FrontmatterSurface } from './ai-config.js';

const SURFACE: FrontmatterSurface = {
  idPrefix: 'cursor',
  noun: 'Cursor rule',
  why: 'A .mdc rule needs metadata (`description`, `globs`, or `alwaysApply`) to control when it applies.',
  recommendation: 'Add a frontmatter block describing the rule and its trigger (globs or alwaysApply).',
  // A metadata-less .mdc still loads as a manual rule, so this is softer news
  // than a skill/subagent that cannot register at all.
  noFrontmatterTitle: 'Cursor rule is missing frontmatter',
  noFrontmatterSeverity: 'warning',
  noFrontmatterConfidence: 0.7,
};

/**
 * Glob-existence testing needs different visibility than config discovery: a
 * rule may legitimately target `dist/` output or a *source* directory named
 * `build/`, so only dependency/VCS trees are excluded when asking "does this
 * glob match anything".
 */
const GLOB_TEST_IGNORE = ['**/node_modules/**', '**/.git/**'];

function id(kind: string, key: string): string {
  return `ai-config-cursor-${kind}-${shortHash(key)}`;
}

/** A glob we can meaningfully test for zero matches (skip negations/vars/placeholders). */
function isTestableGlob(glob: string): boolean {
  const g = glob.trim();
  if (!g) return false;
  if (g.startsWith('!')) return false;
  if (g.includes('$') || g.includes('<') || g.includes('>')) return false;
  return true;
}

export function detectCursorRules(context: RepoContext): PromptCiIssue[] {
  const issues: PromptCiIssue[] = [];
  const files = context.aiConfig.cursorRules;

  // ONE repo walk shared by every dead-glob test, built lazily so repos
  // without testable globs never pay for it. Testing each glob with its own
  // fg.sync call would walk the full tree once per glob per rule.
  let repoListing: string[] | null = null;
  const globMatchesAnything = (patterns: string[]): boolean => {
    repoListing ??= listFiles(context.repoRoot, ['**/*'], GLOB_TEST_IGNORE);
    return micromatch.some(repoListing, patterns, { dot: true });
  };

  for (const filePath of files) {
    const content = readTextWithinRoot(context.repoRoot, filePath);
    if (content === undefined) continue;

    const fm = parseFrontmatter(content);

    issues.push(...frontmatterStructureIssues(filePath, content, fm, SURFACE));
    if (!fm.present) continue;

    const description = typeof fm.data.description === 'string' ? fm.data.description.trim() : '';
    const globs = asStringList(fm.data.globs);
    const alwaysApply = fm.data.alwaysApply === true ||
      (typeof fm.data.alwaysApply === 'string' && fm.data.alwaysApply.trim().toLowerCase() === 'true');

    // A rule with no trigger can never activate.
    if (!description && globs.length === 0 && !alwaysApply) {
      issues.push(base({
        id: id('no-trigger', filePath),
        title: 'Cursor rule has no trigger',
        summary: `${filePath} defines no \`description\`, no \`globs\`, and \`alwaysApply\` is not set, so Cursor has no signal for when to apply it.`,
        filePaths: [filePath],
        locations: [{ filePath, startLine: 1, endLine: fm.fenceEndLine > 0 ? fm.fenceEndLine : 1 }],
        evidence: [`Keys present: ${Object.keys(fm.data).join(', ') || '(none)'}`],
        recommendation: 'Add a `description` (agent-requested), `globs` (auto-attached), or `alwaysApply: true`.',
        confidence: 0.7,
      }));
    }

    // Globs that match zero files.
    for (const glob of globs) {
      if (!isTestableGlob(glob)) continue;
      const normalized = glob.replace(/^\//, '');
      // Cursor treats a slashless pattern like `*.tsx` as "any depth", but
      // fast-glob only matches it at the root — so also try a `**/`-anchored
      // variant before declaring the glob dead, to avoid false positives.
      const candidates = normalized.includes('/') ? [normalized] : [normalized, `**/${normalized}`];
      if (!globMatchesAnything(candidates)) {
        issues.push(base({
          id: id('dead-glob', `${filePath}|${glob}`),
          title: 'Cursor rule glob matches no files',
          summary: `${filePath}: the \`globs\` pattern \`${glob}\` matches no files in the repository, so this auto-attached rule never fires.`,
          filePaths: [filePath],
          locations: [{ filePath, startLine: fm.keyLines.globs ?? 1, endLine: fm.keyLines.globs ?? 1 }],
          evidence: [`Glob: ${glob}`],
          recommendation: 'Update the glob to match real paths, or remove the rule if the code it targeted is gone.',
          confidence: 0.6,
        }));
      }
    }
  }

  // Scanner-form paths so inline suppressions can match (see withScannerPaths).
  return withScannerPaths(context.repoRoot, issues);
}
