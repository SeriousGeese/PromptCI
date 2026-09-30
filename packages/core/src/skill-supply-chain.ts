/**
 * Skill supply-chain scan
 *
 * An Agent Skill is instructions (SKILL.md plus reference docs) and bundled
 * scripts that an agent loads on demand and runs with the user's permissions.
 * Installing a third-party skill is installing code. The structural skills
 * detector (skills-detector.ts) checks that a skill *loads*; this detector
 * reads the same skill — and every file bundled in its directory — as plain
 * text and flags content characteristic of supply-chain abuse.
 *
 * Static only. Nothing here executes, imports, fetches or resolves anything:
 * skill content is matched line by line against fixed patterns, so the same
 * files always produce the same findings (no network, no clock, no LLM).
 *
 * Rules (tag `skill-supply-chain` + the rule id below):
 *
 *   remote-exec            fetch piped/substituted into an interpreter
 *                          (`curl … | bash`, `bash <(curl …)`, `iwr … | iex`,
 *                          download-then-`sh`)                           high
 *   encoded-exec           decode-then-execute (`base64 -d | sh`,
 *                          `eval(atob(…))`, `powershell -enc <b64>`)      high
 *   remote-eval            a bundled script that both evaluates dynamic code
 *                          (eval/exec/new Function/iex, dynamic
 *                          require/import, pickle.loads) AND makes network
 *                          calls                                         high
 *   dynamic-eval           eval/exec/new Function/iex with no network call
 *                          in the same script                            warning
 *   credential-exfil       a bundled script that reads credential stores or
 *                          dumps the whole environment AND makes network
 *                          calls                                         high
 *   exfil-instruction      prose telling the agent to send/upload secrets to
 *                          a destination                         high / warning
 *   instruction-override   prompt-injection text ("ignore previous
 *                          instructions", chat-template role tokens)     high
 *   conceal-from-user      prose hiding actions from the user    high / warning
 *   permission-bypass      flags/prose that disable permission or safety
 *                          prompts (`--dangerously-skip-permissions`)    warning
 *   hidden-unicode         Unicode tag characters and bidi overrides (high),
 *                          zero-width characters (warning)
 *   hidden-html-comment    agent-directed text inside an HTML comment, which
 *                          a rendered preview hides but the agent reads  warning
 *   hidden-html-element    text hidden by `display:none`/`hidden`        warning
 *   encoded-blob           a large base64 blob in instruction text       warning
 *   unpinned-remote-dep    a remote dependency with no pinned version (git
 *                          URL without a commit/tag, `@latest`, a script
 *                          fetched from a branch)                        warning
 *   missing-script         the skill invokes a script (`python scripts/x.py`)
 *                          that is not bundled and not in the repo  warning,
 *                          ai_config (same family as the structural
 *                          dead-reference check)
 *
 * False-positive controls (the heuristics are deliberately conservative — a
 * rule that fires on healthy skills is worse than no rule):
 *
 *  - Prose rules skip a match negated earlier in the same sentence ("never
 *    pipe curl into bash"), a sentence that discusses the behavior rather than
 *    directing it ("block network calls without user consent", "detect
 *    injection such as …"), and prompt-injection text that is quoted (a skill
 *    that *documents* injection strings).
 *  - missing-script reads only the SKILL.md (reference docs hold worked
 *    examples of scripts the reader would write), ignores JSON/YAML/TOML
 *    example fences, bare filenames (`python manage.py` names the user's
 *    project), build output paths and unknown `$VARS`, and accepts a script
 *    found in the skill directory, the plugin root, or the repo root.
 *  - A single named API key read from the environment and sent to an API is
 *    the normal shape of an API-calling skill and is NOT flagged; only bulk
 *    environment dumps and credential-store reads count as a secret source.
 *    Likewise, prose that sends a key "in the Authorization header" is skipped.
 *  - Dynamic require/import is only suspicious alongside network access; on
 *    its own it is the usual `require(path.join(__dirname, …))`.
 *  - Zero-width joiners inside emoji and non-Latin scripts, emoji flag tag
 *    sequences, a leading BOM, and `data:` URIs are ignored.
 *  - `npx some-tool` with no version is not flagged (too common to be signal);
 *    an explicit `@latest` or an unpinned git/tarball source is. In markdown,
 *    install commands are only read from code fences and inline code spans.
 *  - One finding per rule per file: repeated matches add evidence and
 *    locations, not extra score deductions.
 *
 * Findings are owned by the skill's SKILL.md (`filePaths`), with `locations`
 * pointing at the exact file and line — a SKILL.md line, or a line in a
 * bundled file. An inline `promptci-ignore: security` annotation in the
 * SKILL.md therefore also covers findings in that skill's bundled scripts,
 * which cannot carry an HTML-comment annotation of their own. Evidence quotes
 * the matched text with its repo-relative path; line numbers live in
 * `locations` so baseline fingerprints stay stable across edits.
 *
 * No finding is auto-fixable: repairing a skill means changing what it does,
 * which needs a human-reviewed diff.
 */

import * as path from 'node:path';
import type { RepoContext } from './repo-context.js';
import type { IssueCategory, IssueSeverity, PromptCiIssue } from './types.js';
import { isFileWithinRoot, lineOf, readTextWithinRoot, shortHash, withScannerPaths } from './ai-config.js';
import { blankCodeBlockLines, scanFencedLines } from './markdown-fences.js';
import { extractFileRefs } from './skills-detector.js';

// ── Types ─────────────────────────────────────────────────────────────────────

type Kind = 'instructions' | 'script' | 'manifest';
type Lang = 'js' | 'py' | 'sh' | 'ps' | 'rb' | 'other';

type SkillDoc = {
  /** Repo-relative POSIX path. */
  path: string;
  kind: Kind;
  lang: Lang;
  content: string;
  lines: string[];
  /** Last line of the SKILL.md frontmatter block (0 when none / not a SKILL.md). */
  frontmatterEnd: number;
};

type Skill = {
  /** Repo-relative POSIX path of the SKILL.md. */
  skillMd: string;
  /** Repo-relative POSIX skill directory. */
  dir: string;
  docs: SkillDoc[];
  /** Also audited by the structural skills detector, which reports its own dead references. */
  structurallyAudited: boolean;
};

export type SkillSupplyChainRule =
  | 'remote-exec'
  | 'encoded-exec'
  | 'remote-eval'
  | 'dynamic-eval'
  | 'credential-exfil'
  | 'exfil-instruction'
  | 'instruction-override'
  | 'conceal-from-user'
  | 'permission-bypass'
  | 'hidden-unicode'
  | 'hidden-html-comment'
  | 'hidden-html-element'
  | 'encoded-blob'
  | 'unpinned-remote-dep'
  | 'missing-script';

type Hit = {
  line: number;
  excerpt: string;
  severity: IssueSeverity;
  confidence: number;
};

type RuleSpec = {
  title: string;
  category: IssueCategory;
  summary: string;
  recommendation: string;
};

// ── Rule wording ──────────────────────────────────────────────────────────────

const RULES: Record<SkillSupplyChainRule, RuleSpec> = {
  'remote-exec': {
    title: 'Skill may download and execute remote code',
    category: 'security',
    summary:
      'content fetched from the network appears to be piped or substituted straight into an interpreter. ' +
      'Whatever the server returns at run time is executed with the user\'s permissions, and it can change after the skill was reviewed.',
    recommendation:
      'Consider vendoring the script into the skill directory (so it is reviewed with the skill), or download it to a file, ' +
      'verify a pinned checksum, and only then run it.',
  },
  'encoded-exec': {
    title: 'Skill may decode and execute an encoded payload',
    category: 'security',
    summary:
      'an encoded string appears to be decoded and executed. Encoding hides what actually runs from anyone reviewing the skill.',
    recommendation: 'Replace the encoded payload with the plain-text commands it runs, so the behavior can be reviewed.',
  },
  'remote-eval': {
    title: 'Skill script may evaluate code fetched from the network',
    category: 'security',
    summary:
      'a bundled script evaluates dynamically built code (eval/exec, `new Function`, a dynamic import, or deserialization) ' +
      'and also makes network calls — the shape of a remote-code loader.',
    recommendation:
      'Review what the evaluated code is built from. If it comes from the network, replace the loader with code bundled in the skill.',
  },
  'dynamic-eval': {
    title: 'Skill script evaluates dynamically built code',
    category: 'security',
    summary:
      'a bundled script uses eval/exec, `new Function`, or Invoke-Expression. What it runs cannot be read from the script itself.',
    recommendation: 'Consider replacing dynamic evaluation with direct code so the script\'s behavior is reviewable.',
  },
  'credential-exfil': {
    title: 'Skill script reads credentials and makes network calls',
    category: 'security',
    summary:
      'a bundled script reads a credential store (SSH keys, cloud or registry credentials, wallets, the keychain) or dumps ' +
      'the whole environment, and the same script makes network calls — a possible credential-exfiltration path.',
    recommendation:
      'Confirm the script needs this access. A skill should read only the specific variable it needs and send it only to the ' +
      'service that requires it; remove bulk environment dumps and credential-file reads.',
  },
  'exfil-instruction': {
    title: 'Skill instructions may direct sending secrets off-machine',
    category: 'security',
    summary:
      'the instructions appear to tell the agent to send, upload or post secrets, credentials or environment variables to a destination.',
    recommendation:
      'Remove the instruction. Skills should never direct an agent to transmit credentials anywhere; if an API call needs a key, ' +
      'reference the environment variable by name only.',
  },
  'instruction-override': {
    title: 'Skill contains prompt-injection style override text',
    category: 'security',
    summary:
      'the text appears to try to override the agent\'s existing instructions (e.g. "ignore previous instructions") or embeds ' +
      'chat-template role tokens. A skill has no legitimate reason to do this.',
    recommendation:
      'Remove the override text. If the skill documents injection strings as examples, quote them so they read as data.',
  },
  'conceal-from-user': {
    title: 'Skill instructions may hide actions from the user',
    category: 'security',
    summary: 'the instructions appear to tell the agent to act silently or keep something from the user.',
    recommendation: 'Remove the concealment. Every action a skill takes should be visible to the person running it.',
  },
  'permission-bypass': {
    title: 'Skill may disable agent permission or safety prompts',
    category: 'security',
    summary:
      'the skill appears to turn off permission prompts, approvals or sandboxing (for example `--dangerously-skip-permissions`), ' +
      'so later actions would run without the user confirming them.',
    recommendation:
      'Remove the bypass and let the agent\'s normal permission prompts apply; grant narrowly scoped `allowed-tools` instead if needed.',
  },
  'hidden-unicode': {
    title: 'Skill contains invisible or bidirectional Unicode characters',
    category: 'security',
    summary:
      'the file contains characters that do not render — Unicode tag characters and bidi overrides can smuggle instructions ' +
      'or reorder text so what a reviewer sees differs from what the agent reads.',
    recommendation: 'Remove the invisible characters (the evidence shows them as <U+XXXX>) and re-review the affected lines.',
  },
  'hidden-html-comment': {
    title: 'Skill hides agent-directed text in an HTML comment',
    category: 'security',
    summary:
      'an HTML comment contains agent-directed or sensitive text. Rendered previews hide comments, but the agent reads them.',
    recommendation: 'Move the text into visible prose (or delete it) so reviewers see everything the agent is told.',
  },
  'hidden-html-element': {
    title: 'Skill hides text from rendered view with HTML/CSS',
    category: 'security',
    summary:
      'an HTML element hides its content from rendered previews (`display:none`, `visibility:hidden`, `hidden`), but the agent still reads it.',
    recommendation: 'Remove the hiding markup so the content is visible to reviewers, or delete the hidden content.',
  },
  'encoded-blob': {
    title: 'Skill instructions contain a large encoded blob',
    category: 'security',
    summary: 'the instruction text contains a long base64-like string whose content cannot be reviewed by reading the skill.',
    recommendation: 'Replace the blob with the plain content it encodes, or move binary assets into bundled files.',
  },
  'unpinned-remote-dep': {
    title: 'Skill pulls a remote dependency without a pinned version',
    category: 'security',
    summary:
      'the skill installs or fetches remote code by a mutable reference (a git URL without a commit or tag, `@latest`, or a ' +
      'script on a branch), so what runs can change after the skill was reviewed.',
    recommendation: 'Pin the dependency to an exact version, tag or commit SHA (and prefer a checksum for downloaded scripts).',
  },
  'missing-script': {
    title: 'Skill invokes a script that is not bundled with it',
    category: 'ai_config',
    summary:
      'the skill tells the agent to run a script that exists neither in the skill directory nor at that path in the repo, so ' +
      'what actually runs cannot be reviewed with the skill.',
    recommendation: 'Bundle the script in the skill directory, fix the path, or remove the instruction.',
  },
};

// ── File classification ───────────────────────────────────────────────────────

const INSTRUCTION_EXT = /\.(?:md|mdx|markdown|txt)$/i;

const SCRIPT_EXT: Record<string, Lang> = {
  sh: 'sh', bash: 'sh', zsh: 'sh', ksh: 'sh', fish: 'sh', command: 'sh',
  js: 'js', mjs: 'js', cjs: 'js', ts: 'js', mts: 'js', cts: 'js', jsx: 'js', tsx: 'js',
  py: 'py', pyw: 'py',
  rb: 'rb',
  ps1: 'ps', psm1: 'ps',
  pl: 'other', php: 'other', lua: 'other', bat: 'other', cmd: 'other',
};

function langFromShebang(firstLine: string): Lang | undefined {
  const m = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(firstLine);
  if (!m) return undefined;
  const interp = path.posix.basename(m[1]!) === 'env' ? (m[2] ?? '') : path.posix.basename(m[1]!);
  if (/^(?:node|deno|bun|tsx|ts-node)$/.test(interp)) return 'js';
  if (/^python/.test(interp)) return 'py';
  if (/^(?:ba|z|k|da|fi)?sh$/.test(interp)) return 'sh';
  if (/^ruby$/.test(interp)) return 'rb';
  if (/^pwsh$/.test(interp)) return 'ps';
  return 'other';
}

function classify(relPath: string, content: string): { kind: Kind; lang: Lang } | undefined {
  const base = path.posix.basename(relPath);
  if (base === 'package.json' || /^requirements[\w.-]*\.txt$/i.test(base)) return { kind: 'manifest', lang: 'other' };
  if (INSTRUCTION_EXT.test(base)) return { kind: 'instructions', lang: 'other' };
  const ext = /\.([a-z0-9]+)$/i.exec(base)?.[1]?.toLowerCase();
  if (ext && SCRIPT_EXT[ext]) return { kind: 'script', lang: SCRIPT_EXT[ext]! };
  if (!ext || !base.includes('.')) {
    const lang = langFromShebang(content.split(/\r?\n/, 1)[0] ?? '');
    if (lang) return { kind: 'script', lang };
  }
  return undefined; // data/config/assets — not read by these rules
}

function frontmatterEnd(lines: string[]): number {
  if ((lines[0] ?? '').replace(/^\uFEFF/, '').trim() !== '---') return 0;
  for (let i = 1; i < lines.length; i++) {
    if (/^(?:---|\.\.\.)[ \t]*$/.test(lines[i]!)) return i + 1;
  }
  return 0;
}

// ── Text helpers ──────────────────────────────────────────────────────────────

type InvisibleClass = 'tag' | 'bidi' | 'zero-width';

function invisibleClass(cp: number): InvisibleClass | undefined {
  if (cp >= 0xe0000 && cp <= 0xe007f) return 'tag';
  if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) return 'bidi';
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d || (cp >= 0x2060 && cp <= 0x2064) || cp === 0x180e || cp === 0xfeff) {
    return 'zero-width';
  }
  return undefined;
}

function codepointLabel(cp: number): string {
  return `<U+${cp.toString(16).toUpperCase().padStart(4, '0')}>`;
}

/** Render invisible characters visibly so evidence never carries a hidden payload. */
function visible(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    out += invisibleClass(cp) ? codepointLabel(cp) : ch;
  }
  return out;
}

const MAX_EXCERPT = 100;

/** A display excerpt of `line` around the match at `index`. */
function excerpt(line: string, index = 0): string {
  const clean = visible(line).replace(/\s+/g, ' ').trim();
  if (clean.length <= MAX_EXCERPT) return clean;
  // Re-find the match position in the cleaned string approximately.
  const start = Math.max(0, Math.min(index - 30, clean.length - MAX_EXCERPT));
  const body = clean.slice(start, start + MAX_EXCERPT);
  return `${start > 0 ? '…' : ''}${body}${start + MAX_EXCERPT < clean.length ? '…' : ''}`;
}

/** Join backslash-continued lines so a `curl … \` / `| bash` split is one command. */
function logicalLines(lines: string[]): Array<{ text: string; line: number }> {
  const out: Array<{ text: string; line: number }> = [];
  let buf = '';
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (buf === '') start = i + 1;
    if (/(?:^|[^\\])\\[ \t]*$/.test(l)) {
      buf += `${l.replace(/\\[ \t]*$/, '')} `;
      continue;
    }
    out.push({ text: buf + l, line: start });
    buf = '';
  }
  if (buf !== '') out.push({ text: buf, line: start });
  return out;
}

/**
 * An imperative negation earlier in the same sentence: "never pipe curl into
 * bash". Deliberately excludes a bare "not" — "if brew is not installed, run
 * curl … | bash" is still an instruction to run it.
 */
const NEGATION_RE = /\b(?:never|don't|do\s+not|avoid|must\s+not|mustn't|should\s+not|shouldn't|refuse\s+to)\b[^.;!?]*$/i;

function isNegated(line: string, index: number): boolean {
  return NEGATION_RE.test(line.slice(Math.max(0, index - 80), index));
}

/**
 * The sentence *discusses* the behavior rather than directing it — a security
 * skill describing what to block, or docs listing unsupported flows. Applied to
 * the prose rules only; command patterns (remote-exec) are judged as written.
 */
const DISCUSSION_RE =
  /\b(?:prevent\w*|block(?:s|ed|ing)?|detect\w*|den(?:y|ies|ied)|reject\w*|flag(?:s|ged)?|forbid\w*|prohibit\w*|dangerous|malicious|attack(?:s|er|ers)?|unsafe|risk(?:s|y)?|(?:not|un)\s*supported|vulnerab\w*|exploit\w*|injection)\b/i;

/** URLs are stripped first — a host named `attacker.example` is not discussion. */
function discusses(sentence: string): boolean {
  return DISCUSSION_RE.test(sentence.replace(/\bhttps?:\/\/\S+/gi, ' '));
}

function isDiscussion(line: string, index: number): boolean {
  const sentence = sentences(line).find((s) => index >= s.offset && index < s.offset + s.text.length);
  return discusses(sentence?.text ?? line);
}

/** The match sits inside a double-quoted, curly-quoted or backticked span. */
function isQuoted(line: string, start: number, end: number): boolean {
  const before = line.slice(0, start);
  const after = line.slice(end);
  for (const q of ['"', '`']) {
    const count = before.split(q).length - 1;
    if (count % 2 === 1 && after.includes(q)) return true;
  }
  return before.lastIndexOf('\u201C') > before.lastIndexOf('\u201D') && after.includes('\u201D');
}

// ── Pattern tables ────────────────────────────────────────────────────────────

const FETCH_CMD = String.raw`(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|aria2c|downloadstring)`;
/** Interpreters that execute whatever arrives on stdin when given no script argument. */
const STDIN_INTERP = String.raw`(?:python[0-9.]*|node|perl|ruby|php|deno|bun)(?=\s*$|\s+-(?:\s|$)|\s*[;&|)\x60'"])`;
const SHELL = String.raw`(?:ba|z|k|da|fi)?sh\b`;

const REMOTE_EXEC_PATTERNS: RegExp[] = [
  // curl … | bash   /   iwr … | iex
  new RegExp(String.raw`\b${FETCH_CMD}\b[^|\n]*\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:env\s+(?:\S+=\S*\s+)*)?(?:${SHELL}|${STDIN_INTERP}|iex\b|invoke-expression\b|pwsh\b|powershell\b)`, 'i'),
  // bash <(curl …)   /   source <(wget …)
  /(?:^|[\s;&|(`])(?:(?:ba|z|k)?sh|source|\.)\s+<\(\s*(?:curl|wget)\b/i,
  // sh -c "$(curl …)"   /   eval "$(wget …)"   /   python -c "$(curl …)"
  /\b(?:(?:ba|z|k)?sh\s+-c|eval|python[0-9.]*\s+-c|node\s+-e|perl\s+-e|ruby\s+-e)\s+["']?(?:\$\(|`)\s*(?:curl|wget)\b/i,
  // iex (iwr …)   /   Invoke-Expression ((New-Object Net.WebClient).DownloadString(…))
  /\b(?:iex|invoke-expression)\b[^\n]*\b(?:iwr|irm|invoke-webrequest|invoke-restmethod|downloadstring|net\.webclient)\b/i,
  // curl -o x.sh URL && bash x.sh
  /\b(?:curl|wget)\b[^\n]*?\bhttps?:\/\/[^\n]*?(?:&&|;)\s*(?:sudo\s+)?(?:ba|z)?sh\s+[^\s-]/i,
];

const ENCODED_EXEC_PATTERNS: RegExp[] = [
  /\bbase64\s+(?:-d|--decode|-D)\b[^\n|]*\|\s*(?:sudo\s+)?(?:(?:ba|z|k|da)?sh|python[0-9.]*|node|perl|ruby)\b/i,
  /\b(?:eval|exec|Function|Invoke-Expression|iex)\s*\(?\s*(?:atob|Buffer\.from|base64\.b64decode|b64decode|base64\.decodebytes|codecs\.decode|\[(?:System\.)?Convert\]::FromBase64String)\b/i,
  /\b(?:powershell|pwsh)(?:\.exe)?\b[^\n]*\s-(?:e|ec|enc|encodedcommand)\s+[A-Za-z0-9+/]{20,}={0,2}/i,
];

/** Direct eval-of-fetch on one line: remote-eval without needing file context. */
const DIRECT_REMOTE_EVAL_RE =
  /\b(?:eval|exec|Function)\s*\(\s*(?:await\s+)?\(?\s*(?:await\s+)?(?:fetch|requests\.get|urlopen|urllib\.request\.urlopen|http\.get)\s*\(/i;

/** Strong dynamic evaluation, per language. */
const EVAL_PATTERNS: Partial<Record<Lang, RegExp[]>> = {
  js: [
    /(?<![.\w$])eval\s*\(/,
    /\bnew\s+Function\s*\(/,
    /\bvm\.(?:runInNewContext|runInThisContext|runInContext|compileFunction)\s*\(|\bnew\s+vm\.Script\s*\(/,
  ],
  py: [/(?<![.\w])(?:exec|eval)\s*\(/],
  sh: [/(?:^|[\s;&|(])eval\s+\S/],
  ps: [/\b(?:Invoke-Expression|iex)\b/i],
  rb: [/(?<![.\w])eval\s*[( ]/],
};

/** Dynamic loading that is only suspicious next to network access. */
const DYNAMIC_LOAD_PATTERNS: Partial<Record<Lang, RegExp[]>> = {
  js: [
    /(?<![.\w$])require\s*\(\s*(?!['"][^'"]*['"]\s*\))[^)\s]/,
    /(?<![.\w$])import\s*\(\s*(?!['"][^'"]*['"]\s*\))[^)\s]/,
  ],
  py: [
    /(?<![.\w])__import__\s*\(\s*(?!['"])/,
    /\bimportlib\.import_module\s*\(\s*(?!['"])/,
    /\b(?:pickle|marshal)\.loads?\s*\(/,
  ],
};

const NETWORK_RE = new RegExp(
  [
    String.raw`(?:^|[\s;&|(\x60$])(?:curl|wget|nc|ncat|netcat|socat|scp|sftp|telnet)\s`,
    String.raw`\/dev\/(?:tcp|udp)\/`,
    String.raw`(?<![.\w$])fetch\s*\(`,
    String.raw`\baxios\b`,
    String.raw`\bhttps?\.(?:get|request)\s*\(`,
    String.raw`\brequire\s*\(\s*['"](?:node:)?(?:https?|net|dgram)['"]`,
    String.raw`\bfrom\s+['"](?:node:)?(?:https?|net|dgram)['"]`,
    String.raw`\bnew\s+WebSocket\b`,
    String.raw`\bXMLHttpRequest\b`,
    String.raw`\b(?:node-fetch|undici)\b`,
    String.raw`\brequests\.(?:get|post|put|patch|request|Session)\b`,
    String.raw`\burllib\.request\b`,
    String.raw`\burlopen\s*\(`,
    String.raw`\bhttp\.client\b`,
    String.raw`\bhttpx\.`,
    String.raw`\baiohttp\b`,
    String.raw`\bsocket\.(?:socket|create_connection)\b`,
    String.raw`\bsmtplib\b`,
    String.raw`\b(?:Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b`,
    String.raw`\bNet\.WebClient\b`,
    String.raw`\bSystem\.Net\.Http\b`,
    String.raw`\bNet::HTTP\b`,
    String.raw`\bopen-uri\b`,
    String.raw`\bURI\.open\b`,
    String.raw`\bdns\.(?:resolve|lookup)\s*\(`,
  ].join('|'),
  'i',
);

/** Bulk environment dumps — not a single named variable. */
const BULK_ENV_RE = new RegExp(
  [
    String.raw`JSON\.stringify\(\s*process\.env\s*\)`,
    String.raw`Object\.(?:entries|keys|values)\(\s*process\.env\s*\)`,
    String.raw`json\.dumps\(\s*(?:dict\(\s*)?os\.environ`,
    String.raw`\bstr\(\s*os\.environ\s*\)`,
    String.raw`\bos\.environ\.items\(\s*\)`,
    String.raw`(?:^|[\s;&(])(?:printenv|env)\s*[|>]`,
    String.raw`\$\(\s*(?:printenv|env)\s*\)`,
    String.raw`\x60\s*(?:printenv|env)\s*\x60`,
    String.raw`\bprintenv\s*$`,
    String.raw`\/proc\/(?:self|\d+|\$\$)\/environ`,
    String.raw`\b(?:Get-ChildItem|gci|dir|ls)\s+env:`,
    String.raw`\[Environment\]::GetEnvironmentVariables\(\s*\)`,
    String.raw`\bENV\.to_h\b`,
  ].join('|'),
  'i',
);

/**
 * Credential stores whose only reason to be read next to a network call is to
 * send them somewhere: SSH private keys, AWS/GPG stores, netrc/git-credentials,
 * keychains, wallets, browser logins. Config a legitimate client reads for its
 * own service (kubeconfig, docker/gh/gcloud config, .npmrc) is deliberately
 * not listed — a k8s or registry skill reading it is normal.
 */
const CREDENTIAL_SOURCE_RE = new RegExp(
  [
    String.raw`(?:^|[\s'"\/\\~(])\.ssh(?=[\s'")]|\/?['"]|\/?$)`, // the whole ~/.ssh directory
    String.raw`\.ssh\/(?:id_\w+|[\w.-]+\.(?:pem|key))\b`,
    String.raw`\bid_(?:rsa|ed25519|ecdsa|dsa)\b`,
    String.raw`(?:^|[\s'"\/\\~(])\.(?:aws|gnupg)(?=[\/\\'"\s)]|$)`,
    String.raw`(?:^|[\s'"\/\\~(])\.(?:netrc|git-credentials)\b`,
    String.raw`\bsecurity\s+(?:find-generic-password|find-internet-password|dump-keychain)\b`,
    String.raw`\bsecret-tool\s+lookup\b`,
    String.raw`\bwallet\.dat\b`,
    String.raw`\.config\/solana\/id\.json`,
    String.raw`\bkeystore\/UTC--`,
    String.raw`\.ethereum\/keystore`,
    String.raw`\bLogin Data\b`,
    String.raw`\bseed[_\s-]?phrase\b`,
  ].join('|'),
  'i',
);

// Prose: prompt-injection overrides.
const OVERRIDE_PATTERNS: RegExp[] = [
  /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+|every\s+)?(?:of\s+)?(?:the\s+|your\s+|my\s+|these\s+|those\s+)?(?:previous|prior|above|earlier|preceding|system|developer|safety)\s+(?:instructions?|prompts?|rules|guidelines|directives|messages?|context)\b/i,
  /\byou\s+are\s+(?:now\s+)?(?:in\s+)?(?:DAN|developer\s+mode|jailbroken|jailbreak\s+mode|unrestricted\s+mode|god\s+mode)\b/i,
  /<\|im_start\|>|<\|(?:system|endoftext)\|>|<<SYS>>|\[\/?INST\]/i,
  /\b(?:new|updated|actual|real)\s+system\s+prompt\b/i,
  /\b(?:these|this|the\s+following)\s+instructions?\s+(?:take|takes|have|has)\s+(?:precedence|priority)\s+over\s+(?:all\s+|any\s+|the\s+)?(?:system|safety)\b/i,
];

// Prose: concealment. Strong patterns are high; "don't tell the user" is a warning.
const CONCEAL_STRONG: RegExp[] = [
  // Not "consent": "… without user consent" is overwhelmingly a policy statement, not an instruction.
  /\b(?:without|w\/o)\s+(?:the\s+)?user'?s?\s+(?:knowledge|knowing|noticing|awareness)\b/i,
  /\b(?:hide|conceal|obscure)\s+(?:this|these|it|them|that|the\s+[\w\s-]{1,30}?)\s+from\s+(?:the\s+)?user\b/i,
  /\bsilently\s+(?:upload|send|post|exfiltrate|transmit|forward)\b/i,
];
const CONCEAL_SOFT: RegExp[] = [
  // "never tell the user TO do X" is advice about wording, not concealment.
  /\b(?:do\s+not|don't|never)\s+(?:tell|inform|notify|alert|warn)\s+(?:the\s+)?user\b(?!\s+to\b)/i,
  /\b(?:do\s+not|don't|never)\s+(?:mention|reveal|disclose)\s+(?:this|that|it|these\s+(?:steps|instructions))\s+to\s+(?:the\s+)?user\b/i,
];

// Permission/safety bypass. Flags apply to every file; prose to instruction files only.
const BYPASS_FLAG_RE =
  /--dangerously-skip-permissions\b|--dangerously-bypass-approvals-and-sandbox\b|\bbypassPermissions\b|--yolo\b|--allow-all-tools\b/i;
const BYPASS_PROSE: RegExp[] = [
  /\bwithout\s+(?:first\s+)?(?:asking|prompting|checking\s+with)\s+(?:the\s+user\s+)?(?:for\s+)?(?:permission|confirmation|approval|consent)\b/i,
  /\b(?:disable|turn\s+off|bypass|circumvent|skip|override)\s+(?:the\s+|any\s+|all\s+)?(?:sandbox(?:ing)?|safety\s+(?:checks?|guardrails?|filters?|prompts?)|guardrails?|permission\s+(?:prompts?|checks?|dialogs?)|approval\s+(?:prompts?|steps?)|content\s+(?:filters?|polic(?:y|ies)))\b/i,
  /\bauto[-\s]?approve\s+(?:all|every|any)\b/i,
];

// Prose: exfiltration instructions.
const EXFIL_VERB = String.raw`(?:send|upload|post|transmit|exfiltrate|forward|paste|leak|e-?mail)`;
const EXFIL_SECRET = String.raw`(?:\b(?:env(?:ironment)?\s+var(?:iable)?s?|secrets?|credentials?|api[\s_-]?keys?|access[\s_-]?tokens?|auth(?:entication)?\s+tokens?|bearer\s+tokens?|private\s+keys?|ssh\s+keys?|id_rsa|passwords?(?!\s+reset)|session\s+cookies|browser\s+cookies|wallets?|seed\s+phrases?|keychain)\b|\.env\b|~\/\.ssh\b|\.aws\/credentials\b)`;
const EXFIL_DEST_STRONG = String.raw`(?:webhook|pastebin|paste\.|hastebin|discord|telegram|ngrok|requestbin|pipedream|interactsh|burpcollaborator|\.onion\b|https?:\/\/\d{1,3}(?:\.\d{1,3}){3})`;
const EXFIL_DEST_WEAK = String.raw`(?:https?:\/\/|server|endpoint|remote|external|third[-\s]party|attacker|e-?mail\s+address)`;
const EXFIL_RE = new RegExp(
  String.raw`\b${EXFIL_VERB}\b[^\n]{0,80}?${EXFIL_SECRET}[^\n]{0,100}?\b(?:to|into|at|via)\b[^\n]{0,60}?(?:${EXFIL_DEST_STRONG}|${EXFIL_DEST_WEAK})`,
  'i',
);
const EXFIL_DEST_STRONG_RE = new RegExp(EXFIL_DEST_STRONG, 'i');
/** Sending a key as request auth is how API skills work, not exfiltration. */
const AUTH_CONTEXT_RE = /\b(?:header|authorization|authenticate|bearer\s+auth)\b|\s-H\s/i;

// Hidden markup.
const HIDDEN_ELEMENT_RE =
  /<[a-z][^>]*\sstyle\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:px|pt|em|rem)?\s*(?:;|["'])|opacity\s*:\s*0(?:\.0+)?\s*(?:;|["']))|<[a-z][^>]*\shidden(?:\s|>|=|\/)/i;
/** Tooling directives and section markers that legitimately live in comments. */
const BENIGN_COMMENT_RE =
  /^\s*(?:promptci-ignore|markdownlint|prettier|eslint|cspell|textlint|vale\b|toc\b|omit\s+in\s+toc|end\s*toc|mdformat|lint|region|endregion|#region|#endregion|@formatter|todo\b|fixme\b|xxx\b)/i;
const AGENT_DIRECTED_RE = new RegExp(
  [
    String.raw`\b(?:ignore|disregard|forget)\b[^\n]{0,40}\b(?:instructions?|prompts?|rules|guidelines)\b`,
    String.raw`\byou\s+(?:must|are\s+now|will\s+now|should\s+(?:always|never|secretly|silently))\b`,
    String.raw`\b(?:assistant|claude|the\s+(?:ai|agent|model|llm))\s*[:,]`,
    String.raw`\b(?:dear|hey)\s+(?:ai|assistant|claude|agent|model)\b`,
    String.raw`\bsystem\s+prompt\b`,
    String.raw`\b(?:curl|wget|iwr|invoke-webrequest)\b`,
    String.raw`\bbase64\s+-d\b`,
    String.raw`\b(?:api[_\s-]?keys?|secrets?|credentials?|passwords?|private\s+keys?)\b`,
    String.raw`~\/\.ssh|\.env\b`,
    String.raw`\b(?:run|execute|download|upload|send|install)\s+(?:this|the\s+following|it)\b`,
  ].join('|'),
  'i',
);

/** A base64-alphabet run of at least 200 characters. */
const BLOB_RE = /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{200,}={0,2}(?![A-Za-z0-9+/=])/g;

// Unpinned remote dependencies.
const INSTALL_CTX_RE = /\b(?:pip[0-9.]*|pipx|uvx|uv|npm|pnpm|yarn|bun|npx|bunx|go|cargo|gem|deno)\b/i;
const GIT_SOURCE_RE = /\bgit\+(?:https?|ssh|git|file):\/\/[^\s'"<>)`]+|\bgithub:[\w.-]+\/[\w.-]+(?:#[^\s'"<>)`]*)?/gi;
const LATEST_RE =
  /\b(?:npx|bunx|pnpm\s+dlx|yarn\s+dlx|uvx|pipx\s+run|npm\s+(?:i|install|exec|add)|pnpm\s+(?:add|i|install)|yarn\s+add|bun\s+(?:add|i|install|x)|go\s+(?:install|run)|deno\s+(?:run|install))\b[^\n;&|]*?(?<![\w-])((?:@?[\w.-]+\/)?[\w.-]+@(?:latest|master|main|HEAD))(?![\w.-])/i;
const NPM_INSTALL_RE = /\b(?:npm\s+(?:i|install|add)|pnpm\s+(?:add|i|install)|yarn\s+add|bun\s+(?:add|i|install))\b([^\n;&|]*)/i;
const CARGO_GIT_RE = /\bcargo\s+install\b[^\n;&|]*--git\s+\S+/i;
const MUTABLE_SCRIPT_URL_RE = new RegExp(
  [
    String.raw`https?:\/\/raw\.githubusercontent\.com\/[^/\s]+\/[^/\s]+\/(?:refs\/heads\/)?(?:main|master|HEAD|develop|dev|trunk)\/[^\s'"<>)\x60]*`,
    String.raw`https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/raw\/(?:refs\/heads\/)?(?:main|master|HEAD|develop|dev|trunk)\/[^\s'"<>)\x60]*`,
    String.raw`https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/releases\/latest\/download\/[^\s'"<>)\x60]*`,
    String.raw`https?:\/\/gist\.githubusercontent\.com\/[^/\s]+\/[0-9a-f]+\/raw\/(?![0-9a-f]{40}\/)[^\s'"<>)\x60]+`,
  ].join('|'),
  'i',
);
const FETCH_VERB_RE = /\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|fetch|urlopen|requests\.get|download|downloadstring)\b/i;
const SCRIPTISH_URL_RE = /(?:\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|ps1|rb|pl)(?:[?#]|$)|install)/i;
const REMOTE_IMPORT_RE = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"](https?:\/\/[^'"]+)['"]/g;

/** A pinned git ref: a commit SHA (7–40 hex) or a version tag. */
function isPinnedRef(ref: string | undefined): boolean {
  if (!ref) return false;
  const r = ref.replace(/^semver:/i, '').trim();
  return /^[0-9a-f]{7,40}$/i.test(r) || /^v?\d+(?:\.\d+)+(?:[-+.][\w.-]*)?$/.test(r);
}

/** Ref of a git/github source: `@ref` after the repo path (pip) or `#ref` (npm). */
function gitSourceRef(source: string): string | undefined {
  const hash = source.indexOf('#');
  if (hash >= 0) {
    const frag = source.slice(hash + 1);
    if (!/^(?:egg|subdirectory)=/.test(frag)) return frag.split('&')[0];
  }
  const noFrag = hash >= 0 ? source.slice(0, hash) : source;
  const noScheme = noFrag.replace(/^(?:git\+)?[a-z]+:\/\//i, '').replace(/^github:/i, '');
  const slash = noScheme.indexOf('/');
  const repoPath = slash >= 0 ? noScheme.slice(slash + 1) : noScheme; // drop user@host
  const at = repoPath.lastIndexOf('@');
  return at >= 0 ? repoPath.slice(at + 1) : undefined;
}

function isUnpinnedRemoteSpec(spec: string): boolean {
  const s = spec.trim();
  if (/^(?:git\+|git:|github:|gitlab:|bitbucket:)/i.test(s) || /^[A-Za-z0-9][\w.-]*\/[\w.-]+(?:#.*)?$/.test(s)) {
    return !isPinnedRef(gitSourceRef(s.startsWith('git') || s.includes(':') ? s : `github:${s}`));
  }
  if (/^https?:\/\//i.test(s)) return !/\d+\.\d+\.\d+|#sha(?:256|512)=/i.test(s);
  return false;
}

// Script invocations (for missing-script).
const SCRIPT_REF = String.raw`((?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\/|\{baseDir\}\/|\.\/)?[\w@.\-/]+\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|mts|rb|pl|ps1))(?![\w.\-/])`;
const INVOKE_RE = new RegExp(
  String.raw`(?:^|[\s\x60'"(;&|])(?:sudo\s+)?(?:bash|sh|zsh|python[0-9.]*|node|deno\s+run(?:\s+-\S+)*|bun(?:\s+run)?|tsx|ts-node|ruby|perl|pwsh(?:\s+-File)?|powershell(?:\.exe)?(?:\s+-\S+)*?\s+-File|source|uv\s+run)\s+${SCRIPT_REF}`,
  'gi',
);
const DIRECT_EXEC_RE = new RegExp(String.raw`(?:^|[\s\x60'"(;&|])(\.\/[\w@.\-/]+\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|ps1))(?![\w.\-/])`, 'g');

// ── Collector ─────────────────────────────────────────────────────────────────

const SEVERITY_RANK: Record<IssueSeverity, number> = { info: 0, warning: 1, high: 2, critical: 3 };
const MAX_EVIDENCE = 5;

class HitCollector {
  private readonly groups = new Map<string, { rule: SkillSupplyChainRule; file: string; hits: Hit[] }>();

  add(rule: SkillSupplyChainRule, file: string, hit: Hit): void {
    const key = `${rule}\u0000${file}`;
    const group = this.groups.get(key) ?? { rule, file, hits: [] };
    if (!group.hits.some((h) => h.line === hit.line && h.excerpt === hit.excerpt)) group.hits.push(hit);
    this.groups.set(key, group);
  }

  toIssues(skillMd: string): PromptCiIssue[] {
    return [...this.groups.values()]
      .sort((a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file))
      .map(({ rule, file, hits }) => buildIssue(skillMd, rule, file, hits));
  }
}

function buildIssue(skillMd: string, rule: SkillSupplyChainRule, file: string, hits: Hit[]): PromptCiIssue {
  const spec = RULES[rule];
  const sorted = [...hits].sort((a, b) => a.line - b.line);
  const top = sorted.reduce((best, h) =>
    SEVERITY_RANK[h.severity] > SEVERITY_RANK[best.severity] ||
    (h.severity === best.severity && h.confidence > best.confidence) ? h : best);
  const shown = sorted.slice(0, MAX_EVIDENCE);
  const evidence = shown.map((h) => `${file}: ${h.excerpt}`);
  if (sorted.length > shown.length) evidence.push(`${file}: …and ${sorted.length - shown.length} more match(es)`);
  const where = file === skillMd ? skillMd : `${file} (bundled with ${skillMd})`;
  return {
    id: `skill-supply-chain-${rule}-${shortHash(`${skillMd}|${file}`)}`,
    severity: top.severity,
    category: spec.category,
    title: spec.title,
    summary: `${where}: ${spec.summary}`,
    filePaths: [skillMd],
    locations: shown.map((h) => ({ filePath: file, startLine: h.line, endLine: h.line })),
    evidence,
    recommendation: spec.recommendation,
    confidence: top.confidence,
    tags: ['skill-supply-chain', rule],
  };
}

// ── Rule checks ───────────────────────────────────────────────────────────────

type Add = (rule: SkillSupplyChainRule, line: number, excerptText: string, severity: IssueSeverity, confidence: number) => void;

/** remote-exec + encoded-exec. Returns the lines consumed so weaker rules skip them. */
function checkExec(doc: SkillDoc, add: Add): Set<number> {
  const consumed = new Set<number>();
  for (const { text, line } of logicalLines(doc.lines)) {
    for (const [rule, patterns] of [['remote-exec', REMOTE_EXEC_PATTERNS], ['encoded-exec', ENCODED_EXEC_PATTERNS]] as const) {
      for (const re of patterns) {
        const m = re.exec(text);
        if (!m) continue;
        if (doc.kind === 'instructions' && isNegated(text, m.index)) continue;
        add(rule, line, excerpt(text, m.index), 'high', 0.85);
        consumed.add(line);
        break;
      }
    }
  }
  return consumed;
}

function firstLineMatching(doc: SkillDoc, re: RegExp): { line: number; index: number } | undefined {
  for (let i = 0; i < doc.lines.length; i++) {
    const m = re.exec(doc.lines[i]!);
    if (m) return { line: i + 1, index: m.index };
  }
  return undefined;
}

/** remote-eval / dynamic-eval / credential-exfil — bundled scripts only. */
function checkScript(doc: SkillDoc, consumed: Set<number>, add: Add): void {
  const network = firstLineMatching(doc, NETWORK_RE);
  const evalHits: Array<{ line: number; index: number }> = [];
  const loadHits: Array<{ line: number; index: number }> = [];

  for (let i = 0; i < doc.lines.length; i++) {
    const line = i + 1;
    if (consumed.has(line)) continue;
    const text = doc.lines[i]!;
    const direct = DIRECT_REMOTE_EVAL_RE.exec(text);
    if (direct) {
      add('remote-eval', line, excerpt(text, direct.index), 'high', 0.85);
      continue;
    }
    const ev = (EVAL_PATTERNS[doc.lang] ?? []).map((re) => re.exec(text)).find(Boolean);
    if (ev) { evalHits.push({ line, index: ev.index }); continue; }
    const ld = (DYNAMIC_LOAD_PATTERNS[doc.lang] ?? []).map((re) => re.exec(text)).find(Boolean);
    if (ld) loadHits.push({ line, index: ld.index });
  }

  if (network && (evalHits.length > 0 || loadHits.length > 0)) {
    for (const h of [...evalHits, ...loadHits]) {
      add('remote-eval', h.line, excerpt(doc.lines[h.line - 1]!, h.index), 'high', 0.75);
    }
    add('remote-eval', network.line, `network call: ${excerpt(doc.lines[network.line - 1]!, network.index)}`, 'high', 0.75);
  } else {
    for (const h of evalHits) {
      add('dynamic-eval', h.line, excerpt(doc.lines[h.line - 1]!, h.index), 'warning', 0.6);
    }
  }

  if (network) {
    const sources: Array<{ line: number; index: number }> = [];
    for (let i = 0; i < doc.lines.length; i++) {
      const text = doc.lines[i]!;
      const m = BULK_ENV_RE.exec(text) ?? CREDENTIAL_SOURCE_RE.exec(text);
      if (!m) continue;
      // `ssh -i ~/.ssh/id_rsa host` / `IdentityFile` uses the key to authenticate — it is not read out.
      if (/(?:\s-i\s*|IdentityFile\s+|identity_file\s*=\s*)\S*$/.test(text.slice(0, m.index + 1))) continue;
      sources.push({ line: i + 1, index: m.index });
    }
    if (sources.length > 0) {
      for (const s of sources) {
        add('credential-exfil', s.line, `credential/env read: ${excerpt(doc.lines[s.line - 1]!, s.index)}`, 'high', 0.7);
      }
      add('credential-exfil', network.line, `network call: ${excerpt(doc.lines[network.line - 1]!, network.index)}`, 'high', 0.7);
    }
  }
}

/**
 * Sentences of a line with their offsets, for prose rules. Splits only on
 * terminal punctuation followed by whitespace, so `.env`, URLs and `x.sh` stay
 * inside their sentence.
 */
function sentences(line: string): Array<{ text: string; offset: number }> {
  const out: Array<{ text: string; offset: number }> = [];
  let offset = 0;
  for (const part of line.split(/(?<=[.!?])\s+/)) {
    const at = line.indexOf(part, offset);
    out.push({ text: part, offset: at });
    offset = at + part.length;
  }
  return out;
}

/** Prose rules — instruction files (SKILL.md, reference docs). */
/**
 * First match of any pattern that is a live directive: not negated, not
 * discussing the behavior, and (for `skipQuoted`) not a quoted example.
 * `negatable: false` is for patterns that embed their own negation.
 */
function directive(
  text: string,
  patterns: RegExp[],
  opts: { skipQuoted?: boolean; negatable?: boolean } = {},
): RegExpExecArray | undefined {
  for (const re of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    if (opts.negatable !== false && isNegated(text, m.index)) continue;
    if (opts.skipQuoted && isQuoted(text, m.index, m.index + m[0].length)) continue;
    if (isDiscussion(text, m.index)) continue;
    return m;
  }
  return undefined;
}

function checkProse(doc: SkillDoc, add: Add): void {
  for (let i = 0; i < doc.lines.length; i++) {
    const text = doc.lines[i]!;
    const line = i + 1;

    const override = directive(text, OVERRIDE_PATTERNS, { skipQuoted: true });
    if (override) add('instruction-override', line, excerpt(text, override.index), 'high', 0.8);

    const strong = directive(text, CONCEAL_STRONG);
    const soft = strong ? undefined : directive(text, CONCEAL_SOFT, { negatable: false });
    if (strong) add('conceal-from-user', line, excerpt(text, strong.index), 'high', 0.75);
    else if (soft) add('conceal-from-user', line, excerpt(text, soft.index), 'warning', 0.6);

    const bypass = directive(text, BYPASS_PROSE);
    if (bypass) add('permission-bypass', line, excerpt(text, bypass.index), 'warning', 0.6);

    for (const s of sentences(text)) {
      const m = EXFIL_RE.exec(s.text);
      if (!m) continue;
      if (isNegated(s.text, m.index) || AUTH_CONTEXT_RE.test(s.text) || discusses(s.text)) continue;
      // The lazy match stops at the first destination word; judge strength on the whole rest of the sentence.
      const strong = EXFIL_DEST_STRONG_RE.test(s.text.slice(m.index));
      add('exfil-instruction', line, excerpt(text, s.offset + m.index), strong ? 'high' : 'warning', strong ? 0.75 : 0.6);
      break;
    }
  }
}

/** permission-bypass flags — every file kind. */
function checkBypassFlags(doc: SkillDoc, add: Add): void {
  for (let i = 0; i < doc.lines.length; i++) {
    const text = doc.lines[i]!;
    const m = BYPASS_FLAG_RE.exec(text);
    if (!m) continue;
    if (doc.kind === 'instructions' && isNegated(text, m.index)) continue;
    add('permission-bypass', i + 1, excerpt(text, m.index), 'warning', 0.7);
  }
}

const EMOJI_OR_SCRIPT_RE = /\p{Extended_Pictographic}|\p{Emoji_Modifier}|\uFE0F|\u20E3/u;

function isContextualJoiner(chars: string[], idx: number): boolean {
  const neighbor = (ch: string | undefined) =>
    ch !== undefined && (EMOJI_OR_SCRIPT_RE.test(ch) || (/\p{L}|\p{M}/u.test(ch) && ch.codePointAt(0)! > 0x7f));
  return neighbor(chars[idx - 1]) || neighbor(chars[idx + 1]);
}

function isFlagTagSequence(chars: string[], idx: number): boolean {
  let j = idx;
  while (j > 0 && invisibleClass(chars[j - 1]!.codePointAt(0)!) === 'tag') j--;
  return j > 0 && chars[j - 1]!.codePointAt(0) === 0x1f3f4; // \u{1F3F4} subdivision flags
}

/** hidden-unicode — every file kind. */
function checkHiddenUnicode(doc: SkillDoc, add: Add): void {
  for (let i = 0; i < doc.lines.length; i++) {
    const chars = Array.from(doc.lines[i]!);
    const found = new Map<number, number>();
    let severe = false;
    for (let k = 0; k < chars.length; k++) {
      const cp = chars[k]!.codePointAt(0)!;
      const cls = invisibleClass(cp);
      if (!cls) continue;
      if (cp === 0xfeff && i === 0 && k === 0) continue; // BOM
      if ((cp === 0x200c || cp === 0x200d) && isContextualJoiner(chars, k)) continue;
      if (cls === 'tag' && isFlagTagSequence(chars, k)) continue;
      if (cls !== 'zero-width') severe = true;
      found.set(cp, (found.get(cp) ?? 0) + 1);
    }
    if (found.size === 0) continue;
    const summary = [...found.entries()]
      .sort((a, b) => a[0] - b[0])
      .slice(0, 4)
      .map(([cp, n]) => `${codepointLabel(cp)}×${n}`)
      .join(' ');
    add('hidden-unicode', i + 1, `${summary} in: ${excerpt(doc.lines[i]!)}`, severe ? 'high' : 'warning', severe ? 0.9 : 0.7);
  }
}

/** hidden-html-comment, hidden-html-element, encoded-blob — instruction files. */
function checkHiddenMarkup(doc: SkillDoc, add: Add): void {
  const blanked = blankCodeBlockLines(doc.content.replace(/\r\n/g, '\n'));
  const commentRe = /<!--([\s\S]*?)-->/g;
  let m: RegExpExecArray | null;
  while ((m = commentRe.exec(blanked)) !== null) {
    const body = m[1] ?? '';
    if (BENIGN_COMMENT_RE.test(body)) continue;
    const hit = AGENT_DIRECTED_RE.exec(body);
    if (!hit) continue;
    const offset = m.index + 4 + hit.index;
    const line = blanked.slice(0, offset).split('\n').length;
    add('hidden-html-comment', line, excerpt(doc.lines[line - 1] ?? body, hit.index), 'warning', 0.6);
  }

  const blankedLines = blanked.split('\n');
  for (let i = 0; i < blankedLines.length; i++) {
    const text = blankedLines[i]!;
    const el = HIDDEN_ELEMENT_RE.exec(text);
    if (el) add('hidden-html-element', i + 1, excerpt(text, el.index), 'warning', 0.6);
  }

  for (let i = 0; i < doc.lines.length; i++) {
    const text = doc.lines[i]!;
    for (const b of text.matchAll(BLOB_RE)) {
      const blob = b[0];
      const idx = b.index ?? 0;
      if (/(?:base64,|data:[^,\s]*,)\s*$/i.test(text.slice(0, idx))) continue; // data: URI
      if (!/[0-9]/.test(blob) || !/[A-Z]/.test(blob) || !/[a-z]/.test(blob)) continue;
      if ((blob.match(/\//g)?.length ?? 0) > blob.length / 10) continue; // a long path, not a payload
      add('encoded-blob', i + 1, `${blob.length}-char encoded string: ${blob.slice(0, 40)}…`, 'warning', 0.5);
      break;
    }
  }
}

/**
 * The text a reader is meant to *run*: every line of a script, but only fenced
 * blocks and inline `code spans` of an instruction file — prose such as "npm
 * install and then run tests/foo.js" must not be parsed as a command line.
 */
function commandTexts(doc: SkillDoc): Array<{ text: string; line: number }> {
  if (doc.kind !== 'instructions') return logicalLines(doc.lines);
  const blanked = blankCodeBlockLines(doc.content.replace(/\r\n/g, '\n')).split('\n');
  const out: Array<{ text: string; line: number }> = [];
  for (const logical of logicalLines(doc.lines)) {
    const i = logical.line - 1;
    const fenced = (blanked[i] ?? '') === '' && (doc.lines[i] ?? '').trim() !== '';
    if (fenced) {
      out.push(logical);
      continue;
    }
    for (const span of logical.text.matchAll(/`([^`\n]+)`/g)) out.push({ text: span[1]!, line: logical.line });
  }
  return out;
}

/** unpinned-remote-dep — command text in every file, plus bundled manifests. */
function checkUnpinned(doc: SkillDoc, consumed: Set<number>, add: Add): void {
  const hit = (line: number, text: string, index: number, confidence = 0.6) =>
    add('unpinned-remote-dep', line, excerpt(text, index), 'warning', confidence);

  if (doc.kind === 'manifest') {
    checkManifest(doc, hit);
    return;
  }

  for (const { text, line } of commandTexts(doc)) {
    if (consumed.has(line)) continue;

    if (INSTALL_CTX_RE.test(text)) {
      let flagged = false;
      for (const g of text.matchAll(GIT_SOURCE_RE)) {
        if (!isPinnedRef(gitSourceRef(g[0]))) { hit(line, text, g.index ?? 0); flagged = true; break; }
      }
      if (flagged) continue;
    }

    const latest = LATEST_RE.exec(text);
    if (latest) { hit(line, text, latest.index, 0.5); continue; }

    const npm = NPM_INSTALL_RE.exec(text);
    if (npm) {
      const tokens = (npm[1] ?? '').trim().split(/\s+/).filter((t) => t && !t.startsWith('-'));
      const bad = tokens.find((t) =>
        !t.startsWith('@') && !t.startsWith('.') && !t.startsWith('/') && !t.startsWith('file:') &&
        !/\.(?:js|mjs|cjs|ts|json|md|sh|py|txt)$/i.test(t) &&
        (/^[A-Za-z0-9][\w.-]*\/[\w.-]+(?:#\S*)?$/.test(t) || /^https?:\/\//i.test(t)) &&
        isUnpinnedRemoteSpec(t));
      if (bad) { hit(line, text, npm.index); continue; }
    }

    const cargo = CARGO_GIT_RE.exec(text);
    if (cargo && !/--(?:rev|tag)\s+\S+/.test(text)) { hit(line, text, cargo.index); continue; }

    const url = MUTABLE_SCRIPT_URL_RE.exec(text);
    if (url && FETCH_VERB_RE.test(text) && SCRIPTISH_URL_RE.test(url[0])) { hit(line, text, url.index); continue; }

    if (doc.kind === 'script' && doc.lang === 'js') {
      for (const imp of text.matchAll(REMOTE_IMPORT_RE)) {
        const u = imp[1]!;
        if (!/@v?\d+(?:\.\d+)*|@[0-9a-f]{7,40}|\/v?\d+\.\d+\.\d+\//i.test(u)) { hit(line, text, imp.index ?? 0); break; }
      }
    }
  }
}

function checkManifest(doc: SkillDoc, hit: (line: number, text: string, index: number) => void): void {
  const base = path.posix.basename(doc.path);
  if (base === 'package.json') {
    let parsed: unknown;
    try { parsed = JSON.parse(doc.content); } catch { return; }
    if (typeof parsed !== 'object' || parsed === null) return;
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const deps = (parsed as Record<string, unknown>)[section];
      if (typeof deps !== 'object' || deps === null) continue;
      for (const [name, spec] of Object.entries(deps as Record<string, unknown>)) {
        if (typeof spec !== 'string') continue;
        const s = spec.trim();
        if (s === '' || s === '*' || s === 'latest' || isUnpinnedRemoteSpec(s)) {
          const line = lineOf(doc.content, `"${name}"`);
          hit(line, doc.lines[line - 1] ?? `"${name}": "${spec}"`, 0);
        }
      }
    }
    return;
  }
  // requirements*.txt
  for (let i = 0; i < doc.lines.length; i++) {
    const text = doc.lines[i]!.replace(/\s+#.*$/, '');
    const g = /\bgit\+[a-z]+:\/\/\S+/i.exec(text);
    if (g && !isPinnedRef(gitSourceRef(g[0]))) { hit(i + 1, text, g.index); continue; }
    const u = /\bhttps?:\/\/\S+\.(?:zip|tar\.gz|tgz|whl)\S*/i.exec(text);
    if (u && !/\d+\.\d+|#sha256=/i.test(u[0])) hit(i + 1, text, u.index);
  }
}

const CONFIG_FENCE_LANGS: ReadonlySet<string> = new Set(['json', 'jsonc', 'json5', 'yaml', 'yml', 'toml']);

/**
 * missing-script — script invocations in the SKILL.md that resolve nowhere.
 * Bundled reference docs are not checked: they are where skills keep worked
 * examples of scripts the *reader* would write, which never exist.
 */
function checkMissingScripts(
  repoRoot: string,
  skill: Skill,
  doc: SkillDoc,
  alreadyReported: ReadonlySet<string>,
  add: Add,
): void {
  const pluginRoot = /^(.*?)\/?skills\/[^/]+$/.exec(skill.dir)?.[1];
  const resolveCandidates = (raw: string): string[] | undefined => {
    let ref = raw;
    let bases: string[];
    const varMatch = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?\/(.*)$/.exec(ref);
    if (varMatch) {
      const name = varMatch[1]!;
      ref = varMatch[2]!;
      if (name === 'CLAUDE_SKILL_DIR' || name === 'SKILL_DIR') bases = [skill.dir];
      else if (name === 'CLAUDE_PLUGIN_ROOT' && pluginRoot !== undefined) bases = [pluginRoot || '.'];
      else if (name === 'CLAUDE_PROJECT_DIR') bases = ['.'];
      else return undefined; // an unknown variable — cannot resolve statically
    } else if (ref.startsWith('{baseDir}/')) {
      ref = ref.slice('{baseDir}/'.length);
      bases = [skill.dir];
    } else {
      // A bare `manage.py` usually names a file in the *user's* project, not the
      // skill — only paths with a directory segment are checked.
      ref = ref.replace(/^\.\//, '');
      if (!ref.includes('/')) return undefined;
      bases = [...new Set([skill.dir, ...(pluginRoot ? [pluginRoot] : []), '.'])];
    }
    if (!ref || ref.includes('..') || ref.startsWith('/')) return undefined;
    // Build output (`dist/server.js`) is produced later, never bundled.
    if (/^(?:dist|build|out|target|node_modules|\.venv|venv)\//.test(ref)) return undefined;
    return bases.map((b) => (b === '.' ? ref : `${b}/${ref}`));
  };

  const fence = scanFencedLines(doc.content.replace(/\r\n/g, '\n'));
  for (let i = 0; i < doc.lines.length; i++) {
    const text = doc.lines[i]!;
    // A `"command": "bash …"` inside a JSON/YAML example is sample config, not an instruction to run.
    if (fence[i]?.inFence && CONFIG_FENCE_LANGS.has(fence[i]!.lang)) continue;
    for (const re of [INVOKE_RE, DIRECT_EXEC_RE]) {
      for (const m of text.matchAll(re)) {
        const raw = m[1]!;
        const bare = raw.replace(/^\.\//, '');
        if (alreadyReported.has(bare) || alreadyReported.has(raw)) continue;
        const candidates = resolveCandidates(raw);
        if (!candidates) continue;
        if (candidates.some((c) => isFileWithinRoot(repoRoot, c))) continue;
        add('missing-script', i + 1, `\`${raw}\` not found (looked in: ${candidates.join(', ')})`, 'warning', 0.6);
      }
    }
  }
}

// ── Detector ──────────────────────────────────────────────────────────────────

function loadDoc(repoRoot: string, relPath: string, isSkillMd: boolean): SkillDoc | undefined {
  const content = readTextWithinRoot(repoRoot, relPath);
  if (content === undefined) return undefined;
  const cls = isSkillMd ? { kind: 'instructions' as const, lang: 'other' as const } : classify(relPath, content);
  if (!cls) return undefined;
  const lines = content.split(/\r?\n/);
  return { path: relPath, ...cls, content, lines, frontmatterEnd: isSkillMd ? frontmatterEnd(lines) : 0 };
}

function collectSkills(context: RepoContext): Skill[] {
  const skills: Skill[] = [];
  const audited = new Set(context.aiConfig.skills);
  const dirs = context.aiConfig.allSkills.map((s) => path.posix.dirname(s));
  const owner = (file: string): number => {
    let best = -1;
    dirs.forEach((dir, idx) => {
      if (dir !== '.' && file.startsWith(`${dir}/`) && (best < 0 || dir.length > dirs[best]!.length)) best = idx;
    });
    return best;
  };
  const bundled = new Map<number, string[]>();
  for (const file of context.aiConfig.skillFiles) {
    const idx = owner(file);
    if (idx < 0) continue;
    const list = bundled.get(idx) ?? [];
    list.push(file);
    bundled.set(idx, list);
  }
  context.aiConfig.allSkills.forEach((skillMd, idx) => {
    const main = loadDoc(context.repoRoot, skillMd, true);
    if (!main) return;
    const docs = [main];
    for (const file of bundled.get(idx) ?? []) {
      const doc = loadDoc(context.repoRoot, file, false);
      if (doc) docs.push(doc);
    }
    skills.push({ skillMd, dir: dirs[idx]!, docs, structurallyAudited: audited.has(skillMd) });
  });
  return skills;
}

/** Scan one skill (its SKILL.md and bundled files) for supply-chain risk. */
function scanSkill(repoRoot: string, skill: Skill): PromptCiIssue[] {
  const collector = new HitCollector();
  // Refs the structural detector already flags when missing — don't report them twice.
  const alreadyReported = new Set(
    skill.structurallyAudited ? extractFileRefs(skill.docs[0]!.content).map((r) => r.ref) : [],
  );

  for (const doc of skill.docs) {
    const add: Add = (rule, line, excerptText, severity, confidence) => {
      const where = doc.frontmatterEnd > 0 && line <= doc.frontmatterEnd ? '(frontmatter) ' : '';
      collector.add(rule, doc.path, { line, excerpt: `${where}${excerptText}`, severity, confidence });
    };

    checkHiddenUnicode(doc, add);
    checkBypassFlags(doc, add);
    if (doc.kind === 'manifest') {
      checkUnpinned(doc, new Set(), add);
      continue;
    }
    const consumed = checkExec(doc, add);
    checkUnpinned(doc, consumed, add);
    if (doc.kind === 'script') {
      checkScript(doc, consumed, add);
    } else {
      checkProse(doc, add);
      checkHiddenMarkup(doc, add);
      if (doc === skill.docs[0]) checkMissingScripts(repoRoot, skill, doc, alreadyReported, add);
    }
  }

  return collector.toIssues(skill.skillMd);
}

export function detectSkillSupplyChain(context: RepoContext): PromptCiIssue[] {
  const issues = collectSkills(context).flatMap((skill) => scanSkill(context.repoRoot, skill));
  // Scanner-form paths so inline suppressions can match (see withScannerPaths).
  return withScannerPaths(context.repoRoot, issues);
}
