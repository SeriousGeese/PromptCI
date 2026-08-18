/**
 * Shared support for the AI-setup config detectors (issue #23).
 *
 * These detectors audit the non-markdown surfaces of a 2026 AI setup — skills,
 * subagents, hooks/permissions, MCP servers, and Cursor rules — against
 * filesystem reality, the same way `command-validity` verifies documented
 * commands. Everything here is deterministic and offline: no network, no LLM,
 * identical output for identical input.
 *
 * This module holds the pieces every one of those detectors needs: a minimal
 * YAML-frontmatter parser, root-relative path helpers that refuse to escape the
 * repo, a stable file lister, and issue path normalization.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import fg from 'fast-glob';
import type { PromptCiIssue } from './types.js';

// ── Path helpers ──────────────────────────────────────────────────────────────

/** Convert a filesystem path to forward-slash form for stable, portable output. */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Resolve `relativePath` under `repoRoot`, returning the absolute path — or
 * `null` when the result escapes the root (via `..` or an absolute path). Every
 * filesystem read below routes through this so a hostile config value cannot
 * point the detector at `/etc/passwd`.
 */
export function resolveWithinRoot(repoRoot: string, relativePath: string): string | null {
  try {
    const root = path.resolve(repoRoot);
    const resolved = path.resolve(root, relativePath);
    const rel = path.relative(root, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return resolved;
  } catch {
    return null;
  }
}

/** True when a repo-relative path exists and is a regular file. */
export function isFileWithinRoot(repoRoot: string, relativePath: string): boolean {
  const abs = resolveWithinRoot(repoRoot, relativePath);
  if (!abs) return false;
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

/** Read a repo-relative text file, or `undefined` if it is absent/unreadable. */
export function readTextWithinRoot(repoRoot: string, relativePath: string): string | undefined {
  const abs = resolveWithinRoot(repoRoot, relativePath);
  if (!abs) return undefined;
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Directory names excluded when discovering config files: dependency trees and
 * vendored copies whose own `.claude/` must never pollute the scan. This is a
 * *discovery* policy — do not reuse it to answer "does glob X match anything in
 * the repo" (see detectCursorRules, which needs `dist/`/`build/` visible).
 */
const DISCOVERY_IGNORE = [
  '**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**',
  '**/worktrees/**', '**/.worktrees/**',
];

/**
 * List files under `repoRoot` matching `patterns`, returned as repo-relative
 * POSIX paths in sorted order. Dotfiles are included (these configs all live in
 * dot-directories). Pass `ignore` to override the default discovery excludes.
 */
export function listFiles(repoRoot: string, patterns: string[], ignore: string[] = DISCOVERY_IGNORE): string[] {
  let matches: string[];
  try {
    matches = fg.sync(patterns, {
      cwd: repoRoot,
      dot: true,
      onlyFiles: true,
      followSymbolicLinks: false,
      ignore,
    });
  } catch {
    return [];
  }
  return matches.map(toPosix).sort();
}

/** Stable short hash for building per-finding IDs. */
export function shortHash(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 12);
}

/**
 * Rewrite an issue's `filePaths`/`locations` from the detectors' repo-relative
 * POSIX form to the absolute form the scanner stores in `InstructionFile.path`.
 * Inline `promptci-ignore` suppressions match on exact path equality with the
 * scanned file, so detector output must speak the same dialect or the
 * `ai_config` category is unsuppressable. Display strings (titles, summaries,
 * evidence) keep the friendly relative form; baseline fingerprints re-normalize
 * absolute paths back to repo-relative, so they are unaffected.
 */
export function withScannerPaths(repoRoot: string, issues: PromptCiIssue[]): PromptCiIssue[] {
  const abs = (p: string) => path.resolve(repoRoot, p);
  return issues.map((issue) => ({
    ...issue,
    filePaths: issue.filePaths.map(abs),
    locations: issue.locations.map((loc) => ({ ...loc, filePath: abs(loc.filePath) })),
  }));
}

/** Extensions treated as invokable local scripts in hook/MCP command strings. */
export const SCRIPT_EXT_RE = /\.(sh|bash|zsh|js|mjs|cjs|ts|py|rb|ps1)$/i;

/**
 * 1-based line where `needle` first appears in `raw`, or 1 when not found.
 * JSON sources store strings escaped, so a parsed command containing quotes or
 * backslashes never appears verbatim — fall back to the JSON-escaped form
 * before giving up on a real line number.
 */
export function lineOf(raw: string, needle: string): number {
  let idx = raw.indexOf(needle);
  if (idx < 0) idx = raw.indexOf(JSON.stringify(needle).slice(1, -1));
  if (idx < 0) return 1;
  return raw.slice(0, idx).split(/\r?\n/).length;
}

// ── Frontmatter parsing ─────────────────────────────────────────────────────

export type FrontmatterValue = string | string[] | boolean | number | null;

export type Frontmatter = {
  /** An opening `---` fence was present on the first content line. */
  present: boolean;
  /** A closing `---` (or `...`) fence was found. */
  closed: boolean;
  /** Top-level key → parsed value. Last write wins on duplicate keys. */
  data: Record<string, FrontmatterValue>;
  /** 1-based line of each top-level key (first occurrence). */
  keyLines: Record<string, number>;
  /** 1-based line of the closing fence, or -1 when unterminated. */
  fenceEndLine: number;
  /** 1-based first line of the document body after the closing fence. */
  bodyStartLine: number;
  /** Structural problems found while parsing (duplicate keys, etc.). */
  errors: string[];
};

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * A closing fence must sit at column 0. An indented `---` is content — most
 * commonly a markdown horizontal rule inside a `|` block-scalar description —
 * and must not terminate the frontmatter.
 */
const FENCE_RE = /^(?:---|\.\.\.)[ \t]*$/;

/**
 * Strip a YAML trailing comment (` #` onward) from a raw value, tracking quote
 * state so a `#` inside a quoted string survives. A quote only *opens* at the
 * start of the value or after whitespace/`[`/`{`/`(`/`,` — an apostrophe inside
 * a word (o'brien) is content, not a quote.
 */
function stripTrailingComment(raw: string): string {
  let quote = '';
  let prev = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (quote) {
      if (c === quote) quote = '';
    } else if ((c === '"' || c === "'") && (prev === '' || /[\s[{(,]/.test(prev))) {
      quote = c;
    } else if (c === '#' && (prev === '' || /\s/.test(prev))) {
      return raw.slice(0, i).trimEnd();
    }
    prev = c;
  }
  return raw;
}

/**
 * Split on top-level `,` only — commas inside quotes or `[]`/`{}`/`()` are left
 * alone. Without this, a glob with a brace-expansion pattern such as a
 * `{ts,tsx}` suffix would be shredded at the inner comma, producing bogus
 * dead-glob findings. A quote only opens at the start of an item, so an
 * apostrophe inside a path does not swallow the following commas.
 */
function splitTopLevelCommas(inner: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let depth = 0;
  let quote = '';
  for (const c of inner) {
    if (quote) {
      cur += c;
      if (c === quote) quote = '';
      continue;
    }
    if ((c === '"' || c === "'") && cur.trim() === '') { quote = c; cur += c; continue; }
    if (c === '[' || c === '{' || c === '(') { depth++; cur += c; continue; }
    if (c === ']' || c === '}' || c === ')') { if (depth > 0) depth--; cur += c; continue; }
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts.map((s) => unquote(s.trim())).filter((s) => s !== '');
}

function unquote(s: string): string {
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseScalar(raw: string): FrontmatterValue {
  // Comment stripping happens BEFORE dispatch so `globs: ["*.ts"] # note` is
  // still recognized as a sequence, not left behind as a raw bracketed string.
  const value = stripTrailingComment(raw).trim();
  if (value === '') return null;
  // Fully-quoted string: contents verbatim (a `#` inside was preserved above).
  const unquoted = unquote(value);
  if (unquoted !== value) return unquoted;
  // Inline flow sequence: [a, b, c]
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (inner === '') return [];
    return splitTopLevelCommas(inner);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

/**
 * Parse a minimal YAML frontmatter block from the top of a document.
 *
 * Handles the subset these config files actually use: top-level `key: value`
 * scalars, quoted strings, booleans/numbers, inline `[a, b]` sequences, block
 * lists (`  - item`), and `|`/`>` block scalars. Nested mappings are recorded
 * as errors rather than silently dropped, since none of the audited surfaces
 * use them and a nested block is far more likely to be a mistake.
 *
 * This is deliberately not a full YAML engine — it exists to answer "is the
 * frontmatter structurally sane and what are its top-level keys", not to load
 * arbitrary YAML.
 */
export function parseFrontmatter(content: string): Frontmatter {
  const text = stripBom(content);
  const lines = text.split(/\r?\n/);
  const result: Frontmatter = {
    present: false,
    closed: false,
    data: {},
    keyLines: {},
    fenceEndLine: -1,
    bodyStartLine: 1,
    errors: [],
  };

  if (lines.length === 0 || lines[0]!.trim() !== '---') {
    return result; // no frontmatter — whole file is body
  }
  result.present = true;

  let lastListKey: string | null = null;
  let blockScalarKey: string | null = null;
  let blockScalarFold = false;
  let blockScalarLines: string[] = [];

  const flushBlockScalar = () => {
    if (blockScalarKey === null) return;
    const joined = blockScalarFold ? blockScalarLines.join(' ') : blockScalarLines.join('\n');
    result.data[blockScalarKey] = joined.trim();
    blockScalarKey = null;
    blockScalarLines = [];
  };

  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (blockScalarKey !== null) {
      // Block scalar continues while lines are indented or blank; the closing
      // fence (column 0 only) or a non-indented line ends it.
      if (FENCE_RE.test(line)) {
        flushBlockScalar();
        result.closed = true;
        result.fenceEndLine = i + 1;
        result.bodyStartLine = i + 2;
        break;
      }
      if (trimmed === '' || /^\s/.test(line)) {
        blockScalarLines.push(trimmed);
        continue;
      }
      flushBlockScalar();
      // fall through to normal handling of this line
    }

    if (FENCE_RE.test(line)) {
      result.closed = true;
      result.fenceEndLine = i + 1;
      result.bodyStartLine = i + 2;
      break;
    }
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    // Block list item belonging to the most recent empty-valued key.
    const listMatch = /^(\s*)-\s+(.*)$/.exec(line);
    if (listMatch && lastListKey) {
      const arr = result.data[lastListKey];
      const item = unquote(stripTrailingComment(listMatch[2]!).trim());
      if (item !== '') {
        if (Array.isArray(arr)) arr.push(item);
        else result.data[lastListKey] = [item];
      }
      continue;
    }

    const kvMatch = /^(\s*)([^:\s][^:]*):\s?(.*)$/.exec(line);
    if (!kvMatch) {
      result.errors.push(`Unparseable frontmatter line ${i + 1}: ${trimmed.slice(0, 60)}`);
      continue;
    }
    const indent = kvMatch[1]!.length;
    const key = kvMatch[2]!.trim();
    const rawValue = kvMatch[3]!;

    if (indent > 0) {
      // Nested mapping — outside the supported subset.
      result.errors.push(`Nested frontmatter key "${key}" on line ${i + 1} is not supported`);
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(result.data, key)) {
      result.errors.push(`Duplicate frontmatter key "${key}" (line ${i + 1})`);
    } else {
      result.keyLines[key] = i + 1; // first occurrence
    }

    const valueTrimmed = rawValue.trim();
    if (valueTrimmed === '|' || valueTrimmed === '|-' || valueTrimmed === '|+' ||
        valueTrimmed === '>' || valueTrimmed === '>-' || valueTrimmed === '>+') {
      blockScalarKey = key;
      blockScalarFold = valueTrimmed.startsWith('>');
      blockScalarLines = [];
      lastListKey = null;
      continue;
    }

    if (valueTrimmed === '') {
      // Either an empty scalar or the header of a block list on following lines.
      result.data[key] = null;
      lastListKey = key;
      continue;
    }

    result.data[key] = parseScalar(rawValue);
    lastListKey = null;
  }

  if (blockScalarKey !== null) flushBlockScalar();

  if (!result.closed) {
    // Unterminated frontmatter — the whole remainder was consumed as fm.
    result.bodyStartLine = lines.length + 1;
  }

  return result;
}

/** Coerce a frontmatter value that may be a list or comma/newline string into a string[]. */
export function asStringList(value: FrontmatterValue): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string') {
    // Top-level commas only — `*.{ts,tsx}` is one glob, not two fragments.
    return value.split('\n').flatMap((line) => splitTopLevelCommas(line));
  }
  return [String(value)];
}
