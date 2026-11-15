/**
 * Cursor Rules Detector (issue #23)
 *
 * Audits Cursor project rules (`.cursor/rules/**\/*.mdc`):
 *
 *  - Frontmatter validity: present, closed, structurally sound.
 *  - `globs` that match zero files in the repo — an Auto-Attached rule keyed to
 *    a path that no longer exists never fires.
 *  - Rules with no trigger at all (no `description`, no `globs`, not
 *    `alwaysApply`): manual-only (included when @-mentioned), reported as info.
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

    // A rule with no description, globs or alwaysApply is manual-only: Cursor
    // includes it when it is @-mentioned in chat. Informational, not a defect.
    if (!description && globs.length === 0 && !alwaysApply) {
      issues.push(base({
        id: id('no-trigger', filePath),
        severity: 'info',
        title: 'Cursor rule is manual-only (no automatic trigger)',
        summary: `${filePath} defines no \`description\`, no \`globs\`, and \`alwaysApply\` is not set, so Cursor documents it as a manual rule: included only when you @-mention it in chat. That is fine if intended.`,
        filePaths: [filePath],
        locations: [{ filePath, startLine: 1, endLine: fm.fenceEndLine > 0 ? fm.fenceEndLine : 1 }],
        evidence: [`Keys present: ${Object.keys(fm.data).join(', ') || '(none)'}`],
        recommendation: 'If this rule should apply automatically, add a `description` (agent-requested), `globs` (auto-attached), or `alwaysApply: true`; otherwise reference it with @rule-name.',
        confidence: 0.7,
      }));
    }

    // Globs that match zero files.
    for (const glob of globs) {
      if (!isTestableGlob(glob)) continue;
      const normalized = glob.replace(/^\//, '');
      // Cursor documents `*.ts` as the .ts files in the root and `**/*.ts` as
      // .ts files in any directory, so a slashless glob is tested as written
      // (root-level only), with no any-depth fallback.
      if (!globMatchesAnything([normalized])) {
        const nestedHint = !normalized.includes('/') && globMatchesAnything([`**/${normalized}`]);
        issues.push(base({
          id: id('dead-glob', `${filePath}|${glob}`),
          title: 'Cursor rule glob matches no files',
          summary: nestedHint
            ? `${filePath}: the \`globs\` pattern \`${glob}\` matches no files in the repository root; Cursor documents a slashless pattern as root-level only, so this rule may never auto-attach to the nested files it seems aimed at.`
            : `${filePath}: the \`globs\` pattern \`${glob}\` matches no files in the repository, so this auto-attached rule may never fire.`,
          filePaths: [filePath],
          locations: [{ filePath, startLine: fm.keyLines.globs ?? 1, endLine: fm.keyLines.globs ?? 1 }],
          evidence: [`Glob: ${glob}`],
          recommendation: nestedHint
            ? `Use \`**/${normalized}\` to match at any depth, or point the glob at real paths.`
            : 'Update the glob to match real paths, or remove the rule if the code it targeted is gone.',
          confidence: 0.6,
        }));
      }
    }
  }

  // Scanner-form paths so inline suppressions can match (see withScannerPaths).
  return withScannerPaths(context.repoRoot, issues);
}
