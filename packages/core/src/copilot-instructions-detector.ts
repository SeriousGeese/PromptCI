/**
 * Copilot Instructions Detector (issue #66)
 *
 * Audits GitHub Copilot path-specific instruction files
 * (`.github/instructions/**\/*.instructions.md`; GitHub requires that suffix).
 * These use `applyTo:` frontmatter globs to scope which files they apply to —
 * analogous to Cursor's `.mdc` `globs`. This mirrors `detectCursorRules`:
 *
 *  - Frontmatter validity: present, closed, structurally sound.
 *  - Neither `applyTo` nor `description` — in VS Code the file is then only
 *    available for manual attachment (there is no default pattern); info.
 *  - Plain `.md` files under `.github/instructions/` that Copilot will not load.
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
  recommendation: 'Add a frontmatter block with an `applyTo:` glob (use `applyTo: "**"` for all files) or a `description`.',
  // Frontmatter is optional; with no `applyTo` or `description` VS Code leaves the
  // file for manual attachment, so this is a hint, not a defect.
  noFrontmatterTitle: 'Copilot instructions file is missing frontmatter',
  noFrontmatterSeverity: 'info',
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

    // Neither `applyTo` nor `description`: VS Code leaves the file available for
    // manual attachment (no default pattern), so it is not applied automatically.
    const description = typeof fm.data.description === 'string' ? fm.data.description.trim() : '';
    if (applyTo.length === 0) {
      if (!description) {
        issues.push(base({
          id: id('no-applyto', filePath),
          severity: 'info',
          title: 'Copilot instructions file has no applyTo glob or description',
          summary: `${filePath} defines neither an \`applyTo\` glob nor a \`description\`. VS Code documents such a file as available for manual attachment rather than applied automatically, and \`applyTo\` has no default pattern.`,
          filePaths: [filePath],
          locations: [{ filePath, startLine: 1, endLine: fm.fenceEndLine > 0 ? fm.fenceEndLine : 1 }],
          evidence: [`Keys present: ${Object.keys(fm.data).join(', ') || '(none)'}`],
          recommendation: 'If it should apply automatically, add an `applyTo:` glob (or `applyTo: "**"` for all files) or a `description`; otherwise attach it manually.',
          confidence: 0.6,
        }));
      }
      continue; // no globs to test
    }

    const globLine = fm.keyLines.applyTo ?? 1;
    for (const glob of applyTo) {
      if (!isTestableGlob(glob) || matchesEverything(glob)) continue;
      const normalized = glob.replace(/^\//, '');
      // GitHub and VS Code document `*.py` as matching the current/root directory
      // only (`**` or `**/*.py` for any depth), so test the glob as written.
      const candidates = [normalized];

      if (!matchesBroad(candidates)) {
        const nestedHint = !normalized.includes('/') && matchesBroad([`**/${normalized}`]);
        issues.push(base({
          id: id('dead-glob', `${filePath}|${glob}`),
          title: 'Copilot instructions applyTo glob matches no files',
          summary: nestedHint
            ? `${filePath}: the \`applyTo\` glob \`${glob}\` matches no files in the repository root; GitHub documents a slashless pattern as matching the current directory only, so this file may never reach the nested files it seems aimed at.`
            : `${filePath}: the \`applyTo\` glob \`${glob}\` matches no files in the repository, so this instructions file may never apply.`,
          filePaths: [filePath],
          locations: [{ filePath, startLine: globLine, endLine: globLine }],
          evidence: [`Glob: ${glob}`],
          recommendation: nestedHint
            ? `Use \`**/${normalized}\` to match at any depth, or point the glob at real paths.`
            : 'Update the glob to match real paths, or remove the file if the code it targeted is gone.',
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

  // Plain `.md` files in `.github/instructions/`: GitHub requires the name to end
  // `.instructions.md`, so Copilot is documented not to load these as
  // path-specific instructions.
  for (const filePath of context.aiConfig.copilotPlainMd ?? []) {
    issues.push(base({
      id: id('not-instructions-md', filePath),
      severity: 'info',
      title: 'Copilot path-specific instructions file is not named .instructions.md',
      summary: `${filePath} is under .github/instructions/ but its name does not end with \`.instructions.md\`, which GitHub documents as required for path-specific instructions, so Copilot may not load it.`,
      filePaths: [filePath],
      locations: [{ filePath, startLine: 1, endLine: 1 }],
      evidence: [`File name: ${filePath.split('/').pop()}`],
      recommendation: 'Rename it to NAME.instructions.md if it is meant as path-specific instructions; otherwise move it out of .github/instructions/.',
      confidence: 0.6,
    }));
  }

  // Scanner-form paths so inline suppressions can match (see withScannerPaths).
  return withScannerPaths(context.repoRoot, issues);
}
