/**
 * Skills Detector (issue #23)
 *
 * Audits Agent Skills — `SKILL.md` files under `.claude/`, `.agents/skills/`
 * and plugin `skills/<name>/` directories — against filesystem reality:
 *
 *  - Frontmatter validity: present, closed, required `name`/`description`, and
 *    `name` matching the skill's directory (how Claude resolves a skill).
 *  - Trigger descriptions: an empty `description` never triggers the skill; two
 *    skills sharing a description compete for the same triggers.
 *  - Dead file references: paths in the skill body (scripts, references) that
 *    resolve neither beside the skill nor from the repo root.
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
  existsWithinRoot,
  shortHash,
  toPosix,
  withScannerPaths,
  aiConfigIssue as base,
  frontmatterStructureIssues,
} from './ai-config.js';
import type { FrontmatterSurface } from './ai-config.js';
import { isHomeRooted } from './dead-references.js';
import { createGitIgnoreChecker } from './gitignore.js';

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

/**
 * Looks like a file reference (a bundled resource or a repo file), not prose or
 * a URL. A leading `/` is kept: the detector reads it as repo-root-relative and
 * only checks it when its first segment exists at the repo root.
 */
function isBundledFileRef(ref: string): boolean {
  if (!ref) return false;
  const r = ref.trim();
  if (/^(https?:|mailto:|#|\/\/)/i.test(r)) return false; // URL / anchor
  if (/^[a-zA-Z]:[\\/]/.test(r)) return false; // Windows absolute
  if (/[<>{}*?|"\s]/.test(r)) return false; // placeholder / glob / whitespace
  if (r.includes('..')) return false; // don't chase parent escapes
  const withoutAnchor = r.split('#')[0]!;
  const hasSlash = withoutAnchor.includes('/');
  const hasExt = /\.[a-z0-9]{1,6}$/i.test(withoutAnchor);
  // Require a directory segment AND an extension — high-confidence file paths only.
  return hasSlash && hasExt;
}

export function extractFileRefs(content: string): Array<{ ref: string; line: number }> {
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

/**
 * Repo-relative paths a skill's file reference may resolve to, in lookup order,
 * or `undefined` when the reference should not be checked at all.
 *
 *  - `/Docs/x.md` is repo-root-relative. It is only checked when its first
 *    segment exists at the repo root; otherwise it is an absolute system path
 *    (`/usr/local/bin/tool.sh`) that says nothing about this repository.
 *  - `scripts/x.py` is looked up beside the SKILL.md, then (for a
 *    `…/skills/<name>/` layout) at the plugin root, then at the repo root.
 */
function resolutionCandidates(repoRoot: string, skillDir: string, ref: string): string[] | undefined {
  if (ref.startsWith('/')) {
    const rooted = ref.slice(1);
    return existsWithinRoot(repoRoot, rooted.split('/')[0]!) ? [rooted] : undefined;
  }
  const pluginRoot = /^(.*?)\/?skills\/[^/]+$/.exec(skillDir)?.[1];
  const bases = [skillDir, ...(pluginRoot ? [pluginRoot] : []), '.'];
  return [...new Set(bases.map((b) => (b === '.' || b === '' ? ref : `${b}/${ref}`)))];
}

// ── Detector ──────────────────────────────────────────────────────────────────

/** A line telling the reader NOT to touch a file ("never commit `.beads/issues.jsonl`") is not a claim that it exists. */
const PROHIBITION_RE = /\b(?:do\s+not|don'?t|never|avoid|must\s+not|should\s+not|shouldn'?t)\b/i;

export function detectSkills(context: RepoContext): PromptCiIssue[] {
  const issues: PromptCiIssue[] = [];
  const parsed: ParsedSkill[] = [];
  let isIgnored: ((repoRelativePath: string) => boolean) | undefined;

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

    // Dead file references in the body. A skill may point at its own bundled
    // files (`scripts/run.py`) or at files of the repository it documents
    // (`Docs/contract.md`, `.github/workflows/ci.yml`), so a relative reference
    // is only dead when it resolves from NEITHER the skill directory NOR the
    // repo root. A leading slash (`/Docs/contract.md`) means repo root.
    const skillDir = toPosix(path.dirname(filePath));
    const bodyLines = content.split(/\r?\n/);
    for (const { ref, line } of extractFileRefs(content)) {
      // Files that are not part of a checkout by nature: the reader's home
      // directory, git internals, and "never commit `X`"-style prohibitions.
      if (isHomeRooted(ref) || /^\/?\.git\//.test(ref)) continue;
      if (PROHIBITION_RE.test(bodyLines[line - 1] ?? '')) continue;
      const candidates = resolutionCandidates(context.repoRoot, skillDir, ref);
      if (!candidates) continue; // e.g. `/usr/bin/tool.sh` — a system path, not a repo file
      if (candidates.some((candidate) => isFileWithinRoot(context.repoRoot, candidate))) continue;
      // Local/generated state the repo's own ignore rules say is never checked in.
      isIgnored ??= createGitIgnoreChecker(context.repoRoot);
      if (candidates.some((candidate) => isIgnored!(candidate))) continue;
      const leadingSlash = ref.startsWith('/');
      issues.push(base({
        id: id('dead-ref', filePath, ref),
        title: 'Skill references a bundled file that does not exist',
        summary: leadingSlash
          ? `${filePath} references \`${ref}\`, but no such file exists at that path from the repository root.`
          : `${filePath} references \`${ref}\`, but no such file exists relative to the skill directory or the repository root.`,
        filePaths: [filePath],
        locations: [{ filePath, startLine: line, endLine: line }],
        evidence: [`Reference: ${ref}`, `Looked in: ${candidates.join(', ')}`],
        recommendation: 'Add the referenced file, fix the path, or remove the reference.',
        confidence: 0.75,
      }));
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
