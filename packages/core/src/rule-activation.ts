/**
 * When a tool loads a rule file (pcic-k1t3.10): on every request, or only for
 * some files, modes or requests.
 *
 * Several tools let one rule file say, in YAML frontmatter or by where it sits,
 * that it is not always loaded. A check that compares what every tool is told on
 * every request (cross-tool-parity) must leave those files out, or it reads a
 * rule meant for `*.test.ts` files, or for one Roo Code mode, as the repository's
 * rule. The formats, as each vendor documents them:
 *
 *  - Cursor `.cursor/rules/*.mdc`: always only with `alwaysApply: true`; otherwise
 *    attached by `globs`, by `description` or by hand.
 *  - Windsurf / Devin Local `.windsurf/rules/*.md`, `.devin/rules/*.md`:
 *    `trigger: always_on` loads every session; `glob`, `model_decision` and
 *    `manual` load only for matching files, when judged relevant, or on request.
 *  - Kiro `.kiro/steering/*.md`: `inclusion: always` (the default with no
 *    frontmatter); `fileMatch`, `manual` and `auto` are conditional.
 *  - Roo Code: `.roo/rules-<mode>/` and `.roorules-<mode>` apply only in that mode;
 *    every other Roo Code rule file (an `.mdc` one too) is always loaded.
 *  - Copilot `.instructions.md`, Cursor and any other rule file without a format
 *    of its own: `applyTo:` or `globs:` with a value scopes it, unless
 *    `alwaysApply: true` says otherwise. Amazon Q and Junie document no
 *    frontmatter, so their files are always loaded; Kiro and Windsurf decide by
 *    `inclusion` / `trigger` alone.
 *
 * Two scoped rules with different scopes (two Roo Code modes, two Kiro
 * fileMatchPatterns, two Copilot applyTo or Cursor globs) are never loaded
 * together, so they cannot contradict each other in one request
 * ({@link neverLoadedTogether}). Codex reads AGENTS.override.md instead of the
 * AGENTS.md in the same directory ({@link agentsOverridePairs}).
 *
 * Deterministic and offline: it reads only the file's own path and text.
 */

import * as path from 'node:path';
import type { FileType, InstructionFile } from './types.js';
import { fileIdPath } from './finding-id.js';
import { ROO_MODE_SLUG } from './discovery.js';

/** `always`: loaded on every request. `scoped`: loaded only for some files, modes or requests. */
export type RuleActivation = 'always' | 'scoped';

/** The first YAML frontmatter block's text, or '' when the file has none. The closing `---` must be a line of its own. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function frontmatterOf(content: string): string {
  return FRONTMATTER_RE.exec(content.replace(/^\u{FEFF}/u, ''))?.[1] ?? '';
}

/** A top-level scalar `key: value` of the frontmatter, unquoted and lower-cased; undefined when absent or empty. */
function scalar(frontmatter: string, key: 'trigger' | 'inclusion'): string | undefined {
  const re = key === 'trigger' ? /^trigger[ \t]*:[ \t]*(.*)$/m : /^inclusion[ \t]*:[ \t]*(.*)$/m;
  const raw = re.exec(frontmatter)?.[1]?.replace(/[ \t]+#.*$/, '').trim();
  if (raw === undefined) return undefined;
  const value = raw.replace(/^(['"])(.*)\1$/, '$2').trim().toLowerCase();
  return value === '' ? undefined : value;
}

/**
 * A frontmatter key's value as a list (`a, b`, `[a, b]` or `- a` lines below
 * the key), each item unquoted, sorted and comma-joined: a stable key to compare
 * two files' scopes by. Undefined when the key is absent or empty. Reads one
 * line at a time, so it stays linear in the frontmatter's length.
 */
function listValue(frontmatter: string, key: string): string | undefined {
  const lines = frontmatter.split(/\r?\n/);
  const wanted = key.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const m = /^[ \t]*([A-Za-z_]+)[ \t]*:[ \t]*(.*)$/.exec(lines[i]!);
    if (!m || m[1]!.toLowerCase() !== wanted) continue;
    const items: string[] = [];
    const inline = m[2]!.replace(/[ \t]+#.*$/, '').trim();
    if (inline !== '') {
      items.push(...inline.replace(/^\[/, '').replace(/\]$/, '').split(','));
    } else {
      for (let j = i + 1; j < lines.length; j++) {
        const item = /^[ \t]*-[ \t]*(.*)$/.exec(lines[j]!);
        if (!item) break;
        items.push(item[1]!);
      }
    }
    const values = items.map((s) => s.trim().replace(/^(['"])(.*)\1$/, '$2').trim()).filter((s) => s !== '').sort();
    return values.length > 0 ? values.join(',') : undefined;
  }
  return undefined;
}

/**
 * `alwaysApply: true` on a frontmatter line. Horizontal whitespace only, so the
 * match stays linear in the frontmatter's length (a `\s*` here could span lines).
 */
const ALWAYS_APPLY_RE = /^[ \t]*alwaysApply[ \t]*:[ \t]*true[ \t]*\r?$/im;
/** A `globs:` or `applyTo:` key with a value, on its line or as a `- item` list below it. */
const SCOPE_KEY_RE = /^[ \t]*(?:globs|applyTo)[ \t]*:[ \t]*(?:[^\s]|\r?\n[ \t]*-)/im;
/**
 * Types whose own format decides activation without `globs` / `applyTo`: Kiro
 * (`inclusion`), Windsurf (`trigger`), and Amazon Q and Junie, whose docs
 * describe no frontmatter at all (every rule file is loaded).
 */
const OWN_ACTIVATION_TYPES: ReadonlySet<FileType> = new Set<FileType>(['kiro', 'windsurf', 'amazonq', 'junie']);

/** Windsurf / Devin Local triggers that load a rule only for some files or requests. */
const WINDSURF_SCOPED_TRIGGERS: ReadonlySet<string> = new Set(['glob', 'model_decision', 'manual']);
/** Kiro inclusion modes that load a steering file only for some files or requests. */
const KIRO_SCOPED_INCLUSIONS: ReadonlySet<string> = new Set(['filematch', 'manual', 'auto']);
/** Roo Code mode-specific rules: a `.roo/rules-<mode>/` directory or a `.roorules-<mode>` file; group 1 or 2 is the mode. */
const ROO_MODE_RULE_RE = new RegExp(`^(?:\\.roo/rules-([^/]+)/|\\.roorules-(${ROO_MODE_SLUG})$)`);

type ActivationInput = Pick<InstructionFile, 'path' | 'relativePath' | 'fileType' | 'content'>;

/** When the tool that reads `file` loads it; see the module doc for each format. */
export function ruleActivation(file: ActivationInput): RuleActivation {
  const rel = fileIdPath(file);
  const fm = frontmatterOf(file.content);
  const alwaysApply = ALWAYS_APPLY_RE.test(fm);
  // Roo Code reads every file of its rule directories whatever the extension or
  // frontmatter; only the mode-specific directories and files are scoped.
  if (file.fileType === 'roo') return ROO_MODE_RULE_RE.test(rel) ? 'scoped' : 'always';
  // Cursor project rules are attached by description or glob unless they say alwaysApply.
  if (/\.mdc$/i.test(rel)) return alwaysApply ? 'always' : 'scoped';
  // The trigger / inclusion mode decides on its own: an always-on rule that also
  // lists `globs` is still loaded every session, and one with no trigger is too.
  if (file.fileType === 'windsurf') {
    const trigger = scalar(fm, 'trigger');
    return trigger !== undefined && WINDSURF_SCOPED_TRIGGERS.has(trigger) ? 'scoped' : 'always';
  }
  if (file.fileType === 'kiro') {
    const inclusion = scalar(fm, 'inclusion');
    return inclusion !== undefined && KIRO_SCOPED_INCLUSIONS.has(inclusion) ? 'scoped' : 'always';
  }
  if (OWN_ACTIVATION_TYPES.has(file.fileType)) return 'always';
  if (alwaysApply) return 'always';
  return SCOPE_KEY_RE.test(fm) ? 'scoped' : 'always';
}

/**
 * What a scoped rule is scoped to, comparable between files: `mode:<slug>` for a
 * Roo Code mode rule, `files:<patterns>` for a Kiro fileMatchPattern, a Windsurf
 * glob trigger's `globs`, a Copilot `applyTo` or a Cursor/other `globs`.
 * Undefined for an always-loaded file and for a rule loaded on request or by
 * description (it may be loaded alongside anything).
 */
export function ruleScopeKey(file: ActivationInput): string | undefined {
  const rel = fileIdPath(file);
  if (file.fileType === 'roo') {
    const m = ROO_MODE_RULE_RE.exec(rel);
    return m ? `mode:${(m[1] ?? m[2])!.toLowerCase()}` : undefined;
  }
  if (ruleActivation(file) !== 'scoped') return undefined;
  const fm = frontmatterOf(file.content);
  let patterns: string | undefined;
  if (file.fileType === 'kiro') {
    patterns = scalar(fm, 'inclusion') === 'filematch' ? listValue(fm, 'fileMatchPattern') : undefined;
  } else if (file.fileType === 'windsurf') {
    patterns = scalar(fm, 'trigger') === 'glob' ? listValue(fm, 'globs') : undefined;
  } else {
    patterns = listValue(fm, 'applyTo') ?? listValue(fm, 'globs');
  }
  return patterns === undefined ? undefined : `files:${patterns}`;
}

/**
 * True when two different files are scoped rules with different scopes, so no
 * single request loads both: two Roo Code modes, or two file patterns. A conflict
 * between them is not one an agent ever sees.
 */
export function neverLoadedTogether(a: ActivationInput, b: ActivationInput): boolean {
  if (a === b || fileIdPath(a) === fileIdPath(b)) return false;
  const keyA = ruleScopeKey(a);
  const keyB = ruleScopeKey(b);
  return keyA !== undefined && keyB !== undefined && keyA !== keyB;
}

/**
 * Each directory's [AGENTS.md, AGENTS.override.md] when both are scanned: Codex
 * reads the override INSTEAD of the AGENTS.md beside it (at most one file per
 * directory), so the two are never loaded together by Codex, and an override
 * exists precisely to say something else.
 */
export function agentsOverridePairs<T extends Pick<InstructionFile, 'path' | 'relativePath'>>(files: readonly T[]): Array<[T, T]> {
  const byDir = new Map<string, { agents?: T; override?: T }>();
  for (const f of files) {
    const rel = fileIdPath(f);
    const base = path.posix.basename(rel);
    if (base !== 'AGENTS.md' && base !== 'AGENTS.override.md') continue;
    const dir = path.posix.dirname(rel);
    const entry = byDir.get(dir) ?? {};
    if (base === 'AGENTS.md') entry.agents = f;
    else entry.override = f;
    byDir.set(dir, entry);
  }
  const pairs: Array<[T, T]> = [];
  for (const dir of [...byDir.keys()].sort()) {
    const { agents, override } = byDir.get(dir)!;
    if (agents && override) pairs.push([agents, override]);
  }
  return pairs;
}
