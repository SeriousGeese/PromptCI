import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { RepoContext } from './repo-context.js';
import type { PromptCiIssue } from './types.js';
import { fencedBlocks, scanFencedLines } from './markdown-fences.js';

/**
 * Command Validity Detector
 *
 * Validates shell commands documented in instruction files without executing
 * them.  Checks that referenced scripts, files, and package.json script names
 * actually exist in the repository.
 *
 * Scope:
 *  - Commands extracted from fenced code blocks (```bash / ```sh / …)
 *  - Inline backtick commands
 *  - Prose patterns like "run pnpm test"
 *  - Multi-command lines joined with && are split and each segment validated
 *
 * Findings are heuristic — cautious wording is intentional.
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Stable per-finding ID based on file + command text. */
function issueId(filePath: string, cmdText: string): string {
  const hash = crypto
    .createHash('sha1')
    .update(`${filePath}|${cmdText}`)
    .digest('hex')
    .slice(0, 12);
  return `cmd-validity-${hash}`;
}

/** Returns true when a repo-relative path exists on disk. */
function fileExists(repoRoot: string, relativePath: string): boolean {
  try {
    const full = path.resolve(repoRoot, relativePath);
    return fs.existsSync(full);
  } catch {
    return false;
  }
}

function readPackageScripts(packageJsonPath: string): { name?: string; scripts: Record<string, string> } | null {
  try {
    const raw = fs.readFileSync(packageJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const scripts = typeof parsed.scripts === 'object' && parsed.scripts !== null && !Array.isArray(parsed.scripts)
      ? Object.fromEntries(
          Object.entries(parsed.scripts).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
        )
      : {};
    return {
      name: typeof parsed.name === 'string' ? parsed.name : undefined,
      scripts,
    };
  } catch {
    return null;
  }
}

function pnpmFilterValue(parts: string[]): string | undefined {
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]!;
    if (part === '--filter' || part === '-F') return parts[i + 1];
    if (part.startsWith('--filter=')) return part.slice('--filter='.length);
    if (part.startsWith('-F=')) return part.slice('-F='.length);
  }
  return undefined;
}

function normalizePnpmFilter(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value
    .replace(/^['"]|['"]$/g, '')
    .replace(/^\.\.\./, '')
    .replace(/\.\.\.$/, '')
    .replace(/^!/, '')
    .trim();
}

function workspacePackageJsonCandidates(repoRoot: string, selector: string): string[] {
  const candidates = new Set<string>();
  const selectorAsPath = selector.replace(/\\/g, '/');
  if (selectorAsPath.startsWith('.') || selectorAsPath.includes('/')) {
    candidates.add(path.join(repoRoot, selectorAsPath, 'package.json'));
  }

  for (const dir of ['apps', 'packages', 'libs']) {
    const absDir = path.join(repoRoot, dir);
    try {
      for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          candidates.add(path.join(absDir, entry.name, 'package.json'));
        }
      }
    } catch {
      // Workspace directory absent.
    }
  }

  return [...candidates];
}

function workspaceHasScript(context: RepoContext, selector: string | undefined, scriptName: string): boolean {
  const normalizedSelector = normalizePnpmFilter(selector);
  if (!normalizedSelector) return false;

  for (const candidate of workspacePackageJsonCandidates(context.repoRoot, normalizedSelector)) {
    const pkg = readPackageScripts(candidate);
    if (!pkg) continue;
    const packageDir = path.dirname(candidate).replace(/\\/g, '/');
    const relDir = path.relative(context.repoRoot, packageDir).replace(/\\/g, '/');
    const selectorMatches =
      pkg.name === normalizedSelector ||
      relDir === normalizedSelector ||
      relDir.endsWith(`/${normalizedSelector}`);
    if (selectorMatches && !!pkg.scripts[scriptName]) return true;
  }

  return false;
}

/** Returns true when a path string looks like a file reference (not a flag). */
function isLikelyFilePath(str: string): boolean {
  if (!str) return false;
  if (str.startsWith('-')) return false; // CLI flag
  // Looks like a path if it has a directory separator or a file extension
  return str.includes('/') || str.includes('\\') || /\.[a-z]{1,5}$/i.test(str);
}

// ── Standard subcommands that are NOT user-defined package scripts ─────────────

const PNPM_BUILTINS = new Set([
  'install', 'i', 'add', 'remove', 'uninstall', 'test', 'it', 'init',
  'create', 'publish', 'link', 'unlink', 'outdated', 'audit', 'update',
  'up', 'exec', 'dlx', 'run', 'store', 'list', 'ls', 'why', 'pack',
  'recursive', 'm', 'multi', 'prune',
]);

const NPM_BUILTINS = new Set([
  'install', 'i', 'ci', 'uninstall', 'remove', 'update', 'outdated',
  'audit', 'start', 'stop', 'restart', 'test', 'it', 'init', 'create',
  'publish', 'link', 'unlink', 'pack', 'exec', 'run',
]);

const YARN_BUILTINS = new Set([
  'install', 'add', 'remove', 'upgrade', 'outdated', 'audit', 'init',
  'create', 'publish', 'link', 'unlink', 'why', 'pack', 'run',
]);

// ── Command extraction ────────────────────────────────────────────────────────

type ExtractedCommand = {
  text: string;
  line: number;
  /**
   * Repo-relative directory the command runs in. '.' = repo root. `null` means
   * the working directory is unknown (an unresolvable `cd`, e.g. an absolute or
   * out-of-repo path), in which case script/file validation is skipped.
   */
  cwd?: string | null;
};

/**
 * CV6: Resolves a `cd <target>` against the current repo-relative directory so
 * that a `cd apps/web && pnpm test:e2e` line validates `test:e2e` against
 * `apps/web/package.json` rather than the repo-root manifest. Returns the new
 * repo-relative POSIX directory ('.' for root), or `null` when the target
 * escapes the repo or is absolute/home (an unknown location we won't validate).
 */
function resolveCwd(current: string | null, target: string): string | null {
  if (current === null) return null;
  const cleaned = target.replace(/^['"]|['"]$/g, '').trim();
  if (!cleaned || cleaned.startsWith('/') || cleaned.startsWith('~') || /^[a-zA-Z]:[\\/]/.test(cleaned)) {
    return null; // absolute or home path — not resolvable to a repo-relative dir
  }
  const parts: string[] = current === '.' ? [] : current.split('/');
  for (const seg of cleaned.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null; // escapes repo root
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.length === 0 ? '.' : parts.join('/');
}

/**
 * Splits a command string on `&&`, `||`, `;`, and newlines, yielding
 * individual segments. This allows a single `run:` block or backtick
 * expression like `pnpm lint && pnpm test` — or `pnpm lint; pnpm bogus`, or
 * `cmd1 || cmd2` — to be validated command-by-command.
 *
 * CV4: previously only `&&`/newline were split, so `;` and `||` joined
 * commands stayed as ONE segment — `pnpm lint; pnpm bogus` read as tool
 * "pnpm", subcommand "lint;" (a false-positive missing-script report on the
 * literal string "lint;"), and the second command was never validated at all.
 */
function splitOnAmpersand(cmd: string): string[] {
  return cmd
    .split(/&&|\|\||;|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Returns true if a text looks like it could be a shell command to validate. */
function isPotentialCommand(text: string): boolean {
  const KNOWN_PREFIXES = [
    'npm', 'pnpm', 'yarn', 'bun',
    'node', 'tsx', 'ts-node', 'bash', 'sh', 'python', 'python3',
    'dotnet', 'docker', 'make',
    'git', 'ls', 'cd', 'mkdir', 'rm', 'cp', 'mv',
    './', '../',
  ];
  const first = text.trim().split(/\s+/)[0] ?? '';
  if (KNOWN_PREFIXES.some((p) => first === p || first.startsWith('./'))) return true;
  // ./scripts/something.sh style
  if (first.startsWith('./') || first.startsWith('../')) return true;
  return false;
}

/**
 * Fence languages whose content is treated as shell commands. A bare fence
 * (no language) is also treated as shell — that matches the historical
 * behavior of the old regex, where the language group was optional.
 */
const SHELL_FENCE_LANGS = new Set([
  'bash', 'sh', 'shell', 'powershell', 'pwsh', 'zsh', 'command-line', 'cmd',
]);

/** Extracts commands from a single instruction-file content string. */
function extractCommands(content: string): ExtractedCommand[] {
  const commands: ExtractedCommand[] = [];

  // Fenced blocks first, prose second, then sorted back into document order
  // below — findings quote the first occurrence of a command, so the order the
  // two passes produce has to match the order a single interleaved pass did.
  //
  // Only CLOSED blocks contribute: an unclosed fence is a malformed document,
  // and its tail was never meant to read as example commands. Non-shell fences
  // (```json, ```ts, …) are skipped by language — tracking them at all is what
  // keeps a ```json block's bare ``` closer from being misread as an opener,
  // which used to invert the in-block state for the rest of the file.
  for (const block of fencedBlocks(content)) {
    const isShell = block.lang === '' || SHELL_FENCE_LANGS.has(block.lang);
    if (!isShell || !block.closed) continue;

    // Each entry's index corresponds 1:1 to its physical line offset from the
    // block's first content line, so blank leading lines cannot shift the
    // reported line number.
    for (let j = 0; j < block.lines.length; j++) {
      const rawTrimmed = block.lines[j]!.trim();
      if (rawTrimmed.startsWith('#')) continue;
      const trimmed = rawTrimmed.replace(/^\$\s*/, '');
      if (!trimmed) continue;
      // CV6: each documented line is treated as an independent example run
      // from the repo root, so `cd` only affects commands chained after it
      // on the SAME line (e.g. `cd apps/web && pnpm test:e2e`). Setup blocks
      // are written this way — repeating `cd apps/web` on separate lines —
      // so a standalone `cd` must not bleed into later lines.
      let lineCwd: string | null = '.';
      for (const seg of splitOnAmpersand(trimmed)) {
        const cdMatch = /^cd\s+(.+)$/.exec(seg);
        if (cdMatch) {
          lineCwd = resolveCwd(lineCwd, cdMatch[1]!.trim());
        }
        commands.push({ text: seg, line: block.contentStartLine + j, cwd: lineCwd });
      }
    }
  }

  for (const fenceLine of scanFencedLines(content)) {
    if (fenceLine.inFence) continue;
    const i = fenceLine.lineNumber - 1;
    // A trailing CR would block the prose patterns below: `.` does not match
    // it, so the end-of-line lookahead never fires on a CRLF file.
    const line = fenceLine.text.replace(/\r$/, '');

    // Inline backticks
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      const inner = m[1]!.trim();
      // CV6: an inline backtick expression is one shell line, so `cd` inside it
      // affects the commands chained after it (e.g. `cd apps/web && pnpm test:e2e`).
      let lineCwd: string | null = '.';
      // Split on && inside backticks
      for (const seg of splitOnAmpersand(inner)) {
        const cdMatch = /^cd\s+(.+)$/.exec(seg);
        if (cdMatch) {
          lineCwd = resolveCwd(lineCwd, cdMatch[1]!.trim());
        }
        if (isPotentialCommand(seg)) {
          commands.push({ text: seg, line: i + 1, cwd: lineCwd });
        }
      }
    }

    // Prose "run pnpm test" / "run npm run build" patterns
    for (const m of line.matchAll(
      /\brun\s+(pnpm|npm|yarn|bun|node|tsx|ts-node|bash|python|dotnet|docker)\s+(.+?)(?=[.!?](?:\s|$)|[,;!]|$)/gi,
    )) {
      const args = (m[2] ?? '').trim().replace(/[.!?]+$/, '');
      const fullCmd = `${m[1]} ${args}`.trim();
      commands.push({ text: fullCmd, line: i + 1 });
    }
  }

  // Stable sort: segments split from one line keep their left-to-right order.
  return commands.sort((a, b) => a.line - b.line);
}

// ── Command validation ────────────────────────────────────────────────────────

/** Placeholder patterns that indicate a command is intentionally abstract. */
const PLACEHOLDER_RE = /[<{]|\.{3,}|your-file|your-script|example|placeholder/i;

/**
 * CV3/CV5: CLI flags that take a following value argument, keyed by the flag
 * text. Used to skip PAST both the flag and its value when hunting for the
 * "real" subcommand/script-name or file-path argument — without this, a flag
 * like `--filter` or `--loader` gets mistaken for the subcommand, and its
 * VALUE (a package name or loader module) gets mistaken for a file path.
 */
const FLAGS_WITH_VALUE = new Set(['--filter', '-F', '--cwd', '-C', '--loader', '--require', '-r']);

function flagTakesValue(tool: string, flag: string): boolean {
  if (tool === 'pnpm' && flag === '-r') return false;
  return FLAGS_WITH_VALUE.has(flag);
}

/**
 * Returns the index of the first token in `parts` (starting after the tool
 * name at index 0) that is NOT a flag and not a known flag's value.
 *
 * CV3: `pnpm --filter @promptci/core test` previously read parts[1]
 * ("--filter") as the script name, reporting a false-positive missing
 * script. `pnpm -r build` and `yarn --cwd app build` had the same problem.
 * CV5: `node --loader ts-node/esm src/x.ts` previously matched
 * "ts-node/esm" (the loader flag's VALUE, which happens to contain a slash)
 * as the file being executed, instead of the real target "src/x.ts".
 */
function firstNonFlagArgIndex(parts: string[]): number {
  let idx = 1;
  const tool = parts[0] ?? '';
  while (idx < parts.length) {
    const p = parts[idx]!;
    if (!p.startsWith('-')) break;
    idx++;
    if (flagTakesValue(tool, p) && parts[idx] && !parts[idx]!.startsWith('-')) {
      idx++; // also skip the flag's value token
    }
  }
  return idx;
}

/**
 * CV6/CV7: Validates one or more package-manager script names, honoring both a
 * `cd`-established working directory and slash-joined shorthand.
 *
 * CV6 (cwd): when a command runs after `cd <subdir>`, its scripts live in
 * `<subdir>/package.json`, NOT the repo-root manifest — so
 * `cd apps/web && pnpm test:e2e` is valid whenever apps/web defines `test:e2e`.
 *
 * CV7 (slash shorthand): `pnpm lint/typecheck/test/build` is a documentation
 * shorthand for four separate scripts, not one literal script named
 * "lint/typecheck/test/build". Each `/`-separated part is validated on its own.
 *
 * Returns an error string for the first genuinely-missing script, or null.
 */
function findMissingScript(
  context: RepoContext,
  cwd: string | null,
  parts: string[],
  scriptName: string,
  builtins: Set<string>,
  tool: string,
): string | null {
  // Unknown working directory (unresolvable `cd`) — cannot verify.
  if (cwd === null) return null;

  const names = scriptName.includes('/')
    ? scriptName.split('/').map((s) => s.trim()).filter(Boolean)
    : [scriptName];

  const inSubdir = cwd !== '.' && cwd !== '';
  const dirPkg = inSubdir
    ? readPackageScripts(path.join(context.repoRoot, cwd, 'package.json'))
    : null;
  // cd'd into a directory whose package.json we can't read — don't guess.
  if (inSubdir && !dirPkg) return null;
  const rootScriptsLoaded = Object.keys(context.packageJson.scripts).length > 0;
  // No manifest we can check anywhere — stay silent.
  if (!dirPkg && !rootScriptsLoaded) return null;

  for (const name of names) {
    if (builtins.has(name)) continue;

    if (dirPkg) {
      // A command that runs inside a subdir resolves scripts ONLY from that
      // subdir's manifest (pnpm/npm/yarn do not search parent directories) or
      // from an explicit --filter workspace target. A same-named root script is
      // NOT reachable here, so it must not mask a genuinely missing subdir
      // script.
      if (dirPkg.scripts[name]) continue;
      if (workspaceHasScript(context, pnpmFilterValue(parts), name)) continue;
      return `${tool} script "${name}" does not appear in ${cwd}/package.json scripts`;
    }

    // Repo-root context: the pnpm --filter workspace target or the root manifest.
    if (workspaceHasScript(context, pnpmFilterValue(parts), name)) continue;
    if (context.packageJson.scripts[name]) continue;
    return `${tool} script "${name}" does not appear in package.json scripts`;
  }
  return null;
}

/**
 * Validates a single command segment against the repo context.
 * Returns a human-readable error string, or null if the command looks valid.
 *
 * @param cwd Repo-relative directory the command runs in ('.' = root, null =
 *            unknown after an unresolvable `cd` — validation is skipped).
 */
function validateSegment(seg: string, context: RepoContext, cwd: string | null = '.'): string | null {
  if (PLACEHOLDER_RE.test(seg)) return null;

  const parts = seg.trim().split(/\s+/);
  if (parts.length === 0) return null;
  const tool = parts[0]!;

  // Base directory for file-existence checks — respects a `cd`-established cwd.
  const baseDir = cwd === null
    ? null
    : cwd !== '.' && cwd !== ''
      ? path.join(context.repoRoot, cwd)
      : context.repoRoot;

  // ── Package manager scripts ────────────────────────────────────────────────
  if (tool === 'pnpm') {
    const subIdx = firstNonFlagArgIndex(parts);
    const sub = parts[subIdx];
    if (!sub) return null;
    const scriptName = sub === 'run' ? parts[subIdx + 1] : sub;
    if (!scriptName) return null;
    return findMissingScript(context, cwd, parts, scriptName, PNPM_BUILTINS, 'pnpm');
  }

  if (tool === 'npm') {
    const subIdx = firstNonFlagArgIndex(parts);
    if (parts[subIdx] === 'run' && parts[subIdx + 1]) {
      return findMissingScript(context, cwd, parts, parts[subIdx + 1]!, NPM_BUILTINS, 'npm');
    }
  }

  if (tool === 'yarn') {
    const subIdx = firstNonFlagArgIndex(parts);
    const sub = parts[subIdx];
    if (!sub) return null;
    const scriptName = sub === 'run'
      ? parts[subIdx + 1]
      : sub === 'workspace'
        ? parts[subIdx + 2]
        : sub;
    if (!scriptName) return null;
    return findMissingScript(context, cwd, parts, scriptName, YARN_BUILTINS, 'yarn');
  }

  // ── File-executing commands ────────────────────────────────────────────────
  const FILE_EXECUTORS = ['node', 'tsx', 'ts-node', 'bash', 'sh', 'python', 'python3'];
  if (baseDir && FILE_EXECUTORS.includes(tool) && parts[1]) {
    // Skip flags (and known flags' values, e.g. `--loader ts-node/esm`) to
    // find the actual script/file argument.
    const filePart = parts[firstNonFlagArgIndex(parts)];
    if (filePart && isLikelyFilePath(filePart) && !fileExists(baseDir, filePart)) {
      return `File "${filePart}" referenced by "${tool}" does not appear to exist in the repository`;
    }
  }

  // ── Direct script invocations: ./scripts/foo.sh ───────────────────────────
  if (baseDir && (tool.startsWith('./') || tool.startsWith('../'))) {
    if (!fileExists(baseDir, tool)) {
      return `Script "${tool}" does not appear to exist in the repository`;
    }
  }

  // ── docker compose -f <file> ───────────────────────────────────────────────
  if (baseDir && tool === 'docker' && parts[1] === 'compose' && parts.includes('-f')) {
    const fIdx = parts.indexOf('-f');
    const composeFile = parts[fIdx + 1];
    if (composeFile && isLikelyFilePath(composeFile) && !fileExists(baseDir, composeFile)) {
      return `Docker Compose file "${composeFile}" does not appear to exist in the repository`;
    }
  }

  // ── dotnet test <project-or-solution> ─────────────────────────────────────
  if (baseDir && tool === 'dotnet' && parts[1] === 'test' && parts[2]) {
    const target = parts[2];
    if (isLikelyFilePath(target)) {
      if (!fileExists(baseDir, target)) {
        return `dotnet test target "${target}" does not appear to exist`;
      }
      if (!/\.(sln|csproj|fsproj)$/.test(target)) {
        return `dotnet test target "${target}" should be a .sln, .csproj, or .fsproj file`;
      }
    }
  }

  return null;
}

// ── Public detector ───────────────────────────────────────────────────────────

/**
 * Validates commands documented in instruction files against the repository's
 * actual scripts and file structure.
 *
 * Returns findings only for high-confidence breakages — missing package
 * scripts and missing file references.  Executable binary availability is
 * out of scope.
 */
export function detectCommandValidity(context: RepoContext): PromptCiIssue[] {
  const issues: PromptCiIssue[] = [];
  const reported = new Set<string>();

  for (const file of context.files) {
    const commands = extractCommands(file.content);

    for (const cmd of commands) {
      const error = validateSegment(cmd.text, context, cmd.cwd ?? '.');
      if (!error) continue;

      // Deduplicate same command text appearing twice in the same file
      const dedupeKey = `${file.path}|${cmd.text}`;
      if (reported.has(dedupeKey)) continue;
      reported.add(dedupeKey);

      issues.push({
        id: issueId(file.path, cmd.text),
        severity: 'warning',
        category: 'command_validity',
        title: `Possible reference to missing command or file: \`${cmd.text.split(/\s+/).slice(0, 3).join(' ')}\``,
        summary: error,
        filePaths: [file.path],
        locations: [{ filePath: file.path, startLine: cmd.line, endLine: cmd.line }],
        evidence: [`Command: \`${cmd.text}\``, `In file: ${file.path}`],
        recommendation:
          'Verify the command. If the script was renamed, update the instruction file. ' +
          'If it is an illustrative example, wrap it in a placeholder like <script-name> to suppress this finding.',
        confidence: 0.8,
      });
    }
  }

  return issues;
}
