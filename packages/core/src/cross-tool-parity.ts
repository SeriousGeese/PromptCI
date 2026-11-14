/**
 * Cross-tool parity detector (pcic-sev5).
 *
 * A repository that carries more than one tool's instruction file (AGENTS.md,
 * CLAUDE.md, .cursorrules, .github/copilot-instructions.md, GEMINI.md, ...)
 * hands each tool a different rulebook. When those rulebooks disagree on a
 * concrete, checkable fact, two people on the same repo get different agent
 * behaviour from the same prompt, and nobody sees it because each tool only
 * reads its own file. The generic conflict detectors compare sections of
 * prose; this one compares what each TOOL FILE says about three facts:
 *
 *   - the package manager (`pnpm install` here, `npm install` there, or one
 *     file forbidding what the other uses),
 *   - the test command (`pnpm test` vs `pnpm test:unit`, `vitest` vs `jest`,
 *     `pytest` vs `unittest`),
 *   - a forbidden path (one file says never edit `src/generated/`, another
 *     tells the agent to add files there).
 *
 * Deliberately narrow, because a parity finding that is only sometimes right
 * trains people to ignore the rest:
 *
 *   - Only tool instruction files are compared (not READMEs, docs or skills),
 *     and only files in the same scope: a nested package's CLAUDE.md may
 *     legitimately differ from the root AGENTS.md. A tool directory (.cursor/,
 *     .github/, .windsurf/ ...) belongs to the scope that holds it.
 *   - A file counts as "using" a package manager only when it shows a command
 *     or an explicit "use X" for exactly one of them; a file that lists
 *     several alternatives says nothing and is skipped. Global installs are not
 *     the project's package manager.
 *   - Glob-scoped rule files (Cursor `globs:`, Copilot `applyTo:`) apply to
 *     part of the tree and are skipped.
 *   - Everything is worded as a possibility, and nothing is auto-applied: the
 *     right repair (usually a pointer file to AGENTS.md) discards one file's
 *     content, which only a person can judge.
 *
 * Deterministic: no clock, network or randomness; files and findings are
 * emitted in a fixed order.
 */

import * as crypto from 'node:crypto';
import type { FileType, InstructionFile, PromptCiIssue } from './types.js';
import { scanFencedLines } from './markdown-fences.js';
import { fileIdPath } from './finding-id.js';
import { snippet } from './evidence.js';

/** The file types that are one tool's own instruction file. */
const TOOL_TYPES: ReadonlySet<FileType> = new Set<FileType>([
  'claude', 'agents', 'cursor', 'windsurf', 'copilot', 'gemini', 'cline',
]);

type Place = { line: number; text: string };

type FileFacts = {
  file: InstructionFile;
  label: string;
  /** Package managers the file shows being used. */
  pmUsed: Map<string, Place>;
  /** Package managers the file tells the reader NOT to use. */
  pmForbidden: Map<string, Place>;
  /** family -> value -> first place, for test commands. */
  tests: Map<string, Map<string, Place>>;
  /** Paths the file says not to edit. */
  pathsForbidden: Map<string, Place>;
  /** Paths the file tells the reader to edit or add to. */
  pathsEdited: Map<string, Place>;
};

// ── Scope and eligibility ────────────────────────────────────────────────────

/**
 * The directory whose rules a tool file sets: its own directory, with any
 * tool directory stripped (`.github/copilot-instructions.md` and
 * `.cursor/rules/x.mdc` belong to the directory that holds `.github/` /
 * `.cursor/`). Files with no repo-relative path are grouped by their directory.
 */
function scopeOf(file: InstructionFile): string {
  const segments = fileIdPath(file).split('/');
  const dirs = segments.slice(0, -1);
  const tool = dirs.findIndex((s) => TOOL_DIRS.has(s));
  return (tool === -1 ? dirs : dirs.slice(0, tool)).join('/');
}

/**
 * Directories that hold one tool's instruction files and belong to the scope
 * above them. Any other hidden directory (`.config/`, `.devcontainer/`) is a
 * scope of its own: stripping it would compare unrelated files.
 */
const TOOL_DIRS: ReadonlySet<string> = new Set(['.github', '.cursor', '.windsurf', '.clinerules', '.claude', '.gemini', '.codex']);

/** Cursor `globs:` / Copilot `applyTo:` frontmatter: the rules cover part of the tree only. */
function isGlobScoped(content: string): boolean {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!m) return false;
  const fm = m[1]!;
  if (/^\s*alwaysApply\s*:\s*true\s*$/im.test(fm)) return false;
  return /^\s*(?:globs|applyTo)\s*:\s*\S/im.test(fm);
}

// ── Line walking ─────────────────────────────────────────────────────────────

type ScannedLine = { n: number; text: string; fence: boolean; lang: string };

/** Fence languages whose lines are shell-ish and may hold a command to run. */
const SHELL_LANGS: ReadonlySet<string> = new Set(['', 'bash', 'sh', 'shell', 'zsh', 'console', 'terminal', 'cmd', 'powershell', 'ps1']);

function scanLines(content: string): ScannedLine[] {
  const out: ScannedLine[] = [];
  for (const l of scanFencedLines(content)) {
    if (l.kind === 'open' || l.kind === 'close') continue;
    out.push({ n: l.lineNumber, text: l.text.replace(/\r$/, ''), fence: l.inFence, lang: l.lang });
  }
  return out;
}

/** Text of a line that can hold a command: shell fences in full, otherwise only its code spans. */
function commandText(line: ScannedLine): string {
  if (line.fence) return SHELL_LANGS.has(line.lang) ? line.text.replace(/^\s*(?:[$>#]\s+)?/, '') : '';
  const spans: string[] = [];
  for (const m of line.text.matchAll(/(`+)([^`]+)\1/g)) spans.push(m[2]!);
  return spans.join('\n');
}

const NEGATION_BEFORE_RE = /\b(?:never|don'?t|do\s+not|must\s+not|should\s+not|shouldn'?t|avoid|instead\s+of|rather\s+than|not)\b[^.;]*$/i;

// ── Package manager ──────────────────────────────────────────────────────────

const PMS = ['npm', 'pnpm', 'yarn', 'bun'] as const;
const PM_ALT = PMS.join('|');
const PM_VERBS = 'install|i|ci|add|run|test|start|build|dev|lint|remove|update|upgrade|publish|exec';
const PM_COMMAND_RE = new RegExp(`(?:^|[\\s(;&|])(${PM_ALT})\\s+(?:${PM_VERBS})\\b([^\\n;&|]*)`, 'gi');
const NOT_A_PM_NOUN = '(?!\\s+(?:packages?|modules?|registry|scripts?|workspaces?|dependenc\\w+|audit|lockfile|cache))';
const PM_USE_RE = new RegExp(`\\b(?:use|uses|using|prefer|stick\\s+to|always\\s+use|run\\s+with|managed\\s+(?:by|with))\\s+(?:the\\s+)?(${PM_ALT})\\b${NOT_A_PM_NOUN}`, 'gi');
const PM_FORBID_RE = new RegExp(`\\b(?:never|don'?t|do\\s+not|must\\s+not|should\\s+not|shouldn'?t|avoid|instead\\s+of|rather\\s+than|not)\\s+(?:use\\s+|using\\s+|run\\s+|with\\s+)?(?:the\\s+)?(${PM_ALT})\\b${NOT_A_PM_NOUN}`, 'gi');
const GLOBAL_RE = /(?:\s-g\b|--global\b|\binstall\s+-g\b)/;

function collectPackageManagers(lines: ScannedLine[], facts: FileFacts): void {
  const setFirst = (map: Map<string, Place>, pm: string, line: ScannedLine): void => {
    if (!map.has(pm)) map.set(pm, { line: line.n, text: snippet(line.text.trim(), 100) });
  };
  for (const line of lines) {
    // A command: shell fence line or code span.
    const cmd = commandText(line);
    for (const m of cmd.matchAll(PM_COMMAND_RE)) {
      const pm = m[1]!.toLowerCase();
      if (GLOBAL_RE.test(m[0])) continue; // a global tool install is not the project's package manager
      const before = cmd.slice(0, m.index);
      // `npx` and `pnpm dlx` are one-off runners; `npm` inside a longer word is not a command.
      if (NEGATION_BEFORE_RE.test(before)) continue;
      setFirst(facts.pmUsed, pm, line);
    }
    // Prose, outside fences.
    if (!line.fence) {
      for (const m of line.text.matchAll(PM_USE_RE)) setFirst(facts.pmUsed, m[1]!.toLowerCase(), line);
      for (const m of line.text.matchAll(PM_FORBID_RE)) setFirst(facts.pmForbidden, m[1]!.toLowerCase(), line);
    }
    // A command written after a negation in a code span: "do not run `npm install`".
    if (!line.fence) {
      for (const m of line.text.matchAll(new RegExp(`(?:never|don'?t|do\\s+not|must\\s+not|should\\s+not|avoid)\\s+(?:run\\s+|use\\s+)?\`(?:${PM_ALT}\\s+(?:${PM_VERBS})\\b[^\`]*)\``, 'gi'))) {
        const pm = /`(\w+)/.exec(m[0])![1]!.toLowerCase();
        if ((PMS as readonly string[]).includes(pm)) setFirst(facts.pmForbidden, pm, line);
      }
    }
  }
  // A file that "uses" X only because it forbids X on the same line is not using it.
  for (const pm of facts.pmForbidden.keys()) {
    const used = facts.pmUsed.get(pm);
    const forbidden = facts.pmForbidden.get(pm)!;
    if (used && used.line === forbidden.line) facts.pmUsed.delete(pm);
  }
}

// ── Test command ─────────────────────────────────────────────────────────────

const JS_SCRIPT_TEST_RE = /(?:^|[\s(;&|])(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(test(?::[\w-]+)?)\b(?!\s*-g)/gi;
const JS_RUNNER_RE = /(?:^|[\s(;&|])(?:(?:npx|pnpm\s+exec|pnpm\s+dlx|yarn\s+dlx|bunx)\s+)?(vitest|jest|mocha|ava)\b(?!\.)/gi;
const PY_PYTEST_RE = /(?:^|[\s(;&|])(?:python3?\s+-m\s+)?(pytest)\b/gi;
const PY_UNITTEST_RE = /(?:^|[\s(;&|])python3?\s+-m\s+(unittest)\b/gi;

function collectTestCommands(lines: ScannedLine[], facts: FileFacts): void {
  const add = (family: string, value: string, line: ScannedLine): void => {
    const byValue = facts.tests.get(family) ?? new Map<string, Place>();
    if (!byValue.has(value)) byValue.set(value, { line: line.n, text: snippet(line.text.trim(), 100) });
    facts.tests.set(family, byValue);
  };
  for (const line of lines) {
    const cmd = commandText(line);
    if (!cmd) continue;
    // A prohibited command ("never run jest") is not the file's test command.
    const guarded = (index: number): boolean => NEGATION_BEFORE_RE.test(cmd.slice(0, index));
    for (const m of cmd.matchAll(JS_SCRIPT_TEST_RE)) if (!guarded(m.index)) add('js-script', m[1]!.toLowerCase(), line);
    for (const m of cmd.matchAll(JS_RUNNER_RE)) if (!guarded(m.index)) add('js-runner', m[1]!.toLowerCase(), line);
    for (const m of cmd.matchAll(PY_PYTEST_RE)) if (!guarded(m.index)) add('py', m[1]!.toLowerCase(), line);
    for (const m of cmd.matchAll(PY_UNITTEST_RE)) if (!guarded(m.index)) add('py', m[1]!.toLowerCase(), line);
  }
}

// ── Forbidden paths ──────────────────────────────────────────────────────────

const FORBID_VERB_RE = /\b(?:never|don'?t|do\s+not|must\s+not|should\s+not|shouldn'?t|avoid)\s+(?:\w+\s+){0,2}?(?:edit|modify|touch|change|alter|overwrite|rewrite|commit|delete|remove|write\s+(?:to|in))\b/i;
/** A prohibition limited to one way of doing it ("by hand", "directly") does not forbid the path. */
const SCOPED_PROHIBITION_RE = /\b(?:by\s+hand|manually|directly|unless|except|without\s+(?:running|regenerat))/i;
const EDIT_VERB_RE = /\b(?:edit|modify|update|change|add\s+(?:\w+\s+){0,3}?(?:to|in|under)|write\s+(?:to|in)|create\s+(?:\w+\s+){0,3}?(?:in|under))\b/i;
const ANY_NEGATION_RE = /\b(?:never|not|don'?t|do\s+not|avoid|no\s+longer|read-?only|off-?limits|generated|regenerate|auto-?generated)\b|n't\b/i;

/** A backticked token that names a repo path: has a slash or a file extension, no glob in the middle. */
function pathTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/`([^`\s]+)`/g)) {
    let token = m[1]!.replace(/^\.\//, '').replace(/\/(?:\*\*?(?:\/\*)?)$/, '/').replace(/\/+$/, '');
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
    if (FORBID_VERB_RE.test(line.text) && !SCOPED_PROHIBITION_RE.test(line.text)) {
      for (const t of tokens) if (!facts.pathsForbidden.has(t)) facts.pathsForbidden.set(t, place);
    } else if (EDIT_VERB_RE.test(line.text) && !ANY_NEGATION_RE.test(line.text.replace(/`[^`]*`/g, ' '))) {
      for (const t of tokens) if (!facts.pathsEdited.has(t)) facts.pathsEdited.set(t, place);
    }
  }
}

// ── Findings ─────────────────────────────────────────────────────────────────

type Mention = { facts: FileFacts; place: Place };

type Grouped = {
  dimension: 'package manager' | 'test command' | 'forbidden path';
  scope: string;
  key: string;
  title: string;
  /** What each side says, for the summary. */
  sides: string[];
  mentions: Mention[];
  confidence: number;
  explicit: boolean;
};

function issueId(dimension: string, scope: string, key: string): string {
  const hash = crypto.createHash('sha1').update(`cross-tool-parity:${dimension}:${scope}:${key}`).digest('hex').slice(0, 12);
  return `cross-tool-parity-${hash}`;
}

function singleKey(map: Map<string, Place> | undefined): string | undefined {
  return map && map.size === 1 ? [...map.keys()][0] : undefined;
}

function addMention(group: Grouped, facts: FileFacts, place: Place): void {
  if (!group.mentions.some((m) => m.facts === facts && m.place.line === place.line)) group.mentions.push({ facts, place });
}

function pairFindings(a: FileFacts, b: FileFacts, scope: string, groups: Map<string, Grouped>): void {
  const upsert = (g: Omit<Grouped, 'mentions'>, mentions: Mention[]): void => {
    const id = `${g.dimension}|${g.scope}|${g.key}`;
    const existing = groups.get(id) ?? { ...g, mentions: [] };
    existing.confidence = Math.max(existing.confidence, g.confidence);
    existing.explicit = existing.explicit || g.explicit;
    for (const s of g.sides) if (!existing.sides.includes(s)) existing.sides.push(s);
    for (const m of mentions) addMention(existing, m.facts, m.place);
    groups.set(id, existing);
  };

  // Package manager: two different single choices, or one file forbidding what the other uses.
  const pmA = singleKey(a.pmUsed);
  const pmB = singleKey(b.pmUsed);
  if (pmA && pmB && pmA !== pmB) {
    const explicit = a.pmForbidden.has(pmB) || b.pmForbidden.has(pmA);
    const mentions: Mention[] = [
      { facts: a, place: a.pmUsed.get(pmA)! },
      { facts: b, place: b.pmUsed.get(pmB)! },
    ];
    if (a.pmForbidden.has(pmB)) mentions.push({ facts: a, place: a.pmForbidden.get(pmB)! });
    if (b.pmForbidden.has(pmA)) mentions.push({ facts: b, place: b.pmForbidden.get(pmA)! });
    const pair = [pmA, pmB].sort();
    upsert({
      dimension: 'package manager', scope, key: pair.join('|'),
      title: `Possible package manager disagreement between tool files: ${pair.join(' vs ')}`,
      sides: [`${a.label} uses ${pmA}`, `${b.label} uses ${pmB}`],
      confidence: explicit ? 0.75 : 0.65, explicit,
    }, mentions);
  } else {
    for (const [x, y] of [[a, b], [b, a]] as const) {
      for (const pm of x.pmForbidden.keys()) {
        const used = y.pmUsed.get(pm);
        // Covered above when both files name a single, different manager.
        if (!used || (pmA && pmB && pmA !== pmB)) continue;
        upsert({
          dimension: 'package manager', scope, key: `forbid:${pm}`,
          title: `Possible package manager disagreement between tool files: ${pm} is both used and ruled out`,
          sides: [`${x.label} says not to use ${pm}`, `${y.label} uses ${pm}`],
          confidence: 0.7, explicit: true,
        }, [{ facts: x, place: x.pmForbidden.get(pm)! }, { facts: y, place: used }]);
      }
    }
  }

  // Test command: one command per family on each side, and they differ.
  for (const family of ['js-script', 'js-runner', 'py']) {
    const ta = a.tests.get(family);
    const tb = b.tests.get(family);
    const va = singleKey(ta);
    const vb = singleKey(tb);
    if (!va || !vb || va === vb) continue;
    const pair = [va, vb].sort();
    const label = family === 'js-script' ? 'test script' : 'test runner';
    upsert({
      dimension: 'test command', scope, key: `${family}:${pair.join('|')}`,
      title: `Possible test command disagreement between tool files: ${pair.join(' vs ')}`,
      sides: [`${a.label} runs ${va}`, `${b.label} runs ${vb}`].map((s) => `${s} (${label})`),
      confidence: 0.55, explicit: false,
    }, [{ facts: a, place: ta!.get(va)! }, { facts: b, place: tb!.get(vb)! }]);
  }

  // Forbidden path: one file rules a path out, the other tells the reader to edit it.
  for (const [x, y] of [[a, b], [b, a]] as const) {
    for (const [forbidden, place] of x.pathsForbidden) {
      for (const [edited, editPlace] of y.pathsEdited) {
        if (edited !== forbidden && !edited.startsWith(`${forbidden}/`)) continue;
        upsert({
          dimension: 'forbidden path', scope, key: forbidden,
          title: `Possible forbidden path disagreement between tool files: ${forbidden}`,
          sides: [`${x.label} says not to edit ${forbidden}`, `${y.label} says to edit ${edited}`],
          confidence: 0.6, explicit: true,
        }, [{ facts: x, place }, { facts: y, place: editPlace }]);
      }
    }
  }
}

/**
 * Detect tool instruction files that disagree on the package manager, the test
 * command or a forbidden path. See the file header for what is compared and
 * what is deliberately not.
 */
export function detectCrossToolParity(files: InstructionFile[]): PromptCiIssue[] {
  const tools = files
    .filter((f) => TOOL_TYPES.has(f.fileType) && !isGlobScoped(f.content))
    .sort((x, y) => (fileIdPath(x) < fileIdPath(y) ? -1 : fileIdPath(x) > fileIdPath(y) ? 1 : 0));
  if (tools.length < 2) return [];

  const byScope = new Map<string, FileFacts[]>();
  for (const file of tools) {
    const facts: FileFacts = {
      file,
      label: fileIdPath(file),
      pmUsed: new Map(),
      pmForbidden: new Map(),
      tests: new Map(),
      pathsForbidden: new Map(),
      pathsEdited: new Map(),
    };
    const lines = scanLines(file.content);
    collectPackageManagers(lines, facts);
    collectTestCommands(lines, facts);
    collectPaths(lines, facts);
    const scope = scopeOf(file);
    const list = byScope.get(scope) ?? [];
    list.push(facts);
    byScope.set(scope, list);
  }

  const groups = new Map<string, Grouped>();
  for (const [scope, list] of byScope) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) pairFindings(list[i]!, list[j]!, scope, groups);
    }
  }

  const issues: PromptCiIssue[] = [];
  for (const g of [...groups.values()].sort((x, y) => (issueId(x.dimension, x.scope, x.key) < issueId(y.dimension, y.scope, y.key) ? -1 : 1))) {
    const mentions = [...g.mentions].sort((x, y) => (x.facts.label === y.facts.label ? x.place.line - y.place.line : x.facts.label < y.facts.label ? -1 : 1));
    const filePaths = [...new Set(mentions.map((m) => m.facts.file.path))];
    issues.push({
      id: issueId(g.dimension, g.scope, g.key),
      severity: 'warning',
      category: 'conflict',
      title: g.title,
      summary:
        `Possible cross-tool mismatch — review these together. ${g.sides.join('; ')}. ` +
        `A person or agent following one tool's file may get a different ${g.dimension} than one following the other's.`,
      filePaths,
      locations: mentions.map((m) => ({ filePath: m.facts.file.path, startLine: m.place.line })),
      evidence: mentions.map((m) => `${m.facts.label}:${m.place.line}: ${m.place.text}`),
      recommendation:
        `Decide which ${g.dimension} is correct for this repository and state it once, in AGENTS.md. ` +
        `Make the tool-specific files short pointers to it rather than restating the rule.`,
      fixRecipe:
        `Keep the ${g.dimension} in AGENTS.md and replace the conflicting line in each tool file with a pointer ` +
        `("See AGENTS.md for ${g.dimension === 'forbidden path' ? 'paths that must not be edited' : g.dimension === 'test command' ? 'how to run tests' : 'the package manager'}"). ` +
        `Not applied automatically: it discards one file's wording, which only the team can judge.`,
      confidence: g.confidence,
    });
  }
  return issues;
}
