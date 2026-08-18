/**
 * Hooks / Settings Detector (issue #23)
 *
 * Audits `.claude/settings.json` and `.claude/settings.local.json`:
 *
 *  - Invalid JSON: the file will not load at all.
 *  - Hook commands referencing local scripts that do not exist in the repo.
 *  - Dangerous hook patterns: piping a remote download straight into a shell
 *    (`curl … | sh`), and unquoted `$CLAUDE_PROJECT_DIR` path expansions.
 *
 * Hook commands run automatically on tool events, so a broken or unsafe command
 * is higher-stakes than a stale doc line. Deterministic and offline.
 */

import type { RepoContext } from './repo-context.js';
import type { PromptCiIssue } from './types.js';
import {
  readTextWithinRoot,
  isFileWithinRoot,
  listFiles,
  shortHash,
  lineOf,
  withScannerPaths,
  SCRIPT_EXT_RE,
} from './ai-config.js';

const SETTINGS_GLOBS = ['.claude/settings.json', '.claude/settings.local.json'];

/** curl/wget piped straight into a shell — the classic remote-code-execution footgun. */
const CURL_PIPE_SH_RE = /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|dash)\b/i;

type CommandHook = { command: string; event: string };

function id(kind: string, key: string): string {
  return `ai-config-hook-${kind}-${shortHash(key)}`;
}

function base(issue: Omit<PromptCiIssue, 'severity' | 'category' | 'confidence'> &
  Partial<Pick<PromptCiIssue, 'severity' | 'category' | 'confidence'>>): PromptCiIssue {
  return {
    severity: 'warning',
    category: 'ai_config',
    confidence: 0.8,
    ...issue,
  };
}

/** Recursively collect `{ type: 'command', command }` hook entries, tagged with their event key. */
function collectCommandHooks(hooks: unknown, event: string, out: CommandHook[]): void {
  if (Array.isArray(hooks)) {
    for (const item of hooks) collectCommandHooks(item, event, out);
    return;
  }
  if (typeof hooks !== 'object' || hooks === null) return;
  const obj = hooks as Record<string, unknown>;
  if (obj.type === 'command' && typeof obj.command === 'string') {
    out.push({ command: obj.command, event });
  }
  for (const [key, value] of Object.entries(obj)) {
    // When we recurse from the top-level `hooks` map, the key names the event
    // (PreToolUse, PostToolUse, …); deeper down `hooks`/`matcher` keys are just
    // structure, so we keep the nearest event label.
    const nextEvent = event === '' ? key : event;
    if (typeof value === 'object' && value !== null) collectCommandHooks(value, nextEvent, out);
  }
}

/** Interpreters whose script argument is the file they execute. */
const INTERPRETERS = new Set([
  'bash', 'sh', 'zsh', 'dash', 'node', 'deno', 'python', 'python3', 'ruby',
  'ts-node', 'tsx', 'pwsh', 'powershell',
]);

/** Launchers that wrap another command (`npx tsx x.ts`, `timeout 5 bash x.sh`). */
const WRAPPERS = new Set([
  'npx', 'bunx', 'pnpm', 'yarn', 'uv', 'uvx', 'env', 'timeout', 'nice', 'sudo', 'exec', 'command',
]);

/** Strip surrounding quotes, then a leading `$CLAUDE_PROJECT_DIR/` / `${CLAUDE_PROJECT_DIR}/`. */
function normalizeScriptToken(token: string): string {
  const unquoted = token.replace(/^['"]|['"]$/g, '');
  return unquoted.replace(/^\$\{?CLAUDE_PROJECT_DIR\}?[/\\]/, '');
}

/**
 * Extract repo-relative local script references from a hook command string.
 *
 * Each `&&`/`||`/`;`/`|`-chained segment is its own command. Within a segment,
 * the *executed script* is verified — the segment's own executable, or (after
 * any interpreter/wrapper prefix like `bash`, `npx tsx`, `timeout 5 node`) the
 * first argument bearing a script extension, which naturally skips flags and
 * their extension-less values (`node --max-old-space-size 4096 scripts/x.js`).
 * Other tokens are checked only when explicitly relative (`./x`, `.claude/x`,
 * `$CLAUDE_PROJECT_DIR/x`), so a lint hook like `eslint --fix src/foo.js` does
 * not get its target argument flagged as a missing script.
 */
function extractScriptRefs(command: string): string[] {
  const refs = new Set<string>();

  const add = (rawToken: string, executed: boolean) => {
    if (rawToken.startsWith('-')) return;
    const unquoted = rawToken.replace(/^['"]|['"]$/g, '');
    const token = normalizeScriptToken(rawToken);
    if (!token || token.includes('$') || /[<>{}*?|"'`]/.test(token)) return; // still has a var/placeholder
    if (token.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(token) || /^https?:/i.test(token)) return; // absolute/url
    if (token.includes('..')) return;
    if (!SCRIPT_EXT_RE.test(token)) return;
    // Tested on the quote-stripped form so `"./scripts/x.sh"` still counts.
    const explicitRel = unquoted.startsWith('./') || unquoted.startsWith('.claude/') ||
      /^\$\{?CLAUDE_PROJECT_DIR\}?[/\\]/.test(unquoted);
    if (executed || explicitRel) refs.add(token.replace(/\\/g, '/'));
  };

  for (const segment of command.split(/&&|\|\||;|\|/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;

    const first = normalizeScriptToken(tokens[0]!);
    if (INTERPRETERS.has(first) || WRAPPERS.has(first)) {
      // The executed script is the first argument that looks like a script
      // file; flags and their extension-less values are skipped naturally.
      for (let i = 1; i < tokens.length; i++) {
        if (!tokens[i]!.startsWith('-') && SCRIPT_EXT_RE.test(normalizeScriptToken(tokens[i]!))) {
          add(tokens[i]!, true);
          break;
        }
      }
    } else {
      // The segment itself may be a direct script invocation (`./scripts/x.sh`).
      add(tokens[0]!, true);
    }

    // Remaining tokens are verified only when explicitly relative.
    for (let i = 1; i < tokens.length; i++) add(tokens[i]!, false);
  }

  return [...refs];
}

/**
 * True when the character at `index` sits inside a single- or double-quoted
 * region of `command`. Used so `sh -c "cd $CLAUDE_PROJECT_DIR/x"` — quoted,
 * space-safe — is not flagged as an unquoted expansion.
 */
function insideQuotes(command: string, index: number): boolean {
  let quote = '';
  for (let i = 0; i < index; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    }
  }
  return quote !== '';
}

/** Finds a `$CLAUDE_PROJECT_DIR/...` expansion that no quote region protects. */
function hasUnquotedProjectDir(command: string): boolean {
  for (const m of command.matchAll(/\$\{?CLAUDE_PROJECT_DIR\}?[/\\]/g)) {
    if (!insideQuotes(command, m.index)) return true;
  }
  return false;
}

export function detectHooksSettings(context: RepoContext): PromptCiIssue[] {
  const issues: PromptCiIssue[] = [];
  const settingsFiles = listFiles(context.repoRoot, SETTINGS_GLOBS);

  for (const filePath of settingsFiles) {
    const raw = readTextWithinRoot(context.repoRoot, filePath);
    if (raw === undefined) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      issues.push(base({
        id: id('invalid-json', filePath),
        severity: 'high',
        title: 'Settings file is not valid JSON',
        summary: `${filePath} could not be parsed as JSON, so Claude Code cannot load its hooks or permissions.`,
        filePaths: [filePath],
        locations: [{ filePath, startLine: 1, endLine: 1 }],
        evidence: [`Parse error: ${(err as Error).message}`],
        recommendation: 'Fix the JSON syntax (trailing commas and comments are not allowed in settings.json).',
        confidence: 0.95,
      }));
      continue;
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
    const hooks = (parsed as Record<string, unknown>).hooks;
    if (hooks === undefined) continue;

    const commandHooks: CommandHook[] = [];
    collectCommandHooks(hooks, '', commandHooks);

    const reportedMissing = new Set<string>();
    for (const { command, event } of commandHooks) {
      const line = lineOf(raw, command);

      // Dangerous: remote download piped into a shell.
      if (CURL_PIPE_SH_RE.test(command)) {
        issues.push(base({
          id: id('curl-pipe-sh', `${filePath}|${command}`),
          severity: 'high',
          impact: 'high',
          title: 'Hook pipes a remote download into a shell',
          summary: `A ${event || 'hook'} command in ${filePath} pipes \`curl\`/\`wget\` output directly into a shell, running whatever the remote host serves with your permissions.`,
          filePaths: [filePath],
          locations: [{ filePath, startLine: line, endLine: line }],
          evidence: [`Command: ${command.slice(0, 160)}`],
          recommendation: 'Download to a file, review it, and pin a checksum before executing — never pipe a network fetch straight into sh/bash.',
          confidence: 0.85,
        }));
      }

      // Footgun: unquoted $CLAUDE_PROJECT_DIR path expansion.
      if (hasUnquotedProjectDir(command)) {
        issues.push(base({
          id: id('unquoted-project-dir', `${filePath}|${command}`),
          severity: 'info',
          title: 'Hook uses an unquoted $CLAUDE_PROJECT_DIR path',
          summary: `A ${event || 'hook'} command in ${filePath} expands \`$CLAUDE_PROJECT_DIR\` unquoted; if the project path contains a space the command breaks or runs the wrong file.`,
          filePaths: [filePath],
          locations: [{ filePath, startLine: line, endLine: line }],
          evidence: [`Command: ${command.slice(0, 160)}`],
          recommendation: 'Wrap the path in double quotes, e.g. `"$CLAUDE_PROJECT_DIR/script.sh"`.',
          confidence: 0.5,
        }));
      }

      // Missing local script references.
      for (const ref of extractScriptRefs(command)) {
        if (isFileWithinRoot(context.repoRoot, ref)) continue;
        const key = `${filePath}|${ref}`;
        if (reportedMissing.has(key)) continue;
        reportedMissing.add(key);
        issues.push(base({
          id: id('missing-script', key),
          title: 'Hook command references a script that does not exist',
          summary: `A ${event || 'hook'} command in ${filePath} runs \`${ref}\`, but that file is not present in the repository.`,
          filePaths: [filePath],
          locations: [{ filePath, startLine: line, endLine: line }],
          evidence: [`Referenced script: ${ref}`, `Command: ${command.slice(0, 160)}`],
          recommendation: 'Add the script, fix the path, or remove the hook.',
          confidence: 0.75,
        }));
      }
    }
  }

  // Scanner-form paths so inline suppressions can match (see withScannerPaths).
  return withScannerPaths(context.repoRoot, issues);
}
