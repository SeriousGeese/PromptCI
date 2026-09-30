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
 * skill content is matched against fixed patterns, so the same files always
 * produce the same findings (no network, no clock, no LLM).
 *
 * Rules (tag `skill-supply-chain` + the rule id below):
 *
 *   remote-exec            fetched content piped into a shell (`curl … |
 *                          bash`, by path, via env/sudo/busybox/xargs, in a
 *                          subshell, through any number of pipe stages),
 *                          process/here-string substitution, `iex (iwr …)`,
 *                          or a downloaded file executed later in the same
 *                          command without first being verified           high
 *   encoded-exec           decoded content executed (`base64 -d | sh`, `xxd
 *                          -r -p | sh`, decode-to-file then run, `eval
 *                          "$(… | base64 -d)"`, `exec(b64decode(…))`,
 *                          `powershell -enc`)                             high
 *   remote-eval            eval of fetched code (also in SKILL.md code), or
 *                          a script that both evaluates dynamic code AND
 *                          makes network calls                            high
 *   dynamic-eval           eval/exec/new Function/iex, no network call   warning
 *   credential-exfil       credential-store read or environment dump AND
 *                          network calls in the same file                 high
 *   exfil-instruction      prose sending secrets to a destination  high/warning
 *   instruction-override   prompt-injection text                          high
 *   conceal-from-user      prose hiding actions from the user      high/warning
 *   permission-bypass      flags/prose disabling permission prompts    warning
 *   hidden-unicode         tag characters, bidi controls (high); other
 *                          invisible/format/control characters       (warning)
 *   hidden-html-comment    agent-directed text inside an HTML comment  warning
 *   hidden-html-element    text hidden by `display:none`/`hidden`      warning
 *   encoded-blob           a large base64 blob in instruction text     warning
 *   unpinned-remote-dep    a remote dependency with no pinned version  warning
 *   missing-script         the SKILL.md runs a script that exists nowhere
 *                                                          warning, ai_config
 *   unscanned-files        content this scan could not fully read, named:
 *                          binaries/archives/executables, compiled-language
 *                          sources, files over the cap or budget, oversized
 *                          files (head and tail read), overlong continuation
 *                          chains (warning); dependency directories and
 *                          include-filtered files (info)
 *
 * Hostile input: every regex uses bounded quantifiers and runs over lines in
 * overlapping 2000-character windows behind cheap prefilters, and every rule
 * whose span can exceed the window overlap (pipes, command chains) is matched
 * procedurally over the whole logical command, so results do not depend on
 * window alignment. HTML comments and tags are found with indexOf walks. A
 * rule keeps scanning past its evidence cap (a flood of low-severity matches
 * cannot hide a later high-severity one). Documents are loaded, scanned and
 * dropped one at a time under a per-scan byte, file and line budget, SKILL.md
 * files and scripts/executables first; a priority file the budget cannot
 * reach is reported at HIGH (fail closed). There is deliberately no
 * wall-clock budget: output must not depend on the clock.
 *
 * Documentation vs directive (the false-positive controls). Outside fenced
 * code — prose, inline code, table rows — a negation or discussion word only
 * counts when it directly GOVERNS the match: an imperative negation with
 * nothing or one executing verb between ("never run `curl … | bash`"), a
 * discussion word right before it ("this skill detects `curl | bash`" — a
 * `Label:` is not governance), or a predicate right after it ("… is
 * dangerous"). Governance ends at but / and / then / instead / so and at
 * clause punctuation; "never forget/hesitate/stop/skip/fail/neglect/mind" is
 * not a negation. Even then, context NEVER drops a match, or lowers its
 * severity, when the match names a concrete target — a URL, a host (dotted,
 * IPv4/IPv6, host:port, defanged or quote-split), a host/path, a `$VARIABLE`
 * or `$(…)`, or any address-like argument or config/list flag given to
 * curl/wget/iwr — it only lowers confidence (0.4) and notes "looks like
 * documentation". Target-less exec documentation ("never run `curl | bash`")
 * is dropped; target-less override/concealment/bypass text is dropped only
 * when the governed phrase is itself set off in a code span, quotes or a
 * table cell (otherwise it is kept at low confidence), and quoted text after
 * an adoption phrase ("your new rule is \"…\"") is never data. The trade-off: a
 * security skill quoting a real installer URL is reported (high, low
 * confidence); the escape hatch is the baseline or a config `exclude`.
 * Other controls: one named API key sent to an API is not exfiltration;
 * dynamic require/import only counts next to network access; emoji ZWJ, a
 * single variation selector after a non-ASCII character, flag tag sequences,
 * RTL marks in RTL text, a leading BOM and `data:` URIs are ignored; `npx
 * tool` without a version is not flagged; a table row whose first cell is just
 * a flag, and whose other cells direct nothing, documents that flag.
 *
 * Findings list the file they were found in plus the owning SKILL.md in
 * `filePaths`, with `locations` at the exact line. Inline `promptci-ignore`
 * annotations inside a skill directory never suppress these findings
 * (scan.ts). Evidence quotes the matched text with every invisible or control
 * character shown as `<U+XXXX>` and tag-character payloads decoded. No finding
 * is auto-fixable: repairing a skill needs a human-reviewed diff.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RepoContext } from './repo-context.js';
import type { IssueCategory, IssueSeverity, PromptCiIssue } from './types.js';
import type { SkillBundleSkip } from './ai-config.js';
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
import { codepointLabel, visibleText } from './evidence.js';

/** First entry of every finding's `tags`. */
export const SKILL_SUPPLY_CHAIN_TAG = 'skill-supply-chain';

/** Total bytes of skill content read per scan; the rest is reported, not read. */
export const MAX_SCAN_BYTES = 20 * 1024 * 1024;
/** Total skill files read per scan. */
export const MAX_SCAN_FILES = 2000;

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * instructions: markdown/text the agent reads. script: executable code.
 * manifest: dependency manifests. text: other text (Makefile, Dockerfile,
 * YAML/JSON/HTML, compiled-language sources…) read for the command/exfil rules.
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
  /** Indices of non-blank lines — the only lines most rules need to look at. */
  active: number[];
  /** Per line: inside a fenced code block (instructions only). */
  fenced: Uint8Array;
  /** Per line: the enclosing fence's info string. */
  fenceLang: Map<number, string>;
  /** Last line of the SKILL.md frontmatter block (0 when none / not a SKILL.md). */
  frontmatterEnd: number;
  /** The trailing 500 KB of an oversized file: line numbers are unknown. */
  tail: boolean;
};

type Unscanned = { path: string; reason: string; severity: IssueSeverity };

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
      'content fetched from the network appears to be executed — piped or substituted into an interpreter, or downloaded and run ' +
      'without verification. Whatever the server returns at run time runs with the user\'s permissions, and it can change after the skill was reviewed.',
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
    title: 'Some skill content was not fully scanned',
    category: 'security',
    summary:
      'part of this skill could not be checked by the supply-chain scan — binaries, archives or compiled-language sources it cannot ' +
      'analyze, files beyond the per-skill cap or the per-scan budget, the middle of very large files, or directories it does not walk. ' +
      'Anything in those parts was not checked.',
    recommendation:
      'Review the listed content by hand. A skill that ships binaries or very large files deserves extra scrutiny before installing.',
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
/**
 * Compiled-language and infrastructure sources: read for command/exfil
 * patterns only. Noted at info (the rules that matter still ran on them).
 */
const SOURCE_EXT: ReadonlySet<string> = new Set([
  'go', 'rs', 'java', 'c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'cs', 'swift', 'kt', 'kts', 'groovy', 'gradle', 'scala',
  'tf', 'hcl', 'sql', 'service', 'desktop',
]);
/** Windows/macOS script hosts: read for command/exfil patterns, noted at warning (they run directly). */
const SCRIPT_HOST_EXT: ReadonlySet<string> = new Set(['vbs', 'vba', 'vbe', 'hta', 'applescript', 'wsf', 'jse', 'reg']);
/** Binary executables, archives and shortcuts: never readable as text — reported. */
const BINARY_REPORT_EXT: ReadonlySet<string> = new Set([
  'exe', 'dll', 'so', 'dylib', 'wasm', 'jar', 'war', 'class', 'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar',
  'msi', 'dmg', 'pkg', 'deb', 'rpm', 'appimage', 'apk', 'bin', 'o', 'a', 'lnk', 'scr', 'com', 'pif', 'scpt', 'node',
]);
/** Office documents and databases: not readable here, rarely executable — noted at info. */
const OPAQUE_DOC_EXT: ReadonlySet<string> = new Set(['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt', 'odt', 'sqlite', 'sqlite3', 'db']);
/** Media, fonts, data and OS clutter: assets, not read and not reported. */
const ASSET_EXT: ReadonlySet<string> = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'tif', 'tiff', 'pdf', 'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'mp4', 'wav', 'ogg', 'flac', 'mov', 'avi', 'webm', 'm4a', 'csv', 'tsv', 'parquet', 'psd', 'sketch', 'fig', 'pyc',
]);
const ASSET_NAMES: ReadonlySet<string> = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

type Classified = { kind: Kind; lang: Lang; note?: { reason: string; severity: IssueSeverity } };
type Classification = Classified | 'probe' | { skip: 'asset' } | { report: string; severity: IssueSeverity };

/** Classify by name alone; 'probe' means "sniff the first bytes". */
function classifyByName(relPath: string): Classification {
  const base = path.posix.basename(relPath);
  if (ASSET_NAMES.has(base.toLowerCase())) return { skip: 'asset' };
  if (base === 'package.json' || /^requirements[\w.-]{0,40}\.txt$/i.test(base)) return { kind: 'manifest', lang: 'other' };
  if (/^(?:GNU)?makefile$/i.test(base) || /^(?:Dockerfile|Containerfile|Justfile)(?:\..{1,40})?$/i.test(base)) {
    return { kind: 'text', lang: 'sh' };
  }
  // Templates (.env.example/.sample/.template/.dist) document variable names, not secrets.
  if (/^\.env\.(?:example|sample|template|dist|defaults?)$/i.test(base)) return { skip: 'asset' };
  if (/^\.env(?:\..{1,40})?$/i.test(base) || /\.env$/i.test(base)) {
    return { report: 'environment/secrets file bundled with the skill — not read; review it by hand', severity: 'warning' };
  }
  const ext = /\.([a-z0-9]{1,12})$/i.exec(base)?.[1]?.toLowerCase();
  if (ext === undefined || base.lastIndexOf('.') <= 0) return 'probe';
  if (INSTRUCTION_EXT.has(ext)) return { kind: 'instructions', lang: 'other' };
  if (SCRIPT_EXT[ext]) return { kind: 'script', lang: SCRIPT_EXT[ext]! };
  if (ext === 'mk' || ext === 'dockerfile') return { kind: 'text', lang: 'sh' };
  if (TEXT_EXT.has(ext)) return { kind: 'text', lang: 'other' };
  if (SOURCE_EXT.has(ext)) {
    return { kind: 'text', lang: 'other', note: { reason: `.${ext} source — only command and exfiltration patterns were checked`, severity: 'info' } };
  }
  if (SCRIPT_HOST_EXT.has(ext)) {
    return { kind: 'script', lang: 'other', note: { reason: `.${ext} script — only command and exfiltration patterns were checked`, severity: 'warning' } };
  }
  if (BINARY_REPORT_EXT.has(ext)) return { report: `binary executable or archive (.${ext}) — cannot be reviewed as text`, severity: 'warning' };
  if (OPAQUE_DOC_EXT.has(ext)) return { report: `.${ext} document/database — not read`, severity: 'info' };
  if (ASSET_EXT.has(ext)) return { skip: 'asset' };
  return 'probe'; // unknown extension: text is scanned, binary is reported
}

/**
 * Scanned first, so no amount of decoy content can push them past a budget:
 * every SKILL.md, scripts, manifests, shell-like config, executables and
 * extensionless/unknown files (which may be executables).
 */
function isPriorityFile(relPath: string): boolean {
  if (path.posix.basename(relPath) === 'SKILL.md') return true;
  const cls = classifyByName(relPath);
  if (cls === 'probe') return true;
  if ('skip' in cls) return false;
  if ('report' in cls) return cls.severity !== 'info';
  return cls.kind === 'script' || cls.kind === 'manifest' || (cls.kind === 'text' && cls.lang === 'sh');
}

function langFromShebang(firstLine: string): Lang | undefined {
  const m = /^#!\s{0,5}(\S{1,200})(?:\s{1,5}(\S{1,100}))?/.exec(firstLine);
  if (!m) return undefined;
  const interp = path.posix.basename(m[1]!) === 'env' ? (m[2] ?? '') : path.posix.basename(m[1]!);
  if (/^(?:node|deno|bun|tsx|ts-node)$/.test(interp)) return 'js';
  if (/^python/.test(interp)) return 'py';
  if (/^(?:ba|z|k|da|fi)?sh$/.test(interp)) return 'sh';
  if (/^ruby$/.test(interp)) return 'rb';
  if (/^pwsh$/.test(interp)) return 'ps';
  return 'other';
}

function binaryKind(head: Buffer): string {
  if (head.length >= 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) return 'ELF executable';
  if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) return 'Windows executable';
  if (head.length >= 4 && (head.readUInt32BE(0) === 0xfeedface || head.readUInt32BE(0) === 0xfeedfacf ||
      head.readUInt32BE(0) === 0xcefaedfe || head.readUInt32BE(0) === 0xcffaedfe || head.readUInt32BE(0) === 0xcafebabe)) {
    return 'Mach-O/Java binary';
  }
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return 'ZIP archive';
  return 'binary file';
}

function frontmatterEnd(lines: string[]): number {
  if ((lines[0] ?? '').replace(/^\u{FEFF}/u, '').trim() !== '---') return 0;
  for (let i = 1; i < lines.length && i < 500; i++) {
    if (/^(?:---|\.\.\.)[ \t]*$/.test(lines[i]!)) return i + 1;
  }
  return 0;
}

// ── Text helpers ──────────────────────────────────────────────────────────────

const visible = visibleText;

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

/** Longest line segment a regex ever sees; long lines are scanned in overlapping windows. */
const MAX_SCAN_WINDOW = 2000;
/** Every windowed regex's longest possible match is well under this. */
const WINDOW_OVERLAP = 600;

type Found = { index: number; match: RegExpExecArray };

function fakeMatch(text: string, index: number, end: number): RegExpExecArray {
  return Object.assign([text.slice(index, end)], { index, input: text, groups: undefined }) as RegExpExecArray;
}

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
  for (let start = 0; start < text.length; start += MAX_SCAN_WINDOW - WINDOW_OVERLAP) {
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

type Logical = { text: string; line: number };

/**
 * Join continued lines so a `curl … \` / `| bash` split, or a pipe at the end
 * of one line and the shell on the next, is one command. A markdown table row
 * (starting with `|`) never pipe-joins. Joins are capped so 16k continued lines
 * cannot become one giant string; each cap hit is returned so it can be
 * reported instead of silently splitting a command.
 */
function logicalLines(doc: SkillDoc): { lines: Logical[]; capped: number[] } {
  const out: Logical[] = [];
  const capped: number[] = [];
  let buf = '';
  let start = 0;
  let joined = 0;
  let prev = -2;
  // Only non-blank lines produce logical lines; a blank line ends any continuation.
  for (const i of doc.active) {
    const l = doc.lines[i]!;
    if (buf !== '' && i !== prev + 1) {
      out.push({ text: buf, line: start });
      buf = '';
    }
    prev = i;
    if (buf === '') {
      start = i + 1;
      joined = 0;
    }
    const trimmed = l.trimEnd();
    const backslash = trimmed.endsWith('\\') && !trimmed.endsWith('\\\\');
    const operator = (trimmed.endsWith('|') || trimmed.endsWith('&&')) &&
      !(doc.kind === 'instructions' && !doc.fenced[i] && l.trimStart().startsWith('|'));
    if (backslash || operator) {
      if (joined < MAX_JOINED_LINES && buf.length + l.length < MAX_JOINED_CHARS) {
        buf += `${backslash ? trimmed.slice(0, -1) : trimmed} `;
        joined++;
        continue;
      }
      capped.push(start);
    }
    out.push({ text: buf + l, line: start });
    buf = '';
  }
  if (buf !== '') out.push({ text: buf, line: start });
  return { lines: out, capped };
}

// ── Documentation vs directive ────────────────────────────────────────────────

/**
 * Imperative negations. Followed by mind/hesitate/forget/stop/skip/fail/neglect
 * they are not negations of what follows ("never forget to run …").
 */
const NEGATION_WORD_RE =
  /\b(?:never|don't|dont|do\s{1,5}not|avoid|must\s{1,5}not|mustn't|should\s{1,5}not|shouldn't|refuse\s{1,5}to)\b(?!\s{1,5}(?:mind|hesitate|forget|stop|skip|fail|neglect)\w{0,4}\b)/gi;
/**
 * Governance ends at a clause boundary or a coordinating word. A colon ends it
 * too: `Injection:` / `Detect:` / `Example of:` are labels, not governance.
 */
const GOVERNANCE_BREAK_RE = /[,;:.!?]|\b(?:but|and|then|instead|so)\b/i;
/** Discussion words may sit up to this many words before the match. */
const MAX_GOVERNED_WORDS = 2;
/** The only words allowed between a negation and what it negates: "never RUN `…`". */
const EXECUTING_VERB_RE = /^(?:run|pipe|use|execute|invoke|call|send|pass|type|paste)$/i;

function words(gap: string): string[] {
  return gap.match(/[A-Za-z0-9_'-]+/g) ?? [];
}
/**
 * Words that mark a match as being *discussed* — only these, and only when they
 * govern the match. Generic words (bad, risk, flag, wrong, skip, avoid) are
 * deliberately absent: one of them anywhere in a sentence must not silence a rule.
 */
const DISCUSSION_WORD_RE =
  /\b(?:detect\w{0,10}|block(?:s|ed|ing)?|prevent\w{0,10}|reject\w{0,10}|forbid\w{0,10}|prohibit\w{0,10}|den(?:y|ies|ied)|malicious|dangerous|insecure|unsafe|vulnerab\w{0,10}|exploit\w{0,10}|injection|attack\w{0,10}|(?:not|un)\s{0,3}supported|anti-?pattern|example\s{1,5}of)\b/gi;
/** "`…` is dangerous" — a predicate right after the match. */
const DISCUSSION_AFTER_RE =
  /^[`'")\]\s]{0,6}(?:is|are|was|would\s{1,5}be|looks)\s{1,5}(?:dangerous|insecure|unsafe|malicious|risky|an?\s{1,5}(?:security\s{1,5})?(?:risk|red\s{1,5}flag|attack))\b/i;
/** The last `re` match inside `before` whose gap to the end passes `gapOk`. */
function governs(before: string, re: RegExp, gapOk: (gap: string) => boolean): boolean {
  let last: RegExpExecArray | undefined;
  re.lastIndex = 0;
  for (const m of before.matchAll(re)) last = m;
  if (!last) return false;
  return gapOk(before.slice((last.index ?? 0) + last[0].length));
}

/**
 * An imperative negation that directly governs the match: nothing, or one
 * executing verb, between them ("never `…`", "never run `…`"), same clause.
 */
function governedNegation(text: string, index: number): boolean {
  return governs(text.slice(Math.max(0, index - 80), index), NEGATION_WORD_RE, (gap) => {
    if (gap.length > 30 || GOVERNANCE_BREAK_RE.test(gap)) return false;
    const w = words(gap);
    return w.length === 0 || (w.length === 1 && EXECUTING_VERB_RE.test(w[0]!));
  });
}

/** A discussion word directly before the match (not a `Label:`), or a predicate right after it. */
function governedDiscussion(text: string, index: number, length: number): boolean {
  if (DISCUSSION_AFTER_RE.test(text.slice(index + length, index + length + 60))) return true;
  return governs(text.slice(Math.max(0, index - 80), index), DISCUSSION_WORD_RE,
    (gap) => gap.length <= 30 && !GOVERNANCE_BREAK_RE.test(gap) && words(gap).length <= MAX_GOVERNED_WORDS);
}

/**
 * A concrete target: a URL, a host (dotted, IPv4, IPv6, host:port such as
 * `localhost:8000`, or obfuscated — `evil[.]com`, `evil .com`, `"evil"".com"`,
 * `'evil'.com`), a host/path, or a variable/command substitution.
 */
const TARGET_RE = new RegExp(
  [
    String.raw`https?:\/\/`,
    String.raw`\b(?:[a-z0-9-]{1,63}\.){1,5}[a-z]{2,24}(?::\d{1,5})?\/\S`,
    String.raw`\b(?:[a-z0-9-]{1,63}\.){2,5}[a-z]{2,24}\b`,
    String.raw`\b[a-z0-9-]{1,63}\.(?:com|net|org|io|dev|app|xyz|ru|cn|info|biz|co|me|tk|top|site|online|cloud|run|link|ly|gg|ai|so|to)\b`,
    String.raw`\b\d{1,3}(?:\.\d{1,3}){3}\b`, // IPv4
    String.raw`\[[0-9a-f:]{2,45}\]|\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}\b`, // IPv6
    String.raw`\b[a-z][a-z0-9-]{0,62}(?:\.[a-z0-9-]{1,63}){0,5}:\d{2,5}\b`, // host:port
    String.raw`\[\.\]|\(\.\)|\{\.\}|\[dot\]|\(dot\)`, // defanged hosts
    String.raw`\w\s{1,3}\.(?:com|net|org|io|dev|app|xyz|ru|cn|info|biz|co|me|tk|top|site|sh)\b`, // "evil .com"
    String.raw`\w["']{1,2}\.[a-z]{2,24}\b`, // 'evil'.com, "evil"".com"
    String.raw`\$\{?[A-Za-z_][A-Za-z0-9_]{0,60}\}?`,
    String.raw`\$\(`,
  ].join('|'),
  'i',
);
const FETCHER_RE = /\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b/gi;
const FETCH_CONFIG_FLAG_RE = /^(?:-K|--config|-i|--input-file|-T|--upload-file|--url|--url-query)(?:=|$)|^-K\S/;

/**
 * A fetcher given a non-flag argument that looks like an address
 * (`curl intranet/x.sh`, `wget host:8080`, `curl $U`) or a config/list/url flag
 * (`curl -K cfg`, `wget -i list`, `--url x`) has a target, whatever its
 * spelling. Bare `curl | bash` does not — and neither does prose such as
 * "pipe curl into bash", whose "arguments" are plain words.
 */
function fetcherHasArgument(span: string): boolean {
  for (const m of span.matchAll(FETCHER_RE)) {
    const rest = span.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 300);
    const args = rest.split(/[|;&)`\n]/, 1)[0]!.trim().split(/\s+/)
      .map((a) => a.replace(/[.,:;!?'")\]]+$/, ''))
      .filter(Boolean);
    if (args.some((a) => FETCH_CONFIG_FLAG_RE.test(a) || (!a.startsWith('-') && /[/.:@=$~\d[]/.test(a)))) return true;
  }
  return false;
}

function hasTarget(span: string): boolean {
  const s = span.slice(0, 600);
  return TARGET_RE.test(s) || fetcherHasArgument(s);
}

/** skip: pure documentation, dropped. lowconf: documentation that names a target — kept at full severity, low confidence. */
type DocVerdict = 'skip' | 'lowconf' | 'none';

/**
 * Is this match documentation rather than a directive? Only outside fenced
 * code, and only when a negation/discussion word directly governs it. A match
 * with a concrete target is never dropped and never loses severity — it only
 * gets low confidence and a "looks like documentation" note. For rules whose
 * matches never carry a target (override, strong concealment, permission
 * bypass), governance drops a match only when the phrase is itself set off as
 * a quotation — in a code span, quotes or a table cell; otherwise it too is
 * kept at low confidence. (The escape hatch for a real false positive is the
 * baseline or a config `exclude`.)
 */
function documentationVerdict(
  doc: SkillDoc, lineIndex: number, text: string, index: number, length: number, targetless = false,
): DocVerdict {
  if (doc.kind !== 'instructions' || doc.fenced[lineIndex]) return 'none';
  if (!governedNegation(text, index) && !governedDiscussion(text, index, length)) return 'none';
  if (hasTarget(text.slice(index, index + Math.max(length, 1) + 80))) return 'lowconf';
  if (!targetless) return 'skip';
  return isQuoted(text, index, index + length) || isTableRow(text) ? 'skip' : 'lowconf';
}

function isTableRow(line: string): boolean {
  return line.trimStart().startsWith('|');
}

/** Quoted text preceded by an adoption phrase is an instruction being installed, not quoted data. */
const ADOPTION_RE =
  /\b(?:(?:rule|instructions?|prompt|policy|directive|task|goal|job)\s{1,5}(?:is|are|now)|you\s{1,5}are|you\s{1,5}will|from\s{1,5}now\s{1,5}on|always|remember\s{1,5}(?:that|to)|act\s{1,5}as|your\s{1,5}new)\b[^.!?]{0,40}$/i;

/** Quoted data: inside quotes/backticks and NOT preceded by an adoption phrase ("your new rule is \"…\""). */
function isQuotedData(line: string, start: number, end: number): boolean {
  if (!isQuoted(line, start, end)) return false;
  const before = line.slice(Math.max(0, start - 200), start);
  const open = Math.max(before.lastIndexOf('"'), before.lastIndexOf('`'), before.lastIndexOf('\u{201C}'));
  return !ADOPTION_RE.test(before.slice(0, Math.max(0, open)));
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

/** A table row whose first cell is just a flag/setting name: `| --yolo | … |`. */
const FLAG_DOC_ROW_RE = /^\s{0,10}\|\s{0,5}`?(?:--[\w-]{2,60}|bypassPermissions)`?\s{0,5}\|/;
/** A cell that runs something or tells the reader to: code, or an imperative. */
const ROW_DIRECTIVE_RE =
  /`[^`]{0,200}`|\b(?:run|use|execute|launch|invoke|start|pass|add|set|enable|always|call|claude|codex|npx|bash|sh)\b/i;

/**
 * Flag documentation: the first cell is just the flag, and no other cell
 * contains code or an imperative (`| --yolo | always pass this |` is a directive).
 */
function isFlagDocRow(row: string): boolean {
  if (!FLAG_DOC_ROW_RE.test(row)) return false;
  const cells = row.split(/(?<!\\)\|/).slice(2); // [lead, flag cell, …rest]
  return !cells.some((cell) => ROW_DIRECTIVE_RE.test(cell));
}

// ── Shell structure (quote-aware, linear) ─────────────────────────────────────

type Segment = { text: string; start: number; sep: string };

/**
 * Split a command line into segments at unquoted `|`, `||`, `&&`, `;`, `&`.
 * `sep` is the separator AFTER the segment. A quote only opens at a word start
 * (so the apostrophe in "don't" is not a quote); quote tracking is skipped for
 * prose, where quotes delimit a quoted command rather than shell strings.
 */
function splitCommands(text: string, quoteAware: boolean, quoted?: Array<{ start: number; end: number }>): Segment[] {
  const out: Segment[] = [];
  let start = 0;
  let quote = '';
  let quoteStart = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) {
        quote = '';
        if (quoted && quoted.length < 50) quoted.push({ start: quoteStart + 1, end: i });
      }
      continue;
    }
    if (quoteAware && (c === '"' || c === "'") && (i === 0 || /[\s=(:,[{]/.test(text[i - 1]!))) {
      quote = c;
      quoteStart = i;
      continue;
    }
    if (quoteAware && c === '\\') { i++; continue; }
    let sep = '';
    if (c === '|') sep = text[i + 1] === '|' ? '||' : text[i + 1] === '&' ? '|&' : '|';
    else if (c === '&') sep = text[i + 1] === '&' ? '&&' : (text[i - 1] === '>' || text[i + 1] === '>' ? '' : '&');
    else if (c === ';') sep = ';';
    if (!sep) continue;
    out.push({ text: text.slice(start, i), start, sep: sep === '|&' ? '|' : sep });
    i += sep.length - 1;
    start = i + 1;
  }
  out.push({ text: text.slice(start), start, sep: '' });
  return out;
}

const FETCH_CMD = String.raw`(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|aria2c|downloadstring|downloadfile)`;
const FETCH_STAGE_RE = new RegExp(String.raw`(?:^|[\s(\x60{>"':=])${FETCH_CMD}\b`, 'i');
const DECODE_STAGE_RE = /(?:^|[\s(`{>"':=])(?:base64\s{1,5}(?:-\S{1,10}\s{1,5}){0,3}(?:-d|--decode|-D)\b|xxd\s{1,5}(?:-\S{1,10}\s{1,5}){0,3}-r\b|openssl\s{1,5}(?:base64|enc)\b[^|;&\n]{0,80}\s-d\b|uudecode\b)/i;
/** Interpreters that execute whatever arrives on stdin when given no script argument. */
const STDIN_INTERP = String.raw`(?:python[0-9.]{0,5}|node|perl|ruby|php|deno|bun)(?=\s{0,5}$|\s{1,5}-(?:\s|$)|\s{0,5}[;&|)}\x60'"])`;
/**
 * What executes stdin (or its lines): a shell, `$SHELL`, `source /dev/stdin`,
 * a stdin-reading interpreter, `python -c 'exec(sys.stdin.read())'`,
 * `awk '{system($0)}'`, PowerShell's iex.
 */
const SHELL_WORD = String.raw`(?:\$\{?SHELL\}?(?!\w)|(?:source|\.)\s{1,5}\/dev\/stdin\b|(?:ba|z|k|da|fi|a)?sh\b|` +
  String.raw`python[0-9.]{0,5}\s{1,5}-c\s{1,5}["']?[^|\n]{0,80}?(?:exec|eval)\s{0,5}\(\s{0,5}sys\.stdin|` +
  String.raw`g?awk\s{1,5}(?:-\S{1,20}\s{1,5}){0,3}["']?[^|\n]{0,60}?system\s{0,5}\(\s{0,5}\$0|` +
  String.raw`${STDIN_INTERP}|iex\b|invoke-expression\b|pwsh\b|powershell\b)`;
/** Command wrappers that can sit in front of the shell in a pipeline stage. */
const STAGE_WRAPPER = String.raw`(?:` + [
  String.raw`sudo(?:\s{1,5}-{1,2}[\w-]{1,20}(?:[= ]\s{0,3}[\w.@:-]{1,40})?){0,5}`,
  String.raw`env(?:\s{1,5}-\S{1,20}){0,3}(?:\s{1,5}[^\s=]{1,40}=\S{0,100}){0,5}`,
  String.raw`xargs(?:\s{1,5}-\S{1,20}(?:\s{1,5}[^\s-]\S{0,20})?){0,4}`,
  String.raw`busybox`,
  String.raw`nice(?:\s{1,5}-n\s{0,3}-?\d{1,3}|\s{1,5}-\d{1,3})?`,
  String.raw`timeout(?:\s{1,5}-\S{1,20}){0,3}\s{1,5}[\d.]{1,8}[smhd]?`,
  String.raw`nohup`,
  String.raw`exec`,
  String.raw`command`,
  String.raw`stdbuf(?:\s{1,5}-\S{1,20}){0,3}`,
  String.raw`[A-Za-z_]\w{0,40}=\S{0,100}`,
].join('|') + String.raw`)\s{1,5}`;
/**
 * A pipeline stage that is a shell: optional subshell/brace, up to six
 * wrappers (sudo -u x, env A=…, nice, timeout N, exec, command, xargs…), a
 * path prefix, `env`.
 */
const SHELL_STAGE_RE = new RegExp(
  String.raw`^\s{0,5}[({]?\s{0,3}(?:${STAGE_WRAPPER}){0,6}` +
  String.raw`(?:[\w./-]{0,40}\/)?(?:env\s{1,5}(?:-\S{1,20}\s{1,5}){0,3})?` +
  SHELL_WORD,
  'i',
);
/** Pipeline stages followed from the producer to the shell. */
const MAX_PIPE_HOPS = 16;

/**
 * `producer … | [stage |]… shell` over the whole logical command — split on
 * unquoted pipes, so the cost is linear and no window alignment can hide it.
 */
function pipeInto(text: string, producer: RegExp, quoteAware: boolean, depth = 0): Found | undefined {
  if (!text.includes('|')) return undefined;
  const quoted: Array<{ start: number; end: number }> = [];
  const segs = splitCommands(text, quoteAware, quoted);
  const direct = pipeInSegments(text, segs, producer);
  if (direct || depth > 0) return direct;
  // A quoted string can itself be a command: `sh -c "curl … | sh"`, `"postinstall": "curl … | bash"`.
  // Its contents are scanned on their own, so `curl -d 'a|bash' URL` (no fetch before the pipe) stays clean.
  for (const q of quoted) {
    const inner = pipeInto(text.slice(q.start, q.end), producer, true, depth + 1);
    if (inner) return { index: q.start + inner.index, match: fakeMatch(text, q.start + inner.index, q.start + inner.index + inner.match[0].length) };
  }
  return undefined;
}

const SHELL_WORD_HINT_RE = /sh\b|SHELL|stdin|awk|python|node|perl|ruby|php|deno|bun|iex|invoke-expression|pwsh|powershell/i;

function pipeInSegments(text: string, segs: Segment[], producer: RegExp): Found | undefined {
  // Each segment is tested as a shell stage at most once, however many producers look at it.
  const isShell: Array<boolean | undefined> = new Array(segs.length);
  const shellAt = (k: number): boolean => {
    if (isShell[k] === undefined) {
      const head = segs[k]!.text.slice(0, 400);
      isShell[k] = SHELL_WORD_HINT_RE.test(head) && SHELL_STAGE_RE.test(head);
    }
    return isShell[k]!;
  };
  for (let s = 0; s < segs.length; s++) {
    if (segs[s]!.sep !== '|') continue;
    const p = producer.exec(segs[s]!.text);
    if (!p) continue;
    for (let hop = 1; hop <= MAX_PIPE_HOPS && s + hop < segs.length; hop++) {
      const next = segs[s + hop]!;
      if (shellAt(s + hop)) {
        const index = segs[s]!.start + p.index;
        const end = Math.min(text.length, next.start + Math.min(next.text.length, 60));
        return { index, match: fakeMatch(text, index, end) };
      }
      if (next.sep !== '|') break; // the pipeline ended
    }
  }
  return undefined;
}

/**
 * A real verification command (the first word of its segment, not text inside
 * an `echo` or a comment) that actually checks something: `sha256sum -c`,
 * `shasum -c`, `gpg --verify`, `gpgv`, `cosign verify[-blob]`, `minisign -V`,
 * `slsa-verifier verify…`, `openssl dgst … -verify`. A bare `sha256sum x`
 * only prints a hash — it verifies nothing.
 */
const VERIFY_CMD_RE =
  /^\s{0,5}(?:sudo\s{1,5})?(?:(?:sha(?:1|224|256|384|512)sum|shasum)\b(?=[^|;&]{0,300}\s(?:-c|--check)\b)|gpg\b(?=[^|;&]{0,300}\s--verify\b)|gpgv\b|cosign\s{1,5}verify(?:-blob)?\b|minisign\s{1,5}-V\b|slsa-verifier\s{1,5}verify|openssl\s{1,5}dgst\b(?=[^|;&]{0,300}\s-verify\b))/i;
const CHECKSUM_MANIFEST_RE = /^\s{0,5}(?:sudo\s{1,5})?(?:sha(?:1|224|256|384|512)sum|shasum)\b[^|;&]{0,300}\s(?:-c|--check)(?:\s{1,5}|=)(\S{1,300})/i;
const RUN_FILE_RE = /^\s{0,5}(?:sudo\s{1,5}(?:-\S{1,20}\s{1,5}){0,5})?(?:(?:[\w./-]{0,40}\/)?(?:(?:ba|z|k|da)?sh|source|\.|python[0-9.]{0,5}|node|perl|ruby|pwsh|powershell)\s{1,5}(?:-\S{1,20}\s{1,5}){0,3})?(\S{1,300})/i;
/** `X=$(curl …)` — a variable holding fetched content. */
const FETCH_ASSIGN_RE = /^\s{0,5}(?:export\s{1,5}|local\s{1,5}|readonly\s{1,5})?([A-Za-z_]\w{0,60})=["']?(?:\$\(|`)\s{0,5}(?:curl|wget|iwr|irm)\b/i;
/** `eval "$X"` / `bash -c "$X"` / `sh <<< "$X"` — running a variable's content. */
const RUN_VAR_RE = /^\s{0,5}(?:eval|(?:ba|z|k|da)?sh\s{1,5}(?:-c|<<<)|iex|invoke-expression)\s{0,5}\(?\s{0,5}["']?\$\{?([A-Za-z_]\w{0,60})\}?/i;

function fileKey(p: string): string {
  return path.posix.basename(p.replace(/^['"]+|['"]+$/g, '').replace(/\\/g, '/'));
}

/** Exact file-name tokens of a command segment (quotes stripped, basenames) — no substring matching. */
function tokenKeys(seg: string): Set<string> {
  return new Set(seg.split(/\s+/).filter(Boolean).map(fileKey));
}

/** Output file of a download/decode command (`curl -o f`, `curl -O URL`, `wget URL`, `base64 -d > f`). */
function producedFile(seg: string, kind: 'remote' | 'encoded'): string | undefined {
  const redirect = /(?:^|\s)>{1,2}\s{0,3}(\S{1,300})/.exec(seg);
  if (kind === 'encoded') return redirect ? fileKey(redirect[1]!) : undefined;
  const url = /https?:\/\/[^\s'"`)]{1,2000}/i.exec(seg)?.[0];
  if (/\bcurl\b/i.test(seg)) {
    const out = /(?:\s-[a-zA-Z]{0,10}o\s{0,3}|\s--output[= ]\s{0,3})(\S{1,300})/.exec(seg);
    if (out) return fileKey(out[1]!);
    if (/\s-[a-zA-Z]{0,10}O\b|\s--remote-name\b/.test(seg) && url) return fileKey(url.split(/[?#]/)[0]!);
    return redirect ? fileKey(redirect[1]!) : undefined;
  }
  if (/\bwget\b/i.test(seg)) {
    const out = /(?:\s-[a-zA-Z]{0,10}O\s{0,3}|\s--output-document[= ]\s{0,3})(\S{1,300})/.exec(seg);
    if (out) return out[1] === '-' ? undefined : fileKey(out[1]!);
    return url ? fileKey(url.split(/[?#]/)[0]!) : undefined;
  }
  return redirect ? fileKey(redirect[1]!) : undefined;
}

/** A local hash command writing a checksum file: `sha256sum x.sh > x.sum` — a self-certified manifest. */
const HASH_TO_FILE_RE =
  /^\s{0,5}(?:sudo\s{1,5})?(?:(?:sha(?:1|224|256|384|512)|md5|b2)sum|shasum|openssl\s{1,5}dgst)\b(?![^|;&]{0,300}\s(?:-c|--check)\b)[^|;&]{0,300}>{1,2}\s{0,3}(\S{1,300})/i;
/** Any local hash command (feeding a `-c -` check from it is self-certification too). */
const HASH_CMD_RE = /^\s{0,5}(?:sudo\s{1,5})?(?:(?:sha(?:1|224|256|384|512)|md5|b2)sum|shasum|openssl\s{1,5}dgst)\b/i;
/** Candidates worth a chain scan when nothing is being tracked yet. */
const CHAIN_HINT_RE = /curl|wget|iwr|irm|invoke-web|base64|xxd|openssl|uudecode|sum\b|gpg|cosign|minisign|slsa/i;

/** Whether a checksum manifest exists in the repo (a pre-existing, reviewable file). */
type ManifestExists = (name: string) => boolean;

type ChainHit = { rule: 'remote-exec' | 'encoded-exec'; found: Found; fromLine: number };

/**
 * Tracks content produced by a download (or a decode) and reports when it is
 * executed later: `curl -o x URL && chmod +x x && ./x`, `base64 -d > f; sh f`,
 * `X=$(curl …); eval "$X"`. Lines of one script, or one fenced block, are fed
 * in order and behave like `;`-separated commands, so a download on one line
 * and its execution on another are still caught.
 *
 * A download is cleared only by a REAL verification command, chained with
 * `&&` to both the fetch and the run on the same logical line (a failed check
 * must stop the run — `;`, `||` and a new line do not), that names the
 * executed file exactly: a `-c` manifest that was itself fetched in the chain
 * or already exists in the repo — never one generated locally (`sha256sum x >
 * x.sum`), a here-string or process substitution, or a check run with
 * `--ignore-missing` — a piped checksum line (`echo "h  x.sh" | sha256sum -c -`,
 * not piped from a local hash command), or `gpg --verify sig x.sh`.
 */
class ChainScanner {
  private readonly produced = new Map<string, { kind: 'remote' | 'encoded'; line: number; feed: number; seg: number; index: number }>();
  private readonly fetchedVars = new Map<string, { line: number; feed: number; index: number }>();
  private readonly generated = new Set<string>();
  private feeds = 0;

  constructor(private readonly manifestExists: ManifestExists = () => false) {}

  feed(text: string, line: number, quoteAware: boolean): ChainHit | undefined {
    const feedId = ++this.feeds;
    if (this.produced.size === 0 && this.fetchedVars.size === 0 && !CHAIN_HINT_RE.test(text)) return undefined;
    let segs = splitCommands(text, quoteAware).slice(0, 500);
    // A comment ends the command line: nothing after `#` runs (or verifies).
    const commentAt = segs.findIndex((s) => /(?:^|\s)#/.test(s.text));
    if (commentAt >= 0) {
      const s = segs[commentAt]!;
      segs = [...segs.slice(0, commentAt), { ...s, text: s.text.slice(0, s.text.search(/(?:^|\s)#/)), sep: '' }];
    }
    const isVerify = segs.map((s) => VERIFY_CMD_RE.test(s.text));
    /** Every separator from segment `from` up to `to` (same line) is `&&`, or the pipe feeding a verify command. */
    const chainedAnd = (from: number, to: number): boolean => {
      for (let m = from; m < to; m++) {
        const sep = segs[m]!.sep;
        if (sep === '&&') continue;
        if (sep === '|' && isVerify[m + 1]) continue;
        return false;
      }
      return true;
    };
    const verifiedAt = new Map<string, number[]>();

    for (let k = 0; k < segs.length; k++) {
      const seg = segs[k]!;
      const t = seg.text;
      const at = seg.start + Math.max(0, t.search(/\S/));
      const assign = FETCH_ASSIGN_RE.exec(t);
      if (assign) {
        this.fetchedVars.set(assign[1]!, { line, feed: feedId, index: at });
        continue;
      }
      const isFetch = FETCH_STAGE_RE.test(t) && /https?:\/\//i.test(t);
      const isDecode = DECODE_STAGE_RE.test(t);
      if (isFetch || isDecode) {
        const kind = isFetch ? 'remote' : 'encoded';
        const file = producedFile(t, kind);
        if (file) this.produced.set(file, { kind, line, feed: feedId, seg: k, index: at });
        continue;
      }
      const generated = HASH_TO_FILE_RE.exec(t);
      if (generated) {
        this.generated.add(fileKey(generated[1]!));
        continue;
      }
      if (isVerify[k]) {
        for (const file of this.verifiedFiles(t, k > 0 && segs[k - 1]!.sep === '|' ? segs[k - 1]!.text : undefined)) {
          verifiedAt.set(file, [...(verifiedAt.get(file) ?? []), k]);
        }
        continue;
      }
      const runVar = RUN_VAR_RE.exec(t);
      if (runVar && this.fetchedVars.has(runVar[1]!)) {
        const src = this.fetchedVars.get(runVar[1]!)!;
        return this.hit('remote-exec', text, src.feed === feedId ? src.index : at, seg.start + t.length, src.line);
      }
      // `chmod +x f` and `cat f` are not executions.
      if (/^\s{0,5}(?:chmod|cat|ls|rm|mv|cp|echo|printf|test|\[)\b/i.test(t)) continue;
      const run = RUN_FILE_RE.exec(t);
      if (!run) continue;
      const file = fileKey(run[1]!);
      const source = this.produced.get(file);
      if (!source) continue;
      const verified = source.kind === 'remote' && source.feed === feedId &&
        (verifiedAt.get(file) ?? []).some((v) => v > source.seg && chainedAnd(source.seg, k));
      if (verified) continue;
      return this.hit(source.kind === 'remote' ? 'remote-exec' : 'encoded-exec', text,
        source.feed === feedId ? source.index : at, seg.start + t.length, source.line);
    }
    return undefined;
  }

  /** Files a verification segment really checks. */
  private verifiedFiles(t: string, pipedFrom: string | undefined): string[] {
    const produced = [...this.produced.keys()];
    // Self-certification: nothing checked against a locally generated or inline manifest counts.
    if (/--ignore-missing\b|<<<|<\(/.test(t)) return [];
    const manifest = CHECKSUM_MANIFEST_RE.exec(t)?.[1];
    if (manifest !== undefined) {
      if (manifest === '-' || manifest === '/dev/stdin') {
        if (pipedFrom === undefined || HASH_CMD_RE.test(pipedFrom) || /<\(|\$\(/.test(pipedFrom)) return [];
        const names = tokenKeys(pipedFrom);
        return produced.filter((f) => names.has(f));
      }
      const key = fileKey(manifest);
      if (manifest.startsWith('<') || this.generated.has(key)) return [];
      const fetched = this.produced.get(key)?.kind === 'remote';
      if (!fetched && !this.manifestExists(manifest.replace(/^['"]+|['"]+$/g, ''))) return [];
      return produced; // a real manifest covers what it lists
    }
    const names = tokenKeys(t);
    return produced.filter((f) => names.has(f));
  }

  private hit(rule: ChainHit['rule'], text: string, index: number, end: number, fromLine: number): ChainHit {
    const i = Math.min(index, text.length);
    return { rule, found: { index: i, match: fakeMatch(text, i, Math.max(i, Math.min(text.length, end))) }, fromLine };
  }
}

/**
 * Regex patterns whose longest match stays well inside the window overlap,
 * each behind a cheap prefilter a window must pass first.
 */
type Guarded = { requires: (window: string) => boolean; pattern: RegExp };

const REMOTE_EXEC_PATTERNS: Guarded[] = [
  // bash <(curl …)   /   bash < <(curl …)   /   source <(wget …)
  {
    requires: (w) => w.includes('<('),
    pattern: /(?:^|[\s;&|(`])(?:(?:[\w./-]{0,40}\/)?(?:ba|z|k)?sh|source|\.)\s{1,5}(?:<\s{0,3})?<\(\s{0,5}(?:curl|wget)\b/i,
  },
  // sh -c "$(curl …)"   /   eval "$(wget …)"   /   bash <<< "$(curl …)"
  {
    requires: (w) => w.includes('$(') || w.includes('`'),
    pattern: /\b(?:(?:ba|z|k)?sh\s{1,5}(?:-c|<<<)|eval|python[0-9.]{0,5}\s{1,5}-c|node\s{1,5}-e|perl\s{1,5}-e|ruby\s{1,5}-e)\s{0,5}["']?(?:\$\(|`)\s{0,5}(?:curl|wget)\b/i,
  },
  // iex (iwr …)   /   iex (curl …)   /   Invoke-Expression ((New-Object Net.WebClient).DownloadString(…))
  {
    requires: (w) => /iex|invoke-expression/i.test(w) && /iwr|irm|curl|wget|invoke-web|invoke-rest|downloadstring|webclient/i.test(w),
    pattern: /\b(?:iex|invoke-expression)\b[^\n]{0,120}\b(?:iwr|irm|curl|wget|invoke-webrequest|invoke-restmethod|downloadstring|net\.webclient)\b/i,
  },
];

const ENCODED_EXEC_PATTERNS: Guarded[] = [
  // eval "$(echo … | base64 -d)"   /   sh -c "$(… | base64 -d)"
  {
    requires: (w) => w.includes('$(') && /base64|xxd/i.test(w),
    pattern: /\b(?:eval|(?:ba|z|k)?sh\s{1,5}-c)\s{0,5}["']?\$\([^)\n]{0,300}(?:base64\s{1,5}(?:-\S{1,10}\s{1,5}){0,3}(?:-d|--decode|-D)|xxd\s{1,5}(?:-\S{1,10}\s{1,5}){0,3}-r)\b/i,
  },
  // eval(atob(…))   /   exec(base64.b64decode(…))   /   exec(__import__('base64').b64decode(…))
  {
    requires: (w) => /atob|Buffer\.from|b64decode|decodebytes|codecs\.decode|FromBase64String|a85decode|b32decode/i.test(w),
    pattern: /\b(?:eval|exec|Function|Invoke-Expression|iex)\s{0,5}\(?[^\n]{0,80}?(?:atob|Buffer\.from|b64decode|b32decode|a85decode|decodebytes|codecs\.decode|FromBase64String)\b/i,
  },
  {
    requires: (w) => /powershell|pwsh/i.test(w) && /\s-(?:e|ec|enc|encodedcommand)\s{1,5}[A-Za-z0-9+/]{20}/i.test(w),
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
  /\b(?:ignore|disregard|forget)\s{1,5}(?:all\s{1,5}|any\s{1,5}|every\s{1,5})?(?:of\s{1,5})?(?:the\s{1,5}|your\s{1,5}|my\s{1,5}|these\s{1,5}|those\s{1,5})?(?:previous|prior|above|earlier|preceding|system|developer|safety)\s{1,5}(?:instructions?|prompts?|rules|guidelines|directives|messages?|context)\b(?![\w/-]|\.[\w/]|\s{1,5}(?:files?|folders?|director(?:y|ies)|docs?|pages?|in\s{1,5}\S{0,80}\/))/i,
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
const HIDDEN_STYLE_RE =
  /\sstyle\s{0,5}=\s{0,5}["'][^"'>]{0,200}(?:display\s{0,5}:\s{0,5}none|visibility\s{0,5}:\s{0,5}hidden|font-size\s{0,5}:\s{0,5}0(?:px|pt|em|rem)?\s{0,5}(?:;|["'])|opacity\s{0,5}:\s{0,5}0(?:\.0{1,5})?\s{0,5}(?:;|["']))/i;
const HIDDEN_ATTR_RE = /\shidden(?:\s|=|\/|$)/i;
/** Tooling directives and section markers that legitimately live in comments. */
const BENIGN_COMMENT_RE =
  /^\s{0,20}(?:promptci-ignore|markdownlint|prettier|eslint|cspell|textlint|vale\b|toc\b|omit\s{1,5}in\s{1,5}toc|end\s{0,5}toc|mdformat|lint|region|endregion|#region|#endregion|@formatter|todo\b|fixme\b|xxx\b)/i;
/** Comment content that is always suspicious, even behind a benign-looking prefix. */
const STRONG_COMMENT_RE =
  /\b(?:ignore|disregard|forget)\b[^\n]{0,40}\b(?:instructions?|prompts?|rules|guidelines)\b|\bsystem\s{1,5}prompt\b|\b(?:curl|wget|iwr|invoke-webrequest)\b|\bbase64\s{1,5}-d\b|~\/\.ssh|\b(?:send|upload|exfiltrate)\b[^\n]{0,40}\b(?:secrets?|credentials?|keys?|tokens?|\.env)\b/i;
/** A second-person or imperative directive: a benign-looking prefix does not excuse it. */
const COMMENT_DIRECTIVE_RE =
  /\byou\b|\b(?:must|always|never|approve|run|ignore|execute|send|upload|install|delete|disable|download|fetch|read|print|reveal)\b/i;
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
 * `npx tool@latest` — found from the tag backwards: each `@latest` looks back a
 * bounded distance for an installer on the same command.
 */
const LATEST_TAG_RE = /(?<=[\w.-])@(?:latest|master|main|HEAD)(?![\w.-])/gi;
const INSTALLER_BEFORE_RE =
  /\b(?:npx|bunx|pnpm\s{1,5}dlx|yarn\s{1,5}dlx|uvx|pipx\s{1,5}run|npm\s{1,5}(?:i|install|exec|add)|pnpm\s{1,5}(?:add|i|install)|yarn\s{1,5}add|bun\s{1,5}(?:add|i|install|x)|go\s{1,5}(?:install|run)|deno\s{1,5}(?:run|install))\b[^\n;&|]{0,200}$/i;
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

function latestInstall(text: string): Found | undefined {
  if (!/@(?:latest|master|main|head)/i.test(text)) return undefined;
  for (const tag of findAll(LATEST_TAG_RE, text, 10)) {
    if (INSTALLER_BEFORE_RE.test(text.slice(Math.max(0, tag.index - 230), tag.index))) return tag;
  }
  return undefined;
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
/** Hits kept per rule per file. Scanning continues past it; higher-severity hits displace lower ones. */
const MAX_HITS_PER_RULE_FILE = 25;

function outranks(a: Hit, b: Hit): boolean {
  const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  return s !== 0 ? s > 0 : a.confidence > b.confidence;
}

class HitCollector {
  private readonly groups = new Map<string, { rule: SkillSupplyChainRule; file: string; hits: Hit[]; total: number }>();

  /** Would a hit of this strength be kept? (Full groups keep only their strongest hits.) */
  accepts(rule: SkillSupplyChainRule, file: string, severity: IssueSeverity, confidence: number): boolean {
    const group = this.groups.get(`${rule}|${file}`);
    if (!group || group.hits.length < MAX_HITS_PER_RULE_FILE) return true;
    const probe: Hit = { excerpt: '', severity, confidence };
    return group.hits.some((h) => outranks(probe, h));
  }

  /** Count a hit that was not kept, so the evidence can say how many more there were. */
  count(rule: SkillSupplyChainRule, file: string): void {
    const group = this.groups.get(`${rule}|${file}`);
    if (group) group.total++;
  }

  add(rule: SkillSupplyChainRule, file: string, hit: Hit): void {
    const key = `${rule}|${file}`;
    let group = this.groups.get(key);
    if (!group) {
      group = { rule, file, hits: [], total: 0 };
      this.groups.set(key, group);
    }
    if (group.hits.some((h) => h.line === hit.line && h.excerpt === hit.excerpt)) return;
    group.total++;
    if (group.hits.length < MAX_HITS_PER_RULE_FILE) {
      group.hits.push(hit);
      return;
    }
    // Full: keep the strongest hits, so a flood of weak matches cannot hide a later strong one.
    let weakest = 0;
    for (let i = 1; i < group.hits.length; i++) if (outranks(group.hits[weakest]!, group.hits[i]!)) weakest = i;
    if (outranks(hit, group.hits[weakest]!)) group.hits[weakest] = hit;
  }

  toIssues(skillMd: string): PromptCiIssue[] {
    return [...this.groups.values()]
      .filter((g) => g.hits.length > 0)
      .sort((a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file))
      .map(({ rule, file, hits, total }) => buildIssue(skillMd, rule, file, hits, total));
  }
}

function buildIssue(skillMd: string, rule: SkillSupplyChainRule, file: string, hits: Hit[], total: number): PromptCiIssue {
  const spec = RULES[rule];
  // Evidence: the strongest hits (the maximum severity is always shown), displayed in file order.
  const byStrength = hits
    .map((h, order) => ({ h, order }))
    .sort((a, b) => (outranks(a.h, b.h) ? -1 : outranks(b.h, a.h) ? 1 : a.order - b.order));
  const top = byStrength[0]!.h;
  const shown = byStrength.slice(0, MAX_EVIDENCE)
    .sort((a, b) => ((a.h.line ?? 0) - (b.h.line ?? 0)) || a.order - b.order)
    .map((x) => x.h);
  const shownFile = visible(file);
  const evidence = shown.map((h) => (rule === 'unscanned-files' ? h.excerpt : `${shownFile}: ${h.excerpt}`));
  if (total > shown.length) {
    evidence.push(rule === 'unscanned-files'
      ? `…and ${total - shown.length} more unscanned item(s)`
      : `${shownFile}: …and ${total - shown.length} more match(es)`);
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

/** `excerptText` may be a thunk: it is only rendered when the collector keeps the hit. */
type Add = (rule: SkillSupplyChainRule, line: number, excerptText: string | (() => string), severity: IssueSeverity, confidence: number) => void;
const render = (t: string | (() => string)): string => (typeof t === 'function' ? t() : t);

/** Confidence given to a match that looks like documentation but names a concrete target. */
const DOCUMENTED_CONFIDENCE = 0.4;

/** Record a hit under a documentation verdict: skipped, kept at low confidence (same severity), or as-is. */
function addJudged(
  add: Add, verdict: DocVerdict, rule: SkillSupplyChainRule, line: number, text: string | (() => string),
  severity: IssueSeverity, confidence: number,
): void {
  if (verdict === 'skip') return;
  if (verdict === 'lowconf') add(rule, line, () => `(looks like documentation, but names a target) ${render(text)}`, severity, DOCUMENTED_CONFIDENCE);
  else add(rule, line, text, severity, confidence);
}

/** remote-exec + encoded-exec (+ one-line remote-eval in instruction code). Returns consumed lines. */
/** Cheap per-line prefilter: a line with none of these cannot match any exec rule. */
const EXEC_HINT_RE = /[|&;<$`]|iex|invoke-expression|atob|decode|FromBase64|powershell|pwsh/i;

/** remote-exec / encoded-exec matches in one logical command. */
function execMatches(text: string, quoteAware: boolean): Array<{ rule: SkillSupplyChainRule; found: Found }> {
  const hits: Array<{ rule: SkillSupplyChainRule; found: Found }> = [];
  if (!EXEC_HINT_RE.test(text)) return hits;
  const pipe = pipeInto(text, FETCH_STAGE_RE, quoteAware);
  if (pipe) hits.push({ rule: 'remote-exec', found: pipe });
  const decodedPipe = pipeInto(text, DECODE_STAGE_RE, quoteAware);
  if (decodedPipe) hits.push({ rule: 'encoded-exec', found: decodedPipe });
  if (!hits.some((h) => h.rule === 'remote-exec')) {
    for (const g of REMOTE_EXEC_PATTERNS) {
      const f = findFirst(g.pattern, text, g.requires);
      if (f) { hits.push({ rule: 'remote-exec', found: f }); break; }
    }
  }
  if (!hits.some((h) => h.rule === 'encoded-exec')) {
    for (const g of ENCODED_EXEC_PATTERNS) {
      const f = findFirst(g.pattern, text, g.requires);
      if (f) { hits.push({ rule: 'encoded-exec', found: f }); break; }
    }
  }
  return hits;
}

/**
 * Block ids for chain tracking: a whole script/config file is one block; in
 * markdown each fenced block is one block and every prose line its own.
 */
function chainBlocks(doc: SkillDoc): (lineIndex: number) => number {
  if (doc.kind !== 'instructions') return () => 0;
  const ids = new Int32Array(doc.lines.length);
  let id = 0;
  for (let i = 0; i < doc.lines.length; i++) {
    if (doc.fenced[i] && !(i > 0 && doc.fenced[i - 1])) id++;
    ids[i] = doc.fenced[i] ? id : -(i + 1);
  }
  return (i) => ids[i]!;
}

function checkExec(doc: SkillDoc, logical: Logical[], commands: Logical[], add: Add, manifestExists?: ManifestExists): Set<number> {
  const consumed = new Set<number>();
  const blockOf = chainBlocks(doc);
  let chain = new ChainScanner(manifestExists);
  let block = Number.NaN;
  for (const { text, line } of logical) {
    const i = line - 1;
    const quoteAware = doc.kind !== 'instructions' || doc.fenced[i] === 1;
    const b = blockOf(i);
    if (b !== block) {
      chain = new ChainScanner(manifestExists);
      block = b;
    }
    const hits: Array<{ rule: SkillSupplyChainRule; found: Found; note?: string }> = execMatches(text, quoteAware);
    const chained = chain.feed(text, line, quoteAware);
    if (chained) {
      hits.push({
        rule: chained.rule,
        found: chained.found,
        note: chained.fromLine !== line ? `(fetched/decoded at line ${chained.fromLine}) ` : undefined,
      });
    }
    for (const { rule, found, note } of hits) {
      const len = found.match[0].length;
      const verdict = documentationVerdict(doc, i, text, found.index, len);
      addJudged(add, verdict, rule, line, () => `${note ?? ''}${excerpt(text, found.index, len)}`, 'high', 0.85);
      if (verdict !== 'skip') consumed.add(line);
    }
  }
  if (doc.kind === 'instructions') {
    // `exec(requests.get(url).text)` in a SKILL.md code sample is still a remote-code loader.
    for (const { text, line } of commands) {
      if (consumed.has(line)) continue;
      const hit = findFirst(DIRECT_REMOTE_EVAL_RE, text);
      if (!hit) continue;
      consumed.add(line);
      add('remote-eval', line, excerpt(text, hit.index, hit.match[0].length), 'high', 0.85);
    }
  }
  return consumed;
}

function firstLineMatching(doc: SkillDoc, re: RegExp): { line: number; index: number } | undefined {
  for (const i of doc.active) {
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
  const evalPatterns = EVAL_PATTERNS[doc.lang] ?? [];
  const loadPatterns = DYNAMIC_LOAD_PATTERNS[doc.lang] ?? [];

  for (const i of doc.active) {
    const line = i + 1;
    if (consumed.has(line)) continue;
    const text = doc.lines[i]!;
    const direct = findFirst(DIRECT_REMOTE_EVAL_RE, text);
    if (direct) {
      add('remote-eval', line, excerpt(text, direct.index, direct.match[0].length), 'high', 0.85);
      continue;
    }
    if (evalHits.length + loadHits.length >= MAX_HITS_PER_RULE_FILE) continue;
    const ev = evalPatterns.map((re) => findFirst(re, text)).find(Boolean);
    if (ev) { evalHits.push({ line, index: ev.index }); continue; }
    const ld = loadPatterns.map((re) => findFirst(re, text)).find(Boolean);
    if (ld) loadHits.push({ line, index: ld.index });
  }

  if (network && (evalHits.length > 0 || loadHits.length > 0)) {
    add('remote-eval', network.line, `network call: ${excerpt(doc.lines[network.line - 1]!, network.index)}`, 'high', 0.75);
    for (const h of [...evalHits, ...loadHits]) add('remote-eval', h.line, excerpt(doc.lines[h.line - 1]!, h.index), 'high', 0.75);
  } else {
    for (const h of evalHits) add('dynamic-eval', h.line, excerpt(doc.lines[h.line - 1]!, h.index), 'warning', 0.6);
  }

  if (!network) return;
  const sources: Array<{ line: number; index: number }> = [];
  for (const i of doc.active) {
    if (sources.length >= MAX_HITS_PER_RULE_FILE) break;
    const text = doc.lines[i]!;
    const m = findFirst(BULK_ENV_RE, text) ?? findFirst(CREDENTIAL_SOURCE_RE, text);
    if (!m) continue;
    // `ssh -i ~/.ssh/id_rsa host` / `IdentityFile` uses the key to authenticate — it is not read out.
    if (/(?:\s-i\s{0,5}|IdentityFile\s{1,5}|identity_file\s{0,5}=\s{0,5})\S{0,300}$/.test(text.slice(Math.max(0, m.index - 300), m.index + 1))) continue;
    sources.push({ line: i + 1, index: m.index });
  }
  if (sources.length === 0) return;
  add('credential-exfil', network.line, `network call: ${excerpt(doc.lines[network.line - 1]!, network.index)}`, 'high', 0.7);
  for (const s of sources) add('credential-exfil', s.line, `credential/env read: ${excerpt(doc.lines[s.line - 1]!, s.index)}`, 'high', 0.7);
}

/**
 * First match of any pattern with its documentation verdict. `negatable:
 * false` is for patterns that embed their own negation; `skipQuoted` treats a
 * quoted phrase (a documented injection string) as data.
 */
function directive(
  doc: SkillDoc,
  lineIndex: number,
  text: string,
  patterns: RegExp[],
  opts: { skipQuoted?: boolean; negatable?: boolean; targetless?: boolean } = {},
): { found: Found; verdict: DocVerdict } | undefined {
  for (const re of patterns) {
    const m = findFirst(re, text);
    if (!m) continue;
    const len = m.match[0].length;
    if (opts.skipQuoted && isQuotedData(text, m.index, m.index + len)) continue;
    let verdict: DocVerdict;
    if (opts.negatable === false) {
      verdict = !doc.fenced[lineIndex] && governedDiscussion(text, m.index, len)
        ? (hasTarget(text.slice(m.index, m.index + len + 80)) ? 'lowconf' : 'skip')
        : 'none';
    } else {
      verdict = documentationVerdict(doc, lineIndex, text, m.index, len, opts.targetless);
    }
    if (verdict === 'skip') continue;
    return { found: m, verdict };
  }
  return undefined;
}

/** exfil-instruction for one clause: verb → secret → preposition → destination, each in a bounded window. */
function checkExfil(clause: string): {
  index: number; severity: IssueSeverity; confidence: number; strong: boolean; negated: boolean; target: boolean;
} | undefined {
  for (const verb of findAll(EXFIL_VERB_RE, clause, 20)) {
    // A negated verb is still examined: "never send the keys to https://evil" names a target and is kept.
    const negated = governedNegation(clause, verb.index);
    const afterVerb = verb.index + verb.match[0].length;
    const window = clause.slice(afterVerb, afterVerb + 120);
    const bulk = SECRET_BULK_RE.exec(window);
    const single = bulk ? null : SECRET_SINGLE_RE.exec(window);
    const secret = bulk ?? single;
    if (!secret) continue;
    const afterSecret = afterVerb + secret.index + secret[0].length;
    const prep = PREPOSITION_RE.exec(clause.slice(afterSecret, afterSecret + 120));
    if (!prep) continue;
    const destStart = afterSecret + prep.index + prep[0].length;
    const dest = clause.slice(destStart, destStart + 100);
    const strong = EXFIL_DEST_STRONG_RE.test(dest);
    // Auth context ("in the Authorization header") only excuses a non-exfil destination.
    if (!strong && AUTH_CONTEXT_RE.test(clause)) continue;
    const target = hasTarget(dest);
    const base = { index: verb.index, strong, negated, target };
    if (strong) return { ...base, severity: 'high', confidence: 0.75 };
    if (bulk && EXFIL_DEST_ANY_RE.test(dest)) return { ...base, severity: 'warning', confidence: 0.6 };
    if (single && EXFIL_DEST_EXTERNAL_RE.test(dest)) return { ...base, severity: 'warning', confidence: 0.6 };
  }
  return undefined;
}

/** Clauses of a line with their offsets: split on terminal punctuation or `;` followed by whitespace. */
function clauses(line: string): Array<{ text: string; offset: number }> {
  const out: Array<{ text: string; offset: number }> = [];
  let offset = 0;
  for (const part of line.split(/(?<=[.!?;])\s+/)) {
    const at = line.indexOf(part, offset);
    out.push({ text: part, offset: at });
    offset = at + part.length;
  }
  return out;
}

/** Prose rules — instruction files (SKILL.md, reference docs). */
function checkProse(doc: SkillDoc, add: Add): void {
  const record = (rule: SkillSupplyChainRule, line: number, text: string, r: { found: Found; verdict: DocVerdict }, severity: IssueSeverity, confidence: number) =>
    addJudged(add, r.verdict, rule, line, excerpt(text, r.found.index, r.found.match[0].length), severity, confidence);

  for (const i of doc.active) {
    const text = doc.lines[i]!;
    if (text.length < 8) continue;
    const line = i + 1;

    if (OVERRIDE_HINT_RE.test(text)) {
      const r = directive(doc, i, text, OVERRIDE_PATTERNS, { skipQuoted: true, targetless: true });
      if (r) record('instruction-override', line, text, r, 'high', 0.8);
    }

    if (CONCEAL_HINT_RE.test(text)) {
      const strong = directive(doc, i, text, CONCEAL_STRONG, { targetless: true });
      const soft = strong ? undefined : directive(doc, i, text, CONCEAL_SOFT, { negatable: false });
      if (strong) record('conceal-from-user', line, text, strong, 'high', 0.75);
      else if (soft) record('conceal-from-user', line, text, soft, 'warning', 0.6);
    }

    if (BYPASS_HINT_RE.test(text)) {
      const r = directive(doc, i, text, BYPASS_PROSE, { targetless: true });
      if (r) record('permission-bypass', line, text, r, 'warning', 0.6);
    }

    if (EXFIL_VERB_PREFILTER_RE.test(text)) {
      for (const c of clauses(text)) {
        if (!EXFIL_VERB_PREFILTER_RE.test(c.text)) continue;
        const hit = checkExfil(c.text);
        if (!hit) continue;
        const at = c.offset + hit.index;
        const governed = !doc.fenced[i] && (hit.negated || governedDiscussion(text, at, 10));
        const verdict: DocVerdict = !governed ? 'none' : hit.target ? 'lowconf' : 'skip';
        addJudged(add, verdict, 'exfil-instruction', line, excerpt(text, at, 60), hit.severity, hit.confidence);
        break;
      }
    }
  }
}

/** permission-bypass flags — every file kind. Only a flag-documentation table row is exempt. */
function checkBypassFlags(doc: SkillDoc, add: Add): void {
  for (const i of doc.active) {
    const text = doc.lines[i]!;
    const m = findFirst(BYPASS_FLAG_RE, text);
    if (!m) continue;
    if (doc.kind === 'instructions' && !doc.fenced[i] && isFlagDocRow(text)) continue;
    const len = m.match[0].length;
    addJudged(add, documentationVerdict(doc, i, text, m.index, len, true), 'permission-bypass', i + 1,
      () => excerpt(text, m.index, len), 'warning', 0.7);
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

/** hidden-unicode — every file kind. Every line is examined: a severe payload after many mild lines still counts. */
function checkHiddenUnicode(doc: SkillDoc, add: Add): void {
  for (const i of doc.active) {
    const lineText = doc.lines[i]!;
    // Fast path: plain printable ASCII (plus tab) cannot hide anything.
    if (!/[^\t\x20-\x7e]/.test(lineText)) continue;
    const chars = Array.from(lineText);
    let rtl: boolean | undefined;
    const hasRtl = () => (rtl ??= RTL_SCRIPT_RE.test(lineText));
    const found = new Map<number, number>();
    let severe = false;
    let firstOffset = -1;
    let severeOffset = -1;
    let offset = 0;
    let tagRunPrev: number | undefined;
    let prevWasTag = false;
    for (let k = 0; k < chars.length; k++) {
      const ch = chars[k]!;
      const cp = ch.codePointAt(0)!;
      const isTag = cp >= 0xe0000 && cp <= 0xe007f;
      if (isTag && !prevWasTag) tagRunPrev = k > 0 ? chars[k - 1]!.codePointAt(0) : undefined;
      prevWasTag = isTag;
      const cls = hiddenClass(chars, k, i, tagRunPrev, hasRtl);
      if (cls) {
        if (cls === 'severe' && severeOffset < 0) severeOffset = offset;
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
    const focus = severe ? severeOffset : firstOffset;
    add('hidden-unicode', i + 1, `${counts}${more} in: ${excerpt(lineText, focus, 1)}`, severe ? 'high' : 'warning', severe ? 0.9 : 0.7);
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

/**
 * Hidden HTML elements, found with a single left-to-right walk over `<`: a
 * candidate tag runs to the next `>` unless another `<` comes first, so each
 * character is visited a bounded number of times however the tags nest.
 */
function hiddenElementAt(text: string): Found | undefined {
  let pos = 0;
  let gt = -1; // cached position of the next `>` — each `>` is searched for once
  while (pos < text.length) {
    const lt = text.indexOf('<', pos);
    if (lt < 0) return undefined;
    if (gt !== text.length && gt <= lt) {
      gt = text.indexOf('>', lt + 1);
      if (gt < 0) gt = text.length;
    }
    const end = gt;
    const nextLt = text.indexOf('<', lt + 1);
    if (nextLt >= 0 && nextLt < end) { pos = nextLt; continue; }
    pos = end + 1;
    if (end - lt > 600 || !/^<[a-z]/i.test(text.slice(lt, lt + 2))) continue;
    const tag = text.slice(lt, end);
    if (HIDDEN_STYLE_RE.test(tag) || HIDDEN_ATTR_RE.test(tag)) return { index: lt, match: fakeMatch(text, lt, end + 1) };
  }
  return undefined;
}

/** hidden-html-comment, hidden-html-element, encoded-blob — instruction files. */
function checkHiddenMarkup(doc: SkillDoc, add: Add): void {
  if (doc.content.includes('<!--')) checkHiddenComments(doc, add);

  for (const i of doc.active) {
    if (doc.fenced[i]) continue;
    const text = doc.lines[i]!;
    if (!text.includes('<') || !/style|hidden/i.test(text)) continue;
    const el = hiddenElementAt(text);
    if (el) add('hidden-html-element', i + 1, excerpt(text, el.index, el.match[0].length), 'warning', 0.6);
  }

  for (const i of doc.active) {
    const text = doc.lines[i]!;
    if (text.length < 200) continue;
    const blob = findAll(BLOB_RE, text, 5).find((b) => {
      const s = b.match[0];
      if (/(?:base64,|data:[^,\s]{0,100},)\s{0,5}$/i.test(text.slice(Math.max(0, b.index - 120), b.index))) return false; // data: URI
      if (!/[0-9]/.test(s) || !/[A-Z]/.test(s) || !/[a-z]/.test(s)) return false;
      return (s.match(/\//g)?.length ?? 0) <= s.length / 10; // more slashes = a long path, not a payload
    });
    if (blob) add('encoded-blob', i + 1, `${blob.match[0].length}-char encoded string: ${blob.match[0].slice(0, 40)}…`, 'warning', 0.5);
  }
}

function checkHiddenComments(doc: SkillDoc, add: Add): void {
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
    // A tooling directive or TODO is exempt only when the WHOLE comment is short and plain.
    if (BENIGN_COMMENT_RE.test(body.slice(0, 200)) && body.length <= 120 &&
        !STRONG_COMMENT_RE.test(body) && !COMMENT_DIRECTIVE_RE.test(body)) continue;
    const hit = findFirst(AGENT_DIRECTED_RE, body);
    if (!hit) continue;
    const line = lineAt(lineStarts, start + 4 + hit.index);
    const lineText = doc.lines[line - 1] ?? '';
    const col = start + 4 + hit.index - lineStarts[line - 1]!;
    add('hidden-html-comment', line, () => excerpt(lineText, col, hit.match[0].length), 'warning', 0.6);
  }
}

// ── unpinned-remote-dep ───────────────────────────────────────────────────────

/**
 * The text a reader is meant to *run*: every logical line of a script or config
 * file, but only fenced blocks and inline `code spans` of an instruction file
 * (prose such as "npm install and then run tests/foo.js" is not a command).
 * An inline span governed by a negation/discussion word is documentation.
 */
function commandTexts(doc: SkillDoc, logical: Logical[]): Logical[] {
  if (doc.kind !== 'instructions') return logical;
  const out: Logical[] = [];
  for (const l of logical) {
    if (doc.fenced[l.line - 1]) {
      out.push(l);
      continue;
    }
    if (!l.text.includes('`')) continue;
    for (const span of findAll(/`([^`\n]{1,1000})`/g, l.text, 50)) {
      if (documentationVerdict(doc, l.line - 1, l.text, span.index, span.match[0].length) === 'skip') continue;
      out.push({ text: span.match[1]!, line: l.line });
    }
  }
  return out;
}

/** unpinned-remote-dep — command text in every file, plus bundled manifests. */
/** unpinned-remote-dep; for a manifest also its install scripts. Returns package `bin` targets to scan. */
function checkUnpinned(doc: SkillDoc, commands: Logical[], consumed: Set<number>, add: Add): string[] {
  const hit = (line: number, text: string, index: number, confidence = 0.6) =>
    add('unpinned-remote-dep', line, excerpt(text, index, 80), 'warning', confidence);

  if (doc.kind === 'manifest') return checkManifest(doc, hit, add);

  for (const { text, line } of commands) {
    if (consumed.has(line)) continue;

    if (INSTALL_CTX_RE.test(text)) {
      const unpinned = findAll(GIT_SOURCE_RE, text, 10).find((g) => !isPinnedRef(gitSourceRef(g.match[0])));
      if (unpinned) { hit(line, text, unpinned.index); continue; }
    }

    const latest = latestInstall(text);
    if (latest) { hit(line, text, latest.index, 0.5); continue; }

    const npm = findFirst(NPM_INSTALL_RE, text);
    if (npm) {
      const tokens = (npm.match[1] ?? '').trim().split(/\s+/).filter((t) => t && !t.startsWith('-'));
      const bad = tokens.find((t) =>
        !t.startsWith('@') && !t.startsWith('.') && !t.startsWith('/') && !t.startsWith('file:') &&
        !/\.(?:js|mjs|cjs|ts|json|md|sh|py|txt)$/i.test(t) &&
        (/^[A-Za-z0-9][\w.-]{0,100}\/[\w.-]{1,100}(?:#\S{0,100})?$/.test(t) || /^https?:\/\//i.test(t)) &&
        isUnpinnedRemoteSpec(t));
      if (bad) { hit(line, text, npm.index); continue; }
    }

    const cargo = findFirst(CARGO_GIT_RE, text);
    if (cargo && !/--(?:rev|tag)\s{1,5}\S/.test(text)) { hit(line, text, cargo.index); continue; }

    const url = findFirst(MUTABLE_SCRIPT_URL_RE, text);
    if (url && findFirst(FETCH_VERB_RE, text) && SCRIPTISH_URL_RE.test(url.match[0])) { hit(line, text, url.index); continue; }

    if (doc.kind === 'script' && doc.lang === 'js') {
      const imp = findAll(REMOTE_IMPORT_RE, text, 10)
        .find((m) => !/@v?\d+(?:\.\d+)*|@[0-9a-f]{7,40}|\/v?\d+\.\d+\.\d+\//i.test(m.match[1]!));
      if (imp) hit(line, text, imp.index);
    }
  }
  return [];
}

/**
 * package.json lifecycle/`scripts` commands run on install: each is checked
 * with the exec rules. `bin` targets are returned so the caller can scan them
 * as scripts (the shallow scan of a dependency package).
 */
function checkPackageScripts(doc: SkillDoc, parsed: Record<string, unknown>, add: Add): string[] {
  const scripts = parsed.scripts;
  if (typeof scripts === 'object' && scripts !== null) {
    for (const [name, cmd] of Object.entries(scripts as Record<string, unknown>).slice(0, 100)) {
      if (typeof cmd !== 'string') continue;
      const chained = new ChainScanner().feed(cmd, 1, true);
      for (const { rule, found } of [...execMatches(cmd, true), ...(chained ? [chained] : [])]) {
        add(rule, lineOf(doc.content, `"${name}"`), `scripts.${visible(name)}: ${excerpt(cmd, found.index, found.match[0].length)}`, 'high', 0.85);
      }
    }
  }
  const bin = parsed.bin;
  const targets = typeof bin === 'string' ? [bin] : typeof bin === 'object' && bin !== null
    ? Object.values(bin as Record<string, unknown>).filter((v): v is string => typeof v === 'string')
    : [];
  const dir = path.posix.dirname(doc.path);
  return targets.slice(0, 5)
    .map((t) => path.posix.normalize(`${dir}/${t.replace(/\\/g, '/')}`))
    .filter((t) => t.startsWith(`${dir}/`));
}

function checkManifest(doc: SkillDoc, hit: (line: number, text: string, index: number) => void, add: Add): string[] {
  const base = path.posix.basename(doc.path);
  if (base === 'package.json') {
    let parsed: unknown;
    try { parsed = JSON.parse(doc.content); } catch { return []; }
    if (typeof parsed !== 'object' || parsed === null) return [];
    const bins = checkPackageScripts(doc, parsed as Record<string, unknown>, add);
    let flagged = 0;
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const deps = (parsed as Record<string, unknown>)[section];
      if (typeof deps !== 'object' || deps === null) continue;
      for (const [name, spec] of Object.entries(deps as Record<string, unknown>)) {
        if (typeof spec !== 'string') continue;
        const s = spec.trim();
        if (s === '' || s === '*' || s === 'latest' || isUnpinnedRemoteSpec(s)) {
          if (++flagged > MAX_HITS_PER_RULE_FILE) return bins;
          const line = lineOf(doc.content, `"${name}"`);
          hit(line, doc.lines[line - 1] ?? `"${name}": "${spec}"`, 0);
        }
      }
    }
    return bins;
  }
  // requirements*.txt
  for (const i of doc.active) {
    const text = doc.lines[i]!.replace(/\s#.*$/, '');
    const g = findFirst(/\bgit\+[a-z]{1,10}:\/\/\S{1,500}/i, text);
    if (g && !isPinnedRef(gitSourceRef(g.match[0]))) { hit(i + 1, text, g.index); continue; }
    const u = findFirst(/\bhttps?:\/\/\S{1,500}?\.(?:zip|tar\.gz|tgz|whl)\S{0,200}/i, text);
    if (u && !/\d+\.\d+|#sha256=/i.test(u.match[0])) hit(i + 1, text, u.index);
  }
  return [];
}

// ── missing-script ────────────────────────────────────────────────────────────

/**
 * missing-script — script invocations in the SKILL.md that resolve nowhere.
 * Bundled reference docs are not checked: they are where skills keep worked
 * examples of scripts the *reader* would write, which never exist.
 */
function checkMissingScripts(
  repoRoot: string,
  skillDir: string,
  doc: SkillDoc,
  alreadyReported: () => ReadonlySet<string>,
  add: Add,
): void {
  const pluginRoot = /^(.*?)\/?skills\/[^/]+$/.exec(skillDir)?.[1];
  const resolveCandidates = (raw: string): string[] | undefined => {
    let ref = raw;
    let bases: string[];
    const varMatch = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?\/(.*)$/.exec(ref);
    if (varMatch) {
      const name = varMatch[1]!;
      ref = varMatch[2]!;
      if (name === 'CLAUDE_SKILL_DIR' || name === 'SKILL_DIR') bases = [skillDir];
      else if (name === 'CLAUDE_PLUGIN_ROOT' && pluginRoot !== undefined) bases = [pluginRoot || '.'];
      else if (name === 'CLAUDE_PROJECT_DIR') bases = ['.'];
      else return undefined; // an unknown variable — cannot resolve statically
    } else if (ref.startsWith('{baseDir}/')) {
      ref = ref.slice('{baseDir}/'.length);
      bases = [skillDir];
    } else {
      // A bare `manage.py` usually names a file in the *user's* project, not the
      // skill — only paths with a directory segment are checked.
      ref = ref.replace(/^\.\//, '');
      if (!ref.includes('/')) return undefined;
      bases = [...new Set([skillDir, ...(pluginRoot ? [pluginRoot] : []), '.'])];
    }
    if (!ref || ref.includes('..') || ref.startsWith('/')) return undefined;
    return bases.map((b) => (b === '.' ? ref : `${b}/${ref}`));
  };

  // Filesystem checks are cached per path and capped per document, and the
  // rule stops after its evidence cap: a SKILL.md with 28k distinct script
  // references must not turn into 28k × 3 stat calls.
  const exists = new Map<string, boolean>();
  let fsChecks = 0;
  let found = 0;
  const fileExists = (p: string): boolean | undefined => {
    const cached = exists.get(p);
    if (cached !== undefined) return cached;
    if (fsChecks >= MAX_FS_CHECKS_PER_DOC) return undefined;
    fsChecks++;
    const result = isFileWithinRoot(repoRoot, p);
    exists.set(p, result);
    return result;
  };

  for (const i of doc.active) {
    const text = doc.lines[i]!;
    // A `"command": "bash …"` inside a JSON/YAML example is sample config, not an instruction to run.
    if (doc.fenced[i] && CONFIG_FENCE_LANGS.has(doc.fenceLang.get(i) ?? '')) continue;
    if (!SCRIPT_EXT_HINT_RE.test(text)) continue;
    for (const re of [INVOKE_RE, DIRECT_EXEC_RE]) {
      for (const m of findAll(re, text, 10)) {
        const raw = m.match[1]!;
        const bare = raw.replace(/^\.\//, '');
        const candidates = resolveCandidates(raw);
        if (!candidates) continue;
        let anyExists = false;
        let unknown = false;
        for (const c of candidates) {
          const e = fileExists(c);
          if (e === undefined) unknown = true;
          else if (e) { anyExists = true; break; }
        }
        if (anyExists) continue;
        if (unknown) return; // the per-document check budget is spent — stop rather than guess
        if (alreadyReported().has(bare) || alreadyReported().has(raw)) continue;
        add('missing-script', i + 1, `${visible(raw)} not found (looked in: ${candidates.map(visible).join(', ')})`, 'warning', 0.6);
        if (++found >= MAX_HITS_PER_RULE_FILE) return;
      }
    }
  }
}

/** Filesystem existence checks per document for missing-script. */
const MAX_FS_CHECKS_PER_DOC = 200;

// ── Loading (streamed, budgeted, priority-ordered) ────────────────────────────

type Budget = { bytes: number; files: number; lines: number };

/** Total lines examined per scan: bounds per-line work however the bytes are shaped (e.g. megabytes of newlines). */
export const MAX_SCAN_LINES = 3_000_000;

function readRange(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  const read = fs.readSync(fd, buf, 0, length, position);
  return buf.subarray(0, read);
}

function makeDoc(relPath: string, cls: Classified, content: string, isSkillMd: boolean, tail: boolean): SkillDoc {
  const lines = content.split(/\r?\n/);
  const active: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    // Blank lines carry nothing any rule looks at; iterating only the rest keeps
    // a file of 500k empty lines as cheap as an empty file.
    // Only ASCII spaces/tabs count as blank — a line of invisible characters is exactly what hidden-unicode wants.
    if (l.length > 0 && NOT_BLANK_RE.test(l)) active.push(i);
  }
  const fenced = new Uint8Array(lines.length);
  const fenceLang = new Map<number, string>();
  // Fence tracking only when the document has a fence marker at all.
  if (cls.kind === 'instructions' && (content.includes('```') || content.includes('~~~'))) {
    const fence = scanFencedLines(content.replace(/\r\n/g, '\n'));
    for (let i = 0; i < lines.length; i++) {
      const f = fence[i];
      if (f?.inFence) {
        fenced[i] = 1;
        if (f.lang) fenceLang.set(i, f.lang);
      }
    }
  }
  return {
    path: relPath,
    kind: cls.kind,
    lang: cls.lang,
    content,
    lines,
    active,
    fenced,
    fenceLang,
    frontmatterEnd: isSkillMd && !tail ? frontmatterEnd(lines) : 0,
    tail,
  };
}

const NOT_BLANK_RE = /[^ \t\r]/;

function countLines(buf: Buffer): number {
  let n = 1;
  for (let i = buf.indexOf(10); i >= 0; i = buf.indexOf(10, i + 1)) n++;
  return n;
}

/**
 * Load one file as 1–2 docs (head, and tail when larger than 1 MB), or say
 * why it was not read. Oversized files are read at their first AND last 500 KB
 * so padding a payload past the head does not hide it; the middle is reported.
 * A priority file (SKILL.md, script, executable) the budget cannot cover is
 * reported at HIGH — the scan fails closed rather than passing it silently.
 */
function loadDocs(
  repoRoot: string,
  relPath: string,
  isSkillMd: boolean,
  priority: boolean,
  budget: Budget,
): { docs: SkillDoc[]; unscanned: Unscanned[] } {
  const budgetSeverity: IssueSeverity = priority ? 'high' : 'warning';
  let cls = isSkillMd ? ({ kind: 'instructions', lang: 'other' } as Classification) : classifyByName(relPath);
  if (typeof cls === 'object' && 'skip' in cls) return { docs: [], unscanned: [] };
  if (typeof cls === 'object' && 'report' in cls) {
    return { docs: [], unscanned: [{ path: relPath, reason: cls.report, severity: cls.severity }] };
  }
  const abs = resolveWithinRoot(repoRoot, relPath);
  if (!abs) return { docs: [], unscanned: [] };
  let fd: number | undefined;
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return { docs: [], unscanned: [] };
    const size = stat.size;
    if (budget.files <= 0 || budget.bytes <= 0 || budget.lines <= 0) {
      return { docs: [], unscanned: [{ path: relPath, reason: 'per-scan budget exhausted — not scanned', severity: budgetSeverity }] };
    }
    fd = fs.openSync(abs, 'r');
    if (cls === 'probe') {
      const head = readRange(fd, 0, Math.min(size, BINARY_CHECK_BYTES));
      if (isBinary(head)) {
        return { docs: [], unscanned: [{ path: relPath, reason: `${binaryKind(head)} — cannot be reviewed as text`, severity: 'warning' }] };
      }
      const lang = langFromShebang(head.toString('utf8').split(/\r?\n/, 1)[0] ?? '');
      cls = lang ? { kind: 'script', lang } : { kind: 'text', lang: 'other' };
    }
    const classified = cls as Classified;
    const unscanned: Unscanned[] = classified.note ? [{ path: relPath, reason: classified.note.reason, severity: classified.note.severity }] : [];
    budget.files--;
    const take = (position: number, length: number, tail: boolean): SkillDoc => {
      const buf = readRange(fd!, position, length);
      budget.bytes -= buf.length;
      budget.lines -= countLines(buf);
      return makeDoc(relPath, classified, buf.toString('utf8'), isSkillMd && !tail, tail);
    };
    // Text files are read even with NUL bytes: a stray NUL must not hide a file (hidden-unicode reports it).
    if (size <= 2 * MAX_FILE_SIZE) {
      const want = Math.min(size, budget.bytes);
      const docs = [take(0, want, false)];
      if (want < size) unscanned.push({ path: relPath, reason: 'per-scan budget exhausted part-way — the rest was not scanned', severity: budgetSeverity });
      return { docs, unscanned };
    }
    const docs = [take(0, Math.min(MAX_FILE_SIZE, budget.bytes), false)];
    const tailLen = Math.min(MAX_FILE_SIZE, budget.bytes);
    if (tailLen > 0) docs.push(take(size - tailLen, tailLen, true));
    unscanned.push({
      path: relPath,
      reason: `larger than 1 MB (${Math.round(size / 1024)} KB) — only the first and last 500 KB were scanned`,
      severity: tailLen > 0 ? 'warning' : budgetSeverity,
    });
    return { docs, unscanned };
  } catch {
    return { docs: [], unscanned: [] };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// ── Detector ──────────────────────────────────────────────────────────────────

/** Scan one document (dropped by the caller right after). Returns package `bin` targets to scan next. */
function scanDoc(
  repoRoot: string,
  skillDir: string,
  doc: SkillDoc,
  isSkillMd: boolean,
  alreadyReported: () => ReadonlySet<string>,
  collector: HitCollector,
  unscanned: Unscanned[],
): string[] {
  const add: Add = (rule, line, excerptText, severity, confidence) => {
    if (!collector.accepts(rule, doc.path, severity, confidence)) {
      collector.count(rule, doc.path);
      return;
    }
    const where = doc.tail ? '(end of file) ' : doc.frontmatterEnd > 0 && line <= doc.frontmatterEnd ? '(frontmatter) ' : '';
    collector.add(rule, doc.path, { line: doc.tail ? undefined : line, excerpt: `${where}${render(excerptText)}`, severity, confidence });
  };

  checkHiddenUnicode(doc, add);
  checkBypassFlags(doc, add);
  if (doc.kind === 'manifest') return checkUnpinned(doc, [], new Set(), add);
  const { lines: logical, capped } = logicalLines(doc);
  if (capped.length > 0) {
    unscanned.push({
      path: doc.path,
      reason: `continuation chain longer than ${MAX_JOINED_LINES} lines / ${MAX_JOINED_CHARS} characters at line ${capped[0]} — split for scanning`,
      severity: 'warning',
    });
  }
  const commands = commandTexts(doc, logical);
  // A checksum manifest counts only if it is a real, reviewable file in the repo (or fetched in the chain).
  const manifestExists: ManifestExists = (name) => {
    const rel = name.replace(/^\.\//, '');
    if (!rel || rel.startsWith('/') || /^[a-z]:/i.test(rel)) return false;
    return [`${path.posix.dirname(doc.path)}/${rel}`, `${skillDir}/${rel}`, rel].some((p) => isFileWithinRoot(repoRoot, p));
  };
  const consumed = checkExec(doc, logical, commands, add, manifestExists);
  checkUnpinned(doc, commands, consumed, add);
  if (doc.kind === 'instructions') {
    checkProse(doc, add);
    checkHiddenMarkup(doc, add);
    if (isSkillMd && !doc.tail) checkMissingScripts(repoRoot, skillDir, doc, alreadyReported, add);
  } else {
    checkScript(doc, consumed, add);
  }
  return [];
}

/** Dependency/VCS directory names a skill might reference by path. */
const DEPENDENCY_DIR_NAMES = ['node_modules', '.git', 'worktrees', '.worktrees'];
/**
 * A path reference into a dependency/VCS directory: the name as a path segment
 * (`node node_modules/evil/index.js`, `./.git/hooks/x`), not a substring of
 * something else (`repo.git/`).
 */
const DEPENDENCY_REF_RE: Record<string, RegExp> = {
  node_modules: /(?:^|[\s'"`(=:/])node_modules\//m,
  '.git': /(?:^|[\s'"`(=:])(?:\.\/)?\.git\//m,
  worktrees: /(?:^|[\s'"`(=:])(?:\.\/)?worktrees\//m,
  '.worktrees': /(?:^|[\s'"`(=:])(?:\.\/)?\.worktrees\//m,
};

/** Non-sample hook files under a skill's `.git/hooks`. */
function hasGitHooks(repoRoot: string, gitDir: string): boolean {
  const abs = resolveWithinRoot(repoRoot, `${gitDir}/hooks`);
  if (!abs) return false;
  try {
    return fs.readdirSync(abs).some((f) => !f.endsWith('.sample'));
  } catch {
    return false;
  }
}

function skipReason(skip: SkillBundleSkip, referenced: ReadonlySet<string>, repoRoot: string): Unscanned {
  switch (skip.kind) {
    case 'dependency-dir': {
      const name = path.posix.basename(skip.path);
      const read = name === 'node_modules' ? ' (only package manifests and their bin targets were read)' : '';
      // Code the skill runs from an unscanned directory is unreviewed executable content: fail closed.
      if (referenced.has(name)) {
        return { path: skip.path, reason: `dependency/VCS directory the skill runs or references by path — not walked${read}`, severity: 'high' };
      }
      if (name === '.git' && hasGitHooks(repoRoot, skip.path)) {
        return { path: skip.path, reason: 'git directory with hooks — hooks run on git operations and were not scanned', severity: 'warning' };
      }
      return { path: skip.path, reason: `dependency/VCS directory — not walked${read}`, severity: 'info' };
    }
    case 'include':
      return { path: skip.path, reason: `${skip.count ?? 0} file(s) outside the configured include patterns — not scanned`, severity: 'info' };
    default:
      return { path: skip.path, reason: `bundle too large to list — ${skip.count ?? 'more'} further file(s) not scanned`, severity: 'warning' };
  }
}

type SkillState = {
  skillMd: string;
  dir: string;
  collector: HitCollector;
  unscanned: Unscanned[];
  alreadyReported: () => ReadonlySet<string>;
  /** The SKILL.md head content, kept only for the lazy structural-ref lookup. */
  headContent?: string;
  /** Dependency/VCS directory names referenced by path from the SKILL.md or a script. */
  referenced: Set<string>;
  queue: { priority: string[]; rest: string[] };
  loaded: boolean;
};

/** Per-scan budget overrides (tests exercise budget exhaustion without generating gigabytes). */
export type SkillScanLimits = Partial<{ bytes: number; files: number; lines: number }>;

export function detectSkillSupplyChain(context: RepoContext, limits: SkillScanLimits = {}): PromptCiIssue[] {
  // `allSkills`/`skillFiles` are optional for hand-built contexts from older releases.
  const ai: Partial<RepoContext['aiConfig']> = context.aiConfig ?? {};
  const allSkills = ai.allSkills ?? ai.skills ?? [];
  const audited = new Set(ai.skills ?? []);
  const dirs = allSkills.map((s) => path.posix.dirname(s));
  const owner = (p: string): number => {
    let best = -1;
    dirs.forEach((dir, idx) => {
      if (isSkillContainerDir(dir) || !(p === dir || p.startsWith(`${dir}/`))) return;
      if (best < 0 || dir.length > dirs[best]!.length) best = idx;
    });
    return best;
  };

  const states: SkillState[] = allSkills.map((skillMd, idx) => {
    const state: SkillState = {
      skillMd,
      dir: dirs[idx]!,
      collector: new HitCollector(),
      unscanned: [],
      alreadyReported: () => new Set<string>(),
      referenced: new Set<string>(),
      queue: { priority: [], rest: [] },
      loaded: false,
    };
    // Refs the structural detector already flags when missing are not reported twice
    // (computed lazily, only once a missing script is actually found).
    if (audited.has(skillMd)) {
      let refs: Set<string> | undefined;
      state.alreadyReported = () => (refs ??= new Set(extractFileRefs(state.headContent ?? '').map((r) => r.ref)));
    }
    return state;
  });
  for (const file of ai.skillFiles ?? []) {
    const idx = owner(file);
    if (idx >= 0) (isPriorityFile(file) ? states[idx]!.queue.priority : states[idx]!.queue.rest).push(file);
  }
  for (const file of ai.skillFilesOverCap ?? []) {
    const idx = owner(file);
    if (idx >= 0) {
      states[idx]!.unscanned.push({
        path: file,
        reason: 'over the per-skill file cap — not scanned',
        severity: isPriorityFile(file) ? 'high' : 'warning',
      });
    }
  }

  const budget: Budget = {
    bytes: limits.bytes ?? MAX_SCAN_BYTES,
    files: limits.files ?? MAX_SCAN_FILES,
    lines: limits.lines ?? MAX_SCAN_LINES,
  };
  const noteReferences = (state: SkillState, doc: SkillDoc) => {
    if (doc.kind !== 'instructions' && doc.kind !== 'script' && !(doc.kind === 'text' && doc.lang === 'sh')) return;
    for (const name of DEPENDENCY_DIR_NAMES) if (DEPENDENCY_REF_RE[name]!.test(doc.content)) state.referenced.add(name);
  };
  const visited = new Set<string>();
  const scanFile = (state: SkillState, file: string, isSkillMd: boolean, priority: boolean): ReturnType<typeof loadDocs> => {
    if (visited.has(file)) return { docs: [], unscanned: [] };
    visited.add(file);
    const loaded = loadDocs(context.repoRoot, file, isSkillMd, priority, budget);
    state.unscanned.push(...loaded.unscanned);
    const extra: string[] = [];
    if (isSkillMd) state.headContent = loaded.docs[0]?.content;
    for (const doc of loaded.docs) {
      noteReferences(state, doc);
      extra.push(...scanDoc(context.repoRoot, state.dir, doc, isSkillMd, state.alreadyReported, state.collector, state.unscanned));
    }
    // A dependency package's `bin` targets are what `npx`/install runs: scan them as scripts.
    for (const target of extra) if (owner(target) >= 0) scanFile(state, target, false, true);
    return loaded;
  };

  // Pass 1 — every SKILL.md and every script/executable, across all skills,
  // before any other document: decoys cannot push them past the budget.
  for (const state of states) {
    const main = scanFile(state, state.skillMd, true, true);
    state.loaded = main.docs.length > 0 || main.unscanned.length > 0;
    for (const file of state.queue.priority) scanFile(state, file, false, true);
  }
  // Pass 2 — everything else, while the budget lasts.
  for (const state of states) {
    for (const file of state.queue.rest) scanFile(state, file, false, false);
  }

  const issues: PromptCiIssue[] = [];
  for (const state of states) {
    if (!state.loaded) continue; // unreadable SKILL.md
    for (const skip of ai.skillBundleSkips ?? []) {
      if (owner(skip.path) === states.indexOf(state)) state.unscanned.push(skipReason(skip, state.referenced, context.repoRoot));
    }
    // Name what could not be scanned — never drop it silently.
    for (const u of state.unscanned) {
      state.collector.add('unscanned-files', state.skillMd, { excerpt: `${visible(u.path)}: ${u.reason}`, severity: u.severity, confidence: 0.8 });
    }
    issues.push(...state.collector.toIssues(state.skillMd));
  }
  // Scanner-form paths so inline suppressions can match (see withScannerPaths).
  return withScannerPaths(context.repoRoot, issues);
}
