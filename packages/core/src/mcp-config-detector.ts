/**
 * MCP Config Detector (issue #23)
 *
 * Audits `.mcp.json` (project-scoped MCP server definitions):
 *
 *  - Invalid JSON: the file will not load.
 *  - Duplicate server names: JSON keeps only the last, silently dropping a
 *    server the author thinks is configured.
 *  - Placeholder env values never filled in (`"<your-key>"`, `"changeme"`, …).
 *  - stdio servers whose local `command`/script path does not exist, and
 *    servers declaring neither a `command` nor a `url`.
 *
 * PATH lookups for bare binaries (`npx`, `node`, `docker`) are intentionally out
 * of scope — they are not verifiable deterministically or offline. Only
 * repo-local paths are checked. Deterministic and offline.
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

const MCP_GLOBS = ['.mcp.json'];

function id(kind: string, key: string): string {
  return `ai-config-mcp-${kind}-${shortHash(key)}`;
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

/**
 * Return the direct-child keys of the JSON object whose opening `{` is at
 * `braceStart`, in source order. A string literal counts as a key only when it
 * sits at the object's own depth and is immediately followed by `:`, so nested
 * objects and value strings are ignored. Used to spot duplicate server names,
 * which `JSON.parse` collapses to one.
 */
function directChildKeys(raw: string, braceStart: number): string[] {
  const keys: string[] = [];
  let depth = 0;
  let inStr = false;
  let esc = false;
  let strChars = '';
  let pendingKey: string | null = null;

  for (let i = braceStart; i < raw.length; i++) {
    const c = raw[i]!;
    if (inStr) {
      if (esc) { esc = false; strChars += c; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') {
        inStr = false;
        if (depth === 1) pendingKey = strChars;
        continue;
      }
      strChars += c;
      continue;
    }
    if (c === '"') { inStr = true; strChars = ''; continue; }
    if (c === '{' || c === '[') { depth++; continue; }
    if (c === '}' || c === ']') { depth--; if (depth === 0) break; continue; }
    if (c === ':') { if (depth === 1 && pendingKey !== null) { keys.push(pendingKey); pendingKey = null; } continue; }
    if (c === ',') { pendingKey = null; continue; }
  }
  return keys;
}

function findDuplicateServerNames(raw: string): string[] {
  const marker = /"mcpServers"\s*:/.exec(raw);
  if (!marker) return [];
  const braceStart = raw.indexOf('{', marker.index + marker[0].length);
  if (braceStart < 0) return [];
  const keys = directChildKeys(raw, braceStart);
  const counts = new Map<string, number>();
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k).sort();
}

function isPlaceholderEnvValue(value: string): boolean {
  const v = value.trim();
  if (v === '') return true;
  if (/^<.+>$/.test(v)) return true;
  if (/^(your|my)[-_ ]/i.test(v)) return true;
  if (/^x{3,}$/i.test(v)) return true;
  if (/^\.\.\.+$/.test(v)) return true;
  if (/\b(changeme|change[-_]me|replace[-_]?me|placeholder|example[-_]?key|todo|tbd)\b/i.test(v)) return true;
  return false;
}

/** Local paths referenced by a server's command/args that we can verify exist. */
function localPathRefs(command: string | undefined, args: string[]): string[] {
  const refs = new Set<string>();
  const consider = (token: string, requireRelative: boolean) => {
    const t = token.replace(/^['"]|['"]$/g, '');
    if (!t || t.startsWith('-') || t.includes('$') || /[<>{}*?]/.test(t)) return;
    if (t.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(t) || /^https?:/i.test(t)) return;
    if (t.includes('..')) return;
    const relative = t.startsWith('./') || t.startsWith('.claude/');
    if (requireRelative && !relative) return;
    if (relative || (t.includes('/') && SCRIPT_EXT_RE.test(t))) refs.add(t.replace(/\\/g, '/'));
  };
  if (command) consider(command, false);
  for (const a of args) consider(a, true);
  return [...refs];
}

export function detectMcpConfig(context: RepoContext): PromptCiIssue[] {
  const issues: PromptCiIssue[] = [];
  const files = listFiles(context.repoRoot, MCP_GLOBS);

  for (const filePath of files) {
    const raw = readTextWithinRoot(context.repoRoot, filePath);
    if (raw === undefined) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      issues.push(base({
        id: id('invalid-json', filePath),
        severity: 'high',
        title: 'MCP config is not valid JSON',
        summary: `${filePath} could not be parsed as JSON, so no MCP servers will load from it.`,
        filePaths: [filePath],
        locations: [{ filePath, startLine: 1, endLine: 1 }],
        evidence: [`Parse error: ${(err as Error).message}`],
        recommendation: 'Fix the JSON syntax (no trailing commas, no comments).',
        confidence: 0.95,
      }));
      continue;
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
    const servers = (parsed as Record<string, unknown>).mcpServers;
    if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) continue;

    // Duplicate server names (JSON.parse silently keeps the last).
    for (const dup of findDuplicateServerNames(raw)) {
      issues.push(base({
        id: id('duplicate-name', `${filePath}|${dup}`),
        title: 'Duplicate MCP server name',
        summary: `${filePath} defines the server "${dup}" more than once. JSON keeps only the last definition and silently discards the earlier one.`,
        filePaths: [filePath],
        locations: [{ filePath, startLine: lineOf(raw, `"${dup}"`), endLine: lineOf(raw, `"${dup}"`) }],
        evidence: [`Duplicated server name: ${dup}`],
        recommendation: 'Rename or remove the duplicate so each server name is unique.',
        confidence: 0.85,
      }));
    }

    for (const [name, rawDef] of Object.entries(servers as Record<string, unknown>)) {
      if (typeof rawDef !== 'object' || rawDef === null || Array.isArray(rawDef)) continue;
      const def = rawDef as Record<string, unknown>;
      const command = typeof def.command === 'string' ? def.command : undefined;
      const url = typeof def.url === 'string' ? def.url : undefined;
      const args = Array.isArray(def.args) ? def.args.filter((a): a is string => typeof a === 'string') : [];
      const serverLine = lineOf(raw, `"${name}"`);

      // A server needs either a command (stdio) or a url (http/sse).
      if (!command && !url) {
        issues.push(base({
          id: id('no-command-or-url', `${filePath}|${name}`),
          title: 'MCP server has neither a command nor a url',
          summary: `${filePath}: server "${name}" defines no \`command\` (stdio) and no \`url\` (http/sse), so it cannot start.`,
          filePaths: [filePath],
          locations: [{ filePath, startLine: serverLine, endLine: serverLine }],
          evidence: [`Server: ${name}`, `Keys: ${Object.keys(def).join(', ') || '(none)'}`],
          recommendation: 'Add a `command` (with `args`) for a stdio server, or a `url` for a remote server.',
          confidence: 0.8,
        }));
      }

      // Placeholder env values that were never filled in.
      if (typeof def.env === 'object' && def.env !== null && !Array.isArray(def.env)) {
        for (const [envKey, envVal] of Object.entries(def.env as Record<string, unknown>)) {
          if (typeof envVal !== 'string' || !isPlaceholderEnvValue(envVal)) continue;
          issues.push(base({
            id: id('placeholder-env', `${filePath}|${name}|${envKey}`),
            title: 'MCP server env value is an unfilled placeholder',
            summary: `${filePath}: server "${name}" sets \`env.${envKey}\` to a placeholder (${JSON.stringify(envVal)}) that was never replaced with a real value.`,
            filePaths: [filePath],
            locations: [{ filePath, startLine: lineOf(raw, `"${envKey}"`), endLine: lineOf(raw, `"${envKey}"`) }],
            evidence: [`${envKey}: ${envVal}`],
            recommendation: 'Replace the placeholder with a real value, or reference a shell variable like `"${' + envKey + '}"`.',
            confidence: 0.7,
          }));
        }
      }

      // Local command / script paths that do not exist.
      for (const ref of localPathRefs(command, args)) {
        if (isFileWithinRoot(context.repoRoot, ref)) continue;
        issues.push(base({
          id: id('missing-command', `${filePath}|${name}|${ref}`),
          title: 'MCP server command path does not exist',
          summary: `${filePath}: server "${name}" references the local path \`${ref}\`, which is not present in the repository.`,
          filePaths: [filePath],
          locations: [{ filePath, startLine: serverLine, endLine: serverLine }],
          evidence: [`Referenced path: ${ref}`, `Server: ${name}`],
          recommendation: 'Fix the path, add the missing file, or install the server so the path resolves.',
          confidence: 0.7,
        }));
      }
    }
  }

  // Scanner-form paths so inline suppressions can match (see withScannerPaths).
  return withScannerPaths(context.repoRoot, issues);
}
