/**
 * Cross-tool parity detector (pcic-sev5).
 *
 * A repository that carries more than one tool's instruction file (AGENTS.md,
 * CLAUDE.md, .cursorrules, .github/copilot-instructions.md, GEMINI.md, ...)
 * hands each tool a different rulebook. When another tool's file disagrees with
 * AGENTS.md on a concrete, checkable fact, two people on the same repo get
 * different agent behaviour from the same prompt, and nobody sees it because
 * each tool only reads its own file. This detector compares what each TOOL FILE
 * says with what AGENTS.md says about three facts:
 *
 *   - the package manager (`pnpm install` in one, `npm install` in the other, or
 *     one file ruling out what the other uses),
 *   - the test runner (`vitest` vs `jest`, `pytest` vs `unittest`),
 *   - a path not to edit (one file says never edit `src/generated/`, the other
 *     tells the reader to edit or add files there).
 *
 * Deliberately narrow, because a parity finding that is only sometimes right
 * trains people to ignore the rest (review of PR 167, recorded on pcic-sev5):
 *
 *   - AGENTS.md is the anchor. Each other tool file in the same scope is
 *     compared with it, once per fact. With no AGENTS.md in a scope there is
 *     nothing to be "in parity with", and nothing is reported.
 *   - A file that is identical or near-identical to AGENTS.md (a mirror) cannot
 *     disagree with it and is skipped.
 *   - Only tool instruction files in the same scope are compared: a nested
 *     package's CLAUDE.md may differ. A tool directory (.cursor/, .github/ ...)
 *     belongs to the directory that holds it. `.claude/commands/` and
 *     `.claude/agents/` hold task prompts, not the rulebook, and are skipped, as
 *     are Cursor `.mdc` rules without `alwaysApply: true` and any rule file with
 *     `globs:` / `applyTo:`.
 *   - Negation is read against the whole line ("Avoid npm", "instead of `npm
 *     install`"), and a fenced block introduced as wrong or bad is not usage.
 *   - A command that is directory-scoped (`cd docs && npm install`, "standalone",
 *     "from packages/sdk") says nothing about the repository's choice.
 *   - Forbidden path: only "never edit/modify/change X" against "edit/update X". A
 *     prohibition on committing or deleting is not the opposite of adding, and an
 *     "update X" done by running a command is not an edit by hand.
 *   - Test commands: only different RUNNERS contradict. Two script names of the
 *     same runner (`pnpm test` vs `pnpm test:unit`) do not.
 *   - Findings are `info` and tagged unscored: they cost no health-score points
 *     until precision has been measured on a larger corpus.
 *
 * Wording is cautious and nothing is auto-applied: the usual repair (a pointer
 * file to AGENTS.md) discards one file's wording, which only a person can judge.
 *
 * Deterministic: no clock, network or randomness; files and findings are
 * emitted in a fixed order.
 */

import * as crypto from 'node:crypto';
import type { FileType, InstructionFile, PromptCiIssue } from './types.js';
import { scanFencedLines } from './markdown-fences.js';
import { fileIdPath } from './finding-id.js';
import { snippet } from './evidence.js';
import { UNSCORED_TAG } from './health-score.js';

/** The file types that are one tool's own instruction file. */
const TOOL_TYPES: ReadonlySet<FileType> = new Set<FileType>([
  'claude', 'agents', 'cursor', 'windsurf', 'copilot', 'gemini', 'cline',
]);

/**
 * Directories that hold one tool's instruction files and belong to the scope
 * above them. Any other hidden directory (`.config/`, `.devcontainer/`) is a
 * scope of its own: stripping it would compare unrelated files.
 */
const TOOL_DIRS: ReadonlySet<string> = new Set(['.github', '.cursor', '.windsurf', '.clinerules', '.claude', '.gemini', '.codex']);

/** Near-identical files: at least this share of their distinct lines in common. */
const MIRROR_SIMILARITY = 0.9;

type Place = { line: number; text: string };

type FileFacts = {
  file: InstructionFile;
  label: string;
  /** Package managers the file shows being used. */
  pmUsed: Map<string, Place>;
  /** Package managers the file tells the reader NOT to use. */
  pmForbidden: Map<string, Place>;
  /** Test runners the file shows being used, per family. */
  runners: Map<string, Map<string, Place>>;
  /** Paths the file says not to edit. */
  pathsForbidden: Map<string, Place>;
  /** Paths the file tells the reader to edit or add to. */
  pathsEdited: Map<string, Place>;
};

// ── Eligibility, scope and mirrors ───────────────────────────────────────────

/** Task prompts and sub-agent definitions under .claude/: not the rulebook. */
function isTaskPromptFile(file: InstructionFile): boolean {
  return /(?:^|\/)\.claude\/(?:commands|agents)\//.test(fileIdPath(file));
}

/** Rule files that apply to part of the tree or only when asked for. */
function isScopedRuleFile(file: InstructionFile): boolean {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(file.content)?.[1] ?? '';
  const alwaysApply = /^\s*alwaysApply\s*:\s*true\s*$/im.test(frontmatter);
  // Cursor project rules (.mdc) are attached by description or glob unless they say alwaysApply.
  if (/\.mdc$/i.test(fileIdPath(file))) return !alwaysApply;
  if (alwaysApply) return false;
  return /^\s*(?:globs|applyTo)\s*:\s*\S/im.test(frontmatter);
}

/** The directory whose rules a tool file sets: its own, with a tool directory stripped. */
function scopeOf(file: InstructionFile): string {
  const dirs = fileIdPath(file).split('/').slice(0, -1);
  const tool = dirs.findIndex((s) => TOOL_DIRS.has(s));
  return (tool === -1 ? dirs : dirs.slice(0, tool)).join('/');
}

function isAnchor(file: InstructionFile): boolean {
  return file.fileType === 'agents' && /(?:^|\/)agents\.md$/i.test(fileIdPath(file));
}

function distinctLines(content: string): Set<string> {
  return new Set(content.split('\n').map((l) => l.replace(/\s+/g, ' ').trim().toLowerCase()).filter((l) => l !== ''));
}

/** Identical or near-identical content: a mirror of the anchor cannot disagree with it. */
function isMirror(a: InstructionFile, b: InstructionFile): boolean {
  const la = distinctLines(a.content);
  const lb = distinctLines(b.content);
  if (la.size === 0 && lb.size === 0) return true;
  let common = 0;
  for (const l of la) if (lb.has(l)) common++;
  return common / (la.size + lb.size - common) >= MIRROR_SIMILARITY;
}

// ── Line walking ─────────────────────────────────────────────────────────────

type ScannedLine = {
  n: number;
  text: string;
  fence: boolean;
  lang: string;
  /** In a fenced block introduced as wrong, bad or "don't". */
  negatedBlock: boolean;
  /** In a fenced block that `cd`s elsewhere or is introduced as directory-specific. */
  scopedBlock: boolean;
};

/** Fence languages whose lines are shell-ish and may hold a command to run. */
const SHELL_LANGS: ReadonlySet<string> = new Set(['', 'bash', 'sh', 'shell', 'zsh', 'console', 'terminal', 'cmd', 'powershell', 'ps1']);

/** A label that says the following example is what NOT to do. */
const WRONG_LABEL_RE = /\b(?:wrong|bad|incorrect|don'?t|do\s+not|never|avoid|deprecated|instead\s+of|not\s+this|anti-?pattern|legacy|old)\b|❌|✗/i;

/** Text that confines a command to one directory or package. */
const DIR_SCOPE_RE = /\b(?:standalone|separate(?:ly)?|sub-?packages?|in\s+the\s+[`\w./-]+\s+(?:directory|folder|package|app|workspace|project)|inside\s+(?:the\s+)?[`\w./-]+|from\s+(?:the\s+)?`?[\w.-]+\/[\w./-]*)/i;

/** `cd dir` that moves somewhere other than up or here. */
const CD_RE = /\bcd\s+(?!\.\.?(?:\s|&|;|$))[^\s&;|]+/;

function scanLines(content: string): ScannedLine[] {
  const out: ScannedLine[] = [];
  let prevText = '';
  let negated = false;
  let scoped = false;
  for (const l of scanFencedLines(content)) {
    const text = l.text.replace(/\r$/, '');
    if (l.kind === 'open') {
      negated = WRONG_LABEL_RE.test(prevText);
      scoped = DIR_SCOPE_RE.test(prevText);
      continue;
    }
    if (l.kind === 'close') continue;
    if (!l.inFence) {
      if (text.trim() !== '') prevText = text;
      out.push({ n: l.lineNumber, text, fence: false, lang: '', negatedBlock: false, scopedBlock: false });
      continue;
    }
    if (CD_RE.test(text)) scoped = true; // everything from a `cd` on runs somewhere else
    out.push({ n: l.lineNumber, text, fence: true, lang: l.lang, negatedBlock: negated, scopedBlock: scoped });
  }
  return out;
}

type Segment = { text: string; at: number };

/** Parts of a line that can hold a command: a shell fence line in full, otherwise its code spans. */
function commandSegments(line: ScannedLine): Segment[] {
  if (line.fence) {
    if (!SHELL_LANGS.has(line.lang) || /^\s*#/.test(line.text)) return [];
    const lead = /^\s*(?:[$>]\s+)?/.exec(line.text)![0].length;
    return [{ text: line.text.slice(lead), at: lead }];
  }
  return [...line.text.matchAll(/(`+)([^`]+)\1/g)].map((m) => ({ text: m[2]!, at: m.index + m[1]!.length }));
}

/**
 * A negation earlier in the SAME CLAUSE of the whole line, not just inside a code
 * span. A clause ends at `.`, `;`, `:`, `,`, `!`, `?` or a dash, so "Never
 * hand-edit either tree — run `pnpm build`" does not rule out pnpm.
 */
const NEGATION_BEFORE_RE = /\b(?:never|don'?t|do\s+not|must\s+not|should\s+not|shouldn'?t|avoid|instead\s+of|rather\s+than|not|wrong|bad)\b(?:(?!\s-\s)[^.;:,!?—–])*$/i;

/** True when the mention at `at` in `line` is negated, directory-scoped or sits in a wrong/scoped block. */
function mentionContext(line: ScannedLine, at: number): { negated: boolean; scoped: boolean } {
  const before = line.text.slice(0, at);
  return {
    negated: line.negatedBlock || NEGATION_BEFORE_RE.test(before),
    scoped: line.scopedBlock || CD_RE.test(before) || (!line.fence && DIR_SCOPE_RE.test(line.text)),
  };
}

// ── Package manager ──────────────────────────────────────────────────────────

const PMS = ['npm', 'pnpm', 'yarn', 'bun'] as const;
const PM_ALT = PMS.join('|');
// `publish` and `exec` are not the repository's install tool and are left out.
const PM_VERBS = 'install|i|ci|add|run|test|start|build|dev|lint|remove|update|upgrade';
const PM_COMMAND_RE = new RegExp(`(?:^|[\\s(;&|])(${PM_ALT})\\s+(?:${PM_VERBS})\\b([^\\n;&|]*)`, 'gi');
const NOT_A_PM_NOUN = '(?!\\s+(?:packages?|modules?|registry|scripts?|workspaces?|dependenc\\w+|audit|lockfile|cache))';
const PM_USE_RE = new RegExp(`\\b(?:use|uses|using|prefer|stick\\s+to|always\\s+use|run\\s+with|managed\\s+(?:by|with))\\s+(?:the\\s+)?(${PM_ALT})\\b${NOT_A_PM_NOUN}`, 'gi');
const PM_FORBID_RE = new RegExp(`\\b(?:never|don'?t|do\\s+not|must\\s+not|should\\s+not|shouldn'?t|avoid|instead\\s+of|rather\\s+than|not)\\s+(?:use\\s+|using\\s+|run\\s+|with\\s+)?(?:the\\s+)?(${PM_ALT})\\b${NOT_A_PM_NOUN}`, 'gi');
const GLOBAL_RE = /(?:\s-g\b|--global\b)/;

function collectPackageManagers(lines: ScannedLine[], facts: FileFacts): void {
  const first = (map: Map<string, Place>, pm: string, line: ScannedLine): void => {
    if (!map.has(pm)) map.set(pm, { line: line.n, text: snippet(line.text.trim(), 100) });
  };
  for (const line of lines) {
    for (const seg of commandSegments(line)) {
      for (const m of seg.text.matchAll(PM_COMMAND_RE)) {
        if (GLOBAL_RE.test(m[0])) continue; // a global tool install is not the project's package manager
        const pm = m[1]!.toLowerCase();
        const ctx = mentionContext(line, seg.at + m.index + m[0].toLowerCase().indexOf(pm));
        if (ctx.negated) first(facts.pmForbidden, pm, line);
        else if (!ctx.scoped) first(facts.pmUsed, pm, line);
      }
    }
    if (line.fence) continue;
    for (const m of line.text.matchAll(PM_FORBID_RE)) first(facts.pmForbidden, m[1]!.toLowerCase(), line);
    for (const m of line.text.matchAll(PM_USE_RE)) {
      const ctx = mentionContext(line, m.index);
      if (!ctx.negated && !ctx.scoped) first(facts.pmUsed, m[1]!.toLowerCase(), line);
    }
  }
  // Said on one line as both used and ruled out ("not npm"): the prohibition wins.
  for (const pm of facts.pmForbidden.keys()) {
    if (facts.pmUsed.get(pm)?.line === facts.pmForbidden.get(pm)!.line) facts.pmUsed.delete(pm);
  }
}

// ── Test runner ──────────────────────────────────────────────────────────────

// A whole word: not part of `jest-dom`, `@testing-library/jest-dom`, `./bin/jest` or `java`.
const RUNNERS: ReadonlyArray<{ family: string; re: RegExp }> = [
  { family: 'js-runner', re: /(?<![\w./@-])(vitest|jest|mocha|ava)(?![\w-])/gi },
  { family: 'py', re: /(?<![\w./@-])(pytest)(?![\w-])/gi },
  { family: 'py', re: /(?<![\w./@-])python3?\s+-m\s+(unittest)(?![\w-])/gi },
];

function collectRunners(lines: ScannedLine[], facts: FileFacts): void {
  for (const line of lines) {
    for (const seg of commandSegments(line)) {
      for (const { family, re } of RUNNERS) {
        for (const m of seg.text.matchAll(re)) {
          const ctx = mentionContext(line, seg.at + m.index);
          if (ctx.negated || ctx.scoped) continue;
          const byValue = facts.runners.get(family) ?? new Map<string, Place>();
          const value = m[1]!.toLowerCase();
          if (!byValue.has(value)) byValue.set(value, { line: line.n, text: snippet(line.text.trim(), 100) });
          facts.runners.set(family, byValue);
        }
      }
    }
  }
}

// ── Forbidden paths ──────────────────────────────────────────────────────────

// Only editing: a rule against committing or deleting a path is not the opposite of adding to it.
const FORBID_EDIT_RE = /\b(?:never|don'?t|do\s+not|must\s+not|should\s+not|shouldn'?t|avoid)\s+(?:\w+\s+){0,2}?(?:edit|modify|change|alter|overwrite|rewrite|touch)\b/i;
/** A prohibition limited to one way of doing it ("by hand", "directly") does not forbid the path. */
const SCOPED_PROHIBITION_RE = /\b(?:by\s+hand|manually|directly|unless|except|without\s+(?:running|regenerat))/i;
const EDIT_VERB_RE = /\b(?:edit|modify|update|change|add\s+(?:\w+\s+){0,3}?(?:to|in|under)|write\s+(?:to|in)|create\s+(?:\w+\s+){0,3}?(?:in|under))\b/i;
const ANY_NEGATION_RE = /\b(?:never|not|don'?t|do\s+not|avoid|no\s+longer|read-?only|off-?limits|generated|regenerate|auto-?generated)\b|n't\b/i;
/** The update is done by running something, not by editing the file. */
const DONE_BY_COMMAND_RE = /\b(?:run|runs|via|using|generate[sd]?|regenerat\w*|by\s+running|script)\b/i;

/** A backticked token that names a repo path: has a slash or a file extension, no glob in the middle. */
function pathTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/`([^`\s]+)`/g)) {
    const token = m[1]!.replace(/^\.\//, '').replace(/\/(?:\*\*?(?:\/\*)?)$/, '/').replace(/\/+$/, '');
    if (token === '' || token.includes('*') || token.includes('{') || /^[a-z]+:/i.test(token) || token.startsWith('/') || token.startsWith('~')) continue;
    if (!token.includes('/') && !/\.\w{1,6}$/.test(token)) continue;
    if (/\s|[<>$|]/.test(token)) continue;
    out.push(token);
  }
  return out;
}

function collectPaths(lines: ScannedLine[], facts: FileFacts): void {
  for (const line of lines) {
    if (line.fence) continue;
    const tokens = pathTokens(line.text);
    if (tokens.length === 0) continue;
    const place = { line: line.n, text: snippet(line.text.trim(), 100) };
    const withoutPaths = line.text.replace(/`[^`\s]*`/g, ' ');
    const hasCommandSpan = /`[^`]*\s[^`]*`/.test(line.text);
    if (FORBID_EDIT_RE.test(line.text) && !SCOPED_PROHIBITION_RE.test(line.text)) {
      for (const t of tokens) if (!facts.pathsForbidden.has(t)) facts.pathsForbidden.set(t, place);
    } else if (EDIT_VERB_RE.test(line.text) && !ANY_NEGATION_RE.test(withoutPaths) && !DONE_BY_COMMAND_RE.test(withoutPaths) && !hasCommandSpan) {
      for (const t of tokens) if (!facts.pathsEdited.has(t)) facts.pathsEdited.set(t, place);
    }
  }
}

// ── Findings ─────────────────────────────────────────────────────────────────

type Mention = { facts: FileFacts; place: Place };

type Finding = {
  dimension: 'package manager' | 'test runner' | 'forbidden path';
  scope: string;
  key: string;
  title: string;
  sides: string[];
  mentions: Mention[];
  confidence: number;
};

function issueId(dimension: string, scope: string, key: string): string {
  const hash = crypto.createHash('sha1').update(`cross-tool-parity:${dimension}:${scope}:${key}`).digest('hex').slice(0, 12);
  return `cross-tool-parity-${hash}`;
}

function singleKey(map: Map<string, Place> | undefined): string | undefined {
  return map && map.size === 1 ? [...map.keys()][0] : undefined;
}

/** Findings of one tool file against the anchor. */
function compareToAnchor(anchor: FileFacts, other: FileFacts, scope: string, manifestPm: string | undefined): Finding[] {
  const found: Finding[] = [];
  const pair = `${other.label}`;
  const manifestCovers = (pm: string, place: Place | undefined): boolean =>
    manifestPm !== undefined && manifestPm !== 'unknown' && pm !== manifestPm &&
    new RegExp(`\\b${pm}\\s+(?:install|add|run|exec|dlx|i)\\b`, 'i').test(place?.text ?? '');

  // Package manager: two different single choices, or one file ruling out what the other uses.
  const pmA = singleKey(anchor.pmUsed);
  const pmO = singleKey(other.pmUsed);
  if (pmA && pmO && pmA !== pmO) {
    if (!manifestCovers(pmA, anchor.pmUsed.get(pmA)) && !manifestCovers(pmO, other.pmUsed.get(pmO))) {
      const mentions: Mention[] = [
        { facts: anchor, place: anchor.pmUsed.get(pmA)! },
        { facts: other, place: other.pmUsed.get(pmO)! },
      ];
      const explicit = anchor.pmForbidden.has(pmO) || other.pmForbidden.has(pmA);
      if (anchor.pmForbidden.has(pmO)) mentions.push({ facts: anchor, place: anchor.pmForbidden.get(pmO)! });
      if (other.pmForbidden.has(pmA)) mentions.push({ facts: other, place: other.pmForbidden.get(pmA)! });
      found.push({
        dimension: 'package manager', scope, key: `${pair}:${[pmA, pmO].sort().join('|')}`,
        title: `Possible package manager disagreement with ${anchor.label}: ${other.label} uses ${pmO}, ${anchor.label} uses ${pmA}`,
        sides: [`${anchor.label} uses ${pmA}`, `${other.label} uses ${pmO}`],
        mentions, confidence: explicit ? 0.75 : 0.65,
      });
    }
  } else {
    for (const [x, y] of [[anchor, other], [other, anchor]] as const) {
      for (const pm of x.pmForbidden.keys()) {
        const used = y.pmUsed.get(pm);
        if (!used || manifestCovers(pm, used)) continue;
        found.push({
          dimension: 'package manager', scope, key: `${pair}:forbid:${pm}`,
          title: `Possible package manager disagreement with ${anchor.label}: ${pm} is used in ${y.label} and ruled out in ${x.label}`,
          sides: [`${x.label} says not to use ${pm}`, `${y.label} uses ${pm}`],
          mentions: [{ facts: x, place: x.pmForbidden.get(pm)! }, { facts: y, place: used }], confidence: 0.7,
        });
      }
    }
  }

  // Test runner: one runner per family on each side, and they differ.
  for (const family of ['js-runner', 'py']) {
    const ta = anchor.runners.get(family);
    const to = other.runners.get(family);
    const va = singleKey(ta);
    const vo = singleKey(to);
    if (!va || !vo || va === vo) continue;
    found.push({
      dimension: 'test runner', scope, key: `${pair}:${family}:${[va, vo].sort().join('|')}`,
      title: `Possible test runner disagreement with ${anchor.label}: ${other.label} runs ${vo}, ${anchor.label} runs ${va}`,
      sides: [`${anchor.label} runs ${va}`, `${other.label} runs ${vo}`],
      mentions: [{ facts: anchor, place: ta!.get(va)! }, { facts: other, place: to!.get(vo)! }], confidence: 0.55,
    });
  }

  // Forbidden path: one file rules a path out, the other tells the reader to edit it.
  for (const [x, y] of [[anchor, other], [other, anchor]] as const) {
    for (const [forbidden, place] of x.pathsForbidden) {
      for (const [edited, editPlace] of y.pathsEdited) {
        if (edited !== forbidden && !edited.startsWith(`${forbidden}/`)) continue;
        found.push({
          dimension: 'forbidden path', scope, key: `${pair}:${forbidden}`,
          title: `Possible forbidden path disagreement with ${anchor.label}: ${forbidden}`,
          sides: [`${x.label} says not to edit ${forbidden}`, `${y.label} says to edit ${edited}`],
          mentions: [{ facts: x, place }, { facts: y, place: editPlace }], confidence: 0.6,
        });
      }
    }
  }
  return found;
}

export type CrossToolParityOptions = {
  /**
   * The package manager the repository's manifest and lockfile point to, as
   * `manifest-consistency` reads it. When known, a disagreement that names a
   * different manager is that detector's finding, and is not reported twice.
   */
  manifestPackageManager?: string;
};

/**
 * Detect tool instruction files that disagree with AGENTS.md on the package
 * manager, the test runner or a path not to edit. See the file header for what
 * is compared and what is deliberately not.
 */
export function detectCrossToolParity(files: InstructionFile[], options: CrossToolParityOptions = {}): PromptCiIssue[] {
  const tools = files
    .filter((f) => TOOL_TYPES.has(f.fileType) && !isTaskPromptFile(f) && !isScopedRuleFile(f))
    .sort((x, y) => (fileIdPath(x) < fileIdPath(y) ? -1 : fileIdPath(x) > fileIdPath(y) ? 1 : 0));
  if (tools.length < 2) return [];

  const byScope = new Map<string, InstructionFile[]>();
  for (const file of tools) {
    const scope = scopeOf(file);
    byScope.set(scope, [...(byScope.get(scope) ?? []), file]);
  }

  const factsOf = (file: InstructionFile): FileFacts => {
    const facts: FileFacts = {
      file, label: fileIdPath(file),
      pmUsed: new Map(), pmForbidden: new Map(), runners: new Map(), pathsForbidden: new Map(), pathsEdited: new Map(),
    };
    const lines = scanLines(file.content);
    collectPackageManagers(lines, facts);
    collectRunners(lines, facts);
    collectPaths(lines, facts);
    return facts;
  };

  const found: Finding[] = [];
  for (const [scope, list] of byScope) {
    const anchorFile = list.find(isAnchor);
    if (!anchorFile) continue; // nothing to be in parity with
    const anchor = factsOf(anchorFile);
    for (const file of list) {
      if (file === anchorFile || isMirror(anchorFile, file)) continue;
      found.push(...compareToAnchor(anchor, factsOf(file), scope, options.manifestPackageManager));
    }
  }

  const issues: PromptCiIssue[] = [];
  for (const g of found.sort((x, y) => (issueId(x.dimension, x.scope, x.key) < issueId(y.dimension, y.scope, y.key) ? -1 : 1))) {
    const mentions = [...g.mentions].sort((x, y) => (x.facts.label === y.facts.label ? x.place.line - y.place.line : x.facts.label < y.facts.label ? -1 : 1));
    issues.push({
      id: issueId(g.dimension, g.scope, g.key),
      severity: 'info',
      category: 'conflict',
      title: g.title,
      summary:
        `Possible cross-tool mismatch — review these together. ${g.sides.join('; ')}. ` +
        `A person or agent following one tool's file may get a different ${g.dimension} than one following the other's.`,
      filePaths: [...new Set(mentions.map((m) => m.facts.file.path))],
      locations: mentions.map((m) => ({ filePath: m.facts.file.path, startLine: m.place.line })),
      evidence: mentions.map((m) => `${m.facts.label}:${m.place.line}: ${m.place.text}`),
      recommendation:
        `Decide which ${g.dimension} is correct for this repository and state it once, in AGENTS.md. ` +
        `Make the tool-specific file a short pointer to it rather than restating the rule.`,
      fixRecipe:
        `Keep the ${g.dimension} in AGENTS.md and replace the conflicting line in the tool file with a pointer ` +
        `("See AGENTS.md for ${g.dimension === 'forbidden path' ? 'paths that must not be edited' : g.dimension === 'test runner' ? 'how to run tests' : 'the package manager'}"). ` +
        `Not applied automatically: it discards one file's wording, which only the team can judge.`,
      tags: [UNSCORED_TAG],
      confidence: g.confidence,
    });
  }
  return issues;
}
