/**
 * Copilot Instructions Detector (issue #66)
 *
 * Audits GitHub Copilot per-file instruction files (`.github/instructions/**\/*.md`).
 * These use `applyTo:` frontmatter globs to scope which files they apply to —
 * analogous to Cursor's `.mdc` `globs`. This mirrors `detectCursorRules`:
 *
 *  - Frontmatter validity: present, closed, structurally sound.
 *  - `applyTo:` absent — the file then applies to *every* Copilot request by
 *    default, which is often unintentional.
 *  - `applyTo:` globs that match zero files in the repo — a scope keyed to a
 *    path that no longer exists never fires.
 *  - `applyTo:` globs that match only ignored / build-output files — informational.
 *
 * The legacy single-file `.github/copilot-instructions.md` is always-on and has
 * no `applyTo` support, so discovery (see AI_CONFIG_GLOBS) scopes to
 * `.github/instructions/` only and never reaches this detector.
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
  idPrefix: 'copilot',
  noun: 'Copilot instructions file',
  why: 'A `.instructions.md` file uses an `applyTo:` frontmatter glob to control which files it applies to.',
  recommendation: 'Add a frontmatter block with an `applyTo:` glob (use `applyTo: "**"` to apply to every request).',
  // A frontmatter-less instructions file still loads (Copilot treats it as
  // apply-to-everything), so this is softer news than a skill that cannot register.
  noFrontmatterTitle: 'Copilot instructions file is missing frontmatter',
  noFrontmatterSeverity: 'warning',
  noFrontmatterConfidence: 0.7,
};

/**
 * "Does this glob match any real file" excludes only dependency/VCS trees — a
 * scope may legitimately target `dist/` or a source dir named `build/`.
 */
const GLOB_TEST_IGNORE = ['**/node_modules/**', '**/.git/**'];

/**
 * Trees that are ignored or build output: a glob matching only these is scoped
 * to generated/vendored files, which is worth an info but not a warning.
 */
const IGNORED_TREES = [
  '**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**',
  '**/.next/**', '**/out/**', '**/coverage/**', '**/worktrees/**', '**/.worktrees/**',
];

function id(kind: string, key: string): string {
  return `ai-config-copilot-${kind}-${shortHash(key)}`;
}

/** A glob we can meaningfully test for zero matches (skip negations/vars/placeholders). */
function isTestableGlob(glob: string): boolean {
  const g = glob.trim();
  if (!g) return false;
  if (g.startsWith('!')) return false;
  if (g.includes('$') || g.includes('<') || g.includes('>')) return false;
  return true;
}

/** A glob of `**` (or `** slash *`) means "every file" — always valid, never dead. */
function matchesEverything(glob: string): boolean {
  const g = glob.trim();
  return g === '**' || g === '**/*';
}

export function detectCopilotInstructions(context: RepoContext): PromptCiIssue[] {
  const issues: PromptCiIssue[] = [];
  const files = context.aiConfig.copilotInstructions;

  // TWO repo walks shared across every glob test, built lazily so repos with no
  // testable globs never pay for them. `broad` includes build/vendored output
  // (only node_modules/.git excluded); `source` excludes ignored trees, so a
  // glob that matches `broad` but not `source` hits only ignored files.
  let broad: string[] | null = null;
  let source: string[] | null = null;
  const matchesBroad = (patterns: string[]): boolean => {
    broad ??= listFiles(context.repoRoot, ['**/*'], GLOB_TEST_IGNORE);
    return micromatch.some(broad, patterns, { dot: true });
  };
  const matchesSource = (patterns: string[]): boolean => {
    source ??= listFiles(context.repoRoot, ['**/*'], IGNORED_TREES);
    return micromatch.some(source, patterns, { dot: true });
  };

  for (const filePath of files) {
    const content = readTextWithinRoot(context.repoRoot, filePath);
    if (content === undefined) continue;

    const fm = parseFrontmatter(content);

    issues.push(...frontmatterStructureIssues(filePath, content, fm, SURFACE));
    if (!fm.present) continue;

    const applyTo = asStringList(fm.data.applyTo);

    // No `applyTo` at all → the file applies to every request.
    if (applyTo.length === 0) {
      issues.push(base({
        id: id('no-applyto', filePath),
        title: 'Copilot instructions file has no applyTo glob',
        summary: `${filePath} defines no \`applyTo\` glob, so Copilot applies it to every request by default — often unintentional.`,
        filePaths: [filePath],
        locations: [{ filePath, startLine: 1, endLine: fm.fenceEndLine > 0 ? fm.fenceEndLine : 1 }],
        evidence: [`Keys present: ${Object.keys(fm.data).join(', ') || '(none)'}`],
        recommendation: 'Add an `applyTo:` glob scoping the file to the paths it is about, or set `applyTo: "**"` to make the always-on scope explicit.',
        confidence: 0.7,
      }));
      continue; // no globs to test
    }

    const globLine = fm.keyLines.applyTo ?? 1;
    for (const glob of applyTo) {
      if (!isTestableGlob(glob) || matchesEverything(glob)) continue;
      const normalized = glob.replace(/^\//, '');
      // A slashless pattern like `*.ts` is intended as "any depth"; fast-glob
      // only matches it at the root, so also try a `**/`-anchored variant
      // before declaring the glob dead, to avoid false positives.
      const candidates = normalized.includes('/') ? [normalized] : [normalized, `**/${normalized}`];

      if (!matchesBroad(candidates)) {
        issues.push(base({
          id: id('dead-glob', `${filePath}|${glob}`),
          title: 'Copilot instructions applyTo glob matches no files',
          summary: `${filePath}: the \`applyTo\` glob \`${glob}\` matches no files in the repository, so this instructions file never applies.`,
          filePaths: [filePath],
          locations: [{ filePath, startLine: globLine, endLine: globLine }],
          evidence: [`Glob: ${glob}`],
          recommendation: 'Update the glob to match real paths, or remove the file if the code it targeted is gone.',
          confidence: 0.6,
        }));
      } else if (!matchesSource(candidates)) {
        issues.push(base({
          id: id('ignored-glob', `${filePath}|${glob}`),
          severity: 'info',
          title: 'Copilot instructions applyTo glob matches only ignored files',
          summary: `${filePath}: the \`applyTo\` glob \`${glob}\` matches only ignored or build-output files, so it rarely applies to files you edit.`,
          filePaths: [filePath],
          locations: [{ filePath, startLine: globLine, endLine: globLine }],
          evidence: [`Glob: ${glob}`],
          recommendation: 'Point the glob at source paths, or remove the file if it was meant to target generated output.',
          confidence: 0.55,
        }));
      }
    }
  }

  // Scanner-form paths so inline suppressions can match (see withScannerPaths).
  return withScannerPaths(context.repoRoot, issues);
}
