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
 *                          (`curl … | bash`, `| /usr/bin/env bash`, `| tee f
 *                          | sh`, `bash <(curl …)`, `iwr … | iex`,
 *                          download-then-`sh` without a checksum/signature
 *                          check)                                        high
 *   encoded-exec           decode-then-execute (`base64 -d | sh`, `xxd -r -p
 *                          | sh`, `eval(atob(…))`, `powershell -enc <b64>`) high
 *   remote-eval            eval of fetched code on one line (also in SKILL.md
 *                          code), or a bundled script that both evaluates
 *                          dynamic code (eval/exec/new Function/iex, dynamic
 *                          require/import, pickle.loads) AND makes network
 *                          calls                                         high
 *   dynamic-eval           eval/exec/new Function/iex with no network call
 *                          in the same script                            warning
 *   credential-exfil       a bundled script/config that reads credential
 *                          stores or dumps the whole environment AND makes
 *                          network calls                                 high
 *   exfil-instruction      prose telling the agent to send/upload secrets to
 *                          a destination                         high / warning
 *   instruction-override   prompt-injection text ("ignore previous
 *                          instructions", chat-template role tokens)     high
 *   conceal-from-user      prose hiding actions from the user    high / warning
 *   permission-bypass      flags/prose that disable permission or safety
 *                          prompts (`--dangerously-skip-permissions`)    warning
 *   hidden-unicode         Unicode tag characters and bidi controls (high);
 *                          zero-width/format characters, control characters,
 *                          fillers, runs of variation selectors (warning)
 *   hidden-html-comment    agent-directed text inside an HTML comment, which
 *                          a rendered preview hides but the agent reads  warning
 *   hidden-html-element    text hidden by `display:none`/`hidden`        warning
 *   encoded-blob           a large base64 blob in instruction text       warning
 *   unpinned-remote-dep    a remote dependency with no pinned version (git
 *                          URL without a commit/tag, `@latest`, a script
 *                          fetched from a branch)                        warning
 *   missing-script         the SKILL.md invokes a script that is not bundled
 *                          and not in the repo              warning, ai_config
 *   unscanned-files        files this scan could not fully read (over the
 *                          per-skill file cap, or larger than 500 KB) —
 *                          named, never silently dropped                  info
 *
 * Which files are read: every SKILL.md, markdown/text references, scripts (by
 * extension or shebang), manifests (package.json, requirements*.txt),
 * config-like text (Makefile, Dockerfile, YAML/JSON/TOML/HTML/XML/INI) and
 * extensionless text files. Other extensions (images, fonts, data) are assets
 * and are not read. A stray NUL does not make a text file "binary" here: it is
 * scanned, and the NUL is reported by hidden-unicode.
 *
 * Hostile input: every pattern uses bounded quantifiers and is run over lines
 * in overlapping 2000-character windows, backslash/pipe continuation joins are
 * capped, HTML comments are found with an indexOf walk, and each rule stops
 * collecting after a fixed number of matches per file — so a pathological
 * skill file costs linear time. (A wall-clock budget is deliberately NOT used:
 * detector output must not depend on the clock.)
 *
 * False-positive controls (the heuristics are deliberately conservative — a
 * rule that fires on healthy skills is worse than no rule):
 *
 *  - Outside fenced code blocks (prose, inline code, table cells), a match is
 *    skipped when negated earlier in its sentence ("never pipe curl into
 *    bash"; a bare "not" does not count), when the sentence discusses the
 *    behavior rather than directing it ("this skill detects `curl | bash`",
 *    "Bad: …", "block network calls without user consent"), and — for
 *    injection text — when the phrase is quoted. Fenced code is judged as
 *    written. Bypass flags in a markdown table row are documentation.
 *  - A single named API key read from the environment and sent to an API is
 *    the normal shape of an API-calling skill and is NOT flagged; only bulk
 *    environment dumps and credential-store reads count as a secret source.
 *    Prose sending one key/token/password is flagged only toward a paste,
 *    webhook or explicitly external/attacker destination, never "in the
 *    Authorization header"; bulk secrets (.env, env vars, SSH keys) toward any
 *    URL or server are a warning.
 *  - A download chained with a checksum/signature check (`sha256sum -c`,
 *    `gpg --verify`, `cosign verify`) is not remote-exec.
 *  - Dynamic require/import is only suspicious alongside network access; on
 *    its own it is the usual `require(path.join(__dirname, …))`.
 *  - Zero-width joiners inside emoji and non-Latin scripts, a single
 *    variation selector after a non-ASCII character, emoji flag tag
 *    sequences, directional marks in RTL text, a leading BOM, and `data:` URIs
 *    are ignored.
 *  - `npx some-tool` with no version is not flagged (too common to be signal);
 *    an explicit `@latest` or an unpinned git/tarball source is. In markdown,
 *    install commands are only read from code fences and inline code spans.
 *  - missing-script reads only the SKILL.md (reference docs hold worked
 *    examples of scripts the reader would write), ignores JSON/YAML/TOML
 *    example fences, bare filenames (`python manage.py` names the user's
 *    project), build output paths and unknown `$VARS`, and accepts a script
 *    found in the skill directory, the plugin root, or the repo root.
 *  - One finding per rule per file: repeated matches add evidence and
 *    locations, not extra score deductions (and the whole family shares one
 *    deduction cap, see health-score.ts).
 *
 * Findings list the file they were found in (a bundled script, or the SKILL.md)
 * plus the owning SKILL.md in `filePaths`, with `locations` at the exact line.
 * Inline `promptci-ignore` annotations inside a skill directory never suppress
 * these findings (scan.ts): the skill's own text is what is under audit.
 * Evidence quotes the matched text with its repo-relative path; every
 * invisible or control character is shown as `<U+XXXX>` and tag-character
 * payloads are decoded to `<TAGS:"…">`. Line numbers live in `locations` so
 * baseline fingerprints stay stable across edits.
 *
 * No finding is auto-fixable: repairing a skill means changing what it does,
 * which needs a human-reviewed diff.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RepoContext } from './repo-context.js';
import type { IssueCategory, IssueSeverity, PromptCiIssue } from './types.js';
import {
  isFileWithinRoot,
  isSkillContainerDir,
  lineOf,
  resolveWithinRoot,
  shortHash,
  withScannerPaths,
} from './ai-config.js';
import { MAX_FILE_SIZE, BINARY_CHECK_BYTES, isBinary } from './scanner.js';
import { scanFencedLines } from './markdown-fences.js';
import { extractFileRefs } from './skills-detector.js';

/** First entry of every finding's `tags`. */
export const SKILL_SUPPLY_CHAIN_TAG = 'skill-supply-chain';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * instructions: markdown/text the agent reads. script: executable code.
 * manifest: dependency manifests. text: other config-like text (Makefile,
 * Dockerfile, YAML/JSON/HTML…) read for the command/exfil rules only.
 */
type Kind = 'instructions' | 'script' | 'manifest' | 'text';
type Lang = 'js' | 'py' | 'sh' | 'ps' | 'rb' | 'other';

type SkillDoc = {
  /** Repo-relative POSIX path. */
  path: string;
  kind: Kind;
  lang: Lang;
  content: string;
  lines: string[];
  /** Per line: inside a fenced code block (instructions only; all false otherwise). */
  fenced: boolean[];
  /** Per line: the enclosing fence's info string. */
  fenceLang: string[];
  /** Last line of the SKILL.md frontmatter block (0 when none / not a SKILL.md). */
  frontmatterEnd: number;
};

type Skill = {
  /** Repo-relative POSIX path of the SKILL.md. */
  skillMd: string;
  /** Repo-relative POSIX skill directory. */
  dir: string;
  docs: SkillDoc[];
  /** Files that could not be fully scanned, with the reason. */
  unscanned: Array<{ path: string; reason: string }>;
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
  | 'missing-script'
  | 'unscanned-files';

type Hit = {
  line?: number;
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
    title: 'Skill may evaluate code fetched from the network',
    category: 'security',
    summary:
      'code appears to be evaluated dynamically (eval/exec, `new Function`, a dynamic import, or deserialization) ' +
      'alongside network calls — the shape of a remote-code loader.',
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
      'a bundled file reads a credential store (SSH keys, cloud credentials, wallets, the keychain) or dumps ' +
      'the whole environment, and the same file makes network calls — a possible credential-exfiltration path.',
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
      'the file contains characters that do not render — Unicode tag characters and bidi controls can smuggle instructions ' +
      'or reorder text so what a reviewer sees differs from what the agent reads.',
    recommendation:
      'Remove the invisible characters (the evidence shows them as <U+XXXX>, and decodes tag-character payloads) and re-review the affected lines.',
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
  'unscanned-files': {
    title: 'Some skill files were not fully scanned',
    category: 'security',
    summary:
      'the supply-chain scan could not read every file in this skill (it exceeds the per-skill file cap, or a file is larger ' +
      'than 500 KB and only its first 500 KB was read). Content in the unread part was not checked.',
    recommendation:
      'Review the listed files by hand, or trim the skill (unused assets, generated files) so it can be scanned in full.',
  },
};

// ── File classification ───────────────────────────────────────────────────────

const INSTRUCTION_EXT: ReadonlySet<string> = new Set(['md', 'mdx', 'markdown', 'txt']);
const TEXT_EXT: ReadonlySet<string> = new Set([
  'yml', 'yaml', 'json', 'jsonc', 'json5', 'toml', 'ini', 'cfg', 'conf', 'html', 'htm', 'xhtml', 'xml', 'svg',
]);
const SCRIPT_EXT: Record<string, Lang> = {
  sh: 'sh', bash: 'sh', zsh: 'sh', ksh: 'sh', fish: 'sh', command: 'sh',
  js: 'js', mjs: 'js', cjs: 'js', ts: 'js', mts: 'js', cts: 'js', jsx: 'js', tsx: 'js',
  py: 'py', pyw: 'py',
  rb: 'rb',
  ps1: 'ps', psm1: 'ps',
  pl: 'other', php: 'other', lua: 'other', bat: 'other', cmd: 'other',
};

type Classified = { kind: Kind; lang: Lang };

/** Classify by name alone; 'probe' means "extensionless — sniff the first bytes". */
function classifyByName(relPath: string): Classified | 'probe' | undefined {
  const base = path.posix.basename(relPath);
  if (base === 'package.json' || /^requirements[\w.-]*\.txt$/i.test(base)) return { kind: 'manifest', lang: 'other' };
  if (/^(?:GNU)?makefile$/i.test(base) || /^(?:Dockerfile|Containerfile|Justfile)(?:\..+)?$/i.test(base)) {
    return { kind: 'text', lang: 'sh' };
  }
  const ext = /\.([a-z0-9]+)$/i.exec(base)?.[1]?.toLowerCase();
  const hasExt = ext !== undefined && base.lastIndexOf('.') > 0;
  if (!hasExt) return 'probe';
  if (INSTRUCTION_EXT.has(ext)) return { kind: 'instructions', lang: 'other' };
  if (SCRIPT_EXT[ext]) return { kind: 'script', lang: SCRIPT_EXT[ext]! };
  if (ext === 'mk' || ext === 'dockerfile') return { kind: 'text', lang: 'sh' };
  if (TEXT_EXT.has(ext)) return { kind: 'text', lang: 'other' };
  return undefined; // assets and data — not read
}

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

function frontmatterEnd(lines: string[]): number {
  if ((lines[0] ?? '').replace(/^\u{FEFF}/u, '').trim() !== '---') return 0;
  for (let i = 1; i < lines.length && i < 500; i++) {
    if (/^(?:---|\.\.\.)[ \t]*$/.test(lines[i]!)) return i + 1;
  }
  return 0;
}

// ── Text helpers ──────────────────────────────────────────────────────────────

const INVISIBLE_CATEGORY_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}]/u;

/** Anything that does not render as itself: shown as `<U+XXXX>` in evidence and paths. */
function isDisplayHidden(ch: string, cp: number): boolean {
  return INVISIBLE_CATEGORY_RE.test(ch) ||
    cp === 0x2028 || cp === 0x2029 || cp === 0x3164 || cp === 0xffa0 || cp === 0x115f || cp === 0x1160 ||
    cp === 0x034f || cp === 0x17b4 || cp === 0x17b5 ||
    (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef) || (cp >= 0x180b && cp <= 0x180f);
}

function codepointLabel(cp: number): string {
  return `<U+${cp.toString(16).toUpperCase().padStart(4, '0')}>`;
}

/**
 * Render `text` safely for evidence/summaries: every invisible, control or
 * format character becomes `<U+XXXX>` (tab excepted), and a run of Unicode tag
 * characters is decoded to its ASCII payload as `<TAGS:"…">`.
 */
function visible(text: string): string {
  let out = '';
  let tags = '';
  const flush = () => {
    if (tags) out += `<TAGS:"${tags}">`;
    tags = '';
  };
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0xe0000 && cp <= 0xe007f) {
      tags += cp >= 0xe0020 && cp <= 0xe007e ? String.fromCharCode(cp - 0xe0000) : codepointLabel(cp);
      continue;
    }
    flush();
    if (cp === 0x09 || (cp >= 0x20 && cp < 0x7f)) out += ch;
    else out += isDisplayHidden(ch, cp) ? codepointLabel(cp) : ch;
  }
  flush();
  return out;
}

/** A display-safe path: invisibles shown, wrapped in a code span nothing can break out of. */
function displayPath(p: string): string {
  const safe = visible(p);
  const longestRun = Math.max(0, ...(safe.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longestRun + 1);
  return `${fence}${safe}${fence}`;
}

/**
 * A display excerpt of `text` around the match at `index`. The window is cut
 * from the RAW string first (so padding before a payload cannot push it out
 * of view), then sanitized and whitespace-collapsed.
 */
function excerpt(text: string, index = 0, length = 0): string {
  const from = Math.max(0, index - 40);
  const to = Math.min(text.length, from + 220, index + Math.max(0, length) + 60);
  const shown = visible(text.slice(from, to)).replace(/\s+/g, ' ').trim();
  return `${from > 0 ? '…' : ''}${shown}${to < text.length ? '…' : ''}`;
}

/** Longest line segment a pattern ever sees; long lines are scanned in overlapping windows. */
const MAX_SCAN_WINDOW = 2000;
const WINDOW_OVERLAP = 600;

type Found = { index: number; match: RegExpExecArray };

/** First match of a NON-global `re` in `text`, windowed so every pattern stays linear. */
function findFirst(re: RegExp, text: string, requires?: (window: string) => boolean): Found | undefined {
  if (text.length <= MAX_SCAN_WINDOW) {
    if (requires && !requires(text)) return undefined;
    const m = re.exec(text);
    return m ? { index: m.index, match: m } : undefined;
  }
  for (let start = 0; start < text.length; start += MAX_SCAN_WINDOW - WINDOW_OVERLAP) {
    const window = text.slice(start, start + MAX_SCAN_WINDOW);
    const m = requires && !requires(window) ? null : re.exec(window);
    if (m) return { index: start + m.index, match: m };
    if (start + MAX_SCAN_WINDOW >= text.length) break;
  }
  return undefined;
}

/** Every match of a GLOBAL `re` in `text` (windowed, de-duplicated by position), up to `limit`. */
function findAll(re: RegExp, text: string, limit = 50): Found[] {
  const out: Found[] = [];
  if (text.length <= MAX_SCAN_WINDOW) {
    for (const m of text.matchAll(re)) {
      out.push({ index: m.index ?? 0, match: m });
      if (out.length >= limit) break;
    }
    return out;
  }
  const seen = new Set<number>();
  for (let start = 0; start < text.length || start === 0; start += MAX_SCAN_WINDOW - WINDOW_OVERLAP) {
    for (const m of text.slice(start, start + MAX_SCAN_WINDOW).matchAll(re)) {
      const index = start + (m.index ?? 0);
      if (seen.has(index)) continue;
      seen.add(index);
      out.push({ index, match: m });
      if (out.length >= limit) return out;
    }
    if (start + MAX_SCAN_WINDOW >= text.length) break;
  }
  return out;
}

const MAX_JOINED_LINES = 20;
const MAX_JOINED_CHARS = 4000;

/**
 * Join continued lines so a `curl … \` / `| bash` split, or a pipe at the end
 * of one line and the shell on the next, is one command. Backslash joins apply
 * everywhere; trailing `|`/`&&`/`||` joins only in scripts and fenced code
 * (a markdown table row also ends in `|`). Joins are capped so a file of
 * 16k continued lines cannot become one giant string.
 */
function logicalLines(doc: SkillDoc): Array<{ text: string; line: number }> {
  const out: Array<{ text: string; line: number }> = [];
  let buf = '';
  let start = 0;
  let joined = 0;
  for (let i = 0; i < doc.lines.length; i++) {
    const l = doc.lines[i]!;
    if (buf === '') {
      start = i + 1;
      joined = 0;
    }
    const trimmed = l.trimEnd();
    const backslash = trimmed.endsWith('\\') && !trimmed.endsWith('\\\\');
    const operator = (doc.kind !== 'instructions' || doc.fenced[i]) &&
      (trimmed.endsWith('|') || trimmed.endsWith('&&'));
    if ((backslash || operator) && joined < MAX_JOINED_LINES && buf.length + l.length < MAX_JOINED_CHARS) {
      buf += `${backslash ? trimmed.slice(0, -1) : trimmed} `;
      joined++;
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
 * skill describing what to block, a "Bad:" example, docs listing unsupported
 * flows. Not applied inside fenced code.
 */
const DISCUSSION_RE =
  /\b(?:prevent\w*|block(?:s|ed|ing)?|detect\w*|den(?:y|ies|ied)|reject\w*|flag(?:s|ged)?|forbid\w*|prohibit\w*|dangerous|malicious|attack(?:s|er|ers)?|unsafe|insecure|risk(?:s|y)?|(?:not|un)\s*supported|vulnerab\w*|exploit\w*|injection|bad|wrong|incorrect|anti-?pattern|avoid(?:s|ed|ing)?)\b/i;

/**
 * Sentences of a line with their offsets. Splits only on terminal punctuation
 * followed by whitespace, so `.env`, URLs and `x.sh` stay inside their sentence.
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

/** URLs are stripped first — a host named `attacker.example` is not discussion. */
function discusses(sentence: string): boolean {
  return DISCUSSION_RE.test(sentence.slice(0, MAX_SCAN_WINDOW).replace(/\bhttps?:\/\/\S+/gi, ' '));
}

function isDiscussion(line: string, index: number): boolean {
  const sentence = sentences(line).find((s) => index >= s.offset && index < s.offset + s.text.length);
  return discusses(sentence?.text ?? line);
}

/** The match sits inside a double-quoted, curly-quoted or backticked span. */
function isQuoted(line: string, start: number, end: number): boolean {
  const before = line.slice(Math.max(0, start - MAX_SCAN_WINDOW), start);
  const after = line.slice(end, end + MAX_SCAN_WINDOW);
  for (const q of ['"', '`']) {
    const count = before.split(q).length - 1;
    if (count % 2 === 1 && after.includes(q)) return true;
  }
  return before.lastIndexOf('\u{201C}') > before.lastIndexOf('\u{201D}') && after.includes('\u{201D}');
}

function isTableRow(line: string): boolean {
  return line.trimStart().startsWith('|');
}

// ── Pattern tables (every quantifier bounded) ─────────────────────────────────

const FETCH_CMD = String.raw`(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|aria2c|downloadstring|downloadfile)`;
/** Interpreters that execute whatever arrives on stdin when given no script argument. */
const STDIN_INTERP = String.raw`(?:python[0-9.]{0,5}|node|perl|ruby|php|deno|bun)(?=\s{0,5}$|\s{1,5}-(?:\s|$)|\s{0,5}[;&|)\x60'"])`;
/** A shell (optionally by path, optionally via `env`) or a stdin-reading interpreter. */
const SHELL_TARGET = String.raw`(?:[\w.\/-]{0,40}\/)?(?:env\s{1,5}(?:-\S{1,20}\s{1,5}){0,3})?(?:(?:ba|z|k|da|fi)?sh\b|${STDIN_INTERP})`;
const PIPE_PREFIX = String.raw`\|\s{0,5}(?:sudo\s{1,5}(?:-\S{1,20}\s{1,5}){0,5})?(?:env\s{1,5}(?:[^\s=]{1,40}=\S{0,200}\s{1,5}){0,5})?(?:xargs\s{1,5}(?:-\S{1,20}\s{1,5}){0,4})?`;

/**
 * A pattern plus a cheap prefilter every scanned window must pass first. A
 * window without the prefilter's token cannot match, so hostile filler (a
 * megabyte of `curl `) costs one linear scan instead of a backtracking one.
 */
type Guarded = { requires: (window: string) => boolean; pattern: RegExp };

const REMOTE_EXEC_PATTERNS: Guarded[] = [
  // bash <(curl …)   /   source <(wget …)
  {
    requires: (w) => w.includes('<('),
    pattern: /(?:^|[\s;&|(`])(?:(?:[\w./-]{0,40}\/)?(?:ba|z|k)?sh|source|\.)\s{1,5}<\(\s{0,5}(?:curl|wget)\b/i,
  },
  // sh -c "$(curl …)"   /   eval "$(wget …)"   /   python -c "$(curl …)"
  {
    requires: (w) => w.includes('$(') || w.includes('`'),
    pattern: /\b(?:(?:ba|z|k)?sh\s{1,5}-c|eval|python[0-9.]{0,5}\s{1,5}-c|node\s{1,5}-e|perl\s{1,5}-e|ruby\s{1,5}-e)\s{1,5}["']?(?:\$\(|`)\s{0,5}(?:curl|wget)\b/i,
  },
  // iex (iwr …)   /   Invoke-Expression ((New-Object Net.WebClient).DownloadString(…))
  {
    requires: (w) => /iwr|irm|invoke-web|invoke-rest|downloadstring|webclient/i.test(w),
    pattern: /\b(?:iex|invoke-expression)\b[^\n]{0,120}\b(?:iwr|irm|invoke-webrequest|invoke-restmethod|downloadstring|net\.webclient)\b/i,
  },
];

// `curl … | bash`, `curl … | tee f | sh`, `iwr … | iex` — matched by splitting
// on pipes (see pipeToShell) so the cost is linear however hostile the line.
const FETCH_IN_STAGE_RE = new RegExp(String.raw`\b${FETCH_CMD}\b`, 'i');
const SHELL_STAGE_RE = new RegExp(
  String.raw`^${PIPE_PREFIX.replace(/^\\\|/, '')}(?:${SHELL_TARGET}|iex\b|invoke-expression\b|pwsh\b|powershell\b)`,
  'i',
);
/** Pipeline stages between the fetch and the shell (`| tee f | sh`). */
const MAX_PIPE_HOPS = 4;

function pipeToShell(text: string): Found | undefined {
  if (!text.includes('|')) return undefined;
  const stages = text.split('|');
  let offset = 0;
  for (let s = 0; s < stages.length - 1; s++) {
    const stage = stages[s]!;
    // Only the command actually feeding the pipe: `curl -o f URL; cat f | sh` pipes `cat`, not `curl`.
    const cmdStart = Math.max(stage.lastIndexOf(';'), stage.lastIndexOf('&&'), stage.lastIndexOf('\n')) + 1;
    const fetch = FETCH_IN_STAGE_RE.exec(stage.slice(cmdStart));
    if (fetch) fetch.index += cmdStart;
    if (fetch) {
      for (let hop = 1; hop <= MAX_PIPE_HOPS && s + hop < stages.length; hop++) {
        const next = stages[s + hop]!;
        if (next === '') break; // `||` — a different command, not a pipe
        const shell = SHELL_STAGE_RE.exec(next.slice(0, 400));
        if (shell) {
          const index = offset + fetch.index;
          const end = offset + stages.slice(s, s + hop).reduce((n, st) => n + st.length + 1, 0) + shell[0].length;
          const match = Object.assign([text.slice(index, end)], { index, input: text, groups: undefined }) as RegExpExecArray;
          return { index, match };
        }
      }
    }
    offset += stage.length + 1;
  }
  return undefined;
}

/** `curl -o x.sh URL && bash x.sh` — checked procedurally (see downloadThenRun). */
const DOWNLOAD_FETCH_RE = /\b(?:curl|wget)\b/gi;
const THEN_RUN_RE = new RegExp(String.raw`(?:&&|;)\s{0,5}(?:sudo\s{1,5})?(?:[\w.\/-]{0,40}\/)?(?:ba|z)?sh\s{1,5}[^\s-]`, 'i');

/** A download that is verified before it runs is not "remote exec". */
const VERIFY_RE =
  /\b(?:sha(?:1|224|256|384|512)sum\b[^|;&\n]{0,80}(?:-c\b|--check\b)|shasum\b[^|;&\n]{0,80}(?:-c\b|--check\b)|gpgv?\b[^|;&\n]{0,80}--verify\b|cosign\s{1,5}verify|minisign\s{1,5}-V\b|slsa-verifier\b|openssl\s{1,5}dgst\b[^|;&\n]{0,80}-verify\b)/i;

const ENCODED_EXEC_PATTERNS: Guarded[] = [
  {
    requires: (w) => w.includes('|') && /base64\s{1,5}(?:-d|--decode|-D)\b/i.test(w),
    pattern: new RegExp(String.raw`\bbase64\s{1,5}(?:-d|--decode|-D)\b[^\n|]{0,300}${PIPE_PREFIX}${SHELL_TARGET}`, 'i'),
  },
  {
    requires: (w) => w.includes('|') && /\bxxd\b/i.test(w),
    pattern: new RegExp(String.raw`\bxxd\s{1,5}(?:-\S{1,10}\s{1,5}){0,3}?-r\b[^\n|]{0,300}${PIPE_PREFIX}${SHELL_TARGET}`, 'i'),
  },
  {
    requires: (w) => /atob|Buffer\.from|b64decode|decodebytes|codecs\.decode|FromBase64String/i.test(w),
    pattern: /\b(?:eval|exec|Function|Invoke-Expression|iex)\s{0,5}\(?\s{0,5}(?:atob|Buffer\.from|base64\.b64decode|b64decode|base64\.decodebytes|codecs\.decode|\[(?:System\.)?Convert\]::FromBase64String)\b/i,
  },
  {
    requires: (w) => /\s-(?:e|ec|enc|encodedcommand)\s{1,5}[A-Za-z0-9+/]{20}/i.test(w) && /powershell|pwsh/i.test(w),
    pattern: /\b(?:powershell|pwsh)(?:\.exe)?\b[^\n]{0,300}\s-(?:e|ec|enc|encodedcommand)\s{1,5}[A-Za-z0-9+/]{20,}/i,
  },
];

/** Direct eval-of-fetch on one line: remote-eval without needing file context. */
const DIRECT_REMOTE_EVAL_RE =
  /\b(?:eval|exec|Function)\s{0,5}\(\s{0,5}(?:await\s{1,5})?\(?\s{0,5}(?:await\s{1,5})?(?:fetch|requests\.get|urlopen|urllib\.request\.urlopen|http\.get)\s{0,5}\(/i;

/** Strong dynamic evaluation, per language. */
const EVAL_PATTERNS: Partial<Record<Lang, RegExp[]>> = {
  js: [
    /(?<![.\w$])eval\s{0,5}\(/,
    /\bnew\s{1,5}Function\s{0,5}\(/,
    /\bvm\.(?:runInNewContext|runInThisContext|runInContext|compileFunction)\s{0,5}\(|\bnew\s{1,5}vm\.Script\s{0,5}\(/,
  ],
  py: [/(?<![.\w])(?:exec|eval)\s{0,5}\(/],
  sh: [/(?:^|[\s;&|(])eval\s{1,5}\S/],
  ps: [/\b(?:Invoke-Expression|iex)\b/i],
  rb: [/(?<![.\w])eval\s{0,5}[( ]/],
};

/** Dynamic loading that is only suspicious next to network access. */
const DYNAMIC_LOAD_PATTERNS: Partial<Record<Lang, RegExp[]>> = {
  js: [
    /(?<![.\w$])require\s{0,5}\(\s{0,5}(?!['"][^'"\n]{0,300}['"]\s{0,5}\))[^)\s]/,
    /(?<![.\w$])import\s{0,5}\(\s{0,5}(?!['"][^'"\n]{0,300}['"]\s{0,5}\))[^)\s]/,
  ],
  py: [
    /(?<![.\w])__import__\s{0,5}\(\s{0,5}(?!['"])/,
    /\bimportlib\.import_module\s{0,5}\(\s{0,5}(?!['"])/,
    /\b(?:pickle|marshal)\.loads?\s{0,5}\(/,
  ],
};

const NETWORK_RE = new RegExp(
  [
    String.raw`(?:^|[\s;&|(\x60$])(?:curl|wget|nc|ncat|netcat|socat|scp|sftp|telnet)\s`,
    String.raw`\/dev\/(?:tcp|udp)\/`,
    String.raw`(?<![.\w$])fetch\s{0,5}\(`,
    String.raw`\baxios\b`,
    String.raw`\bhttps?\.(?:get|request)\s{0,5}\(`,
    String.raw`\brequire\s{0,5}\(\s{0,5}['"](?:node:)?(?:https?|net|dgram)['"]`,
    String.raw`\bfrom\s{1,5}['"](?:node:)?(?:https?|net|dgram)['"]`,
    String.raw`\bnew\s{1,5}WebSocket\b`,
    String.raw`\bXMLHttpRequest\b`,
    String.raw`\b(?:node-fetch|undici)\b`,
    String.raw`\brequests\.(?:get|post|put|patch|request|Session)\b`,
    String.raw`\burllib\.request\b`,
    String.raw`\burlopen\s{0,5}\(`,
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
    String.raw`\bdns\.(?:resolve|lookup)\s{0,5}\(`,
  ].join('|'),
  'i',
);

/** Bulk environment dumps — not a single named variable. */
const BULK_ENV_RE = new RegExp(
  [
    String.raw`JSON\.stringify\(\s{0,5}process\.env\s{0,5}\)`,
    String.raw`Object\.(?:entries|keys|values)\(\s{0,5}process\.env\s{0,5}\)`,
    String.raw`json\.dumps\(\s{0,5}(?:dict\(\s{0,5})?os\.environ`,
    String.raw`\bstr\(\s{0,5}os\.environ\s{0,5}\)`,
    String.raw`\bos\.environ\.items\(\s{0,5}\)`,
    String.raw`(?:^|[\s;&(])(?:printenv|env)\s{0,5}[|>]`,
    String.raw`\$\(\s{0,5}(?:printenv|env)\s{0,5}\)`,
    String.raw`\x60\s{0,5}(?:printenv|env)\s{0,5}\x60`,
    String.raw`\bprintenv\s{0,5}$`,
    String.raw`\/proc\/(?:self|\d{1,10}|\$\$)\/environ`,
    String.raw`\b(?:Get-ChildItem|gci|dir|ls)\s{1,5}env:`,
    String.raw`\[Environment\]::GetEnvironmentVariables\(\s{0,5}\)`,
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
    String.raw`\.ssh\/(?:id_\w{1,40}|[\w.-]{1,80}\.(?:pem|key))\b`,
    String.raw`\bid_(?:rsa|ed25519|ecdsa|dsa)\b`,
    String.raw`(?:^|[\s'"\/\\~(])\.(?:aws|gnupg)(?=[\/\\'"\s)]|$)`,
    String.raw`(?:^|[\s'"\/\\~(])\.(?:netrc|git-credentials)\b`,
    String.raw`\bsecurity\s{1,5}(?:find-generic-password|find-internet-password|dump-keychain)\b`,
    String.raw`\bsecret-tool\s{1,5}lookup\b`,
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
  // Not "…previous instructions files in legacy/": a following path/noun makes it a file reference.
  /\b(?:ignore|disregard|forget)\s{1,5}(?:all\s{1,5}|any\s{1,5}|every\s{1,5})?(?:of\s{1,5})?(?:the\s{1,5}|your\s{1,5}|my\s{1,5}|these\s{1,5}|those\s{1,5})?(?:previous|prior|above|earlier|preceding|system|developer|safety)\s{1,5}(?:instructions?|prompts?|rules|guidelines|directives|messages?|context)\b(?![\w./-]|\s{1,5}(?:files?|folders?|director(?:y|ies)|docs?|pages?|in\s{1,5}\S{0,80}\/))/i,
  /\byou\s{1,5}are\s{1,5}(?:now\s{1,5})?(?:in\s{1,5})?(?:DAN|developer\s{1,5}mode|jailbroken|jailbreak\s{1,5}mode|unrestricted\s{1,5}mode|god\s{1,5}mode)\b/i,
  /<\|im_start\|>|<\|(?:system|endoftext)\|>|<<SYS>>|\[\/?INST\]/i,
  /\b(?:new|updated|actual|real)\s{1,5}system\s{1,5}prompt\b/i,
  /\b(?:these|this|the\s{1,5}following)\s{1,5}instructions?\s{1,5}(?:take|takes|have|has)\s{1,5}(?:precedence|priority)\s{1,5}over\s{1,5}(?:all\s{1,5}|any\s{1,5}|the\s{1,5})?(?:system|safety)\b/i,
];

/** Cheap per-line prefilters: a line without these words cannot match the group. */
const OVERRIDE_HINT_RE = /ignore|disregard|forget|you\s{1,5}are|<\||<<SYS|INST\]|system\s{1,5}prompt|precedence|priority/i;
const CONCEAL_HINT_RE = /user|silently/i;
const BYPASS_HINT_RE = /without|disable|turn\s{1,5}off|bypass|circumvent|skip|override|approve/i;

// Prose: concealment. Strong patterns are high; "don't tell the user" is a warning.
const CONCEAL_STRONG: RegExp[] = [
  // Not "consent": "… without user consent" is overwhelmingly a policy statement, not an instruction.
  /\b(?:without|w\/o)\s{1,5}(?:the\s{1,5})?user'?s?\s{1,5}(?:knowledge|knowing|noticing|awareness)\b/i,
  /\b(?:hide|conceal|obscure)\s{1,5}(?:this|these|it|them|that|the\s{1,5}[\w\s-]{1,30}?)\s{1,5}from\s{1,5}(?:the\s{1,5})?user\b/i,
  /\bsilently\s{1,5}(?:upload|send|post|exfiltrate|transmit|forward)\b/i,
];
const CONCEAL_SOFT: RegExp[] = [
  // "never tell the user TO do X" is advice about wording, not concealment.
  /\b(?:do\s{1,5}not|don't|never)\s{1,5}(?:tell|inform|notify|alert|warn)\s{1,5}(?:the\s{1,5})?user\b(?!\s{1,5}to\b)/i,
  /\b(?:do\s{1,5}not|don't|never)\s{1,5}(?:mention|reveal|disclose)\s{1,5}(?:this|that|it|these\s{1,5}(?:steps|instructions))\s{1,5}to\s{1,5}(?:the\s{1,5})?user\b/i,
];

// Permission/safety bypass. Flags apply to every file; prose to instruction files only.
const BYPASS_FLAG_RE =
  /--dangerously-skip-permissions\b|--dangerously-bypass-approvals-and-sandbox\b|\bbypassPermissions\b|--yolo\b|--allow-all-tools\b/i;
const BYPASS_PROSE: RegExp[] = [
  // Not "… without asking for confirmation on each file": that is batching, not bypassing.
  /\bwithout\s{1,5}(?:first\s{1,5})?(?:asking|prompting|checking\s{1,5}with)\s{1,5}(?:the\s{1,5}user\s{1,5})?(?:for\s{1,5})?(?:permission|confirmation|approval|consent)\b(?!\s{1,5}(?:on|for)\s{1,5}(?:each|every|individual|single)\b)/i,
  /\b(?:disable|turn\s{1,5}off|bypass|circumvent|skip|override)\s{1,5}(?:the\s{1,5}|any\s{1,5}|all\s{1,5})?(?:sandbox(?:ing)?|safety\s{1,5}(?:checks?|guardrails?|filters?|prompts?)|guardrails?|permission\s{1,5}(?:prompts?|checks?|dialogs?)|approval\s{1,5}(?:prompts?|steps?)|content\s{1,5}(?:filters?|polic(?:y|ies)))\b/i,
  /\bauto[-\s]?approve\s{1,5}(?:all|every|any)\b/i,
];

// Prose: exfiltration instructions (matched procedurally, see checkExfil).
const EXFIL_VERB_RE = /\b(?:send|upload|post|transmit|exfiltrate|forward|paste|leak|e-?mail)\b/gi;
const EXFIL_VERB_PREFILTER_RE = /\b(?:send|upload|post|transmit|exfiltrate|forward|paste|leak|e-?mail)\b/i;
/** Bulk secrets: always suspicious to move off-machine. */
const SECRET_BULK_RE =
  /\b(?:all\s{1,5}(?:the\s{1,5}|your\s{1,5})?(?:secrets|credentials|tokens|keys|passwords)|env(?:ironment)?\s{1,5}var(?:iable)?s?|private\s{1,5}keys?|ssh\s{1,5}keys?|id_rsa|session\s{1,5}cookies|browser\s{1,5}cookies|wallets?|seed\s{1,5}phrases?|keychain)\b|\.env\b|~\/\.ssh\b|\.aws\/credentials\b/i;
/** One key/token/password: routine to send to the API that needs it. */
const SECRET_SINGLE_RE =
  /\b(?:secrets?|credentials?|api[\s_-]?keys?|access[\s_-]?tokens?|auth(?:entication)?\s{1,5}tokens?|bearer\s{1,5}tokens?|passwords?(?!\s{1,5}reset))\b/i;
const PREPOSITION_RE = /\b(?:to|into|at|via)\b/i;
const EXFIL_DEST_STRONG_RE =
  /webhook|pastebin|paste\.|hastebin|discord|telegram|ngrok|requestbin|pipedream|interactsh|burpcollaborator|\.onion\b|https?:\/\/\d{1,3}(?:\.\d{1,3}){3}/i;
const EXFIL_DEST_ANY_RE = /https?:\/\/|\bserver\b|\bendpoint\b|\bremote\b|\bexternal\b|third[-\s]party|\battacker\b|e-?mail\s{1,5}address/i;
const EXFIL_DEST_EXTERNAL_RE = /\bexternal\b|third[-\s]party|\battacker\b/i;
/** Sending a key as request auth is how API skills work, not exfiltration. */
const AUTH_CONTEXT_RE = /\b(?:header|authorization|authenticate|bearer\s{1,5}auth)\b|\s-H\s/i;

// Hidden markup.
const HIDDEN_ELEMENT_RE =
  /<[a-z][^>]{0,500}\sstyle\s{0,5}=\s{0,5}["'][^"']{0,500}(?:display\s{0,5}:\s{0,5}none|visibility\s{0,5}:\s{0,5}hidden|font-size\s{0,5}:\s{0,5}0(?:px|pt|em|rem)?\s{0,5}(?:;|["'])|opacity\s{0,5}:\s{0,5}0(?:\.0{1,5})?\s{0,5}(?:;|["']))|<[a-z][^>]{0,500}\shidden(?:\s|>|=|\/)/i;
/** Tooling directives and section markers that legitimately live in comments. */
const BENIGN_COMMENT_RE =
  /^\s{0,20}(?:promptci-ignore|markdownlint|prettier|eslint|cspell|textlint|vale\b|toc\b|omit\s{1,5}in\s{1,5}toc|end\s{0,5}toc|mdformat|lint|region|endregion|#region|#endregion|@formatter|todo\b|fixme\b|xxx\b)/i;
const AGENT_DIRECTED_RE = new RegExp(
  [
    String.raw`\b(?:ignore|disregard|forget)\b[^\n]{0,40}\b(?:instructions?|prompts?|rules|guidelines)\b`,
    String.raw`\byou\s{1,5}(?:must|are\s{1,5}now|will\s{1,5}now|should\s{1,5}(?:always|never|secretly|silently))\b`,
    String.raw`\b(?:assistant|claude|the\s{1,5}(?:ai|agent|model|llm))\s{0,5}[:,]`,
    String.raw`\b(?:dear|hey)\s{1,5}(?:ai|assistant|claude|agent|model)\b`,
    String.raw`\bsystem\s{1,5}prompt\b`,
    String.raw`\b(?:curl|wget|iwr|invoke-webrequest)\b`,
    String.raw`\bbase64\s{1,5}-d\b`,
    // An imperative aimed at a secret — "secrets go in .env" is a note, not a directive.
    String.raw`\b(?:read|send|upload|post|print|cat|copy|dump|exfiltrate|include|attach|paste)\b[^\n]{0,40}(?:\b(?:secrets?|credentials?|api[_\s-]?keys?|passwords?|private\s{1,5}keys?)\b|~\/\.ssh|\.env\b)`,
    String.raw`\b(?:run|execute|download|upload|send|install)\s{1,5}(?:this|the\s{1,5}following|it)\b`,
  ].join('|'),
  'i',
);

/** A base64-alphabet run of at least 200 characters. */
const BLOB_RE = /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{200,}={0,2}(?![A-Za-z0-9+/=])/g;

// Unpinned remote dependencies.
const INSTALL_CTX_RE = /\b(?:pip[0-9.]{0,5}|pipx|uvx|uv|npm|pnpm|yarn|bun|npx|bunx|go|cargo|gem|deno)\b/i;
const GIT_SOURCE_RE = /\bgit\+(?:https?|ssh|git|file):\/\/[^\s'"<>)`]{1,500}|\bgithub:[\w.-]{1,100}\/[\w.-]{1,100}(?:#[^\s'"<>)`]{0,100})?/gi;
/**
 * `npx tool@latest` — found from the tag backwards (see latestInstall): each
 * `@latest` looks back a bounded distance for an installer on the same command.
 */
const LATEST_TAG_RE = /(?<=[\w.-])@(?:latest|master|main|HEAD)(?![\w.-])/gi;
const INSTALLER_BEFORE_RE =
  /\b(?:npx|bunx|pnpm\s{1,5}dlx|yarn\s{1,5}dlx|uvx|pipx\s{1,5}run|npm\s{1,5}(?:i|install|exec|add)|pnpm\s{1,5}(?:add|i|install)|yarn\s{1,5}add|bun\s{1,5}(?:add|i|install|x)|go\s{1,5}(?:install|run)|deno\s{1,5}(?:run|install))\b[^\n;&|]{0,200}$/i;

function latestInstall(text: string): Found | undefined {
  if (!/@(?:latest|master|main|head)/i.test(text)) return undefined;
  for (const tag of findAll(LATEST_TAG_RE, text, 10)) {
    if (INSTALLER_BEFORE_RE.test(text.slice(Math.max(0, tag.index - 230), tag.index))) return tag;
  }
  return undefined;
}
const NPM_INSTALL_RE = /\b(?:npm\s{1,5}(?:i|install|add)|pnpm\s{1,5}(?:add|i|install)|yarn\s{1,5}add|bun\s{1,5}(?:add|i|install))\b([^\n;&|]{0,500})/i;
const CARGO_GIT_RE = /\bcargo\s{1,5}install\b[^\n;&|]{0,300}--git\s{1,5}\S/i;
const MUTABLE_SCRIPT_URL_RE = new RegExp(
  [
    String.raw`https?:\/\/raw\.githubusercontent\.com\/[^/\s]{1,100}\/[^/\s]{1,100}\/(?:refs\/heads\/)?(?:main|master|HEAD|develop|dev|trunk)\/[^\s'"<>)\x60]{0,300}`,
    String.raw`https?:\/\/github\.com\/[^/\s]{1,100}\/[^/\s]{1,100}\/raw\/(?:refs\/heads\/)?(?:main|master|HEAD|develop|dev|trunk)\/[^\s'"<>)\x60]{0,300}`,
    String.raw`https?:\/\/github\.com\/[^/\s]{1,100}\/[^/\s]{1,100}\/releases\/latest\/download\/[^\s'"<>)\x60]{0,300}`,
    String.raw`https?:\/\/gist\.githubusercontent\.com\/[^/\s]{1,100}\/[0-9a-f]{1,64}\/raw\/(?![0-9a-f]{40}\/)[^\s'"<>)\x60]{1,300}`,
  ].join('|'),
  'i',
);
const FETCH_VERB_RE = /\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|fetch|urlopen|requests\.get|download|downloadstring)\b/i;
const SCRIPTISH_URL_RE = /(?:\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|ps1|rb|pl)(?:[?#]|$)|install)/i;
const REMOTE_IMPORT_RE = /(?:\bfrom\s{1,5}|\bimport\s{0,5}\(\s{0,5}|\bimport\s{1,5}|\brequire\s{0,5}\(\s{0,5})['"](https?:\/\/[^'"\n]{1,500})['"]/g;

/** A pinned git ref: a commit SHA (7–40 hex) or a version tag. */
function isPinnedRef(ref: string | undefined): boolean {
  if (!ref) return false;
  const r = ref.replace(/^semver:/i, '').trim();
  return /^[0-9a-f]{7,40}$/i.test(r) || /^v?\d{1,10}(?:\.\d{1,10}){1,4}(?:[-+.][\w.-]{0,50})?$/.test(r);
}

/** Ref of a git/github source: `@ref` after the repo path (pip) or `#ref` (npm). */
function gitSourceRef(source: string): string | undefined {
  const hash = source.indexOf('#');
  if (hash >= 0) {
    const frag = source.slice(hash + 1);
    if (!/^(?:egg|subdirectory)=/.test(frag)) return frag.split('&')[0];
  }
  const noFrag = hash >= 0 ? source.slice(0, hash) : source;
  const noScheme = noFrag.replace(/^(?:git\+)?[a-z]{1,10}:\/\//i, '').replace(/^github:/i, '');
  const slash = noScheme.indexOf('/');
  const repoPath = slash >= 0 ? noScheme.slice(slash + 1) : noScheme; // drop user@host
  const at = repoPath.lastIndexOf('@');
  return at >= 0 ? repoPath.slice(at + 1) : undefined;
}

function isUnpinnedRemoteSpec(spec: string): boolean {
  const s = spec.trim();
  if (/^(?:git\+|git:|github:|gitlab:|bitbucket:)/i.test(s) || /^[A-Za-z0-9][\w.-]{0,100}\/[\w.-]{1,100}(?:#.{0,100})?$/.test(s)) {
    return !isPinnedRef(gitSourceRef(s.startsWith('git') || s.includes(':') ? s : `github:${s}`));
  }
  if (/^https?:\/\//i.test(s)) return !/\d+\.\d+\.\d+|#sha(?:256|512)=/i.test(s);
  return false;
}

// Script invocations (for missing-script).
const SCRIPT_REF = String.raw`((?:\$\{?[A-Za-z_][A-Za-z0-9_]{0,60}\}?\/|\{baseDir\}\/|\.\/)?[\w@.\-/]{1,200}\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|mts|rb|pl|ps1))(?![\w.\-/])`;
const INVOKE_RE = new RegExp(
  String.raw`(?:^|[\s\x60'"(;&|])(?:sudo\s{1,5})?(?:bash|sh|zsh|python[0-9.]{0,5}|node|deno\s{1,5}run(?:\s{1,5}-\S{1,40}){0,8}|bun(?:\s{1,5}run)?|tsx|ts-node|ruby|perl|pwsh(?:\s{1,5}-File)?|powershell(?:\.exe)?(?:\s{1,5}-\S{1,40}){0,8}?\s{1,5}-File|source|uv\s{1,5}run)\s{1,5}${SCRIPT_REF}`,
  'gi',
);
const DIRECT_EXEC_RE = new RegExp(String.raw`(?:^|[\s\x60'"(;&|])(\.\/[\w@.\-/]{1,200}\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|ps1))(?![\w.\-/])`, 'g');
const CONFIG_FENCE_LANGS: ReadonlySet<string> = new Set(['json', 'jsonc', 'json5', 'yaml', 'yml', 'toml']);
/** Cheap per-line prefilter: no script extension, no invocation to check. */
const SCRIPT_EXT_HINT_RE = /\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|mts|rb|pl|ps1)\b/i;

// ── Collector ─────────────────────────────────────────────────────────────────

const SEVERITY_RANK: Record<IssueSeverity, number> = { info: 0, warning: 1, high: 2, critical: 3 };
const MAX_EVIDENCE = 5;
/** Matches kept per rule per file; checks stop early once a rule is saturated. */
const MAX_HITS_PER_RULE_FILE = 25;

class HitCollector {
  private readonly groups = new Map<string, { rule: SkillSupplyChainRule; file: string; hits: Hit[] }>();

  /** Record a hit; false once this rule is saturated for this file (callers stop scanning). */
  add(rule: SkillSupplyChainRule, file: string, hit: Hit): boolean {
    const key = `${rule}|${file}`;
    const group = this.groups.get(key) ?? { rule, file, hits: [] };
    this.groups.set(key, group);
    if (group.hits.length >= MAX_HITS_PER_RULE_FILE) return false;
    if (!group.hits.some((h) => h.line === hit.line && h.excerpt === hit.excerpt)) group.hits.push(hit);
    return group.hits.length < MAX_HITS_PER_RULE_FILE;
  }

  toIssues(skillMd: string): PromptCiIssue[] {
    return [...this.groups.values()]
      .filter((g) => g.hits.length > 0)
      .sort((a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file))
      .map(({ rule, file, hits }) => buildIssue(skillMd, rule, file, hits));
  }
}

function buildIssue(skillMd: string, rule: SkillSupplyChainRule, file: string, hits: Hit[]): PromptCiIssue {
  const spec = RULES[rule];
  // Hits without a line (unscanned-files) keep their insertion order.
  const sorted = hits.every((h) => h.line === undefined) ? [...hits] : [...hits].sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  const top = sorted.reduce((best, h) =>
    SEVERITY_RANK[h.severity] > SEVERITY_RANK[best.severity] ||
    (h.severity === best.severity && h.confidence > best.confidence) ? h : best);
  const shown = sorted.slice(0, MAX_EVIDENCE);
  const shownFile = visible(file);
  // unscanned-files evidence already names each file.
  const evidence = shown.map((h) => (rule === 'unscanned-files' ? h.excerpt : `${shownFile}: ${h.excerpt}`));
  if (sorted.length > shown.length) {
    const more = sorted.length >= MAX_HITS_PER_RULE_FILE ? `${sorted.length - shown.length}+` : `${sorted.length - shown.length}`;
    evidence.push(`${shownFile}: …and ${more} more match(es)`);
  }
  const where = file === skillMd ? displayPath(skillMd) : `${displayPath(file)} (bundled with ${displayPath(skillMd)})`;
  return {
    id: `skill-supply-chain-${rule}-${shortHash(`${skillMd}|${file}`)}`,
    severity: top.severity,
    category: spec.category,
    title: spec.title,
    summary: `${where}: ${spec.summary}`,
    // The file the match is in comes first, so suppression and reports stay line-scoped to it.
    filePaths: file === skillMd ? [skillMd] : [file, skillMd],
    locations: shown.map((h) => (h.line === undefined
      ? { filePath: file }
      : { filePath: file, startLine: h.line, endLine: h.line })),
    evidence,
    recommendation: spec.recommendation,
    confidence: top.confidence,
    tags: [SKILL_SUPPLY_CHAIN_TAG, rule],
  };
}

// ── Rule checks ───────────────────────────────────────────────────────────────

/** Record a hit; returns false once the rule is saturated for this file. */
type Add = (rule: SkillSupplyChainRule, line: number, excerptText: string, severity: IssueSeverity, confidence: number) => boolean;

/**
 * A match outside fenced code that is negated or merely discussed ("this skill
 * detects `curl | bash`", "Bad: …") is documentation, not a directive.
 * Fenced code — and every non-markdown file — is judged as written.
 */
function isDocumentation(doc: SkillDoc, lineIndex: number, text: string, index: number): boolean {
  if (doc.kind !== 'instructions' || doc.fenced[lineIndex]) return false;
  return isNegated(text, index) || isDiscussion(text, index);
}

/** `curl -o x.sh URL && bash x.sh`, unless the chain verifies a checksum/signature. */
function downloadThenRun(text: string): Found | undefined {
  if (!/https?:\/\//i.test(text) || !/&&|;/.test(text)) return undefined;
  for (const fetch of findAll(DOWNLOAD_FETCH_RE, text, 20)) {
    const window = text.slice(fetch.index, fetch.index + 600);
    const run = THEN_RUN_RE.exec(window);
    if (run && /https?:\/\//i.test(window.slice(0, run.index))) return { index: fetch.index, match: run };
  }
  return undefined;
}

/** remote-exec + encoded-exec (+ one-line remote-eval in instruction code). Returns consumed lines. */
function checkExec(doc: SkillDoc, add: Add): Set<number> {
  const consumed = new Set<number>();
  const saturated = new Set<SkillSupplyChainRule>();
  for (const { text, line } of logicalLines(doc)) {
    const i = line - 1;
    const verified = findFirst(VERIFY_RE, text) !== undefined;
    const groups: Array<[SkillSupplyChainRule, Guarded[]]> = [
      ['remote-exec', REMOTE_EXEC_PATTERNS],
      ['encoded-exec', ENCODED_EXEC_PATTERNS],
    ];
    for (const [rule, patterns] of groups) {
      if (saturated.has(rule)) continue;
      let hit: Found | undefined = rule === 'remote-exec' ? pipeToShell(text) : undefined;
      for (const g of patterns) {
        if (hit) break;
        hit = findFirst(g.pattern, text, g.requires);
      }
      if (!hit && rule === 'remote-exec' && !verified) hit = downloadThenRun(text);
      if (!hit || (rule === 'remote-exec' && verified)) continue;
      if (isDocumentation(doc, i, text, hit.index)) continue;
      if (!add(rule, line, excerpt(text, hit.index, hit.match[0].length), 'high', 0.85)) saturated.add(rule);
      consumed.add(line);
    }
  }
  if (doc.kind === 'instructions') {
    // `exec(requests.get(url).text)` in a SKILL.md code sample is still a remote-code loader.
    for (const { text, line } of commandTexts(doc)) {
      if (consumed.has(line)) continue;
      const hit = findFirst(DIRECT_REMOTE_EVAL_RE, text);
      if (!hit) continue;
      consumed.add(line);
      if (!add('remote-eval', line, excerpt(text, hit.index, hit.match[0].length), 'high', 0.85)) break;
    }
  }
  return consumed;
}

function firstLineMatching(doc: SkillDoc, re: RegExp): { line: number; index: number } | undefined {
  for (let i = 0; i < doc.lines.length; i++) {
    const m = findFirst(re, doc.lines[i]!);
    if (m) return { line: i + 1, index: m.index };
  }
  return undefined;
}

/** remote-eval / dynamic-eval / credential-exfil — bundled scripts and config text. */
function checkScript(doc: SkillDoc, consumed: Set<number>, add: Add): void {
  const network = firstLineMatching(doc, NETWORK_RE);
  const evalHits: Array<{ line: number; index: number }> = [];
  const loadHits: Array<{ line: number; index: number }> = [];

  for (let i = 0; i < doc.lines.length; i++) {
    const line = i + 1;
    if (consumed.has(line)) continue;
    const text = doc.lines[i]!;
    const direct = findFirst(DIRECT_REMOTE_EVAL_RE, text);
    if (direct) {
      if (!add('remote-eval', line, excerpt(text, direct.index, direct.match[0].length), 'high', 0.85)) break;
      continue;
    }
    if (evalHits.length + loadHits.length >= MAX_HITS_PER_RULE_FILE) continue;
    const ev = (EVAL_PATTERNS[doc.lang] ?? []).map((re) => findFirst(re, text)).find(Boolean);
    if (ev) { evalHits.push({ line, index: ev.index }); continue; }
    const ld = (DYNAMIC_LOAD_PATTERNS[doc.lang] ?? []).map((re) => findFirst(re, text)).find(Boolean);
    if (ld) loadHits.push({ line, index: ld.index });
  }

  if (network && (evalHits.length > 0 || loadHits.length > 0)) {
    add('remote-eval', network.line, `network call: ${excerpt(doc.lines[network.line - 1]!, network.index)}`, 'high', 0.75);
    for (const h of [...evalHits, ...loadHits]) {
      if (!add('remote-eval', h.line, excerpt(doc.lines[h.line - 1]!, h.index), 'high', 0.75)) break;
    }
  } else {
    for (const h of evalHits) {
      if (!add('dynamic-eval', h.line, excerpt(doc.lines[h.line - 1]!, h.index), 'warning', 0.6)) break;
    }
  }

  if (!network) return;
  const sources: Array<{ line: number; index: number }> = [];
  for (let i = 0; i < doc.lines.length && sources.length < MAX_HITS_PER_RULE_FILE; i++) {
    const text = doc.lines[i]!;
    const m = findFirst(BULK_ENV_RE, text) ?? findFirst(CREDENTIAL_SOURCE_RE, text);
    if (!m) continue;
    // `ssh -i ~/.ssh/id_rsa host` / `IdentityFile` uses the key to authenticate — it is not read out.
    if (/(?:\s-i\s{0,5}|IdentityFile\s{1,5}|identity_file\s{0,5}=\s{0,5})\S{0,300}$/.test(text.slice(Math.max(0, m.index - 300), m.index + 1))) continue;
    sources.push({ line: i + 1, index: m.index });
  }
  if (sources.length === 0) return;
  add('credential-exfil', network.line, `network call: ${excerpt(doc.lines[network.line - 1]!, network.index)}`, 'high', 0.7);
  for (const s of sources) {
    if (!add('credential-exfil', s.line, `credential/env read: ${excerpt(doc.lines[s.line - 1]!, s.index)}`, 'high', 0.7)) break;
  }
}

/**
 * First match of any pattern that is a live directive: not negated, not
 * discussing the behavior, and (for `skipQuoted`) not a quoted example.
 * `negatable: false` is for patterns that embed their own negation.
 */
function directive(
  text: string,
  patterns: RegExp[],
  opts: { skipQuoted?: boolean; negatable?: boolean } = {},
): Found | undefined {
  for (const re of patterns) {
    const m = findFirst(re, text);
    if (!m) continue;
    if (opts.negatable !== false && isNegated(text, m.index)) continue;
    if (opts.skipQuoted && isQuoted(text, m.index, m.index + m.match[0].length)) continue;
    if (isDiscussion(text, m.index)) continue;
    return m;
  }
  return undefined;
}

/** exfil-instruction for one sentence: verb → secret → preposition → destination, each in a bounded window. */
function checkExfil(sentence: string): { index: number; severity: IssueSeverity; confidence: number } | undefined {
  if (AUTH_CONTEXT_RE.test(sentence) || discusses(sentence)) return undefined;
  for (const verb of findAll(EXFIL_VERB_RE, sentence, 20)) {
    if (isNegated(sentence, verb.index)) continue;
    const afterVerb = verb.index + verb.match[0].length;
    const window = sentence.slice(afterVerb, afterVerb + 120);
    const bulk = SECRET_BULK_RE.exec(window);
    const single = bulk ? null : SECRET_SINGLE_RE.exec(window);
    const secret = bulk ?? single;
    if (!secret) continue;
    const afterSecret = afterVerb + secret.index + secret[0].length;
    const prep = PREPOSITION_RE.exec(sentence.slice(afterSecret, afterSecret + 120));
    if (!prep) continue;
    const destStart = afterSecret + prep.index + prep[0].length;
    const dest = sentence.slice(destStart, destStart + 100);
    if (EXFIL_DEST_STRONG_RE.test(dest)) return { index: verb.index, severity: 'high', confidence: 0.75 };
    if (bulk && EXFIL_DEST_ANY_RE.test(dest)) return { index: verb.index, severity: 'warning', confidence: 0.6 };
    if (single && EXFIL_DEST_EXTERNAL_RE.test(dest)) return { index: verb.index, severity: 'warning', confidence: 0.6 };
  }
  return undefined;
}

/** Prose rules — instruction files (SKILL.md, reference docs). */
function checkProse(doc: SkillDoc, add: Add): void {
  const done = new Set<SkillSupplyChainRule>();
  const record = (rule: SkillSupplyChainRule, line: number, text: string, m: Found, severity: IssueSeverity, confidence: number) => {
    if (!add(rule, line, excerpt(text, m.index, m.match[0].length), severity, confidence)) done.add(rule);
  };
  for (let i = 0; i < doc.lines.length; i++) {
    const text = doc.lines[i]!;
    const line = i + 1;

    if (!done.has('instruction-override') && OVERRIDE_HINT_RE.test(text)) {
      const m = directive(text, OVERRIDE_PATTERNS, { skipQuoted: true });
      if (m) record('instruction-override', line, text, m, 'high', 0.8);
    }

    if (!done.has('conceal-from-user') && CONCEAL_HINT_RE.test(text)) {
      const strong = directive(text, CONCEAL_STRONG);
      const soft = strong ? undefined : directive(text, CONCEAL_SOFT, { negatable: false });
      if (strong) record('conceal-from-user', line, text, strong, 'high', 0.75);
      else if (soft) record('conceal-from-user', line, text, soft, 'warning', 0.6);
    }

    if (!done.has('permission-bypass') && !isTableRow(text) && BYPASS_HINT_RE.test(text)) {
      const m = directive(text, BYPASS_PROSE);
      if (m) record('permission-bypass', line, text, m, 'warning', 0.6);
    }

    if (!done.has('exfil-instruction') && EXFIL_VERB_PREFILTER_RE.test(text)) {
      for (const s of sentences(text)) {
        const hit = checkExfil(s.text);
        if (!hit) continue;
        if (!add('exfil-instruction', line, excerpt(text, s.offset + hit.index, 60), hit.severity, hit.confidence)) {
          done.add('exfil-instruction');
        }
        break;
      }
    }
  }
}

/** permission-bypass flags — every file kind. A markdown table row documenting a flag is not a directive. */
function checkBypassFlags(doc: SkillDoc, add: Add): void {
  for (let i = 0; i < doc.lines.length; i++) {
    const text = doc.lines[i]!;
    const m = findFirst(BYPASS_FLAG_RE, text);
    if (!m) continue;
    if (doc.kind === 'instructions' && !doc.fenced[i] && isTableRow(text)) continue;
    if (isDocumentation(doc, i, text, m.index)) continue;
    if (!add('permission-bypass', i + 1, excerpt(text, m.index, m.match[0].length), 'warning', 0.7)) return;
  }
}

// ── hidden-unicode ────────────────────────────────────────────────────────────

const RTL_SCRIPT_RE = /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;
const EMOJI_OR_MARK_RE = /\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Emoji_Component}/u;
const LETTER_OR_MARK_RE = /[\p{L}\p{M}]/u;
const MONGOLIAN_RE = /\p{Script=Mongolian}/u;
const FORMAT_RE = /\p{Cf}/u;

function isVariationSelector(cp: number): boolean {
  return (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);
}

/**
 * Classify the character at `k`: 'severe' (tag characters, bidi controls),
 * 'mild' (other invisible/format/control characters), or undefined (visible,
 * or invisible in a legitimate context). `tagRunPrev` is the code point just
 * before the current run of tag characters (tracked by the caller, so a long
 * run is classified in linear time).
 */
function hiddenClass(
  chars: string[],
  k: number,
  lineIndex: number,
  tagRunPrev: number | undefined,
  hasRtl: () => boolean,
): 'severe' | 'mild' | undefined {
  const cp = chars[k]!.codePointAt(0)!;
  if (cp === 0x09 || (cp >= 0x20 && cp < 0x7f)) return undefined;
  if (cp >= 0xe0000 && cp <= 0xe007f) return tagRunPrev === 0x1f3f4 ? undefined : 'severe'; // subdivision flags
  if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) return 'severe';
  const prev = chars[k - 1];
  const next = chars[k + 1];
  if (cp === 0xfeff && lineIndex === 0 && k === 0) return undefined; // BOM
  if (cp === 0x200c || cp === 0x200d) {
    const ctx = (ch: string | undefined) =>
      ch !== undefined && ch.codePointAt(0)! > 0x7f && (EMOJI_OR_MARK_RE.test(ch) || LETTER_OR_MARK_RE.test(ch));
    return ctx(prev) || ctx(next) ? undefined : 'mild';
  }
  if (cp === 0x200e || cp === 0x200f || cp === 0x061c || (cp >= 0x0600 && cp <= 0x0605) || cp === 0x06dd ||
      cp === 0x070f || cp === 0x0890 || cp === 0x0891 || cp === 0x08e2) {
    return hasRtl() ? undefined : 'mild';
  }
  if (isVariationSelector(cp)) {
    // One selector after a non-ASCII character is an emoji/CJK presentation
    // choice; a RUN of selectors is how data is smuggled after a character.
    const prevCp = prev?.codePointAt(0);
    const nextCp = next?.codePointAt(0);
    const lone = nextCp === undefined || !isVariationSelector(nextCp);
    return prevCp !== undefined && prevCp > 0x7f && !isVariationSelector(prevCp) && lone ? undefined : 'mild';
  }
  if (cp >= 0x180b && cp <= 0x180f && cp !== 0x180e) return prev && MONGOLIAN_RE.test(prev) ? undefined : 'mild';
  if (cp === 0x115f || cp === 0x1160) {
    const jamo = (ch: string | undefined) => ch !== undefined && ch.codePointAt(0)! >= 0x1100 && ch.codePointAt(0)! <= 0x11ff;
    return jamo(prev) || jamo(next) ? undefined : 'mild';
  }
  if (cp === 0x3164 || cp === 0xffa0 || cp === 0x034f || cp === 0x17b4 || cp === 0x17b5 || cp === 0x2028 || cp === 0x2029) {
    return 'mild';
  }
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return 'mild'; // control characters (tab excepted above)
  if (FORMAT_RE.test(chars[k]!)) return 'mild'; // zero-width, soft hyphen, invisible operators, …
  return undefined;
}

/** hidden-unicode — every file kind. */
function checkHiddenUnicode(doc: SkillDoc, add: Add): void {
  for (let i = 0; i < doc.lines.length; i++) {
    const lineText = doc.lines[i]!;
    // Fast path: plain printable ASCII (plus tab) cannot hide anything.
    if (!/[^\t\x20-\x7e]/.test(lineText)) continue;
    const chars = Array.from(lineText);
    let rtl: boolean | undefined;
    const hasRtl = () => (rtl ??= RTL_SCRIPT_RE.test(lineText));
    const found = new Map<number, number>();
    let severe = false;
    let firstOffset = -1;
    let offset = 0;
    let tagRunPrev: number | undefined;
    for (let k = 0; k < chars.length; k++) {
      const ch = chars[k]!;
      const cp = ch.codePointAt(0)!;
      const isTag = cp >= 0xe0000 && cp <= 0xe007f;
      if (isTag && (k === 0 || !(chars[k - 1]!.codePointAt(0)! >= 0xe0000 && chars[k - 1]!.codePointAt(0)! <= 0xe007f))) {
        tagRunPrev = k > 0 ? chars[k - 1]!.codePointAt(0) : undefined;
      }
      const cls = hiddenClass(chars, k, i, tagRunPrev, hasRtl);
      if (cls) {
        if (cls === 'severe') severe = true;
        found.set(cp, (found.get(cp) ?? 0) + 1);
        if (firstOffset < 0) firstOffset = offset;
      }
      offset += ch.length;
    }
    if (found.size === 0) continue;
    const counts = [...found.entries()]
      .sort((a, b) => a[0] - b[0])
      .slice(0, 4)
      .map(([cp, n]) => `${codepointLabel(cp)}×${n}`)
      .join(' ');
    const more = found.size > 4 ? ` (+${found.size - 4} more kinds)` : '';
    const text = `${counts}${more} in: ${excerpt(lineText, firstOffset, 1)}`;
    if (!add('hidden-unicode', i + 1, text, severe ? 'high' : 'warning', severe ? 0.9 : 0.7)) return;
  }
}

// ── hidden markup ─────────────────────────────────────────────────────────────

/** 1-based line of a character offset, via binary search over precomputed line starts. */
function lineAt(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** hidden-html-comment, hidden-html-element, encoded-blob — instruction files. */
function checkHiddenMarkup(doc: SkillDoc, add: Add): void {
  // Fenced code blocks blanked out, line count preserved.
  const blankedLines = doc.lines.map((l, i) => (doc.fenced[i] ? '' : l));
  const blanked = blankedLines.join('\n');
  const lineStarts: number[] = [0];
  for (let i = 0; i < blankedLines.length - 1; i++) lineStarts.push(lineStarts[i]! + blankedLines[i]!.length + 1);

  // indexOf walk — no regex over the whole file, and an unclosed `<!--` hides the rest of the file.
  let pos = 0;
  while (pos < blanked.length) {
    const start = blanked.indexOf('<!--', pos);
    if (start < 0) break;
    const close = blanked.indexOf('-->', start + 4);
    const bodyEnd = close < 0 ? blanked.length : close;
    pos = close < 0 ? blanked.length : close + 3;
    const body = blanked.slice(start + 4, bodyEnd);
    if (BENIGN_COMMENT_RE.test(body.slice(0, 200))) continue;
    const hit = findFirst(AGENT_DIRECTED_RE, body);
    if (!hit) continue;
    const line = lineAt(lineStarts, start + 4 + hit.index);
    const lineText = doc.lines[line - 1] ?? '';
    const col = start + 4 + hit.index - lineStarts[line - 1]!;
    if (!add('hidden-html-comment', line, excerpt(lineText, col, hit.match[0].length), 'warning', 0.6)) break;
  }

  for (let i = 0; i < blankedLines.length; i++) {
    const text = blankedLines[i]!;
    if (!/style|hidden/i.test(text)) continue;
    const el = findFirst(HIDDEN_ELEMENT_RE, text);
    if (el && !add('hidden-html-element', i + 1, excerpt(text, el.index, el.match[0].length), 'warning', 0.6)) break;
  }

  for (let i = 0; i < doc.lines.length; i++) {
    const text = doc.lines[i]!;
    if (text.length < 200) continue;
    const blob = findAll(BLOB_RE, text, 5).find((b) => {
      const s = b.match[0];
      if (/(?:base64,|data:[^,\s]{0,100},)\s{0,5}$/i.test(text.slice(Math.max(0, b.index - 120), b.index))) return false; // data: URI
      if (!/[0-9]/.test(s) || !/[A-Z]/.test(s) || !/[a-z]/.test(s)) return false;
      return (s.match(/\//g)?.length ?? 0) <= s.length / 10; // more slashes = a long path, not a payload
    });
    if (blob && !add('encoded-blob', i + 1, `${blob.match[0].length}-char encoded string: ${blob.match[0].slice(0, 40)}…`, 'warning', 0.5)) {
      return;
    }
  }
}

// ── unpinned-remote-dep ───────────────────────────────────────────────────────

/**
 * The text a reader is meant to *run*: every line of a script or config file,
 * but only fenced blocks and inline `code spans` of an instruction file —
 * prose such as "npm install and then run tests/foo.js" is not a command line.
 */
function commandTexts(doc: SkillDoc): Array<{ text: string; line: number }> {
  if (doc.kind !== 'instructions') return logicalLines(doc);
  const out: Array<{ text: string; line: number }> = [];
  for (const logical of logicalLines(doc)) {
    if (doc.fenced[logical.line - 1]) {
      out.push(logical);
      continue;
    }
    if (!logical.text.includes('`')) continue;
    for (const span of findAll(/`([^`\n]{1,1000})`/g, logical.text, 50)) {
      // An inline span in prose that is negated or discussed ("Bad: `npx x@latest`") is documentation.
      if (isNegated(logical.text, span.index) || isDiscussion(logical.text, span.index)) continue;
      out.push({ text: span.match[1]!, line: logical.line });
    }
  }
  return out;
}

/** unpinned-remote-dep — command text in every file, plus bundled manifests. */
function checkUnpinned(doc: SkillDoc, consumed: Set<number>, add: Add): void {
  const hit = (line: number, text: string, index: number, confidence = 0.6) =>
    add('unpinned-remote-dep', line, excerpt(text, index, 80), 'warning', confidence);

  if (doc.kind === 'manifest') {
    checkManifest(doc, hit);
    return;
  }

  for (const { text, line } of commandTexts(doc)) {
    if (consumed.has(line)) continue;

    if (INSTALL_CTX_RE.test(text)) {
      const unpinned = findAll(GIT_SOURCE_RE, text, 10).find((g) => !isPinnedRef(gitSourceRef(g.match[0])));
      if (unpinned) {
        if (!hit(line, text, unpinned.index)) return;
        continue;
      }
    }

    const latest = latestInstall(text);
    if (latest) {
      if (!hit(line, text, latest.index, 0.5)) return;
      continue;
    }

    const npm = findFirst(NPM_INSTALL_RE, text);
    if (npm) {
      const tokens = (npm.match[1] ?? '').trim().split(/\s+/).filter((t) => t && !t.startsWith('-'));
      const bad = tokens.find((t) =>
        !t.startsWith('@') && !t.startsWith('.') && !t.startsWith('/') && !t.startsWith('file:') &&
        !/\.(?:js|mjs|cjs|ts|json|md|sh|py|txt)$/i.test(t) &&
        (/^[A-Za-z0-9][\w.-]{0,100}\/[\w.-]{1,100}(?:#\S{0,100})?$/.test(t) || /^https?:\/\//i.test(t)) &&
        isUnpinnedRemoteSpec(t));
      if (bad) {
        if (!hit(line, text, npm.index)) return;
        continue;
      }
    }

    const cargo = findFirst(CARGO_GIT_RE, text);
    if (cargo && !/--(?:rev|tag)\s{1,5}\S/.test(text)) {
      if (!hit(line, text, cargo.index)) return;
      continue;
    }

    const url = findFirst(MUTABLE_SCRIPT_URL_RE, text);
    if (url && findFirst(FETCH_VERB_RE, text) && SCRIPTISH_URL_RE.test(url.match[0])) {
      if (!hit(line, text, url.index)) return;
      continue;
    }

    if (doc.kind === 'script' && doc.lang === 'js') {
      const imp = findAll(REMOTE_IMPORT_RE, text, 10)
        .find((m) => !/@v?\d+(?:\.\d+)*|@[0-9a-f]{7,40}|\/v?\d+\.\d+\.\d+\//i.test(m.match[1]!));
      if (imp && !hit(line, text, imp.index)) return;
    }
  }
}

function checkManifest(doc: SkillDoc, hit: (line: number, text: string, index: number) => boolean): void {
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
          if (!hit(line, doc.lines[line - 1] ?? `"${name}": "${spec}"`, 0)) return;
        }
      }
    }
    return;
  }
  // requirements*.txt
  for (let i = 0; i < doc.lines.length; i++) {
    const text = doc.lines[i]!.replace(/\s#.*$/, '');
    const g = findFirst(/\bgit\+[a-z]{1,10}:\/\/\S{1,500}/i, text);
    if (g && !isPinnedRef(gitSourceRef(g.match[0]))) {
      if (!hit(i + 1, text, g.index)) return;
      continue;
    }
    const u = findFirst(/\bhttps?:\/\/\S{1,500}?\.(?:zip|tar\.gz|tgz|whl)\S{0,200}/i, text);
    if (u && !/\d+\.\d+|#sha256=/i.test(u.match[0]) && !hit(i + 1, text, u.index)) return;
  }
}

// ── missing-script ────────────────────────────────────────────────────────────

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

  for (let i = 0; i < doc.lines.length; i++) {
    const text = doc.lines[i]!;
    // A `"command": "bash …"` inside a JSON/YAML example is sample config, not an instruction to run.
    if (doc.fenced[i] && CONFIG_FENCE_LANGS.has(doc.fenceLang[i]!)) continue;
    if (!SCRIPT_EXT_HINT_RE.test(text)) continue;
    for (const re of [INVOKE_RE, DIRECT_EXEC_RE]) {
      for (const m of findAll(re, text, 10)) {
        const raw = m.match[1]!;
        const bare = raw.replace(/^\.\//, '');
        if (alreadyReported.has(bare) || alreadyReported.has(raw)) continue;
        const candidates = resolveCandidates(raw);
        if (!candidates) continue;
        if (candidates.some((c) => isFileWithinRoot(repoRoot, c))) continue;
        if (!add('missing-script', i + 1, `${visible(raw)} not found (looked in: ${candidates.map(visible).join(', ')})`, 'warning', 0.6)) {
          return;
        }
      }
    }
  }
}

// ── Detector ──────────────────────────────────────────────────────────────────

/** Read up to MAX_FILE_SIZE bytes; `partial` when the file is larger. */
function readHead(abs: string, size: number, limit: number): Buffer | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(Math.min(size, limit));
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, read);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function loadDoc(
  repoRoot: string,
  relPath: string,
  isSkillMd: boolean,
): { doc?: SkillDoc; partial?: boolean } {
  let cls = isSkillMd ? ({ kind: 'instructions', lang: 'other' } as Classified) : classifyByName(relPath);
  if (!cls) return {};
  const abs = resolveWithinRoot(repoRoot, relPath);
  if (!abs) return {};
  let size: number;
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return {};
    size = stat.size;
  } catch {
    return {};
  }
  if (cls === 'probe') {
    // Extensionless: an asset if it looks binary, a script with a shebang, text otherwise.
    const head = readHead(abs, size, BINARY_CHECK_BYTES);
    if (!head || isBinary(head)) return {};
    const lang = langFromShebang(head.toString('utf8').split(/\r?\n/, 1)[0] ?? '');
    cls = lang ? { kind: 'script', lang } : { kind: 'text', lang: 'other' };
  }
  // Text-classified files are read even when they contain NUL bytes: a stray
  // NUL must not hide a file — hidden-unicode reports it instead.
  const buf = readHead(abs, size, MAX_FILE_SIZE);
  if (!buf) return {};
  const content = buf.toString('utf8');
  const lines = content.split(/\r?\n/);
  const fence = cls.kind === 'instructions' ? scanFencedLines(content.replace(/\r\n/g, '\n')) : [];
  return {
    doc: {
      path: relPath,
      kind: cls.kind,
      lang: cls.lang,
      content,
      lines,
      fenced: lines.map((_, i) => fence[i]?.inFence ?? false),
      fenceLang: lines.map((_, i) => fence[i]?.lang ?? ''),
      frontmatterEnd: isSkillMd ? frontmatterEnd(lines) : 0,
    },
    partial: size > MAX_FILE_SIZE,
  };
}

function collectSkills(context: RepoContext): Skill[] {
  // `allSkills`/`skillFiles` are optional for hand-built contexts from older releases.
  const ai: Partial<RepoContext['aiConfig']> = context.aiConfig ?? {};
  const allSkills = ai.allSkills ?? ai.skills ?? [];
  const audited = new Set(ai.skills ?? []);
  const dirs = allSkills.map((s) => path.posix.dirname(s));
  const owner = (file: string): number => {
    let best = -1;
    dirs.forEach((dir, idx) => {
      if (isSkillContainerDir(dir) || !file.startsWith(`${dir}/`)) return;
      if (best < 0 || dir.length > dirs[best]!.length) best = idx;
    });
    return best;
  };
  const bundled = new Map<number, string[]>();
  const overCap = new Map<number, string[]>();
  for (const [list, target] of [[ai.skillFiles ?? [], bundled], [ai.skillFilesOverCap ?? [], overCap]] as const) {
    for (const file of list) {
      const idx = owner(file);
      if (idx < 0) continue;
      const entries = target.get(idx) ?? [];
      entries.push(file);
      target.set(idx, entries);
    }
  }

  const skills: Skill[] = [];
  allSkills.forEach((skillMd, idx) => {
    const unscanned: Skill['unscanned'] = [];
    const main = loadDoc(context.repoRoot, skillMd, true);
    if (!main.doc) return;
    if (main.partial) unscanned.push({ path: skillMd, reason: 'larger than 500 KB — only the first 500 KB was scanned' });
    const docs = [main.doc];
    for (const file of bundled.get(idx) ?? []) {
      const loaded = loadDoc(context.repoRoot, file, false);
      if (loaded.doc) docs.push(loaded.doc);
      if (loaded.partial) unscanned.push({ path: file, reason: 'larger than 500 KB — only the first 500 KB was scanned' });
    }
    for (const file of overCap.get(idx) ?? []) {
      unscanned.push({ path: file, reason: 'over the per-skill file cap — not scanned' });
    }
    skills.push({ skillMd, dir: dirs[idx]!, docs, unscanned, structurallyAudited: audited.has(skillMd) });
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
      return collector.add(rule, doc.path, { line, excerpt: `${where}${excerptText}`, severity, confidence });
    };

    checkHiddenUnicode(doc, add);
    checkBypassFlags(doc, add);
    if (doc.kind === 'manifest') {
      checkUnpinned(doc, new Set(), add);
      continue;
    }
    const consumed = checkExec(doc, add);
    checkUnpinned(doc, consumed, add);
    if (doc.kind === 'instructions') {
      checkProse(doc, add);
      checkHiddenMarkup(doc, add);
      if (doc === skill.docs[0]) checkMissingScripts(repoRoot, skill, doc, alreadyReported, add);
    } else {
      checkScript(doc, consumed, add);
    }
  }

  // Name the first few unscanned files, then count the rest — never drop them silently.
  const shownUnscanned = skill.unscanned.slice(0, MAX_EVIDENCE - 1);
  for (const { path: file, reason } of shownUnscanned) {
    collector.add('unscanned-files', skill.skillMd, { excerpt: `${visible(file)}: ${reason}`, severity: 'info', confidence: 0.8 });
  }
  if (skill.unscanned.length > shownUnscanned.length) {
    const rest = skill.unscanned.length - shownUnscanned.length;
    collector.add('unscanned-files', skill.skillMd, {
      excerpt: `…and ${rest} more file(s) not fully scanned`, severity: 'info', confidence: 0.8,
    });
  }

  return collector.toIssues(skill.skillMd);
}

export function detectSkillSupplyChain(context: RepoContext): PromptCiIssue[] {
  const issues = collectSkills(context).flatMap((skill) => scanSkill(context.repoRoot, skill));
  // Scanner-form paths so inline suppressions can match (see withScannerPaths).
  return withScannerPaths(context.repoRoot, issues);
}
