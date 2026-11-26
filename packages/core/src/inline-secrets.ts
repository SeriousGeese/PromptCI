/**
 * Inline secrets (pcic-k1t3.10): credentials pasted into an instruction file or
 * a committed agent config file.
 *
 * Instruction files are read by every agent session and committed with the
 * repository, and agent config files (`.mcp.json`, `.claude/settings.json`,
 * `.codex/config.toml`, `.gemini/settings.json`, `.cursor/mcp.json`,
 * `.vscode/mcp.json`) are shared with every teammate. A live key in one is
 * readable by anyone who can read the repository and by every model the agent
 * talks to. This detector looks for strings that have the exact shape of a
 * credential a vendor issues: a fixed prefix and a fixed alphabet and length
 * (the shapes gitleaks ships for AWS, GitHub, GitLab, Slack, Stripe, Anthropic,
 * OpenAI, Google, npm, Hugging Face and SendGrid), and a PEM private-key block
 * with a body.
 *
 * False-positive controls: a prefix alone never matches (`AKIA`, `ghp_` in
 * prose about token formats), the token must fill the whole length the vendor
 * issues, and a token whose random part looks made up (`EXAMPLE`, `xxxx`,
 * `your`, a run of one character, a counting sequence, or too few distinct
 * characters) is skipped. A private-key header needs a closing `-----END` line
 * and at least 64 base64 characters between them, without `...` elisions.
 * `.claude/settings.local.json` is not read: Claude Code keeps it out of git.
 *
 * Evidence never repeats the secret: it names the kind, the line, the first
 * characters and the length.
 *
 * Hostile input: every pattern starts with a fixed prefix and uses bounded
 * quantifiers, the private-key scan is an indexOf walk with a bounded look-ahead,
 * and line numbers come from one binary search over the line starts, so a file
 * is read in time proportional to its length. Deterministic and offline.
 */

import type { RepoContext } from './repo-context.js';
import type { InstructionFile, PromptCiIssue } from './types.js';
import { shortHash } from './ai-config.js';
import { fileIdPath } from './finding-id.js';
import { forwardIndexOf, lineNumberIndex } from './linear-text.js';
import { treeFor } from './repo-tree.js';
import * as path from 'node:path';

/** The agent config files read besides the scanned instruction files; all are shared through git. */
export const AGENT_CONFIG_FILES: readonly string[] = [
  '.mcp.json',
  '.claude/settings.json',
  '.codex/config.toml',
  '.gemini/settings.json',
  '.cursor/mcp.json',
  '.vscode/mcp.json',
];

/** Bytes read per agent config file. */
const MAX_CONFIG_BYTES = 1_000_000;
/** Evidence lines per file; the count of the rest is still given. */
const MAX_EVIDENCE = 10;
/**
 * The fewest distinct characters a token's random part must hold. A real 36-character
 * base62 token has about 25; a hand-typed stand-in (`ghp_aaaabbbbcccc...`) has a handful.
 */
export const MIN_DISTINCT_CHARS = 12;
/** Base64 characters a private-key block must hold between its BEGIN and END lines. */
export const MIN_PRIVATE_KEY_BODY = 64;
/** How far past a BEGIN line the END line is looked for. */
const PRIVATE_KEY_LOOKAHEAD = 12_000;

type SecretShape = {
  kind: string;
  /** A global regex starting with a fixed prefix; every quantifier is bounded. */
  re: RegExp;
  /** Characters of the fixed prefix, excluded from the made-up check. */
  prefix: number;
};

/** Shapes from gitleaks' default config (config/gitleaks.toml), narrowed to live credentials. */
export const SECRET_SHAPES: readonly SecretShape[] = [
  { kind: 'AWS access key ID', re: /\b(?:AKIA|ASIA)[A-Z2-7]{16}\b/g, prefix: 4 },
  { kind: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36}\b/g, prefix: 4 },
  { kind: 'GitHub fine-grained token', re: /\bgithub_pat_\w{82}\b/g, prefix: 11 },
  { kind: 'GitLab personal access token', re: /\bglpat-[\w-]{20}\b/g, prefix: 6 },
  { kind: 'Slack token', re: /\bxox[bpae]-\d{10,13}-\d{10,13}[A-Za-z0-9-]{0,80}/g, prefix: 5 },
  { kind: 'Stripe live key', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,99}\b/g, prefix: 8 },
  { kind: 'Anthropic API key', re: /\bsk-ant-(?:api03|admin01)-[\w-]{93}AA(?![\w-])/g, prefix: 14 },
  { kind: 'OpenAI API key', re: /\bsk-(?:(?:proj|svcacct|admin)-)?[\w-]{20,200}T3BlbkFJ[\w-]{20,200}/g, prefix: 3 },
  { kind: 'Google API key', re: /\bAIza[\w-]{35}(?![\w-])/g, prefix: 4 },
  { kind: 'npm access token', re: /\bnpm_[A-Za-z0-9]{36}\b/g, prefix: 4 },
  { kind: 'Hugging Face token', re: /\bhf_[A-Za-z]{34}\b/g, prefix: 3 },
  { kind: 'SendGrid API key', re: /\bSG\.[\w-]{22}\.[\w-]{43}(?![\w-])/g, prefix: 3 },
];

/** Text a made-up stand-in carries: AWS's own documentation key ends in EXAMPLE. */
const MADE_UP_RE = /example|x{4}|your|dummy|fake|sample|placeholder|redacted|0123456|123456789|abcdefgh|(.)\1{5}/i;

/** True when `token`'s random part reads as typed by hand rather than issued. */
export function looksMadeUp(token: string, prefix: number): boolean {
  const body = token.slice(prefix);
  if (MADE_UP_RE.test(body)) return true;
  return new Set(body).size < MIN_DISTINCT_CHARS;
}

export type SecretHit = { kind: string; line: number; shown: string };

/** What a reader sees instead of the secret: the first characters and the length. */
function redact(token: string, prefix: number): string {
  return `${token.slice(0, Math.min(token.length, prefix + 4))}… (${token.length} characters)`;
}

const PRIVATE_KEY_HEADER_RE = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/;
/** Characters before "PRIVATE KEY" a header can hold: "-----BEGIN " plus up to 40 of type. */
const PRIVATE_KEY_HEADER_LEAD = 52;
const BASE64_CHAR_RE = /[A-Za-z0-9+/=]/;

/** Every credential-shaped string in `content`, in order of appearance per kind. */
export function findSecrets(content: string): SecretHit[] {
  const lineOf = lineNumberIndex(content);
  const hits: SecretHit[] = [];
  for (const shape of SECRET_SHAPES) {
    const re = new RegExp(shape.re.source, shape.re.flags);
    for (const m of content.matchAll(re)) {
      if (looksMadeUp(m[0], shape.prefix)) continue;
      hits.push({ kind: shape.kind, line: lineOf(m.index), shown: redact(m[0], shape.prefix) });
    }
  }
  // PEM private keys: a BEGIN line, a base64 body and an END line. The header is
  // read from a short window around each "PRIVATE KEY" (it is at most about 70
  // characters), and the next line break and END marker are found by forward
  // searches that are reused while the scan moves on, so a line of thousands of
  // "PRIVATE KEY" is still read once.
  const nextBreak = forwardIndexOf(content, '\n');
  const nextEnd = forwardIndexOf(content, '-----END');
  for (let at = content.indexOf('PRIVATE KEY'); at !== -1; at = content.indexOf('PRIVATE KEY', at + 11)) {
    const header = PRIVATE_KEY_HEADER_RE.exec(content.slice(Math.max(0, at - PRIVATE_KEY_HEADER_LEAD), at + 22));
    if (!header) continue;
    const lineEndRaw = nextBreak(at);
    const lineEnd = lineEndRaw === -1 ? content.length : lineEndRaw;
    const windowEnd = Math.min(content.length, lineEnd + PRIVATE_KEY_LOOKAHEAD);
    const end = nextEnd(lineEnd);
    if (end === -1 || end > windowEnd) continue;
    const body = content.slice(lineEnd, end);
    if (body.includes('...') || body.includes('\u2026') || body.includes('<')) continue;
    let base64 = 0;
    for (const ch of body) if (BASE64_CHAR_RE.test(ch)) base64++;
    if (base64 < MIN_PRIVATE_KEY_BODY) continue;
    hits.push({ kind: 'private key', line: lineOf(at), shown: header[0] });
    // The block is one finding; continue after it.
    at = end;
  }
  return hits.sort((a, b) => a.line - b.line);
}

type Source = { relPath: string; issuePath: string; content: string };

export function detectInlineSecrets(context: RepoContext): PromptCiIssue[] {
  const tree = treeFor(context);
  const sources: Source[] = [];
  const seen = new Set<string>();
  const addFile = (file: InstructionFile) => {
    const rel = fileIdPath(file);
    if (seen.has(rel)) return;
    seen.add(rel);
    sources.push({ relPath: rel, issuePath: file.path, content: file.content });
  };
  for (const file of context.files) addFile(file);
  for (const file of context.onDemandFiles ?? []) addFile(file);
  for (const rel of AGENT_CONFIG_FILES) {
    if (seen.has(rel)) continue;
    const read = tree.readText(rel, { maxBytes: MAX_CONFIG_BYTES });
    if (read.state !== 'found') continue;
    seen.add(rel);
    sources.push({ relPath: rel, issuePath: path.resolve(context.repoRoot, rel), content: read.content });
  }

  const issues: PromptCiIssue[] = [];
  for (const source of sources) {
    const hits = findSecrets(source.content);
    if (hits.length === 0) continue;
    const kinds = [...new Set(hits.map((h) => h.kind))].sort();
    const evidence = hits
      .slice(0, MAX_EVIDENCE)
      .map((h) => `Line ${h.line}: ${h.kind} ${h.shown}`);
    if (hits.length > MAX_EVIDENCE) evidence.push(`...and ${hits.length - MAX_EVIDENCE} more`);
    issues.push({
      id: `inline-secret-${shortHash(source.relPath)}`,
      severity: 'high',
      category: 'security',
      title: `Possible credential in ${source.relPath}`,
      summary:
        `${source.relPath} appears to contain ${hits.length === 1 ? 'a credential' : `${hits.length} credentials`} (${kinds.join(', ')}). ` +
        'The file is committed and read by every agent session, so anyone who can read the repository, and every model the agent sends it to, may see it.',
      filePaths: [source.issuePath],
      locations: [{ filePath: source.issuePath, startLine: hits[0]!.line, endLine: hits[0]!.line }],
      evidence,
      recommendation:
        'If the value is real, revoke or rotate it first: removing it from the file does not remove it from git history. ' +
        'Then reference it by environment variable name (`$ANTHROPIC_API_KEY`, `${env:GITHUB_TOKEN}`) and keep the value out of the repository. ' +
        'If it is a made-up example, replace it with an obvious placeholder such as `<your-api-key>`.',
      confidence: 0.8,
      fingerprintKey: `inline-secret:${source.relPath}`,
    });
  }
  return issues;
}
