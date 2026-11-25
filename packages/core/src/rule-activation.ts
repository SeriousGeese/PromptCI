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
 *  - Copilot `.instructions.md` and any other rule file: `applyTo:` or `globs:`
 *    with a value scopes it, unless `alwaysApply: true` says otherwise.
 *
 * Deterministic and offline: it reads only the file's own path and text.
 */

import type { InstructionFile } from './types.js';
import { fileIdPath } from './finding-id.js';

/** `always`: loaded on every request. `scoped`: loaded only for some files, modes or requests. */
export type RuleActivation = 'always' | 'scoped';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

/** The first YAML frontmatter block's text, or '' when the file has none. */
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
 * `alwaysApply: true` on a frontmatter line. Horizontal whitespace only, so the
 * match stays linear in the frontmatter's length (a `\s*` here could span lines).
 */
const ALWAYS_APPLY_RE = /^[ \t]*alwaysApply[ \t]*:[ \t]*true[ \t]*\r?$/im;
/** A `globs:` or `applyTo:` key with a value, on its line or as a `- item` list below it. */
const SCOPE_KEY_RE = /^[ \t]*(?:globs|applyTo)[ \t]*:[ \t]*(?:[^\s]|\r?\n[ \t]*-)/im;

/** Windsurf / Devin Local triggers that load a rule only for some files or requests. */
const WINDSURF_SCOPED_TRIGGERS: ReadonlySet<string> = new Set(['glob', 'model_decision', 'manual']);
/** Kiro inclusion modes that load a steering file only for some files or requests. */
const KIRO_SCOPED_INCLUSIONS: ReadonlySet<string> = new Set(['filematch', 'manual', 'auto']);
/** Roo Code mode-specific rules: a `.roo/rules-<mode>/` directory or a `.roorules-<mode>` file. */
const ROO_MODE_RULE_RE = /^(?:\.roo\/rules-[^/]+\/|\.roorules-[^/]+$)/;

/** When the tool that reads `file` loads it; see the module doc for each format. */
export function ruleActivation(file: Pick<InstructionFile, 'path' | 'relativePath' | 'fileType' | 'content'>): RuleActivation {
  const rel = fileIdPath(file);
  const fm = frontmatterOf(file.content);
  const alwaysApply = ALWAYS_APPLY_RE.test(fm);
  // Roo Code reads every file of its rule directories whatever the extension or
  // frontmatter; only the mode-specific directories and files are scoped.
  if (file.fileType === 'roo') return ROO_MODE_RULE_RE.test(rel) ? 'scoped' : 'always';
  // Cursor project rules are attached by description or glob unless they say alwaysApply.
  if (/\.mdc$/i.test(rel)) return alwaysApply ? 'always' : 'scoped';
  // The trigger / inclusion mode decides on its own: an always-on rule that also
  // lists `globs` is still loaded every session.
  if (file.fileType === 'windsurf') {
    const trigger = scalar(fm, 'trigger');
    if (trigger === 'always_on') return 'always';
    if (trigger !== undefined && WINDSURF_SCOPED_TRIGGERS.has(trigger)) return 'scoped';
  }
  if (file.fileType === 'kiro') {
    const inclusion = scalar(fm, 'inclusion');
    if (inclusion === 'always') return 'always';
    if (inclusion !== undefined && KIRO_SCOPED_INCLUSIONS.has(inclusion)) return 'scoped';
  }
  if (alwaysApply) return 'always';
  return SCOPE_KEY_RE.test(fm) ? 'scoped' : 'always';
}
