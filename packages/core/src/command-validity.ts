import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { RepoContext } from './repo-context.js';
import type { PromptCiIssue } from './types.js';
import { fencedBlocks, scanFencedLines } from './markdown-fences.js';
import { fileIdPath } from './finding-id.js';
import { anyWorkspaceHasScript, isKnownBinary, selectWorkspaces } from './workspace-manifests.js';
import { makefileDefines, readMakefile } from './makefile.js';
import type { MakefileFacts } from './makefile.js';
import { realPathWithinRoot } from './path-containment.js';

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

function isDirectory(repoRoot: string, relativePath: string): boolean {
  try {
    return fs.statSync(path.resolve(repoRoot, relativePath)).isDirectory();
  } catch {
    return false;
  }
}

function readPackageScripts(
  repoRoot: string,
  packageJsonPath: string,
): { name?: string; scripts: Record<string, string> } | null {
  // A manifest committed as a symlink to a file outside the repo is not read.
  if (!realPathWithinRoot(repoRoot, packageJsonPath)) return null;
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

  // Workspace manifests discovered while building the context (declared
  // `workspaces` globs, any layout). The path-based lookup below is only for
  // contexts built without them.
  if (context.workspaces) {
    return selectWorkspaces(context, normalizedSelector).some((ws) => !!ws.scripts[scriptName]);
  }

  for (const candidate of workspacePackageJsonCandidates(context.repoRoot, normalizedSelector)) {
    const pkg = readPackageScripts(context.repoRoot, candidate);
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
  'recursive', 'm', 'multi', 'prune', 'version', 'run-script',
  'env', 'config', 'fetch', 'rebuild', 'rb', 'patch', 'patch-commit', 'deploy',
  'import', 'licenses', 'root', 'bin', 'setup', 'self-update', 'dedupe', 'doctor',
  'approve-builds', 'sbom', 'cache',
]);

const NPM_BUILTINS = new Set([
  'install', 'i', 'ci', 'uninstall', 'remove', 'update', 'outdated',
  'audit', 'start', 'stop', 'restart', 'test', 'it', 'init', 'create',
  'publish', 'link', 'unlink', 'pack', 'exec', 'run', 'run-script', 'version',
]);

const YARN_BUILTINS = new Set([
  'install', 'add', 'remove', 'upgrade', 'outdated', 'audit', 'init',
  'create', 'publish', 'link', 'unlink', 'why', 'pack', 'run', 'version',
  'run-script', 'workspaces', 'exec', 'dlx', 'up', 'info', 'config', 'cache',
  'bin', 'set', 'node', 'global', 'dedupe', 'patch', 'rebuild', 'plugin',
  'constraints', 'unplug', 'npm',
]);

/** `bun <name>` runs a script (or file) only when <name> is not one of bun's own commands. */
export const BUN_BUILTINS: ReadonlySet<string> = new Set([
  'install', 'i', 'add', 'a', 'remove', 'rm', 'update', 'test', 'build', 'init',
  'create', 'c', 'x', 'bunx', 'pm', 'link', 'unlink', 'upgrade', 'repl', 'outdated',
  'publish', 'patch', 'audit', 'info', 'why', 'completions', 'help', 'feedback',
  'run', 'exec',
]);

/** npm and pnpm treat `run-script` as an alias of `run`. */
const RUN_ALIASES = new Set(['run', 'run-script']);

// ── Command extraction ────────────────────────────────────────────────────────

type ExtractedCommand = {
  text: string;
  line: number;
  /**
   * Repo-relative directory the command runs in. '.' = repo root; `undefined`
   * (prose commands, which never carry a `cd`) also means the repo root.
   * `null` means the working directory is unknown — an unresolvable `cd` (an
   * absolute, home, out-of-repo or variable path) — and every script, file and
   * make-target check is skipped: the command is unverifiable, NOT validated
   * against the repo root.
   */
  cwd?: string | null;
  /** Came from a shell code fence (a line meant to be run), not an inline code span. */
  fenced?: boolean;
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
  // `cd -`, `cd $DIR`, `cd "$(git rev-parse --show-toplevel)"`, `cd %TEMP%`,
  // `cd <dir>`: computed or placeholder targets name no knowable directory.
  if (/^-|[$`%<>{}*?]/.test(cleaned)) return null;
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
    // The shared scanner reports the full info string ('{.bash}', 'json,');
    // classify on its leading identifier run, matching the historical opener
    // regex `([a-zA-Z0-9_-]*)`. That keeps a pandoc-attribute fence like
    // ```{.bash} classified as bare-and-therefore-shell (identifier run is
    // empty) instead of being silently skipped as an unknown language.
    const lang = /^[a-zA-Z0-9_-]*/.exec(block.lang)![0];
    const isShell = lang === '' || SHELL_FENCE_LANGS.has(lang);
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
        commands.push({ text: seg, line: block.contentStartLine + j, cwd: lineCwd, fenced: true });
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
const FLAGS_WITH_VALUE = new Set([
  '--filter', '-F', '--cwd', '-C', '--dir', '--loader', '--require', '-r', '--workspace', '--prefix',
]);

function flagTakesValue(tool: string, flag: string): boolean {
  if (tool === 'pnpm' && flag === '-r') return false;
  // npm `-w <workspace>` takes a value; pnpm's `-w` (workspace root) does not.
  if (flag === '-w') return tool === 'npm';
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
function firstNonFlagArgIndex(parts: string[], startIdx = 1): number {
  let idx = startIdx;
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
type ScriptLookup = {
  /**
   * The command form falls through to an installed binary when no script of
   * that name exists: bare `pnpm <bin>` / `yarn <bin>`, `yarn run <bin>`, and
   * `bun run <bin>`. `npm run` and `pnpm run` accept scripts only.
   */
  allowBinary: boolean;
  /** Workspace named by `yarn workspace <name> …`. */
  workspaceName?: string;
};

/** The `--filter`/`-F` (pnpm, bun) or `-w`/`--workspace` (npm) selector, if any. */
function workspaceSelector(tool: string, parts: string[]): string | undefined {
  const filter = pnpmFilterValue(parts);
  if (filter) return filter;
  if (tool !== 'npm') return undefined;
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]!;
    if (part === '-w' || part === '--workspace') return parts[i + 1];
    if (part.startsWith('--workspace=')) return part.slice('--workspace='.length);
  }
  return undefined;
}

/** `pnpm -r` / `pnpm --recursive` / `npm --workspaces`: the script may live in any workspace. */
function runsInAllWorkspaces(tool: string, parts: string[]): boolean {
  if (tool === 'pnpm') return parts.some((p) => p === '-r' || p === '--recursive');
  if (tool === 'npm') return parts.some((p) => p === '--workspaces' || p === '-ws');
  return false;
}

/** A directory override (`--cwd`, `-C`, `--prefix`) re-roots the command like a `cd` would. */
function cwdOverride(parts: string[]): string | undefined {
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]!;
    if (part === '--cwd' || part === '-C' || part === '--dir' || part === '--prefix') return parts[i + 1];
    const eq = /^(?:--cwd|--dir|--prefix)=(.+)$/.exec(part);
    if (eq) return eq[1];
  }
  return undefined;
}

function findMissingScript(
  context: RepoContext,
  cwd: string | null,
  parts: string[],
  scriptName: string,
  builtins: Set<string>,
  tool: string,
  lookup: ScriptLookup,
  onScript?: (name: string) => void,
): string | null {
  const names = scriptName.includes('/')
    ? scriptName.split('/').map((s) => s.trim()).filter(Boolean)
    : [scriptName];
  // Recorded before any early return so callers know this command was judged —
  // including when it could not be checked (unknown working directory).
  for (const name of names) onScript?.(name);

  // Unknown working directory (unresolvable `cd`) — cannot verify.
  if (cwd === null) return null;

  const override = cwdOverride(parts);
  if (override !== undefined) {
    const resolved = resolveCwd(cwd, override);
    if (resolved === null) return null;
    cwd = resolved;
  }

  const selector = lookup.workspaceName ?? workspaceSelector(tool, parts);
  const allWorkspaces = runsInAllWorkspaces(tool, parts);
  const inWorkspaceScope = (name: string): boolean =>
    allWorkspaces ? anyWorkspaceHasScript(context, name) : workspaceHasScript(context, selector, name);

  // With discovered workspaces, an explicit selector means ONLY the selected
  // packages: the root manifest's same-named script is not what runs, and a
  // selector that matches no package is itself the error.
  const selectedWorkspaces =
    selector && context.workspaces && !allWorkspaces
      ? selectWorkspaces(context, selector.replace(/^['"]|['"]$/g, '').replace(/^\.\.\./, '').replace(/\.\.\.$/, '').trim())
      : undefined;

  const inSubdir = cwd !== '.' && cwd !== '';
  const dirPkg = inSubdir
    ? readPackageScripts(context.repoRoot, path.join(context.repoRoot, cwd, 'package.json'))
    : null;
  // cd'd into a directory whose package.json we can't read — don't guess.
  if (inSubdir && !dirPkg) return null;
  const rootScriptsLoaded = Object.keys(context.packageJson.scripts).length > 0;
  // No manifest we can check anywhere — stay silent.
  if (!dirPkg && !rootScriptsLoaded) return null;

  for (const name of names) {
    if (builtins.has(name)) continue;
    // `pnpm vitest run`, `yarn tsc --noEmit`: no script of that name, but it is
    // an installed dependency's binary — the package manager runs that instead.
    if (lookup.allowBinary && isKnownBinary(context, name)) continue;

    if (selectedWorkspaces) {
      if (selectedWorkspaces.length === 0) {
        if (context.workspacesTruncated) continue; // only a sample of the workspace was read
        return `no workspace matches "${selector}" for ${tool} script "${name}"`;
      }
      if (selectedWorkspaces.some((ws) => !!ws.scripts[name])) continue;
      const target = selectedWorkspaces.length === 1
        ? `${selectedWorkspaces[0]!.name ?? selectedWorkspaces[0]!.dir} (${selectedWorkspaces[0]!.dir}/package.json)`
        : `the ${selectedWorkspaces.length} workspaces selected by "${selector}"`;
      return `${tool} script "${name}" does not appear in ${target} scripts`;
    }

    if (dirPkg) {
      // A command that runs inside a subdir resolves scripts ONLY from that
      // subdir's manifest (pnpm/npm/yarn do not search parent directories) or
      // from an explicit --filter workspace target. A same-named root script is
      // NOT reachable here, so it must not mask a genuinely missing subdir
      // script.
      if (dirPkg.scripts[name]) continue;
      if (inWorkspaceScope(name)) continue;
      return `${tool} script "${name}" does not appear in ${cwd}/package.json scripts`;
    }

    // Repo-root context: the workspace target(s) or the root manifest.
    if (inWorkspaceScope(name)) continue;
    if (context.packageJson.scripts[name]) continue;
    return `${tool} script "${name}" does not appear in package.json scripts`;
  }
  return null;
}

const BUILTINS_BY_TOOL: Record<'pnpm' | 'npm' | 'yarn' | 'bun', Set<string>> = {
  pnpm: PNPM_BUILTINS,
  npm: NPM_BUILTINS,
  yarn: YARN_BUILTINS,
  // bun's own commands are filtered before this lookup (bare form only), so
  // `bun run test` is judged against the manifest like any other script.
  bun: new Set(),
};

/**
 * Resolves which script (or file, for bun) a `pnpm`/`npm`/`yarn`/`bun` command
 * invokes and checks it. Handles the `run` / `run-script` forms, the bare
 * `pnpm <script>` / `yarn <script>` / `bun <script>` forms (which fall through
 * to an installed binary), `yarn workspace <name> <script>`, and workspace or
 * directory selectors.
 */
function validatePackageManagerScript(
  tool: 'pnpm' | 'npm' | 'yarn' | 'bun',
  parts: string[],
  context: RepoContext,
  cwd: string | null,
  baseDir: string | null,
  onScript?: (name: string) => void,
): string | null {
  const subIdx = firstNonFlagArgIndex(parts);
  const sub = parts[subIdx];
  if (!sub) return null;

  let explicitRun = false;
  let nameIdx = subIdx;
  let workspaceName: string | undefined;
  if (RUN_ALIASES.has(sub)) {
    explicitRun = true;
    nameIdx = firstNonFlagArgIndex(parts, subIdx + 1);
  } else if (tool === 'npm') {
    return null; // a bare `npm <x>` is an npm command, never a script
  } else if (tool === 'yarn' && sub === 'workspace') {
    workspaceName = parts[subIdx + 1];
    nameIdx = subIdx + 2;
    if (RUN_ALIASES.has(parts[nameIdx] ?? '')) {
      explicitRun = true;
      nameIdx++;
    }
  }

  const scriptName = parts[nameIdx];
  if (!scriptName || scriptName.startsWith('-')) return null;

  if (tool === 'bun') {
    // `bun <x>` / `bun run <x>` also run files — a path is not a script name.
    if (!explicitRun && BUN_BUILTINS.has(scriptName)) return null;
    if (isLikelyFilePath(scriptName)) {
      if (baseDir && /\.[cm]?[jt]sx?$/.test(scriptName) && !fileExists(baseDir, scriptName)) {
        return `File "${scriptName}" referenced by "bun" does not appear to exist in the repository`;
      }
      return null;
    }
  }

  return findMissingScript(
    context,
    cwd,
    parts,
    scriptName,
    BUILTINS_BY_TOOL[tool],
    tool,
    // npm/pnpm `run` only run scripts; every other form can fall through to a binary.
    { allowBinary: !(explicitRun && (tool === 'npm' || tool === 'pnpm')), workspaceName },
    onScript,
  );
}

// ── make targets ──────────────────────────────────────────────────────────────

/** make options whose value is the NEXT token (unless attached: `-Cdir`, `-j4`). */
const MAKE_FLAGS_WITH_VALUE = new Set([
  '-C', '-f', '-o', '-W', '-I', '-E', '--directory', '--file', '--makefile', '--old-file', '--what-if',
  '--include-dir', '--new-file', '--assume-old', '--assume-new', '--eval',
]);
/** Words that follow "make" in English prose (`make sure`), never checked as targets in a code span. */
const MAKE_PROSE_WORDS: ReadonlySet<string> = new Set([
  'sure', 'it', 'this', 'that', 'them', 'these', 'those', 'certain', 'sense', 'changes', 'room', 'use', 'way',
]);
/** make options with an OPTIONAL numeric value (`-j`, `-j 4`, `-l 2.5`). */
const MAKE_FLAGS_WITH_OPTIONAL_NUMBER = new Set(['-j', '-l', '--jobs', '--load-average', '--max-load']);

/**
 * pcic-2b6.10: `make <target>` against the Makefile make would read. Reports a
 * target only when a Makefile exists in the command's directory, this reader
 * could enumerate every target it defines (no `include`, no computed names),
 * and neither an explicit target, a `.PHONY` name nor a pattern rule covers it.
 * Variable assignments (`make X=1`), file-path goals (`make build/app.o`) and
 * names make could build from a same-stem source via its built-in implicit
 * rules (`make hello` next to `hello.c`) are never reported.
 */
function validateMakeTargets(
  parts: string[],
  context: RepoContext,
  cwd: string,
  makefileFor: (dir: string) => MakefileFacts | undefined,
): string | null {
  let dir: string | null = cwd;
  const goals: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i]!;
    // Shell plumbing ends the make invocation.
    if (/^(?:[|&<>#]|\d*>)/.test(p)) break;
    if (p.startsWith('-')) {
      const eq = p.indexOf('=');
      const name = eq === -1 ? p : p.slice(0, eq);
      if (name === '-f' || name === '--file' || name === '--makefile' || /^-f./.test(p)) return null; // another file
      let value: string | undefined;
      if (MAKE_FLAGS_WITH_VALUE.has(name)) {
        value = eq !== -1 ? p.slice(eq + 1) : parts[++i];
      } else if (/^-C./.test(p)) {
        value = p.slice(2);
      } else if (MAKE_FLAGS_WITH_OPTIONAL_NUMBER.has(p) && /^\d+(?:\.\d+)?$/.test(parts[i + 1] ?? '')) {
        i++;
      }
      if ((name === '-C' || name === '--directory' || /^-C./.test(p)) && value !== undefined) {
        dir = resolveCwd(dir, value);
      }
      continue;
    }
    if (p.includes('=')) continue; // `make CC=clang build`
    goals.push(p);
  }
  if (dir === null || goals.length === 0) return null;

  const facts = makefileFor(dir);
  if (!facts || facts.unverifiable) return null;

  const baseDir = dir === '.' ? context.repoRoot : path.join(context.repoRoot, dir);
  let entries: string[] | undefined;
  for (const goal of goals) {
    const target = goal.replace(/^['"]|['"]$/g, '');
    if (!target || isLikelyFilePath(target) || !/^[A-Za-z0-9_.+-]+$/.test(target)) continue;
    if (makefileDefines(facts, target)) continue;
    // make can build `target` from `target.c` etc. with its built-in rules.
    try {
      entries ??= fs.readdirSync(baseDir);
    } catch {
      entries = [];
    }
    if (entries.some((e) => e === target || e.startsWith(`${target}.`))) continue;
    return `make target "${target}" does not appear in ${facts.file}`;
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
function validateSegment(
  seg: string,
  context: RepoContext,
  cwd: string | null = '.',
  onScript?: (name: string) => void,
  opts: {
    fenced?: boolean;
    makefileFor?: (dir: string) => MakefileFacts | undefined;
    /** Repo-relative POSIX directory of the instruction file ('.' = root). */
    fileDir?: string;
  } = {},
): string | null {
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
  if (tool === 'pnpm' || tool === 'npm' || tool === 'yarn' || tool === 'bun') {
    return validatePackageManagerScript(tool, parts, context, cwd, baseDir, onScript);
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

  // ── make <target> ──────────────────────────────────────────────────────────
  if (tool === 'make' && cwd !== null && opts.makefileFor) {
    // An instruction file that sits next to its own Makefile (`tools/AGENTS.md`
    // beside `tools/Makefile`) documents that one, not the root's.
    const fileDir = opts.fileDir ?? '.';
    const makeCwd = cwd === '.' && fileDir !== '.' && opts.makefileFor(fileDir) ? fileDir : cwd;
    // A code span like `make sure` is English, not a make invocation.
    if (!opts.fenced && parts.length === 2 && MAKE_PROSE_WORDS.has(parts[1]!.toLowerCase())) return null;
    return validateMakeTargets(parts, context, makeCwd, opts.makefileFor);
  }

  // ── Direct script invocations: ./scripts/foo.sh ───────────────────────────
  if (baseDir && (tool.startsWith('./') || tool.startsWith('../'))) {
    // pcic-2b6.8: a bare `./src` or `./docs/` in an inline code span is a
    // directory mention, not a script invocation — it is dead-references' to
    // judge. Only a shell-fence line (meant to be run) still reports an absent
    // extensionless `./gradlew`; an existing directory is never a missing script.
    if (parts.length === 1 && path.extname(tool.replace(/\/+$/, '')) === '') {
      if (isDirectory(baseDir, tool)) return null;
      if (!opts.fenced || tool.endsWith('/')) return null;
    }
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
  // Copies: the cached analysis is shared with manifest-consistency.
  return analyzeCommands(context).issues.map((issue) => ({ ...issue }));
}

export type CommandAnalysis = {
  issues: PromptCiIssue[];
  /**
   * Every package-manager script occurrence this detector judged — valid,
   * broken, or uncheckable — as `"<line>:<script name>"`, keyed by
   * `InstructionFile.path`. The manifest-consistency script check uses it to
   * stay silent on the occurrences command-validity already owns, so one
   * command never yields two findings. Keyed by occurrence, not name: another
   * mention of the same script elsewhere in the file is still that check's to
   * judge.
   */
  evaluatedScripts: Map<string, Set<string>>;
};

/**
 * Both command-validity and manifest-consistency need the analysis; compute it
 * once per context.
 */
const analysisCache = new WeakMap<RepoContext, CommandAnalysis>();

export function analyzeCommands(context: RepoContext): CommandAnalysis {
  let analysis = analysisCache.get(context);
  if (!analysis) {
    analysis = computeCommandAnalysis(context);
    analysisCache.set(context, analysis);
  }
  return analysis;
}

function computeCommandAnalysis(context: RepoContext): CommandAnalysis {
  const issues: PromptCiIssue[] = [];
  const evaluatedScripts = new Map<string, Set<string>>();
  const reported = new Set<string>();
  // Makefiles by repo-relative directory: the root one comes from the context,
  // subdirectory ones (`make -C dir`, `cd dir && make`) are read once each.
  const makefiles = new Map<string, MakefileFacts | undefined>();
  const makefileFor = (dir: string): MakefileFacts | undefined => {
    if (dir === '.' || dir === '') return context.makefile;
    if (!makefiles.has(dir)) makefiles.set(dir, readMakefile(context.repoRoot, dir));
    return makefiles.get(dir);
  };

  for (const file of context.files) {
    const commands = extractCommands(file.content);
    const evaluated = new Set<string>();
    const fileDir = path.relative(context.repoRoot, path.dirname(file.path)).replace(/\\/g, '/') || '.';
    evaluatedScripts.set(file.path, evaluated);

    for (const cmd of commands) {
      // pcic-2b6.13: `cmd.cwd ?? '.'` used to turn an unknown directory (null,
      // after `cd /srv/app` or `cd $DIR`) into the repo root and validate the
      // command against the root manifest. Only a command with no cwd at all
      // (prose, which never carries a `cd`) runs from the root; null stays
      // unverifiable.
      const cwd = cmd.cwd === undefined ? '.' : cmd.cwd;
      const error = validateSegment(cmd.text, context, cwd, (name) => evaluated.add(`${cmd.line}:${name}`), {
        fenced: cmd.fenced === true,
        makefileFor,
        fileDir: fileDir.startsWith('..') ? '.' : fileDir,
      });
      if (!error) continue;

      // Deduplicate same command text appearing twice in the same file
      const dedupeKey = `${file.path}|${cmd.text}`;
      if (reported.has(dedupeKey)) continue;
      reported.add(dedupeKey);

      issues.push({
        id: issueId(fileIdPath(file), cmd.text),
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

  return { issues, evaluatedScripts };
}
