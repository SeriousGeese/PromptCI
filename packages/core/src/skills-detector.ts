/**
 * Skills Detector (issue #23)
 *
 * Audits Agent Skills — `SKILL.md` files under `.claude/` (project skills and
 * plugin-bundled skills) — against filesystem reality:
 *
 *  - Frontmatter validity: present, closed, required `name`/`description`, and
 *    `name` matching the skill's directory (how Claude resolves a skill).
 *  - Trigger descriptions: an empty `description` never triggers the skill; two
 *    skills sharing a description compete for the same triggers.
 *  - Dead file references: paths in the skill body (scripts, references) that
 *    point at bundled files which do not exist.
 *
 * All checks are deterministic and offline. Findings are cautiously worded.
 */

import * as path from 'node:path';
import type { RepoContext } from './repo-context.js';
import type { PromptCiIssue } from './types.js';
import {
  parseFrontmatter,
  readTextWithinRoot,
  isFileWithinRoot,
  shortHash,
  toPosix,
  withScannerPaths,
  aiConfigIssue as base,
  frontmatterStructureIssues,
} from './ai-config.js';
import type { FrontmatterSurface } from './ai-config.js';

/** A description shorter than this (after trimming) is treated as effectively empty. */
const MIN_DESCRIPTION_CHARS = 12;

const SURFACE: FrontmatterSurface = {
  idPrefix: 'skill',
  noun: 'Skill',
  why: 'A skill needs `name` and `description` frontmatter or it will not load.',
  recommendation: 'Add a frontmatter block with `name` and `description` at the top of the SKILL.md file.',
};

type ParsedSkill = {
  filePath: string;
  description: string;
};

function id(kind: string, filePath: string, extra = ''): string {
  return `ai-config-skill-${kind}-${shortHash(`${filePath}|${extra}`)}`;
}

function normalizeDescription(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ── Dead-reference extraction (scoped to a skill body) ────────────────────────

/** Looks like a relative file reference to a bundled resource, not prose or a URL. */
function isBundledFileRef(ref: string): boolean {
  if (!ref) return false;
  const r = ref.trim();
  if (/^(https?:|mailto:|#|\/\/)/i.test(r)) return false; // URL / anchor
  if (r.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(r)) return false; // absolute
  if (/[<>{}*?|"\s]/.test(r)) return false; // placeholder / glob / whitespace
  if (r.includes('..')) return false; // don't chase parent escapes
  const withoutAnchor = r.split('#')[0]!;
  const hasSlash = withoutAnchor.includes('/');
  const hasExt = /\.[a-z0-9]{1,6}$/i.test(withoutAnchor);
  // Require a directory segment AND an extension — high-confidence file paths only.
  return hasSlash && hasExt;
}

function extractFileRefs(content: string): Array<{ ref: string; line: number }> {
  const refs: Array<{ ref: string; line: number }> = [];
  // Keyed on the anchor-STRIPPED path — `docs/x.md#one` and `docs/x.md#two`
  // name the same file and must yield one finding, not two with equal ids.
  const seen = new Set<string>();
  const record = (target: string, line: number) => {
    if (!isBundledFileRef(target)) return;
    const ref = target.split('#')[0]!;
    if (seen.has(ref)) return;
    seen.add(ref);
    refs.push({ ref, line });
  };
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Markdown links: [text](path)
    for (const m of line.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      record(m[1]!.split(/\s+/)[0]!.replace(/^<|>$/g, ''), i + 1);
    }
    // Inline code paths: `scripts/foo.py`
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      record(m[1]!.trim(), i + 1);
    }
  }
  return refs;
}

// ── Detector ──────────────────────────────────────────────────────────────────

export function detectSkills(context: RepoContext): PromptCiIssue[] {
  const issues: PromptCiIssue[] = [];
  const parsed: ParsedSkill[] = [];

  for (const filePath of context.aiConfig.skills) {
    const content = readTextWithinRoot(context.repoRoot, filePath);
    if (content === undefined) continue;

    const dirName = toPosix(path.dirname(filePath)).split('/').pop() ?? '';
    const fm = parseFrontmatter(content);

    issues.push(...frontmatterStructureIssues(filePath, content, fm, SURFACE));
    if (!fm.present) continue;

    const name = typeof fm.data.name === 'string' ? fm.data.name.trim() : undefined;
    const description = typeof fm.data.description === 'string' ? fm.data.description.trim() : undefined;

    if (!name) {
      issues.push(base({
        id: id('missing-name', filePath),
        title: 'Skill frontmatter is missing `name`',
        summary: `${filePath} has no \`name\` field. Claude uses \`name\` to identify and invoke the skill.`,
        filePaths: [filePath],
        locations: [{ filePath, startLine: 1, endLine: fm.fenceEndLine > 0 ? fm.fenceEndLine : 1 }],
        evidence: [`Keys present: ${Object.keys(fm.data).join(', ') || '(none)'}`],
        recommendation: 'Add a `name` field to the frontmatter matching the skill directory name.',
        confidence: 0.85,
      }));
    } else if (name !== dirName && dirName) {
      issues.push(base({
        id: id('name-dir-mismatch', filePath),
        title: 'Skill `name` does not match its directory',
        summary: `${filePath}: frontmatter \`name: ${name}\` does not match the skill directory \`${dirName}/\`. Claude resolves skills by directory name.`,
        filePaths: [filePath],
        locations: [{ filePath, startLine: fm.keyLines.name ?? 1, endLine: fm.keyLines.name ?? 1 }],
        evidence: [`name: ${name}`, `directory: ${dirName}`],
        recommendation: 'Rename the directory or the `name` field so they match.',
        confidence: 0.6,
      }));
    }

    if (!description) {
      issues.push(base({
        id: id('missing-description', filePath),
        title: 'Skill frontmatter is missing `description`',
        summary: `${filePath} has no \`description\`. The description is the trigger text Claude matches against — without it the skill rarely activates.`,
        filePaths: [filePath],
        locations: [{ filePath, startLine: 1, endLine: fm.fenceEndLine > 0 ? fm.fenceEndLine : 1 }],
        evidence: [`Keys present: ${Object.keys(fm.data).join(', ') || '(none)'}`],
        recommendation: 'Add a `description` that says what the skill does and when to use it.',
        confidence: 0.85,
      }));
    } else if (description.length < MIN_DESCRIPTION_CHARS) {
      issues.push(base({
        id: id('empty-description', filePath),
        title: 'Skill `description` is too short to trigger reliably',
        summary: `${filePath}: \`description\` is only ${description.length} characters. Claude matches the description against the user's request to decide when to invoke the skill.`,
        filePaths: [filePath],
        locations: [{ filePath, startLine: fm.keyLines.description ?? 1, endLine: fm.keyLines.description ?? 1 }],
        evidence: [`description: ${description}`],
        recommendation: 'Expand the description to describe the task and its trigger conditions.',
        confidence: 0.7,
      }));
    }

    // Dead file references in the body.
    const skillDir = toPosix(path.dirname(filePath));
    for (const { ref, line } of extractFileRefs(content)) {
      const resolved = skillDir === '.' ? ref : `${skillDir}/${ref}`;
      if (!isFileWithinRoot(context.repoRoot, resolved)) {
        issues.push(base({
          id: id('dead-ref', filePath, ref),
          title: 'Skill references a bundled file that does not exist',
          summary: `${filePath} references \`${ref}\`, but no such file exists relative to the skill directory.`,
          filePaths: [filePath],
          locations: [{ filePath, startLine: line, endLine: line }],
          evidence: [`Reference: ${ref}`, `Resolved to: ${resolved}`],
          recommendation: 'Add the referenced file, fix the path, or remove the reference.',
          confidence: 0.75,
        }));
      }
    }

    if (description) parsed.push({ filePath, description });
  }

  // Overlapping / duplicate trigger descriptions across skills.
  issues.push(...detectOverlappingDescriptions(parsed));

  // Scanner-form paths so inline suppressions can match (see withScannerPaths).
  return withScannerPaths(context.repoRoot, issues);
}

function detectOverlappingDescriptions(skills: ParsedSkill[]): PromptCiIssue[] {
  const issues: PromptCiIssue[] = [];
  const byNorm = new Map<string, ParsedSkill[]>();
  for (const skill of skills) {
    if (skill.description.length < MIN_DESCRIPTION_CHARS) continue;
    const norm = normalizeDescription(skill.description);
    if (!norm) continue;
    const group = byNorm.get(norm) ?? [];
    group.push(skill);
    byNorm.set(norm, group);
  }

  for (const group of byNorm.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => a.filePath.localeCompare(b.filePath));
    const paths = sorted.map((s) => s.filePath);
    issues.push(base({
      id: id('overlap', paths.join('|')),
      title: 'Multiple skills share the same trigger description',
      summary: `${paths.length} skills have effectively identical \`description\` text, so Claude cannot tell which to invoke for a given request.`,
      filePaths: paths,
      locations: sorted.map((s) => ({ filePath: s.filePath, startLine: 1, endLine: 1 })),
      evidence: [`Shared description: ${sorted[0]!.description}`, `Skills: ${paths.join(', ')}`],
      recommendation: 'Give each skill a distinct description that states its unique trigger conditions.',
      confidence: 0.75,
    }));
  }

  return issues;
}
