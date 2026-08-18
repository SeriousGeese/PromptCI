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
 * repo, and a stable file lister.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import fg from 'fast-glob';

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

/** True when a repo-relative path exists on disk (file or directory). */
export function existsWithinRoot(repoRoot: string, relativePath: string): boolean {
  const abs = resolveWithinRoot(repoRoot, relativePath);
  if (!abs) return false;
  try {
    return fs.existsSync(abs);
  } catch {
    return false;
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
 * List files under `repoRoot` matching `patterns`, returned as repo-relative
 * POSIX paths in sorted order. Dotfiles are included (these configs all live in
 * dot-directories); `node_modules`, `.git`, and vendored copies are excluded so
 * a dependency's own `.claude/` tree never pollutes the scan.
 */
export function listFiles(repoRoot: string, patterns: string[]): string[] {
  let matches: string[];
  try {
    matches = fg.sync(patterns, {
      cwd: repoRoot,
      dot: true,
      onlyFiles: true,
      followSymbolicLinks: false,
      ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/worktrees/**', '**/.worktrees/**'],
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

// ── Frontmatter parsing ─────────────────────────────────────────────────────

export type FrontmatterValue = string | string[] | boolean | number | null;

export type Frontmatter = {
  /** An opening `---` fence was present on the first content line. */
  present: boolean;
  /** A closing `---` (or `...`) fence was found. */
  closed: boolean;
  /** Top-level key → parsed value. Last write wins on duplicate keys. */
  data: Record<string, FrontmatterValue>;
  /** Top-level keys in the order they first appeared. */
  order: string[];
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
 * Split on top-level `,` only — commas inside quotes or `[]`/`{}`/`()` are left
 * alone. Without this, an inline glob sequence with a brace-expansion pattern
 * such as a quoted `{ts,tsx}` would be shredded at the inner comma, producing
 * bogus dead-glob findings.
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
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '[' || c === '{' || c === '(') { depth++; cur += c; continue; }
    if (c === ']' || c === '}' || c === ')') { if (depth > 0) depth--; cur += c; continue; }
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts.map((s) => unquote(s.trim())).filter((s) => s !== '');
}

function parseScalar(raw: string): FrontmatterValue {
  let value = raw.trim();
  if (value === '') return null;
  // Fully-quoted string: keep contents verbatim (a `#` inside is not a comment).
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  // Inline flow sequence: [a, b, c]
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (inner === '') return [];
    return splitTopLevelCommas(inner);
  }
  // Unquoted scalar: a ` #` begins a trailing comment in YAML — strip it so a
  // value like `name: my-skill # note` does not carry the comment into `name`.
  const commentIdx = value.search(/\s#/);
  if (commentIdx >= 0) value = value.slice(0, commentIdx).trim();
  if (value === '') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return unquote(value);
}

function unquote(s: string): string {
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
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
    order: [],
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
      // fence or a non-indented line ends it.
      if (trimmed === '---' || trimmed === '...') {
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

    if (trimmed === '---' || trimmed === '...') {
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
      const item = unquote(listMatch[2]!.trim());
      if (Array.isArray(arr)) arr.push(item);
      else result.data[lastListKey] = [item];
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
      result.order.push(key);
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

/** Coerce a frontmatter value that may be a list or comma/space string into a string[]. */
export function asStringList(value: FrontmatterValue): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string') {
    return value
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [String(value)];
}
