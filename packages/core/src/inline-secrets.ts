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
 * with a body. Added in pcic-180m: the Supabase service_role JWT and sb_secret_ key,
 * database connection strings with a password, OpenRouter and Groq keys, and OpenAI
 * project and service-account keys that carry no T3BlbkFJ marker.
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
/** The same floor for an AWS access key ID's 16-character random part. */
export const MIN_DISTINCT_CHARS_AWS = 8;
/** Base64 characters a private-key block must hold between its BEGIN and END lines. */
export const MIN_PRIVATE_KEY_BODY = 64;
/** How far past a BEGIN line the END line is looked for. */
const PRIVATE_KEY_LOOKAHEAD = 12_000;

type SecretShape = {
  kind: string;
  /** A global regex starting with a fixed prefix; every quantifier is bounded. */
  re: RegExp;
  /** Characters of the fixed prefix, excluded from the made-up check (a function where the prefix varies). */
  prefix: number | ((token: string) => number);
  /**
   * The fewest distinct characters the random part must hold; {@link MIN_DISTINCT_CHARS}
   * unless set. An AWS key ID has 16 characters from a 32-letter alphabet, so about one
   * real key in six has fewer than 12 distinct ones (PR #251 review).
   */
  minDistinct?: number;
  /** The text the made-up check reads, when it is not the token past its prefix (a connection string's password). */
  secretOf?: (m: RegExpMatchArray) => string;
  /** A last test on a match that fits the shape; false drops it (a JWT that is not a service_role key). */
  accept?: (m: RegExpMatchArray) => boolean;
  /** What a reader sees instead of the default redaction, for a match that holds a secret mid-string. */
  show?: (m: RegExpMatchArray) => string;
};

/** The key `supabase start` prints for every local stack: Supabase CLI packages/stack/src/Defaults.ts DEFAULT_LOCAL_SECRET_KEY. Published, so not a leak. */
// Split so secret scanners and push protection do not read this source as a leak.
const SUPABASE_DEMO_SECRET_KEY = 'sb_' + 'secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz';

/** Decode a base64url JWT segment as a JSON object, or null. */
function jwtPart(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * A Supabase service_role JWT: its payload names the role `service_role`, which bypasses
 * row-level security. The anon key is public by design and a JWT without that role is
 * usually an example, so neither is reported. The key every `supabase start` prints
 * (issuer `supabase-demo`) is a published demo value and is skipped too.
 */
function isServiceRoleJwt(m: RegExpMatchArray): boolean {
  const payload = m[0].split('.')[1];
  const claims = jwtPart(payload ?? '');
  return claims !== null && claims.role === 'service_role' && claims.iss !== 'supabase-demo';
}

/** Passwords documentation and compose files use for a stand-in, compared in lower case without trailing digits. */
const PLACEHOLDER_PASSWORDS = new Set([
  'password', 'passwd', 'pass', 'pwd', 'secret', 'changeme', 'change-me', 'change_me', 'admin', 'root', 'postgres', 'mysql',
  'mongo', 'mongodb', 'test', 'testing', 'example', 'demo', 'dev', 'user', 'username', 'mypassword', 'yourpassword',
  'userpass', 'qwerty', 'letmein', 'redacted', 'hunter', 'supersecret', 'secretpassword', 'dbpassword', 'db_password',
  'database', 'default', 'foobar', 'foo', 'bar', 'secure', 'securepassword', 'strongpassword', 'mysecretpassword', 'p4ssw0rd',
  's3cret', 'token', 'key', 'apikey', 'host', 'localhost',
]);
/** A word a hand-written password carries and an issued one almost never does (`s3cretP4ss`, `dbpass-clear`). */
const PLACEHOLDER_WORD_RE = /pass|secret|s3cret|hunter|pwd|test|demo|admin|change|sample|dummy|fake|temp|replace|insert|todo|here|abc123/i;
/** An ALL_CAPS_SNAKE value (`REPLACE_ME_NOW`) names a slot to fill; an issued password is not written that way. */
const CAPS_SNAKE_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
/**
 * Template syntax in a password slot: `${VAR}`, `{{ var }}`, `{name}`, `[YOUR-PASSWORD]`, a leading `$VAR`,
 * `%s` or `%(name)s`, a run of `*`, or an elision. A bare `%`, `$`, `(` or `)` is not: percent-encoded
 * passwords (`%40`) are real.
 */
const PLACEHOLDER_SYNTAX_RE = /\$\{|\{\{|\{[^}]*\}|\[[^\]]*\]|^\$[A-Za-z_]|%s|%\(\w+\)s|\*{2,}|\.\.\./;
/** Hosts that are this machine or a documentation name: a password there protects nothing shared. */
const LOCAL_HOST_RE = /^(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|host\.docker\.internal|.*\.(?:example|test|invalid|localhost)|(?:[\w-]+\.)?example\.(?:com|org|net))$/i;

/** True when a connection string's password and host read as real rather than a stand-in. */
function isRealConnectionString(m: RegExpMatchArray): boolean {
  const password = m[1]!;
  const host = m[2]!;
  if (password.length < 8 || PLACEHOLDER_SYNTAX_RE.test(password) || CAPS_SNAKE_RE.test(password)) return false;
  if (MADE_UP_RE.test(host)) return false;
  if (PLACEHOLDER_PASSWORDS.has(password.toLowerCase().replace(/[\d_-]+$/, '')) || PLACEHOLDER_WORD_RE.test(password)) return false;
  return !LOCAL_HOST_RE.test(host);
}

/** Shapes from gitleaks' default config (config/gitleaks.toml), narrowed to live credentials. */
export const SECRET_SHAPES: readonly SecretShape[] = [
  { kind: 'AWS access key ID', re: /\b(?:AKIA|ASIA)[A-Z2-7]{16}\b/g, prefix: 4, minDistinct: MIN_DISTINCT_CHARS_AWS },
  { kind: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36}\b/g, prefix: 4 },
  { kind: 'GitHub fine-grained token', re: /\bgithub_pat_\w{82}\b/g, prefix: 11 },
  { kind: 'GitLab personal access token', re: /\bglpat-[\w-]{20}\b/g, prefix: 6 },
  { kind: 'Slack token', re: /\bxox[bpae]-\d{10,13}-\d{10,13}[A-Za-z0-9-]{20,80}/g, prefix: 5 },
  { kind: 'Stripe live key', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,99}\b/g, prefix: 8 },
  { kind: 'Anthropic API key', re: /\bsk-ant-(?:api03|admin01)-[\w-]{93}AA(?![\w-])/g, prefix: (t) => (t.startsWith('sk-ant-admin01-') ? 15 : 13) },
  { kind: 'OpenAI API key', re: /\bsk-(?:(?:proj|svcacct|admin)-)?[\w-]{20,200}T3BlbkFJ[\w-]{20,200}/g, prefix: (t) => /^sk-(?:(?:proj|svcacct|admin)-)?/.exec(t)![0].length },
  // Marker-less OpenAI keys (`sk-proj-`, `sk-svcacct-`). No vendor or gitleaks source gives this shape:
  // the 100 to 200 base64url range is unverified and chosen for precision (a real key is about 150 to
  // 170 characters; the T3BlbkFJ shape above covers the older ones). Same kind, so one key is one hit.
  { kind: 'OpenAI API key', re: /\bsk-(?:proj|svcacct)-[A-Za-z0-9_-]{100,200}(?![\w-])/g, prefix: (t) => (t.startsWith('sk-proj-') ? 8 : 11) },
  // OpenRouter: sk-or-v1- and 64 hex characters (trufflehog pkg/detectors/openrouter/openrouter.go:
  // \b(sk-or-v1-[0-9a-f]{64})\b). Gitleaks has no OpenRouter rule.
  { kind: 'OpenRouter API key', re: /\bsk-or-v1-[a-f0-9]{64}\b/g, prefix: 9, minDistinct: 10 },
  // Groq: gsk_ and 52 alphanumerics (trufflehog pkg/detectors/groq/groq.go: \b(gsk_[a-zA-Z0-9]{52})\b).
  // Gitleaks has no Groq rule.
  { kind: 'Groq API key', re: /\bgsk_[A-Za-z0-9]{52}\b/g, prefix: 4 },
  // Supabase secret API key: sb_secret_ and base64url. The Supabase API keys docs give the prefix only; the
  // 22 to 48 range is unverified, bracketing the 31 characters of the Supabase CLI's own default key. That
  // published local key is skipped (SUPABASE_DEMO_SECRET_KEY).
  { kind: 'Supabase secret key', re: /\bsb_secret_[A-Za-z0-9_-]{22,48}(?![\w-])/g, prefix: 10, accept: (m) => m[0] !== SUPABASE_DEMO_SECRET_KEY },
  // Supabase service_role JWT: a three-part JWT whose payload carries role service_role (Supabase API keys docs: service_role is a JWT; the role claim is read from the payload).
  {
    kind: 'Supabase service_role JWT',
    re: /(?<![\w-])eyJ[A-Za-z0-9_-]{10,1500}\.eyJ[A-Za-z0-9_-]{10,3000}\.[A-Za-z0-9_-]{20,1000}(?![\w-])/g,
    prefix: (t) => t.lastIndexOf('.') + 1,
    accept: isServiceRoleJwt,
    show: (m) => redact(m[0], 3),
  },
  // Database connection string with a password: the scheme://user:password@host URI form
  // (Neon and MongoDB Atlas docs show it with stand-in values, which must not fire). Skipped when the password is a stand-in or the host local.
  {
    kind: 'connection string with a password',
    re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:@/'"<>`]{1,64}:([^\s@/'"<>`]{3,128})@([A-Za-z0-9.-]{1,255})/g,
    prefix: 0,
    minDistinct: 5,
    secretOf: (m) => m[1]!,
    accept: isRealConnectionString,
    show: (m) => `${m[0].slice(0, m[0].indexOf(':', m[0].indexOf('://') + 3))}:… (password of ${m[1]!.length} characters)`,
  },
  { kind: 'Google API key', re: /\bAIza[\w-]{35}(?![\w-])/g, prefix: 4 },
  { kind: 'npm access token', re: /\bnpm_[A-Za-z0-9]{36}\b/g, prefix: 4 },
  { kind: 'Hugging Face token', re: /\bhf_[A-Za-z]{34}\b/g, prefix: 3 },
  { kind: 'SendGrid API key', re: /\bSG\.[\w-]{22}\.[\w-]{43}(?![\w-])/g, prefix: 3 },
];

/** Text a made-up stand-in carries: AWS's own documentation key ends in EXAMPLE. */
const MADE_UP_RE = /example|x{4}|your|dummy|fake|sample|placeholder|redacted|0123456|123456789|abcdefgh|(.)\1{5}/i;

/** True when `token`'s random part reads as typed by hand rather than issued. */
export function looksMadeUp(token: string, prefix: number, minDistinct = MIN_DISTINCT_CHARS): boolean {
  const body = token.slice(prefix);
  if (MADE_UP_RE.test(body)) return true;
  return new Set(body).size < minDistinct;
}

export type SecretHit = { kind: string; line: number; shown: string };

/** What a reader sees instead of the secret: the first characters and the length. */
function redact(token: string, prefix: number): string {
  return `${token.slice(0, Math.min(token.length, prefix + 4))}… (${token.length} characters)`;
}

const PRIVATE_KEY_HEADER_RE = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/;
/** Characters before "PRIVATE KEY" a header can hold: "-----BEGIN " plus up to 40 of type. */
const PRIVATE_KEY_HEADER_LEAD = 52;
/** A PEM body line: base64 only. */
const PEM_BODY_LINE_RE = /^[A-Za-z0-9+/=]+$/;
/** RFC 1421 encapsulated headers an encrypted key carries before its body. */
const PEM_HEADER_LINE_RE = /^(?:Proc-Type|DEK-Info):/;

/**
 * Base64 characters in a PEM body, or -1 when the body is not one. Literal `\n` and
 * `\r` escapes count as line breaks, so a key inside a JSON string (a Google
 * service-account `private_key`) reads like one in a .pem file. Every other line must
 * be base64 only: prose, an elision (`MIIEv...`) or a placeholder between the BEGIN
 * and END lines is not a key.
 */
function pemBodyLength(body: string): number {
  let base64 = 0;
  for (const raw of body.replace(/\\+[nr]/g, '\n').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || PEM_HEADER_LINE_RE.test(line)) continue;
    if (!PEM_BODY_LINE_RE.test(line)) return -1;
    base64 += line.length;
  }
  return base64;
}

/** Every credential-shaped string in `content`, in order of appearance per kind. */
export function findSecrets(content: string): SecretHit[] {
  const lineOf = lineNumberIndex(content);
  const hits: SecretHit[] = [];
  /** kind and offset of each hit: two shapes of one kind (OpenAI's) report one key once. */
  const found = new Set<string>();
  for (const shape of SECRET_SHAPES) {
    const re = new RegExp(shape.re.source, shape.re.flags);
    for (const m of content.matchAll(re)) {
      const prefix = typeof shape.prefix === 'number' ? shape.prefix : shape.prefix(m[0]);
      const at = `${shape.kind}:${m.index}`;
      if (found.has(at)) continue;
      if (shape.accept && !shape.accept(m)) continue;
      const secret = shape.secretOf ? shape.secretOf(m) : m[0];
      if (looksMadeUp(secret, shape.secretOf ? 0 : prefix, shape.minDistinct)) continue;
      found.add(at);
      hits.push({ kind: shape.kind, line: lineOf(m.index), shown: shape.show ? shape.show(m) : redact(m[0], prefix) });
    }
  }
  // PEM private keys: a BEGIN header, a base64 body and an END line. The header is
  // read from a short window around each "PRIVATE KEY" (it is at most about 70
  // characters), and the END marker is searched from the header itself, so a key
  // on one line (inside a JSON string) is found too. The next END and BEGIN are
  // found by forward searches reused while the scan moves on, and a body holding
  // another BEGIN is skipped (that header is read on its own), so the bodies read
  // never overlap and a file is read in linear time.
  const nextEnd = forwardIndexOf(content, '-----END');
  const nextBegin = forwardIndexOf(content, '-----BEGIN');
  for (let at = content.indexOf('PRIVATE KEY'); at !== -1; at = content.indexOf('PRIVATE KEY', at + 11)) {
    const windowStart = Math.max(0, at - PRIVATE_KEY_HEADER_LEAD);
    const header = PRIVATE_KEY_HEADER_RE.exec(content.slice(windowStart, at + 22));
    if (!header) continue;
    const headerEnd = windowStart + header.index + header[0].length;
    const end = nextEnd(headerEnd);
    if (end === -1 || end > headerEnd + PRIVATE_KEY_LOOKAHEAD) continue;
    const begin = nextBegin(headerEnd);
    if (begin !== -1 && begin < end) continue;
    if (pemBodyLength(content.slice(headerEnd, end)) < MIN_PRIVATE_KEY_BODY) continue;
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
