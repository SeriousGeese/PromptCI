/**
 * Skills Detector (issue #23)
 *
 * Audits Agent Skills — `SKILL.md` files under `.claude/`, `.agents/skills/`
 * and plugin `skills/<name>/` directories — against filesystem reality:
 *
 *  - Frontmatter validity: closed and parseable. Every field is optional for
 *    Claude Code (`name` defaults to the directory name, `description` to the
 *    first body line) and nested maps such as `hooks` and `metadata` are valid,
 *    so a missing `name`/`description`/frontmatter block, or a `name` that
 *    differs from the directory, is only an unscored portability hint: the
 *    Agent Skills specification and Codex ask for them.
 *  - Trigger descriptions: a missing, very short or duplicated `description` is
 *    reported as an unscored hint (advice, not a documented limit).
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
  shortHash,
  toPosix,
  withScannerPaths,
  aiConfigIssue as base,
  frontmatterStructureIssues,
} from './ai-config.js';
import type { FrontmatterSurface } from './ai-config.js';
import { isHomeRooted } from './dead-references.js';
import { UNSCORED_TAG } from './health-score.js';
import { createGitIgnoreChecker } from './gitignore.js';
import type { IgnoreVerdict } from './gitignore.js';
import { treeFor } from './repo-tree.js';

/** A description shorter than this (after trimming) is treated as effectively empty. */
const MIN_DESCRIPTION_CHARS = 12;

const SURFACE: FrontmatterSurface = {
  idPrefix: 'skill',
  noun: 'Skill',
  why:
    'Claude Code does not need frontmatter (the directory name becomes the command and the first line of the ' +
    'body the description), but the Agent Skills specification and Codex ask for `name` and `description`.',
  recommendation:
    'If the skill should also work in other Agent Skills tools, add a frontmatter block with `name` and ' +
    '`description` at the top of the SKILL.md file.',
  // Optional for Claude Code itself, so a missing block is a portability hint, not a defect.
  noFrontmatterSeverity: 'info',
};

/** Frontmatter-structure findings for a skill, with the Claude Code-valid cases removed or softened. */
function skillStructureIssues(
  filePath: string,
  content: string,
  parsedFm: ReturnType<typeof parseFrontmatter>,
): PromptCiIssue[] {
  // `hooks` and `metadata` are documented nested maps in skill frontmatter, so the parser's
  // "nested key" errors are not findings here.
  const fm = { ...parsedFm, errors: parsedFm.errors.filter((e) => !e.startsWith('Nested frontmatter key')) };
  return frontmatterStructureIssues(filePath, content, fm, SURFACE).map((issue) => {
    if (issue.id.startsWith('ai-config-skill-no-frontmatter-')) return { ...issue, tags: [UNSCORED_TAG] };
    if (issue.id.startsWith('ai-config-skill-fm-error-')) {
      return { ...issue, recommendation: 'Fix the frontmatter so it is valid YAML with unique keys.' };
    }
    return issue;
  });
}

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
 *  - `/Docs/x.md` is repo-root-relative and is always checked, unless its first
 *    segment is a well-known OS root (`/usr/local/bin/tool.sh`): an absolute
 *    system path says nothing about this repository.
 *  - `scripts/x.py` is looked up beside the SKILL.md, then (for a
 *    `…/skills/<name>/` layout) at the plugin root, then at the repo root.
 */
function resolutionCandidates(skillDir: string, ref: string): string[] | undefined {
  if (ref.startsWith('/')) {
    const rooted = ref.slice(1);
    return SYSTEM_ROOTS.has(rooted.split('/')[0]!) ? undefined : [rooted];
  }
  // `.claude/` and `.agents/` are skill containers, not plugin roots.
  const pluginRoot = /^(.*?)\/?skills\/[^/]+$/.exec(skillDir)?.[1];
  const isPlugin = pluginRoot && pluginRoot !== '.claude' && pluginRoot !== '.agents';
  const bases = [skillDir, ...(isPlugin ? [pluginRoot] : []), '.'];
  return [...new Set(bases.map((b) => (b === '.' || b === '' ? ref : `${b}/${ref}`)))];
}

// ── Detector ──────────────────────────────────────────────────────────────────

/** First path segments of absolute OS paths; a leading-slash ref under one is not a repo file. */
const SYSTEM_ROOTS: ReadonlySet<string> = new Set([
  'usr', 'var', 'etc', 'opt', 'tmp', 'home', 'Users', 'Library', 'bin', 'sbin', 'dev', 'proc', 'mnt',
  'private', 'System',
]);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * "Never commit `.beads/issues.jsonl`", "do not stage `out/report.html`": a
 * prohibition on committing a file is not a claim that it exists. Deliberately
 * narrow — the prohibition must be directly followed by commit/stage/check in/
 * add/push/track and the ref must be that verb's object (possibly one of a
 * short list). "Never skip `scripts/validate.sh`" or "don't edit generated
 * files; run `scripts/regen.py`" still ask the reader to use the file.
 */
function isCommitProhibition(lineText: string, ref: string): boolean {
  const bt = '`';
  const gap = `[^${bt};\\n]{0,40}`; // a few words, never crossing a backtick or clause boundary
  const re = new RegExp(
    `\\b(?:do\\s+not|don'?t|never|must\\s+not|should\\s+not|shouldn'?t)\\s+(?:\\w+\\s+)?` +
      `(?:commit|stage|check\\s+in|add|push|track)\\b` +
      // up to a few earlier backticked items of the same list, then the ref itself
      `(?:${gap}${bt}[^${bt}\\n]{1,100}${bt}){0,4}${gap}${bt}?${escapeRegExp(ref)}`,
    'i',
  );
  return re.test(lineText);
}

export function detectSkills(context: RepoContext): PromptCiIssue[] {
  const issues: PromptCiIssue[] = [];
  const parsed: ParsedSkill[] = [];
  let isIgnored: ((repoRelativePath: string) => IgnoreVerdict) | undefined;
  // pcic-e6xa: every existence check below goes through the scan's tree, so a
  // skill cannot point the scan outside the repository through a committed link
  // and a caller's file inventory answers first (pcic-csf).
  const tree = treeFor(context);

  for (const filePath of context.aiConfig.skills) {
    const content = readTextWithinRoot(context.repoRoot, filePath);
    if (content === undefined) continue;

    const dirName = toPosix(path.dirname(filePath)).split('/').pop() ?? '';
    const fm = parseFrontmatter(content);

    issues.push(...skillStructureIssues(filePath, content, fm));
    if (!fm.present) continue;

    const name = typeof fm.data.name === 'string' ? fm.data.name.trim() : undefined;
    const description = typeof fm.data.description === 'string' ? fm.data.description.trim() : undefined;

    // Claude Code: every frontmatter field is optional; `name` defaults to the directory name and
    // sets the /command (the directory name still invokes the skill), so neither of the next two is
    // a defect there. The Agent Skills specification requires `name` and requires it to match the
    // parent directory, and Codex asks for `name` too, so they stay as unscored portability hints.
    if (!name) {
      issues.push(base({
        id: id('missing-name', filePath),
        severity: 'info',
        title: 'Skill frontmatter is missing `name`',
        summary:
          `${filePath} has no \`name\` field. Claude Code uses the directory name${dirName ? ` (\`${dirName}\`)` : ''} as the ` +
          'skill\'s command, so this only matters for other tools: the Agent Skills specification and Codex ask for `name`.',
        filePaths: [filePath],
        locations: [{ filePath, startLine: 1, endLine: fm.fenceEndLine > 0 ? fm.fenceEndLine : 1 }],
        evidence: [`Keys present: ${Object.keys(fm.data).join(', ') || '(none)'}`],
        recommendation: 'If the skill should also work in other Agent Skills tools, add a `name` field that matches the skill directory name.',
        confidence: 0.5,
        tags: [UNSCORED_TAG],
      }));
    } else if (name !== dirName && dirName) {
      issues.push(base({
        id: id('name-dir-mismatch', filePath),
        severity: 'info',
        title: 'Skill `name` does not match its directory',
        summary:
          `${filePath}: frontmatter \`name: ${name}\` differs from the skill directory \`${dirName}/\`. Claude Code accepts this ` +
          '(`name` sets the command and the directory name still invokes the skill); the Agent Skills specification says ' +
          '`name` must match the parent directory, so another Agent Skills tool may treat the skill as invalid.',
        filePaths: [filePath],
        locations: [{ filePath, startLine: fm.keyLines.name ?? 1, endLine: fm.keyLines.name ?? 1 }],
        evidence: [`name: ${name}`, `directory: ${dirName}`],
        recommendation: 'If the skill should also work in other Agent Skills tools, make the directory name and `name` match; otherwise ignore this hint.',
        confidence: 0.4,
        tags: [UNSCORED_TAG],
      }));
    }

    // Description hints (advice, not a documented defect): without a `description` Claude Code falls
    // back to the first non-empty line of the body, and it truncates `description` plus `when_to_use`
    // at 1,536 characters in the skill listing, so the key use case belongs first.
    if (!description) {
      issues.push(base({
        id: id('missing-description', filePath),
        severity: 'info',
        title: 'Skill frontmatter is missing `description`',
        summary:
          `${filePath} has no \`description\`. Claude Code falls back to the first non-empty line of the body for the skill ` +
          'listing, and the Agent Skills specification and Codex ask for a description, so an explicit one may help the agent pick the skill.',
        filePaths: [filePath],
        locations: [{ filePath, startLine: 1, endLine: fm.fenceEndLine > 0 ? fm.fenceEndLine : 1 }],
        evidence: [`Keys present: ${Object.keys(fm.data).join(', ') || '(none)'}`],
        recommendation:
          'Consider adding a `description` that says what the skill does and when to use it, with the key use case first ' +
          '(Claude Code truncates `description` plus `when_to_use` at 1,536 characters in its skill listing).',
        confidence: 0.5,
        tags: [UNSCORED_TAG],
      }));
    } else if (description.length < MIN_DESCRIPTION_CHARS) {
      issues.push(base({
        id: id('empty-description', filePath),
        severity: 'info',
        title: 'Skill `description` is too short to trigger reliably',
        summary: `${filePath}: \`description\` is only ${description.length} characters. The description is what the agent reads to decide when to use the skill, so a very short one may give it little to match on (advice, not a documented limit).`,
        filePaths: [filePath],
        locations: [{ filePath, startLine: fm.keyLines.description ?? 1, endLine: fm.keyLines.description ?? 1 }],
        evidence: [`description: ${description}`],
        recommendation:
          'Consider expanding the description to say what the skill does and when to use it, with the key use case first ' +
          '(Claude Code truncates `description` plus `when_to_use` at 1,536 characters in its skill listing).',
        confidence: 0.4,
        tags: [UNSCORED_TAG],
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
      const candidates = resolutionCandidates(skillDir, ref);
      if (!candidates) continue; // e.g. `/usr/bin/tool.sh` — a system path, not a repo file
      if (candidates.some((candidate) => isFileWithinRoot(tree, candidate))) continue;
      // Local/generated state the repo's own ignore rules say is never checked in.
      isIgnored ??= createGitIgnoreChecker(tree);
      // pcic-csf: `'unknown'` means an applicable `.gitignore` exists whose text
      // the scan does not have — the reference may be ignored local state, so
      // say nothing rather than report it broken on unread rules.
      if (candidates.some((candidate) => isIgnored!(candidate) !== false)) continue;
      if (isCommitProhibition(bodyLines[line - 1] ?? '', ref)) continue;
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
      severity: 'info',
      title: 'Multiple skills share the same trigger description',
      summary: `${paths.length} skills have effectively identical \`description\` text, so the agent may find it hard to tell which to invoke for a given request.`,
      filePaths: paths,
      locations: sorted.map((s) => ({ filePath: s.filePath, startLine: 1, endLine: 1 })),
      evidence: [`Shared description: ${sorted[0]!.description}`, `Skills: ${paths.join(', ')}`],
      recommendation: 'Consider giving each skill a distinct description that states its unique trigger conditions.',
      confidence: 0.5,
      tags: [UNSCORED_TAG],
    }));
  }

  return issues;
}
