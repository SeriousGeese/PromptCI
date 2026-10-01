/**
 * Dependency and framework-API staleness against the repo's manifests
 * (pcic-2b6.11).
 *
 * Instruction files age: they keep recommending a package that was swapped out,
 * a library the ecosystem has abandoned, or an API the installed major version
 * no longer has. An agent follows that text literally. Three rules, all
 * deterministic and offline, all deliberately conservative (a missed finding
 * costs less than a wrong one):
 *
 *  (a) MISSING PACKAGE — an npm-shaped package named by an install command
 *      (`npm i x`, `pnpm add x`) or an import/require line that no package.json
 *      in the repo declares. Low confidence (0.5): the text may describe an
 *      optional or external tool. Prose that merely calls a code span a
 *      "package" is not enough, and an install after a `cd` (or with
 *      `--prefix`/`-C`) targets a directory this check cannot resolve.
 *  (b) DEPRECATED PACKAGE — a short list of packages their maintainers have
 *      deprecated or put in maintenance mode, recommended by the instructions.
 *      `info` when a manifest declares it (the instructions are consistent
 *      with the repo, the dependency is just old), `warning` when no manifest
 *      does (the instructions point at a deprecated package that is not even
 *      installed). Reported instead of (a) for those names.
 *  (c) VERSION-GATED API — `ReactDOM.render` against React >= 18 (warning) or
 *      >= 19 (removed: high), `getInitialProps` in a Next.js app that uses the
 *      app/ router, and NgModule-centric guidance for an Angular >= 17 project
 *      that has no `*.module.ts` files.
 *
 * Only agent-facing instruction files are read (not README/docs, which mostly
 * describe how end users install the project). Prose that tells the agent NOT
 * to use something, or narrates a migration away from it, is never flagged.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import fg from 'fast-glob';
import { INSTRUCTION_FILE_TYPES } from './types.js';
import type { InstructionFile, IssueSeverity, PromptCiIssue } from './types.js';
import type { RepoContext } from './repo-context.js';
import { scanFencedLines } from './markdown-fences.js';
import { snippet } from './evidence.js';
import { resolveReadableWithinRoot } from './path-containment.js';
import { isKnownBinary, parseWorkspaceManifest } from './workspace-manifests.js';
import type { WorkspaceManifest } from './workspace-manifests.js';
import { MAX_FILE_SIZE } from './scanner.js';

// ── Name filters ──────────────────────────────────────────────────────────────

/** Node.js core modules (static: output must not depend on the Node version that runs the scan). */
const NODE_BUILTINS: ReadonlySet<string> = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto',
  'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https',
  'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring',
  'readline', 'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls', 'trace_events', 'tty',
  'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib', 'test', 'sqlite',
]);

/** Package managers, runtimes and version managers: commands, not dependencies. */
const WELL_KNOWN_CLIS: ReadonlySet<string> = new Set([
  'npm', 'pnpm', 'yarn', 'npx', 'bun', 'bunx', 'deno', 'node', 'corepack', 'nvm', 'fnm', 'volta', 'git',
]);

const PLACEHOLDER_NAMES: ReadonlySet<string> = new Set([
  'package', 'package-name', 'pkg', 'name', 'module', 'module-name', 'lib', 'library', 'dependency', 'dep',
  'foo', 'bar', 'baz', 'example', 'sample', 'x', 'y', 'z', 'a', 'b', 'c', 'my-package', 'my-lib', 'my-app',
  'some-package', 'some-lib', 'your-package', 'package-a', 'package-b', 'new-package', 'new-dependency',
]);
const PLACEHOLDER_PREFIX_RE = /^(?:your|my|some|example|sample|foo|bar|baz|pkg|package)(?:-|$)/;
const PLACEHOLDER_SCOPES: ReadonlySet<string> = new Set([
  'scope', 'your-scope', 'my-scope', 'org', 'your-org', 'my-org', 'yourorg', 'myorg', 'company', 'your-company',
  'acme', 'example', 'project', 'repo', 'workspace', 'name', 'user', 'username', 'namespace', 'team', 'monorepo',
  'scope-name', 'org-name', 'your-username',
]);

/**
 * Words that are almost always a path alias or a local directory when they
 * appear as an import's first segment (`import x from 'components/Button'`),
 * not a package.
 */
const ALIAS_LIKE_NAMES: ReadonlySet<string> = new Set([
  'src', 'app', 'lib', 'libs', 'components', 'component', 'utils', 'util', 'hooks', 'types', 'config', 'styles',
  'assets', 'public', 'test', 'tests', 'shared', 'common', 'core', 'store', 'stores', 'services', 'service',
  'pages', 'features', 'modules', 'server', 'client', 'api', 'db', 'models', 'helpers', 'constants', 'context',
  'contexts', 'layouts', 'routes', 'views', 'data', 'mocks', 'fixtures', 'schemas', 'icons', 'images', 'ui',
  'actions', 'reducers', 'providers', 'middleware', 'controllers', 'entities', 'domain',
  // Words that read as a package but name a dependency group or an adjective.
  'dev', 'prod', 'optional', 'peer', 'build', 'lint', 'main', 'default', 'latest', 'local', 'root', 'runtime',
  'required', 'direct', 'transitive', 'external', 'internal', 'vendor',
]);

/**
 * A line that tells the reader NOT to use something, or narrates moving away
 * from it. Prose like this is correct guidance and must never be flagged.
 */
const NEGATION_RE =
  /\b(?:not|never|don'?t|do\s+not|doesn'?t|avoid|instead\s+of|rather\s+than|no\s+longer|replace[sd]?|replacing|migrat\w+|deprecated|removed|legacy|without|except|unlike|vs\.?|versus|older|previously|formerly|used\s+to|drop(?:ped)?|stop\s+using|forbidden|banned|prohibited)\b/i;

// ── Deprecated packages ───────────────────────────────────────────────────────

type DeprecatedPackage = {
  /** What the maintainers say, cautiously worded. */
  status: string;
  replacement: string;
  /**
   * The name is distinctive enough that a bare `` `name` `` code span (and a
   * command invocation) counts as a mention. `request` is not: it is also an
   * ordinary word and variable name.
   */
  distinctive: boolean;
  /** Also a command-line tool, so `npx name ...` / `name build` counts as a mention. */
  command: boolean;
};

const DEPRECATED_PACKAGES: Readonly<Record<string, DeprecatedPackage>> = {
  moment: {
    status: 'is a legacy project in maintenance mode',
    replacement: 'date-fns, Luxon, Day.js, or the Temporal API',
    distinctive: true,
    command: false,
  },
  request: {
    status: 'was deprecated by its maintainers in 2020',
    replacement: 'the built-in fetch, undici, got, or axios',
    distinctive: false,
    command: false,
  },
  tslint: {
    status: 'was deprecated in favor of ESLint',
    replacement: 'ESLint with typescript-eslint',
    distinctive: true,
    command: true,
  },
  'node-sass': {
    status: 'is deprecated (LibSass is no longer maintained)',
    replacement: 'sass (Dart Sass)',
    distinctive: true,
    command: true,
  },
  'react-scripts': {
    status: 'belongs to Create React App, which the React team has deprecated',
    replacement: 'Vite, Next.js, or another maintained React toolchain',
    distinctive: true,
    command: true,
  },
  enzyme: {
    status: 'is unmaintained and has no official adapter for current React versions',
    replacement: '@testing-library/react',
    distinctive: true,
    command: false,
  },
};

// ── Mention extraction ────────────────────────────────────────────────────────

type MentionKind = 'install' | 'import' | 'qualified' | 'span' | 'command';

type Mention = {
  pkg: string;
  kind: MentionKind;
  file: InstructionFile;
  line: number;
  /** The text the mention came from, for evidence. */
  text: string;
};

type Segment = {
  text: string;
  line: number;
  /** True for a line inside a fenced code block, false for an inline code span. */
  fenced: boolean;
  lang: string;
  /** The whole physical line, for negation context. */
  lineText: string;
  /** A `cd` appeared earlier in the same fenced block. */
  afterCd: boolean;
};

const CD_RE = /(?:^|[\s;&|(])(?:cd|pushd)\s+\S/;

const SHELL_LANGS: ReadonlySet<string> = new Set([
  '', 'sh', 'bash', 'shell', 'zsh', 'console', 'shellsession', 'terminal', 'powershell', 'ps1', 'pwsh', 'cmd',
]);
const JS_LANGS: ReadonlySet<string> = new Set([
  '', 'js', 'jsx', 'ts', 'tsx', 'javascript', 'typescript', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte', 'astro',
]);

const INLINE_CODE_RE = /(`+)([^`\n]+)\1/g;

/** Code segments (fenced lines and inline spans) and the plain prose lines of one file. */
function readFile(file: InstructionFile): { segments: Segment[]; prose: Array<{ line: number; text: string }> } {
  const segments: Segment[] = [];
  const prose: Array<{ line: number; text: string }> = [];
  let sawCd = false;
  for (const fl of scanFencedLines(file.content)) {
    const text = fl.text.replace(/\r$/, '');
    if (fl.kind === 'open') sawCd = false;
    if (fl.kind === 'content') {
      segments.push({ text, line: fl.lineNumber, fenced: true, lang: fl.lang, lineText: text, afterCd: sawCd });
      if (CD_RE.test(text)) sawCd = true;
    } else if (fl.kind === 'text') {
      prose.push({ line: fl.lineNumber, text });
      const re = new RegExp(INLINE_CODE_RE.source, INLINE_CODE_RE.flags);
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        segments.push({ text: m[2]!.trim(), line: fl.lineNumber, fenced: false, lang: '', lineText: text, afterCd: false });
      }
    }
  }
  return { segments, prose };
}

const NPM_NAME_RE = /^(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/;
const FILE_EXTENSION_RE = /\.(?:json|jsonc|ts|tsx|mts|cts|jsx|mjs|cjs|md|mdx|ya?ml|toml|lock|css|scss|html|sh|txt|env|config)$/i;

/** `name`, `name@1.2.3`, `@scope/name@latest` -> the package name; undefined when it is not npm-shaped. */
function nameFromInstallSpec(raw: string): string | undefined {
  const spec = raw.replace(/^['"]|['"]$/g, '');
  const m = /^(@[^/@\s]+\/[^/@\s]+|[^/@\s][^@/\s]*)(?:@\S*)?$/.exec(spec);
  if (!m) return undefined;
  const name = m[1]!;
  return NPM_NAME_RE.test(name) && !FILE_EXTENSION_RE.test(name) ? name : undefined;
}

/** `pkg`, `pkg/sub/path`, `@scope/pkg/sub` -> the package name; undefined for relative/absolute/alias/protocol specifiers. */
function nameFromImportSpecifier(spec: string): string | undefined {
  if (/^[./~#$]|^@\/|:|\s|\*|<|\{/.test(spec)) return undefined;
  const m = /^(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._-]*)(?:\/.*)?$/.exec(spec);
  return m ? m[1]! : undefined;
}

/** Flags that point the package manager at another directory. */
const CWD_FLAGS: ReadonlySet<string> = new Set(['-C', '--cwd', '--prefix', '--dir']);
const PRE_VERB_VALUE_FLAGS: ReadonlySet<string> = new Set(['--filter', '-F', '--workspace', ...CWD_FLAGS]);
const POST_VERB_BARE_FLAGS: ReadonlySet<string> = new Set([
  '-D', '--save-dev', '-S', '--save', '-E', '--save-exact', '-O', '--save-optional', '-P', '--save-prod',
  '--dev', '--exact', '--optional', '--peer', '--no-save', '--force', '--legacy-peer-deps', '--ignore-scripts',
  '--silent', '--no-audit', '--no-fund', '--prefer-offline', '--workspace-root', '-W',
]);
const INSTALL_VERBS: Readonly<Record<string, ReadonlySet<string>>> = {
  npm: new Set(['install', 'i', 'add']),
  pnpm: new Set(['add', 'install', 'i']),
  yarn: new Set(['add']),
  bun: new Set(['add', 'install', 'i']),
};

/**
 * Package names an install command adds: `npm i x`, `pnpm add -D y z`,
 * `yarn workspace web add w`, `pnpm --filter web add v`. Global installs
 * (`-g`) are tools, not dependencies, and are skipped; so is any command with a
 * flag this parser does not know (it cannot tell a flag's value from a package).
 */
function installedPackageNames(text: string, afterCd: boolean): string[] {
  if (afterCd) return []; // an earlier `cd` in the block: the install lands in a directory we cannot resolve
  const names: string[] = [];
  for (const command of text.split(/&&|\|\||[;|]/)) {
    // Drop a shell prompt (`$ `) or a subshell opener (`(cd x && ...`) before the command word.
    const tokens = command.replace(/^\s*(?:[$>%]\s+|[({]\s*)+/, '').trim().split(/\s+/);
    const manager = tokens[0];
    if (manager === 'cd' || manager === 'pushd') break; // the rest of the line runs somewhere else
    const verbs = manager ? INSTALL_VERBS[manager] : undefined;
    if (!verbs) continue;
    // The install targets a directory given by a flag, whose manifest is not necessarily the root's.
    if (tokens.some((t) => CWD_FLAGS.has(t) || /^--(?:prefix|cwd|dir)=/.test(t))) continue;

    let i = 1;
    let foundVerb = false;
    for (; i < tokens.length; i++) {
      const tok = tokens[i]!;
      if (verbs.has(tok)) {
        foundVerb = true;
        i++;
        break;
      }
      if (PRE_VERB_VALUE_FLAGS.has(tok) || (manager === 'npm' && tok === '-w') || (manager === 'yarn' && tok === 'workspace')) {
        i++; // its value
        continue;
      }
      if (tok.startsWith('-')) continue;
      break; // another subcommand (run, dlx, exec, ...)
    }
    if (!foundVerb) continue;

    const found: string[] = [];
    let bail = false;
    for (; i < tokens.length; i++) {
      const tok = tokens[i]!;
      if (tok.startsWith('#')) break;
      if (tok === '-g' || tok === '--global' || tok === '--location=global') {
        bail = true;
        break;
      }
      if (tok.startsWith('-')) {
        if (POST_VERB_BARE_FLAGS.has(tok) || (manager === 'pnpm' && tok === '-w') || tok.includes('=')) continue;
        if (PRE_VERB_VALUE_FLAGS.has(tok) || (manager === 'npm' && tok === '-w')) {
          i++;
          continue;
        }
        bail = true; // unknown flag
        break;
      }
      const name = nameFromInstallSpec(tok);
      if (name === undefined) {
        bail = true; // a path, URL, tag or variable: not a plain registry name
        break;
      }
      found.push(name);
    }
    if (!bail) names.push(...found);
  }
  return names;
}

const IMPORT_PATTERNS: readonly RegExp[] = [
  /\bimport\s+(?:type\s+)?(?:[^'"`;]*?\sfrom\s+)?['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  /^\s*\}?\s*from\s+['"]([^'"]+)['"]/g,
];

function importedPackageNames(text: string): string[] {
  const names: string[] = [];
  for (const pattern of IMPORT_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const name = nameFromImportSpecifier(m[1]!);
      if (name !== undefined) names.push(name);
    }
  }
  return names;
}

/**
 * "the `x` package", "library `x`": a code span the prose itself calls a package.
 * Only trusted for the deprecated-package list: as a trigger for an arbitrary
 * name it is too loose ("the `playwright-core` package root", "install
 * `cloudflared`" are not npm dependencies the repo should declare).
 */
const QUALIFIED_SPAN_PATTERNS: readonly RegExp[] = [
  /\b(?:package|library|dependency)\s+`([^`\s]+)`/gi,
  /`([^`\s]+)`\s+(?:npm\s+)?(?:package|library|dependency)\b/gi,
];

function qualifiedSpanNames(line: string): string[] {
  const names: string[] = [];
  for (const pattern of QUALIFIED_SPAN_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const name = nameFromInstallSpec(m[1]!);
      if (name !== undefined) names.push(name);
    }
  }
  return names;
}

const DEPRECATED_COMMAND_RE = /(?:^|[\s;&|(])(?:(?:npx|bunx|yarn|pnpm\s+(?:exec|dlx)|npm\s+exec)\s+)?(react-scripts|tslint|node-sass)(?=\s|$)/g;

function collectMentions(file: InstructionFile): Mention[] {
  const mentions: Mention[] = [];
  const { segments, prose } = readFile(file);
  const add = (pkg: string, kind: MentionKind, line: number, text: string): void => {
    mentions.push({ pkg, kind, file, line, text });
  };

  for (const seg of segments) {
    if (NEGATION_RE.test(seg.lineText)) continue;
    const text = seg.text;

    if (!seg.fenced || SHELL_LANGS.has(seg.lang)) {
      for (const pkg of installedPackageNames(text, seg.afterCd)) add(pkg, 'install', seg.line, seg.lineText);
      const cmd = new RegExp(DEPRECATED_COMMAND_RE.source, 'g');
      let m: RegExpExecArray | null;
      // A deprecated tool invoked as a command; the `command: true` entries only.
      while ((m = cmd.exec(text)) !== null) {
        if (DEPRECATED_PACKAGES[m[1]!]?.command) add(m[1]!, 'command', seg.line, seg.lineText);
      }
    }
    if (!seg.fenced || JS_LANGS.has(seg.lang)) {
      for (const pkg of importedPackageNames(text)) add(pkg, 'import', seg.line, seg.lineText);
    }
    // A span that is nothing but a distinctive deprecated package name.
    if (!seg.fenced && NPM_NAME_RE.test(text) && DEPRECATED_PACKAGES[text]?.distinctive) {
      add(text, 'span', seg.line, seg.lineText);
    }
  }

  for (const { line, text } of prose) {
    if (NEGATION_RE.test(text)) continue;
    for (const pkg of qualifiedSpanNames(text)) add(pkg, 'qualified', line, text);
  }
  return mentions;
}

// ── Manifest facts ────────────────────────────────────────────────────────────

const EXTRA_MANIFEST_LIMIT = 200;
const EXTRA_MANIFEST_IGNORE = [
  '**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.next/**', '**/worktrees/**', '**/.worktrees/**',
  '**/vendor/**', '**/target/**', '**/.turbo/**', '**/coverage/**', '**/Library/**', '**/Temp/**',
];

type Manifests = {
  /** Every dependency name and package name the repo's package.json files declare. */
  declared: Set<string>;
  /** Specs per dependency name, across every manifest. */
  specs: Map<string, string[]>;
  /** At least one package.json was read. */
  any: boolean;
  /** Repo-relative POSIX directories of the manifests read so far. */
  dirs: Set<string>;
  /** Directories of the manifests that declare `next`. */
  nextDirs: string[];
  /** Short names of this repo's own packages: workspace directory basenames and unscoped package names. */
  localNames: Set<string>;
  extrasLoaded: boolean;
};

function addManifest(into: Manifests, ws: WorkspaceManifest): void {
  into.any = true;
  if (ws.name) into.declared.add(ws.name);
  for (const dep of ws.dependencies) into.declared.add(dep);
  for (const [dep, spec] of Object.entries(ws.versions ?? {})) {
    into.specs.set(dep, [...(into.specs.get(dep) ?? []), spec]);
  }
  if (ws.dependencies.includes('next')) into.nextDirs.push(ws.dir);
  into.dirs.add(ws.dir);
  if (ws.dir !== '.') into.localNames.add(path.posix.basename(ws.dir));
  if (ws.name) into.localNames.add(ws.name.replace(/^@[^/]+\//, ''));
}

function contextManifests(context: RepoContext): Manifests {
  const out: Manifests = {
    declared: new Set(),
    specs: new Map(),
    any: false,
    dirs: new Set(),
    nextDirs: [],
    localNames: new Set(),
    extrasLoaded: false,
  };
  const rootRaw = context.manifests.packageJson;
  const rootWorkspace = (context.workspaces ?? []).find((ws) => ws.dir === '.');
  if (rootRaw !== undefined && rootWorkspace === undefined) {
    // A hand-built context: only the parsed root facts exist.
    const { dependencies, devDependencies, peerDependencies } = context.packageJson;
    const root = parseWorkspaceManifest('.', JSON.stringify({ dependencies, devDependencies, peerDependencies }));
    if (root) addManifest(out, root);
  }
  for (const ws of context.workspaces ?? []) addManifest(out, ws);
  return out;
}

/** Every other package.json in the repo (a service in `services/api`, a sample app), read once and lazily. */
function loadExtraManifests(context: RepoContext, into: Manifests): void {
  if (into.extrasLoaded) return;
  into.extrasLoaded = true;
  let files: string[];
  try {
    files = fg.sync(['**/package.json'], {
      cwd: context.repoRoot,
      ignore: EXTRA_MANIFEST_IGNORE,
      dot: false,
      deep: 6,
      onlyFiles: true,
      followSymbolicLinks: false,
      suppressErrors: true,
    });
  } catch {
    return;
  }
  files.sort();
  for (const rel of files.slice(0, EXTRA_MANIFEST_LIMIT)) {
    const dir = path.posix.dirname(rel);
    if (into.dirs.has(dir)) continue;
    try {
      const abs = resolveReadableWithinRoot(context.repoRoot, rel);
      if (!abs) continue;
      const stat = fs.statSync(abs);
      if (!stat.isFile() || stat.size > MAX_FILE_SIZE) continue;
      const manifest = parseWorkspaceManifest(dir, fs.readFileSync(abs, 'utf-8'));
      if (manifest) addManifest(into, manifest);
    } catch {
      // unreadable — skip
    }
  }
}

function scopeOf(name: string): string | undefined {
  return name.startsWith('@') ? name.slice(0, name.indexOf('/')) : undefined;
}

/** Major version of the lowest range a spec allows, or null when it cannot be read statically. */
function majorOf(spec: string): number | null {
  const s = spec.trim();
  if (/^(?:workspace|catalog|link|file|git|github|http|https|npm):/.test(s) || s.startsWith('<')) return null;
  const m = /^(?:\^|~|>=|>|=)?\s*v?(\d+)(?:[.x*]|\b)/.exec(s);
  return m ? parseInt(m[1]!, 10) : null;
}

/** The lowest declared major across every manifest, or null when any spec is unreadable or none exists. */
function lowestMajor(manifests: Manifests, names: string[]): { major: number; spec: string } | null {
  let best: { major: number; spec: string } | null = null;
  for (const name of names) {
    for (const spec of manifests.specs.get(name) ?? []) {
      const major = majorOf(spec);
      if (major === null) return null;
      if (best === null || major < best.major) best = { major, spec };
    }
  }
  return best;
}

// ── Findings ──────────────────────────────────────────────────────────────────

function issueId(rule: string, key: string): string {
  const hash = crypto.createHash('sha1').update(`dep-staleness:${rule}:${key}`).digest('hex').slice(0, 12);
  return `dep-staleness-${rule}-${hash}`;
}

/** First mention per file, in file order. */
function firstPerFile(mentions: Array<{ file: InstructionFile; line: number; text: string }>) {
  const seen = new Set<string>();
  const out: typeof mentions = [];
  for (const m of mentions) {
    if (seen.has(m.file.path)) continue;
    seen.add(m.file.path);
    out.push(m);
  }
  return out;
}

function locationsOf(mentions: Array<{ file: InstructionFile; line: number }>) {
  return mentions.map((m) => ({ filePath: m.file.path, startLine: m.line, endLine: m.line }));
}

function evidenceLine(m: { file: InstructionFile; line: number; text: string }): string {
  return `${m.file.relativePath ?? path.basename(m.file.path)}:${m.line}: "${snippet(m.text, 100)}"`;
}

function isPlaceholder(name: string): boolean {
  const scope = scopeOf(name);
  if (scope !== undefined) return PLACEHOLDER_SCOPES.has(scope.slice(1));
  return PLACEHOLDER_NAMES.has(name) || PLACEHOLDER_PREFIX_RE.test(name);
}

function localDirectoryExists(repoRoot: string, name: string): boolean {
  for (const base of ['.', 'src']) {
    try {
      if (fs.existsSync(path.join(repoRoot, base, name))) return true;
    } catch {
      // unreadable — treat as absent
    }
  }
  return false;
}

function checkPackages(context: RepoContext, files: InstructionFile[], manifests: Manifests): PromptCiIssue[] {
  const byPackage = new Map<string, Mention[]>();
  for (const file of files) {
    for (const mention of collectMentions(file)) {
      byPackage.set(mention.pkg, [...(byPackage.get(mention.pkg) ?? []), mention]);
    }
  }
  if (byPackage.size === 0) return [];

  const issues: PromptCiIssue[] = [];
  const isDeclared = (name: string): boolean => {
    if (manifests.declared.has(name)) return true;
    loadExtraManifests(context, manifests);
    return manifests.declared.has(name) || isKnownBinary(context, name);
  };
  const truncated = context.workspacesTruncated === true;

  for (const [pkg, mentions] of [...byPackage].sort(([a], [b]) => a.localeCompare(b))) {
    const bare = pkg.startsWith('@') ? pkg : pkg.split('/')[0]!;
    if (NODE_BUILTINS.has(bare) || WELL_KNOWN_CLIS.has(bare) || isPlaceholder(pkg)) continue;
    const deprecated = DEPRECATED_PACKAGES[pkg];

    if (deprecated) {
      const declared = isDeclared(pkg);
      const severity: IssueSeverity = declared || truncated ? 'info' : 'warning';
      const where = firstPerFile(mentions);
      issues.push({
        id: issueId('deprecated', pkg),
        severity,
        category: 'stale_instruction',
        title: `Instructions point at a deprecated package: ${pkg}`,
        summary:
          `Instruction files mention \`${pkg}\`, which ${deprecated.status}. ` +
          (declared
            ? 'A package.json in this repo still declares it, so an agent will keep extending the old dependency. '
            : 'No package.json in this repo declares it, so an agent following the instructions would add a deprecated dependency. ') +
          `Consider ${deprecated.replacement} instead, or confirm the repo intends to keep using it.`,
        filePaths: where.map((m) => m.file.path),
        locations: locationsOf(where),
        evidence: [
          ...where.slice(0, 3).map(evidenceLine),
          declared ? `${pkg} is declared in a package.json` : `${pkg} is not declared in any package.json`,
        ],
        recommendation: `Update the instructions to recommend ${deprecated.replacement}${declared ? ', and plan the dependency migration' : ''}; if the repo deliberately keeps ${pkg}, note why.`,
        confidence: 0.7,
      });
      continue;
    }

    if (truncated) continue;
    // Rule (a): only an install command or an import line counts. Prose that merely
    // calls something a package/library is not enough for an arbitrary name.
    const explicit = mentions.filter((m) => m.kind === 'install' || m.kind === 'import');
    if (explicit.length === 0) continue;
    const scope = scopeOf(pkg);
    const viaInstall = explicit.some((m) => m.kind === 'install');
    if (!viaInstall) {
      // An import or "the `x` library" is weaker evidence than an install command:
      // path aliases (`@lib/x`, `components/x`) look exactly like packages.
      if (scope === undefined && (ALIAS_LIKE_NAMES.has(pkg) || localDirectoryExists(context.repoRoot, pkg))) continue;
    }
    if (isDeclared(pkg)) continue;
    // "the `web` package" in a monorepo names a workspace by its directory or short name.
    if (!viaInstall && manifests.localNames.has(pkg)) continue;
    if (!viaInstall && scope !== undefined) {
      // A scoped import is only believed when the repo already uses that scope
      // (`@tanstack/react-query` absent, `@tanstack/react-table` present).
      const scopeInUse = [...manifests.declared].some((d) => scopeOf(d) === scope);
      if (!scopeInUse) continue;
    }

    const where = firstPerFile(explicit);
    issues.push({
      id: issueId('missing-package', pkg),
      severity: 'warning',
      category: 'stale_instruction',
      title: `Package named in instructions is not in any package.json: ${pkg}`,
      summary:
        `Instruction files refer to the npm package \`${pkg}\`, but no package.json in this repo declares it. ` +
        'It may have been removed or renamed since the instructions were written. ' +
        'Treat this as a prompt to check, not a certainty: it may be an optional or external tool.',
      filePaths: where.map((m) => m.file.path),
      locations: locationsOf(where),
      evidence: [...where.slice(0, 3).map(evidenceLine), `${pkg} is not declared in any package.json`],
      recommendation:
        `Remove or update the mention of ${pkg}, or add it to package.json if the repo really depends on it.`,
      confidence: 0.5,
    });
  }
  return issues;
}

// ── Version-gated API checks ──────────────────────────────────────────────────

type ApiHit = { file: InstructionFile; line: number; text: string };

/** Lines (prose or code) that match `re` and are not negated, migration notes or version-pinned. */
function apiMentions(files: InstructionFile[], re: RegExp, skipLine: RegExp): ApiHit[] {
  const hits: ApiHit[] = [];
  for (const file of files) {
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i]!.replace(/\r$/, '');
      if (!re.test(text) || NEGATION_RE.test(text) || skipLine.test(text)) continue;
      hits.push({ file, line: i + 1, text });
    }
  }
  return hits;
}

const REACT_RENDER_RE = /\bReactDOM\.render\b/;
// A line already steering to the modern API, or explicitly about an older React.
const REACT_RENDER_SKIP_RE = /\b(?:createRoot|hydrateRoot)\b|\bReact\s*(?:v\.?\s*)?(?:0|1[0-7])\b|\blegacy\b/i;

function checkReactRender(context: RepoContext, files: InstructionFile[], manifests: Manifests): PromptCiIssue[] {
  const hits = firstPerFile(apiMentions(files, REACT_RENDER_RE, REACT_RENDER_SKIP_RE));
  if (hits.length === 0) return [];
  loadExtraManifests(context, manifests);
  const lowest = lowestMajor(manifests, ['react', 'react-dom']);
  if (lowest === null || lowest.major < 18) return [];

  const removed = lowest.major >= 19;
  return [
    {
      id: issueId('react-dom-render', 'ReactDOM.render'),
      severity: removed ? 'high' : 'warning',
      category: 'stale_instruction',
      title: removed
        ? 'Instructions use ReactDOM.render, which React 19 removed'
        : 'Instructions use ReactDOM.render, which is the legacy React 17 root API',
      summary:
        `Instruction files mention \`ReactDOM.render\`, but package.json declares React ${lowest.spec}. ` +
        (removed
          ? '`ReactDOM.render` was removed in React 19, so code an agent writes from this guidance will fail.'
          : 'In React 18 it still runs but only in legacy mode (with a console warning) and without concurrent features.') +
        ' Use `createRoot` from `react-dom/client` instead.',
      filePaths: hits.map((h) => h.file.path),
      locations: locationsOf(hits),
      evidence: [...hits.slice(0, 3).map(evidenceLine), `package.json declares react ${lowest.spec}`],
      recommendation:
        'Replace the `ReactDOM.render(...)` guidance with `createRoot(container).render(...)` from `react-dom/client`.',
      confidence: 0.8,
    },
  ];
}

const GET_INITIAL_PROPS_RE = /\bgetInitialProps\b/;
// Prose that scopes the API to the pages router.
const PAGES_ROUTER_RE = /\bpages\s*(?:router|dir(?:ectory)?)\b|\bpages\//i;

const APP_ROUTER_FILE_RE = /^(?:layout|page)\.(?:tsx|ts|jsx|js|mdx)$/;

function dirHasAppRouter(repoRoot: string, dir: string): boolean {
  for (const app of ['app', 'src/app']) {
    try {
      const abs = path.join(repoRoot, dir, app);
      if (fs.readdirSync(abs).some((f) => APP_ROUTER_FILE_RE.test(f))) return true;
    } catch {
      // no such directory
    }
  }
  return false;
}

function dirHasPagesRouter(repoRoot: string, dir: string): boolean {
  for (const pages of ['pages', 'src/pages']) {
    try {
      if (fs.statSync(path.join(repoRoot, dir, pages)).isDirectory()) return true;
    } catch {
      // no such directory
    }
  }
  return false;
}

function checkGetInitialProps(context: RepoContext, files: InstructionFile[], manifests: Manifests): PromptCiIssue[] {
  const hits = firstPerFile(apiMentions(files, GET_INITIAL_PROPS_RE, PAGES_ROUTER_RE));
  if (hits.length === 0) return [];
  // A Next app may live outside the conventional workspace directories.
  loadExtraManifests(context, manifests);
  const nextDirs = manifests.nextDirs;
  if (nextDirs.length === 0) return [];
  // Hybrid apps still need getInitialProps in pages/; only a pure app-router project makes it dead guidance.
  if (nextDirs.some((dir) => dirHasPagesRouter(context.repoRoot, dir))) return [];
  if (!nextDirs.some((dir) => dirHasAppRouter(context.repoRoot, dir))) return [];

  return [
    {
      id: issueId('get-initial-props', 'getInitialProps'),
      severity: 'warning',
      category: 'stale_instruction',
      title: 'Instructions use getInitialProps in a Next.js app-router project',
      summary:
        'Instruction files mention `getInitialProps`, but this project uses the Next.js `app/` router ' +
        '(and has no `pages/` directory). `getInitialProps` only applies to the pages router, so an ' +
        'agent following this guidance would write data fetching that never runs.',
      filePaths: hits.map((h) => h.file.path),
      locations: locationsOf(hits),
      evidence: [...hits.slice(0, 3).map(evidenceLine), 'an app/ directory with layout/page files exists; no pages/ directory'],
      recommendation:
        'Describe data fetching with Server Components (async components, `fetch`) or route handlers instead, ' +
        'or scope the `getInitialProps` note to the pages router.',
      confidence: 0.65,
    },
  ];
}

const NGMODULE_RE = /\bNgModules?\b/;
const NGMODULE_SKIP_RE = /\bstandalone\b/i;

function hasNgModuleFiles(repoRoot: string): boolean {
  try {
    return (
      fg.sync(['**/*.module.ts'], {
        cwd: repoRoot,
        ignore: EXTRA_MANIFEST_IGNORE,
        deep: 8,
        onlyFiles: true,
        followSymbolicLinks: false,
        suppressErrors: true,
      }).length > 0
    );
  } catch {
    return true; // cannot tell: stay silent
  }
}

function checkNgModule(context: RepoContext, files: InstructionFile[], manifests: Manifests): PromptCiIssue[] {
  const hits = firstPerFile(apiMentions(files, NGMODULE_RE, NGMODULE_SKIP_RE));
  if (hits.length === 0) return [];
  loadExtraManifests(context, manifests);
  const angular = lowestMajor(manifests, ['@angular/core']);
  if (angular === null || angular.major < 17) return [];
  // A project that still has NgModule files is genuinely module-based; the guidance is right for it.
  if (hasNgModuleFiles(context.repoRoot)) return [];
  return [
    {
      id: issueId('ngmodule', 'NgModule'),
      severity: 'info',
      category: 'stale_instruction',
      title: 'Instructions are NgModule-centric in an Angular 17+ project with no modules',
      summary:
        `Instruction files describe NgModules, but package.json declares @angular/core ${angular.spec} ` +
        'and the repo has no `*.module.ts` files. New Angular projects use standalone components, so an agent ' +
        'following this guidance may scaffold NgModules the project does not use.',
      filePaths: hits.map((h) => h.file.path),
      locations: locationsOf(hits),
      evidence: [...hits.slice(0, 3).map(evidenceLine), `package.json declares @angular/core ${angular.spec}; no *.module.ts files`],
      recommendation: 'Describe standalone components (`standalone: true`, `bootstrapApplication`) instead of NgModules.',
      confidence: 0.6,
    },
  ];
}

// ── Public detector ───────────────────────────────────────────────────────────

export function detectDependencyStaleness(context: RepoContext): PromptCiIssue[] {
  // Agent-facing instruction prose only: README/docs mostly tell end users how to install the project.
  const files = context.files.filter((f) => INSTRUCTION_FILE_TYPES.has(f.fileType));
  if (files.length === 0) return [];

  const manifests = contextManifests(context);
  // Not a JavaScript project (as far as the manifests say): nothing to compare against.
  if (!manifests.any) return [];

  return [
    ...checkPackages(context, files, manifests),
    ...checkReactRender(context, files, manifests),
    ...checkGetInitialProps(context, files, manifests),
    ...checkNgModule(context, files, manifests),
  ].sort((a, b) => a.id.localeCompare(b.id));
}
