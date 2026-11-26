/**
 * Rule activation checks (pcic-k1t3.10): Windsurf / Devin Local rule files and
 * Kiro steering files whose frontmatter cannot load them the way it says.
 *
 * Both tools decide from a rule file's YAML frontmatter when the file reaches
 * the model (rule-activation.ts reads the same keys). A mistake there is silent:
 * the tool loads the rule never, or always, and nothing says so. Each check
 * below is what the vendor documents:
 *
 *  - Windsurf / Devin Local (`.windsurf/rules/*.md`, `.devin/rules/*.md`):
 *    `trigger` is one of always_on, manual, model_decision or glob; a glob rule
 *    names its files in `globs`, and a model_decision rule is matched by its
 *    `description`.
 *  - Kiro (`.kiro/steering/*.md`): `inclusion` is one of always, fileMatch,
 *    manual or auto; fileMatch needs `fileMatchPattern`, auto needs `name`
 *    and `description`, and the frontmatter must be the first content of the
 *    file (a blank line before it and Kiro reads none). A `#[[file:path]]`
 *    reference pulls a workspace file into the steering file, so it must exist.
 *
 * Findings are ai_config warnings: the rule's content is fine, its loading is
 * not. Deterministic and offline; every regex is anchored to one line and the
 * file-reference walk is an indexOf loop, so a file is read in linear time.
 */

import * as path from 'node:path';
import type { RepoContext } from './repo-context.js';
import type { InstructionFile, PromptCiIssue } from './types.js';
import { parseFrontmatter, shortHash, aiConfigIssue } from './ai-config.js';
import type { FrontmatterValue } from './ai-config.js';
import { fileIdPath } from './finding-id.js';
import { lineNumberIndex } from './linear-text.js';
import { buildCodeMask } from './markdown-fences.js';
import { isAbsoluteAnywhere, treeFor } from './repo-tree.js';

const WINDSURF_TRIGGERS: ReadonlySet<string> = new Set(['always_on', 'manual', 'model_decision', 'glob']);
const KIRO_INCLUSIONS: ReadonlySet<string> = new Set(['always', 'filematch', 'manual', 'auto']);
/** `#[[file:path]]`, optionally with a `:start-end` line range (Kiro steering docs). */
const KIRO_FILE_REF_RE = /^([^\]\s:#][^\]:]{0,300})(?::\d+-\d+)?\]\]/;
/** File references reported per steering file. */
const MAX_REFS_PER_FILE = 20;

function textValue(value: FrontmatterValue | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : undefined;
  const text = String(value).trim();
  return text === '' ? undefined : text;
}

function issue(
  file: InstructionFile,
  kind: string,
  line: number,
  fields: { title: string; summary: string; evidence: string; recommendation: string; confidence?: number; severity?: PromptCiIssue['severity'] },
): PromptCiIssue {
  const rel = fileIdPath(file);
  return aiConfigIssue({
    id: `ai-config-rule-activation-${kind}-${shortHash(`${rel}:${fields.evidence}`)}`,
    title: fields.title,
    summary: `${rel}: ${fields.summary}`,
    filePaths: [file.path],
    locations: [{ filePath: file.path, startLine: line, endLine: line }],
    evidence: [fields.evidence],
    recommendation: fields.recommendation,
    confidence: fields.confidence ?? 0.85,
    severity: fields.severity ?? 'warning',
    tags: ['rule-activation', kind],
  });
}

function windsurfIssues(file: InstructionFile): PromptCiIssue[] {
  const fm = parseFrontmatter(file.content);
  // An unclosed block is not frontmatter: its "keys" may be the whole file.
  if (!fm.present || !fm.closed) return [];
  const trigger = textValue(fm.data.trigger);
  const line = (key: string) => fm.keyLines[key] ?? 1;
  if (trigger === undefined) return [];
  const value = trigger.toLowerCase();
  if (!WINDSURF_TRIGGERS.has(value)) {
    return [
      issue(file, 'windsurf-unknown-trigger', line('trigger'), {
        title: 'Windsurf rule has an unknown trigger',
        summary: `\`trigger: ${trigger}\` is not one of the documented triggers (always_on, manual, model_decision, glob), so when the rule loads is up to the tool.`,
        evidence: `trigger: ${trigger}`,
        recommendation: 'Set trigger to always_on, manual, model_decision or glob.',
      }),
    ];
  }
  if (value === 'glob' && textValue(fm.data.globs) === undefined) {
    return [
      issue(file, 'windsurf-glob-without-globs', line('trigger'), {
        title: 'Windsurf glob rule names no files',
        summary: 'the rule is triggered by glob but has no `globs`, so no file matches it and it may never load.',
        evidence: 'trigger: glob (no globs)',
        recommendation: 'Add the file patterns the rule is for (`globs: "**/*.test.ts"`), or use trigger: always_on.',
      }),
    ];
  }
  if (value === 'model_decision' && textValue(fm.data.description) === undefined) {
    return [
      issue(file, 'windsurf-model-decision-without-description', line('trigger'), {
        title: 'Windsurf model_decision rule has no description',
        summary: 'the agent decides whether to load a model_decision rule from its description, and this rule has none.',
        evidence: 'trigger: model_decision (no description)',
        recommendation: 'Add a one-line `description` saying when the rule applies.',
        // The docs say the agent matches the description; they do not call it required.
        severity: 'info',
        confidence: 0.6,
      }),
    ];
  }
  return [];
}

function kiroFrontmatterIssues(file: InstructionFile): PromptCiIssue[] {
  const content = file.content.replace(/^\u{FEFF}/u, '');
  const fm = parseFrontmatter(content);
  if (!fm.present) {
    // Frontmatter after blank lines: Kiro needs it to be the first content of the file.
    const firstContent = /^(?:[ \t]*\r?\n)+---[ \t]*\r?\n/.exec(content);
    if (firstContent) {
      const rest = content.slice(firstContent[0].length, firstContent[0].length + 2000);
      if (/^inclusion[ \t]*:/m.test(rest) && /^---[ \t]*\r?$/m.test(rest)) {
        const line = content.slice(0, firstContent[0].length).split('\n').length - 1;
        return [
          issue(file, 'kiro-frontmatter-not-first', line, {
            title: 'Kiro steering frontmatter is not the first content',
            summary: 'blank lines come before the frontmatter, and Kiro reads frontmatter only when it is the first content of the file, so the inclusion mode is ignored.',
            evidence: 'blank line(s) before the opening ---',
            recommendation: 'Delete the blank lines above the opening `---`.',
          }),
        ];
      }
    }
    return [];
  }
  if (!fm.closed) return [];
  const inclusion = textValue(fm.data.inclusion);
  if (inclusion === undefined) return [];
  const line = (key: string) => fm.keyLines[key] ?? 1;
  const value = inclusion.toLowerCase();
  if (!KIRO_INCLUSIONS.has(value)) {
    return [
      issue(file, 'kiro-unknown-inclusion', line('inclusion'), {
        title: 'Kiro steering file has an unknown inclusion mode',
        summary: `\`inclusion: ${inclusion}\` is not one of the documented modes (always, fileMatch, manual, auto), so when the file loads is up to the tool.`,
        evidence: `inclusion: ${inclusion}`,
        recommendation: 'Set inclusion to always, fileMatch, manual or auto.',
      }),
    ];
  }
  if (value === 'filematch' && textValue(fm.data.fileMatchPattern) === undefined) {
    return [
      issue(file, 'kiro-filematch-without-pattern', line('inclusion'), {
        title: 'Kiro fileMatch steering file names no files',
        summary: 'inclusion is fileMatch but there is no `fileMatchPattern`, so no file matches it and it may never load.',
        evidence: 'inclusion: fileMatch (no fileMatchPattern)',
        recommendation: 'Add `fileMatchPattern: "components/**/*.tsx"` (a string or a list), or use inclusion: always.',
      }),
    ];
  }
  if (value === 'auto') {
    const missing = ['name', 'description'].filter((key) => textValue(fm.data[key]) === undefined);
    if (missing.length > 0) {
      return [
        issue(file, 'kiro-auto-missing-fields', line('inclusion'), {
          title: 'Kiro auto steering file is missing required fields',
          summary: `inclusion is auto, which needs both name and description, and ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} missing; Kiro matches the description against the request to decide whether to load the file.`,
          evidence: `inclusion: auto (no ${missing.join(', no ')})`,
          recommendation: 'Add `name` and a one-line `description` saying when the file applies.',
        }),
      ];
    }
  }
  return [];
}

function kiroFileRefIssues(file: InstructionFile, tree: ReturnType<typeof treeFor>): PromptCiIssue[] {
  const content = file.content;
  const lineOf = lineNumberIndex(content);
  const missing: Array<{ ref: string; line: number }> = [];
  const seen = new Set<string>();
  // A reference written in a code fence or span documents the syntax; Kiro does not resolve it.
  let code: boolean[] | undefined;
  for (let at = content.indexOf('#[[file:'); at !== -1 && missing.length < MAX_REFS_PER_FILE; at = content.indexOf('#[[file:', at + 8)) {
    code ??= buildCodeMask(content);
    if (code[at]) continue;
    const m = KIRO_FILE_REF_RE.exec(content.slice(at + 8, at + 8 + 320));
    if (!m) continue;
    const ref = m[1]!.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (!ref || seen.has(ref) || ref.includes('..') || isAbsoluteAnywhere(ref) || /[<>{}*?]/.test(ref)) continue;
    seen.add(ref);
    // Kiro resolves the path from the workspace root; one written relative to the steering file is accepted too.
    const beside = path.posix.join(path.posix.dirname(fileIdPath(file)), ref);
    if (tree.lookup(ref).state === 'missing' && tree.lookup(beside).state === 'missing') missing.push({ ref, line: lineOf(at) });
  }
  return missing.map(({ ref, line }) =>
    issue(file, 'kiro-file-ref-missing', line, {
      title: `Kiro file reference to a missing file: ${ref}`,
      summary: `the steering file pulls in \`#[[file:${ref}]]\`, which does not exist in the repository, so the agent gets nothing from it.`,
      evidence: `#[[file:${ref}]]`,
      recommendation: 'Point the reference at the file\'s current path (relative to the workspace root), or remove it.',
      confidence: 0.8,
    }),
  );
}

export function detectRuleActivation(context: RepoContext): PromptCiIssue[] {
  const tree = treeFor(context);
  const issues: PromptCiIssue[] = [];
  for (const file of context.files) {
    const rel = fileIdPath(file);
    if (file.fileType === 'windsurf' && /^\.(?:windsurf|devin)\/rules\//.test(rel)) issues.push(...windsurfIssues(file));
    if (file.fileType === 'kiro') {
      issues.push(...kiroFrontmatterIssues(file));
      issues.push(...kiroFileRefIssues(file, tree));
    }
  }
  return issues;
}
