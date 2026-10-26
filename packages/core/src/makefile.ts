/**
 * Makefile target discovery for the command-validity check (`make <target>`).
 *
 * This is a deliberately small reader, not a make implementation. It collects
 * the explicit targets a Makefile defines (`build:`, `lint test: deps`,
 * `check::`), the names listed on `.PHONY`, and pattern rules (`%.o: %.c`).
 * Whenever the file can define targets this reader cannot see — an `include`
 * / `-include` / `sinclude` directive, or a target name computed from a
 * variable or function (`$(BIN):`, `$(eval ...)`) — the result is marked
 * unverifiable and callers must not report anything against it.
 *
 * Deterministic and offline: it only reads the Makefile text.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveReadableWithinRoot } from './path-containment.js';
import { MAX_FILE_SIZE } from './scanner.js';

export type MakefileFacts = {
  /** Repo-relative POSIX path of the Makefile read. */
  file: string;
  /** Explicit targets and `.PHONY` names. */
  targets: string[];
  /** Pattern-rule targets containing `%` (e.g. `%.o`, `build-%`). */
  patterns: string[];
  /**
   * The file can define targets this reader cannot enumerate (`include`,
   * computed target names, `$(eval)`): never report a target as missing.
   */
  unverifiable: boolean;
};

/** GNU make's lookup order when no `-f` is given. */
const MAKEFILE_NAMES = ['GNUmakefile', 'makefile', 'Makefile'];

const TARGET_NAME_RE = /^[A-Za-z0-9_.%/+-]+$/;

/** Join backslash-continued lines, keeping one logical line per rule. */
function logicalLines(content: string): string[] {
  const out: string[] = [];
  let pending = '';
  for (const raw of content.split(/\r?\n/)) {
    if (/\\$/.test(raw)) {
      pending += raw.slice(0, -1) + ' ';
      continue;
    }
    out.push(pending + raw);
    pending = '';
  }
  if (pending) out.push(pending);
  return out;
}

/** Parse Makefile text into its targets. Exported for tests. */
export function parseMakefileTargets(content: string, file = 'Makefile'): MakefileFacts {
  const targets = new Set<string>();
  const patterns = new Set<string>();
  let unverifiable = false;
  let inDefine = false;

  for (const line of logicalLines(content)) {
    // Recipe lines start with a tab; they never define targets.
    if (line.startsWith('\t')) continue;
    const text = line.replace(/(?<!\\)#.*$/, '').trimEnd();
    const trimmed = text.trim();
    if (!trimmed) continue;

    if (/^define\b/.test(trimmed) || /^(?:override\s+)?define\s/.test(trimmed)) {
      inDefine = true;
      continue;
    }
    if (inDefine) {
      if (/^endef\b/.test(trimmed)) inDefine = false;
      continue;
    }

    // Targets this reader cannot see.
    if (/^(?:-include|sinclude|include)\s/.test(trimmed)) {
      unverifiable = true;
      continue;
    }
    if (/\$\((?:eval|call)\b/.test(trimmed)) {
      unverifiable = true;
      continue;
    }

    // `NAME := x`, `NAME ::= x`, `NAME ?= x`, `NAME += x`, `NAME = x`, `export X = y`.
    const colon = trimmed.indexOf(':');
    const equals = trimmed.indexOf('=');
    if (colon === -1) continue;
    if (equals !== -1 && equals < colon) continue; // assignment whose value holds a colon
    const afterColon = trimmed.slice(colon + 1);
    if (/^:?=/.test(afterColon) || /^::=/.test(afterColon)) continue; // `:=` / `::=` / `:::=`

    const head = trimmed.slice(0, colon).trim();
    if (!head) continue;
    if (/^(?:ifeq|ifneq|ifdef|ifndef|else|endif|export|unexport|override|private|vpath)\b/.test(head)) continue;

    if (head.includes('$')) {
      // `$(BIN): main.o` — the target name is computed.
      unverifiable = true;
      continue;
    }

    if (head === '.DEFAULT') {
      // A `.DEFAULT` recipe runs for any target without a rule of its own.
      unverifiable = true;
      continue;
    }

    if (head === '.PHONY') {
      for (const name of afterColon.replace(/^:/, '').trim().split(/\s+/)) {
        if (name && !name.includes('$') && TARGET_NAME_RE.test(name)) targets.add(name);
        else if (name.includes('$')) unverifiable = true;
      }
      continue;
    }

    for (const name of head.split(/\s+/)) {
      if (!name || !TARGET_NAME_RE.test(name)) continue;
      if (name.includes('%')) patterns.add(name);
      else targets.add(name);
    }
  }

  return { file, targets: [...targets].sort(), patterns: [...patterns].sort(), unverifiable };
}

/** True when `target` is defined explicitly or matched by a pattern rule. */
export function makefileDefines(facts: MakefileFacts, target: string): boolean {
  if (facts.targets.includes(target)) return true;
  return facts.patterns.some((pattern) => {
    const idx = pattern.indexOf('%');
    const prefix = pattern.slice(0, idx);
    const suffix = pattern.slice(idx + 1);
    return (
      target.length > prefix.length + suffix.length &&
      target.startsWith(prefix) &&
      target.endsWith(suffix)
    );
  });
}

/**
 * Read the Makefile make would use in a repo-relative directory ('.' = root).
 * `undefined` when there is none (or it is oversized, unreadable, or a symlink
 * leaving the repo).
 */
export function readMakefile(repoRoot: string, dir: string): MakefileFacts | undefined {
  for (const name of MAKEFILE_NAMES) {
    const rel = dir === '.' || dir === '' ? name : `${dir}/${name}`;
    const abs = resolveReadableWithinRoot(repoRoot, rel);
    if (!abs) continue;
    try {
      const stat = fs.statSync(abs);
      if (!stat.isFile()) continue;
      // An exact-case match: on a case-insensitive filesystem `makefile` would
      // otherwise also "find" `Makefile` and report the wrong file name.
      if (!fs.readdirSync(path.dirname(abs)).includes(name)) continue;
      if (stat.size > MAX_FILE_SIZE) return { file: rel, targets: [], patterns: [], unverifiable: true };
      return parseMakefileTargets(fs.readFileSync(abs, 'utf8'), rel);
    } catch {
      continue;
    }
  }
  return undefined;
}
