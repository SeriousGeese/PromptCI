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

import type { RepoContext } from './repo-context.js';
import type { PromptCiIssue } from './types.js';
import {
  parseFrontmatter,
  readTextWithinRoot,
  listFiles,
  shortHash,
  asStringList,
} from './ai-config.js';

const MDC_GLOBS = ['.cursor/rules/**/*.mdc'];

function id(kind: string, key: string): string {
  return `ai-config-cursor-${kind}-${shortHash(key)}`;
}

function base(issue: Omit<PromptCiIssue, 'severity' | 'category' | 'confidence'> &
  Partial<Pick<PromptCiIssue, 'severity' | 'category' | 'confidence'>>): PromptCiIssue {
  return {
    severity: 'warning',
    category: 'ai_config',
    confidence: 0.8,
    ...issue,
  };
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
  const files = listFiles(context.repoRoot, MDC_GLOBS);

  for (const filePath of files) {
    const content = readTextWithinRoot(context.repoRoot, filePath);
    if (content === undefined) continue;

    const fm = parseFrontmatter(content);

    if (!fm.present) {
      issues.push(base({
        id: id('no-frontmatter', filePath),
        title: 'Cursor rule is missing frontmatter',
        summary: `${filePath} has no \`---\` frontmatter. A .mdc rule needs metadata (\`description\`, \`globs\`, or \`alwaysApply\`) to control when it applies.`,
        filePaths: [filePath],
        locations: [{ filePath, startLine: 1, endLine: 1 }],
        evidence: [`First line: ${content.split(/\r?\n/)[0]?.slice(0, 60) ?? '(empty)'}`],
        recommendation: 'Add a frontmatter block describing the rule and its trigger (globs or alwaysApply).',
        confidence: 0.7,
      }));
      continue;
    }

    if (!fm.closed) {
      issues.push(base({
        id: id('unterminated', filePath),
        severity: 'high',
        title: 'Cursor rule frontmatter is not closed',
        summary: `${filePath} opens a \`---\` frontmatter block that is never closed.`,
        filePaths: [filePath],
        locations: [{ filePath, startLine: 1, endLine: 1 }],
        evidence: ['Opening `---` on line 1 has no closing `---`.'],
        recommendation: 'Close the frontmatter block with a `---` line.',
        confidence: 0.9,
      }));
    }

    for (const err of fm.errors) {
      issues.push(base({
        id: id('fm-error', `${filePath}|${err}`),
        title: 'Cursor rule frontmatter has a structural problem',
        summary: `${filePath}: ${err}.`,
        filePaths: [filePath],
        locations: [{ filePath, startLine: 1, endLine: fm.fenceEndLine > 0 ? fm.fenceEndLine : 1 }],
        evidence: [err],
        recommendation: 'Fix the frontmatter so it is valid YAML with flat, unique keys.',
        confidence: 0.7,
      }));
    }

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
        evidence: [`Keys present: ${fm.order.join(', ') || '(none)'}`],
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
      const matches = listFiles(context.repoRoot, candidates);
      if (matches.length === 0) {
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

  return issues;
}
