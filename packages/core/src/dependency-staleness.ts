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
import { isExcludedPath } from './repo-context.js';
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
  /\b(?:not|never|don'?t|do\s+not|doesn'?t|avoid|instead\s+of|rather\s+than|no\s+longer|replace[sd]?|replacing|migrat\w+|deprecated|removed|legacy|without|except|unlike|vs\.?|versus|older|previously|formerly|used\s+to|drop(?:ped)?|stop\s+using|forbidden|banned|prohibited|phas(?:e[sd]?|ing)\s+out|being\s+replaced|sunset\w*)\b/i;

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
// `.js` is deliberately absent: `chart.js` and `three.js` are real package names.
const FILE_EXTENSION_RE =
  /\.(?:json|jsonc|ts|tsx|mts|cts|jsx|mjs|cjs|md|mdx|ya?ml|toml|lock|css|scss|sass|less|styl|html|sh|txt|env|config|dart|go|py|rs|rb|java|kt|swift|vue|svelte|astro|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|mp[34]|wasm|graphql|gql|sql)$/i;
/** `github.com/x/y`, `golang.org/x/net`: a Go/Dart-style module path, not an npm package. */
const DOMAIN_FIRST_SEGMENT_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|dev|co|app|ai|me|sh|xyz|gg|tv|cc|us|uk|de|fr|ru|cn|jp|to|in|so|cloud)\//i;

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
  if (DOMAIN_FIRST_SEGMENT_RE.test(spec)) return undefined;
  const m = /^(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._-]*)(?:\/.*)?$/.exec(spec);
  if (!m) return undefined;
  // `uno.css`, `foo_bar.dart`, `logo.svg`: a file or virtual-module id, not a package.
  return FILE_EXTENSION_RE.test(m[1]!) ? undefined : m[1]!;
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

/** Forms only JavaScript uses: safe in an unlabeled fence or an inline span, where Go/Dart/Python also appear. */
const STRICT_IMPORT_PATTERNS: readonly RegExp[] = [
  /\bimport\s+(?:type\s+)?[^'"`;]*?\sfrom\s+['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  /^\s*\}?\s*from\s+['"]([^'"]+)['"]/g,
];
/** `import 'x'` (side-effect import) reads as Go/Dart too, so it only counts in a JS-labeled fence. */
const SIDE_EFFECT_IMPORT_PATTERN = /\bimport\s+['"]([^'"]+)['"]/g;

function importedPackageNames(text: string, strictOnly: boolean): string[] {
  const names: string[] = [];
  const patterns = strictOnly ? STRICT_IMPORT_PATTERNS : [...STRICT_IMPORT_PATTERNS, SIDE_EFFECT_IMPORT_PATTERN];
  for (const pattern of patterns) {
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

// The trailing comment of a code line (hash, double-slash, slash-star or SQL-style), '' when there is none.
function commentOf(line: string): string {
  const m = /(?:^|\s)(?:#|\/\/|\/\*|--)\s*(.*)$/.exec(line);
  return m ? m[1]! : '';
}

function collectMentions(file: InstructionFile): Mention[] {
  const mentions: Mention[] = [];
  const { segments, prose } = readFile(file);
  const add = (pkg: string, kind: MentionKind, line: number, text: string): void => {
    mentions.push({ pkg, kind, file, line, text });
  };

  for (const seg of segments) {
    // In a fence only the trailing comment can carry prose; an identifier like
    // `import { without } from 'lodash'` is not a negation.
    if (NEGATION_RE.test(seg.fenced ? commentOf(seg.lineText) : seg.lineText)) continue;
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
      // An unlabeled fence or an inline span could be Go, Dart, Python...: JS-only forms there.
      const strictOnly = !seg.fenced || seg.lang === '';
      for (const pkg of importedPackageNames(text, strictOnly)) add(pkg, 'import', seg.line, seg.lineText);
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
// Dot directories (`.github/actions/x`) are included on purpose; only VCS and dependency trees are not.
const EXTRA_MANIFEST_IGNORE = [
  '**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.next/**', '**/worktrees/**', '**/.worktrees/**',
  '**/vendor/**', '**/target/**', '**/.turbo/**', '**/coverage/**', '**/Library/**', '**/Temp/**',
];

/** Modules the host application provides at runtime; they are never in a package.json. */
const HOST_PROVIDED_MODULES: ReadonlySet<string> = new Set(['vscode', 'k6']);

/**
 * Tools manifest-consistency already reports as a "tooling mismatch" when the
 * instructions name one and the repo uses the other: skip them here so one
 * stale mention is not reported twice.
 */
const TOOLING_PAIRS: Readonly<Record<string, readonly string[]>> = {
  jest: ['vitest'],
  vitest: ['jest'],
  '@playwright/test': ['cypress'],
  cypress: ['@playwright/test'],
};

type Catalogs = { default: Record<string, string>; named: Record<string, Record<string, string>> };

type Manifests = {
  /** Every dependency name and package name the repo's package.json files declare (plus Deno import-map keys). */
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
  /** Import prefixes tsconfig/jsconfig `paths` map to local code (`trpc/*` -> `trpc`, `@app/*` -> `@app`). */
  aliasNames: Set<string>;
  aliasScopes: Set<string>;
  /** pnpm-workspace.yaml catalogs, for `catalog:` specs. */
  catalogs: Catalogs;
  /** More manifests exist than were read: a declaration may be in one that was not. */
  truncated: boolean;
  lazyLoaded: boolean;
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
    aliasNames: new Set(),
    aliasScopes: new Set(),
    catalogs: { default: {}, named: {} },
    truncated: context.workspacesTruncated === true,
    lazyLoaded: false,
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

/** Read a repo-relative file through the symlink-aware containment check; undefined when absent or unsafe. */
function readContained(repoRoot: string, rel: string): string | undefined {
  try {
    const abs = resolveReadableWithinRoot(repoRoot, rel);
    if (!abs) return undefined;
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size > MAX_FILE_SIZE) return undefined;
    return fs.readFileSync(abs, 'utf-8');
  } catch {
    return undefined;
  }
}

/** Comments and trailing commas removed, so tsconfig.json / deno.jsonc parse as JSON. */
function parseJsonc(raw: string): unknown {
  let out = '';
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (inString) {
      out += c;
      if (c === '\\') out += raw[++i] ?? '';
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && raw[i + 1] === '/') {
      while (i < raw.length && raw[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && raw[i + 1] === '*') {
      i += 2;
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
  } catch {
    return undefined;
  }
}

function addAlias(into: Manifests, key: string): void {
  if (key.startsWith('@/') || key.startsWith('~') || key.startsWith('#') || key === '*') return;
  const prefix = key.replace(/\/?\*.*$/, '');
  if (!prefix) return;
  if (prefix.startsWith('@')) {
    if (prefix.includes('/')) into.aliasNames.add(prefix);
    else into.aliasScopes.add(prefix);
  } else {
    into.aliasNames.add(prefix.split('/')[0]!);
  }
}

/** tsconfig/jsconfig `paths` keys are local import aliases; a Deno import map's keys are declared dependencies. */
function loadAuxConfigs(context: RepoContext, into: Manifests): void {
  for (const dir of [...new Set(['.', ...into.dirs])]) {
    const at = (file: string): string => (dir === '.' ? file : `${dir}/${file}`);
    for (const file of ['tsconfig.json', 'jsconfig.json']) {
      const raw = readContained(context.repoRoot, at(file));
      const parsed = raw === undefined ? undefined : (parseJsonc(raw) as { compilerOptions?: { paths?: Record<string, unknown> } } | undefined);
      for (const key of Object.keys(parsed?.compilerOptions?.paths ?? {})) addAlias(into, key);
    }
    for (const file of ['deno.json', 'deno.jsonc']) {
      const raw = readContained(context.repoRoot, at(file));
      const parsed = raw === undefined ? undefined : (parseJsonc(raw) as { imports?: Record<string, unknown> } | undefined);
      for (const key of Object.keys(parsed?.imports ?? {})) into.declared.add(key.replace(/\/$/, ''));
    }
  }
}

const CATALOG_ENTRY_RE = /^\s+(['"]?)(@?[^'":\s]+(?:\/[^'":\s]+)?)\1\s*:\s*['"]?([^'"#\s]+)['"]?/;

/** `catalog:` and `catalogs:` of pnpm-workspace.yaml (the small subset of YAML they use). */
function parseCatalogs(rawYaml: string): Catalogs {
  const out: Catalogs = { default: {}, named: {} };
  let section: 'catalog' | 'catalogs' | null = null;
  let named: string | null = null;
  for (const line of rawYaml.split(/\r?\n/)) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    if (/^catalog:\s*(?:#.*)?$/.test(line)) {
      section = 'catalog';
      continue;
    }
    if (/^catalogs:\s*(?:#.*)?$/.test(line)) {
      section = 'catalogs';
      named = null;
      continue;
    }
    if (/^\S/.test(line)) {
      section = null;
      continue;
    }
    if (section === 'catalog') {
      const m = CATALOG_ENTRY_RE.exec(line);
      if (m) out.default[m[2]!] = m[3]!;
    } else if (section === 'catalogs') {
      const header = /^ {1,3}(['"]?)([^'":\s]+)\1\s*:\s*(?:#.*)?$/.exec(line);
      if (header) {
        named = header[2]!;
        out.named[named] ??= {};
        continue;
      }
      const m = CATALOG_ENTRY_RE.exec(line);
      if (m && named) out.named[named]![m[2]!] = m[3]!;
    }
  }
  return out;
}

/** The spec a `catalog:` / `catalog:<name>` reference points at, or the spec itself; undefined when unresolvable. */
function resolveSpec(manifests: Manifests, dep: string, spec: string): string | undefined {
  if (!spec.startsWith('catalog:')) return spec;
  const name = spec.slice('catalog:'.length).trim();
  return name === '' || name === 'default' ? manifests.catalogs.default[dep] : manifests.catalogs.named[name]?.[dep];
}

/**
 * Everything beyond the context's own manifests, read once and only when a
 * mention needs it: other package.json files (a service in `services/api`, a
 * sample app), tsconfig/deno configs, and pnpm catalogs.
 */
function loadLazyFacts(context: RepoContext, into: Manifests): void {
  if (into.lazyLoaded) return;
  into.lazyLoaded = true;
  const exclude = context.exclude ?? [];
  let files: string[] = [];
  try {
    files = fg.sync(['**/package.json'], {
      cwd: context.repoRoot,
      ignore: EXTRA_MANIFEST_IGNORE,
      dot: true,
      onlyFiles: true,
      followSymbolicLinks: false,
      suppressErrors: true,
    });
  } catch {
    // cannot walk: the facts we have are all we get
    into.truncated = true;
  }
  files = files.filter((rel) => !isExcludedPath(rel, exclude) && !into.dirs.has(path.posix.dirname(rel))).sort();
  // Past the cap a declaration may live in a manifest we did not read: rule (a) must not guess.
  if (files.length > EXTRA_MANIFEST_LIMIT) into.truncated = true;
  for (const rel of files.slice(0, EXTRA_MANIFEST_LIMIT)) {
    const raw = readContained(context.repoRoot, rel);
    const manifest = raw === undefined ? undefined : parseWorkspaceManifest(path.posix.dirname(rel), raw);
    if (manifest) addManifest(into, manifest);
  }
  loadAuxConfigs(context, into);
  const yaml = readContained(context.repoRoot, 'pnpm-workspace.yaml');
  if (yaml !== undefined) into.catalogs = parseCatalogs(yaml);
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
    for (const raw of manifests.specs.get(name) ?? []) {
      const spec = resolveSpec(manifests, name, raw);
      const major = spec === undefined ? null : majorOf(spec);
      if (spec === undefined || major === null) return null;
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

/** `<repo>/<dir>/<base>/<name>` through the symlink-aware containment check, or null. */
function containedPath(repoRoot: string, ...parts: string[]): string | null {
  return resolveReadableWithinRoot(repoRoot, path.posix.join(...parts));
}

function pathExists(repoRoot: string, ...parts: string[]): boolean {
  const abs = containedPath(repoRoot, ...parts);
  if (abs === null) return false;
  try {
    return fs.existsSync(abs);
  } catch {
    return false;
  }
}

/** A directory or file named `name` at the root of the repo or of any workspace (or in its src/). */
function localDirectoryExists(repoRoot: string, manifests: Manifests, name: string): boolean {
  for (const dir of new Set(['.', ...manifests.dirs])) {
    for (const base of ['.', 'src']) {
      if (pathExists(repoRoot, dir, base, name)) return true;
    }
  }
  return false;
}

/** `@types/foo` declares `foo`; `@types/scope__name` declares `@scope/name`. */
function typesPackageFor(name: string): string {
  return name.startsWith('@') ? `@types/${name.slice(1).replace('/', '__')}` : `@types/${name}`;
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
    const has = (n: string): boolean => manifests.declared.has(n) || manifests.declared.has(typesPackageFor(n));
    if (has(name)) return true;
    loadLazyFacts(context, manifests);
    return has(name) || isKnownBinary(context, name);
  };

  for (const [pkg, mentions] of [...byPackage].sort(([a], [b]) => a.localeCompare(b))) {
    const bare = pkg.startsWith('@') ? pkg : pkg.split('/')[0]!;
    if (NODE_BUILTINS.has(bare) || WELL_KNOWN_CLIS.has(bare) || HOST_PROVIDED_MODULES.has(bare) || isPlaceholder(pkg)) continue;
    const deprecated = DEPRECATED_PACKAGES[pkg];

    if (deprecated) {
      const declared = isDeclared(pkg);
      const severity: IssueSeverity = declared || manifests.truncated ? 'info' : 'warning';
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

    // Rule (a): only an install command or an import line counts. Prose that merely
    // calls something a package/library is not enough for an arbitrary name.
    const explicit = mentions.filter((m) => m.kind === 'install' || m.kind === 'import');
    if (explicit.length === 0) continue;
    if (isDeclared(pkg)) continue;
    // Declarations may live in manifests we could not read: do not guess.
    if (manifests.truncated) continue;
    // manifest-consistency already reports a Jest/Vitest or Playwright/Cypress mix-up.
    if (TOOLING_PAIRS[pkg]?.some((other) => isDeclared(other))) continue;

    const scope = scopeOf(pkg);
    const viaInstall = explicit.some((m) => m.kind === 'install');
    if (!viaInstall) {
      // An import is weaker evidence than an install command: path aliases
      // (`@lib/x`, `components/x`, tsconfig `paths`) look exactly like packages.
      if (scope === undefined && (ALIAS_LIKE_NAMES.has(pkg) || localDirectoryExists(context.repoRoot, manifests, pkg))) continue;
      if (manifests.aliasNames.has(pkg) || (scope !== undefined && manifests.aliasScopes.has(scope))) continue;
      // An import of one of this monorepo's own packages by its directory or short name.
      if (manifests.localNames.has(pkg)) continue;
      // A scoped import is only believed when the repo already uses that scope
      // (`@tanstack/react-query` absent, `@tanstack/react-table` present).
      if (scope !== undefined && ![...manifests.declared].some((d) => scopeOf(d) === scope)) continue;
    }

    const where = firstPerFile(explicit);
    issues.push({
      id: issueId('missing-package', pkg),
      // An install command is explicit; an import line alone is weaker evidence.
      severity: viaInstall ? 'warning' : 'info',
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

/** "Before:", "old", "legacy", "anti-pattern": the example is shown as what NOT to write. */
const OLD_LABEL_RE = /\b(?:before|old(?:er)?|previously|legacy|prior|outdated|anti-?patterns?|bad|wrong)\b|❌/i;
const HEADING_RE = /^\s{0,3}#{1,6}\s/;

/**
 * Lines (prose or code) that match `re` and read as guidance to follow. Skipped:
 * negated or migration prose, `diff`/`patch` fences (a before/after listing),
 * anything labeled Before/Old, and anything in a section that also names the
 * replacement API (`replacement`) — that is a migration example, not an instruction.
 */
function apiMentions(files: InstructionFile[], re: RegExp, skipLine: RegExp, replacement: RegExp): ApiHit[] {
  const hits: ApiHit[] = [];
  for (const file of files) {
    const lines = scanFencedLines(file.content);
    const sectionOf: number[] = [];
    const sectionText: string[] = [''];
    const headings: string[] = [''];
    const openOf: number[] = [];
    let section = 0;
    let open = -1;
    lines.forEach((fl, i) => {
      if (fl.kind === 'text' && HEADING_RE.test(fl.text)) {
        section++;
        sectionText[section] = '';
        headings[section] = fl.text;
      }
      if (fl.kind === 'open') open = i;
      openOf[i] = fl.inFence ? open : -1;
      sectionOf[i] = section;
      sectionText[section] += `${fl.text}\n`;
    });

    /** The nearest non-blank line before this one, or before the fence it sits in. */
    const lineBefore = (i: number): string => {
      for (let j = (openOf[i]! >= 0 ? openOf[i]! : i) - 1; j >= 0; j--) {
        if (lines[j]!.text.trim() !== '') return lines[j]!.text;
      }
      return '';
    };

    lines.forEach((fl, i) => {
      if (fl.kind === 'open' || fl.kind === 'close') return;
      if (fl.inFence && (fl.lang === 'diff' || fl.lang === 'patch')) return;
      const text = fl.text.replace(/\r$/, '');
      if (!re.test(text) || NEGATION_RE.test(text) || skipLine.test(text)) return;
      if (replacement.test(sectionText[sectionOf[i]!]!)) return;
      if (OLD_LABEL_RE.test(text) || OLD_LABEL_RE.test(headings[sectionOf[i]!]!) || OLD_LABEL_RE.test(lineBefore(i))) return;
      hits.push({ file, line: fl.lineNumber, text });
    });
  }
  return hits;
}

const REACT_RENDER_RE = /\bReactDOM\.render\b/;
// Explicitly about an older React.
const REACT_RENDER_SKIP_RE = /\bReact\s*(?:v\.?\s*)?(?:0|1[0-7])\b/i;
const REACT_ROOT_API_RE = /\b(?:createRoot|hydrateRoot)\b/;

function checkReactRender(context: RepoContext, files: InstructionFile[], manifests: Manifests): PromptCiIssue[] {
  const hits = firstPerFile(apiMentions(files, REACT_RENDER_RE, REACT_RENDER_SKIP_RE, REACT_ROOT_API_RE));
  if (hits.length === 0) return [];
  loadLazyFacts(context, manifests);
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
const APP_ROUTER_API_RE = /\bServer Components?\b|\broute handlers?\b|\bapp\s+router\b/i;

const APP_ROUTER_FILE_RE = /^(?:layout|page)\.(?:tsx|ts|jsx|js|mdx)$/;

function dirHasAppRouter(repoRoot: string, dir: string): boolean {
  for (const app of ['app', 'src/app']) {
    try {
      const abs = containedPath(repoRoot, dir, app);
      if (abs !== null && fs.readdirSync(abs).some((f) => APP_ROUTER_FILE_RE.test(f))) return true;
    } catch {
      // no such directory
    }
  }
  return false;
}

function dirHasPagesRouter(repoRoot: string, dir: string): boolean {
  for (const pages of ['pages', 'src/pages']) {
    try {
      const abs = containedPath(repoRoot, dir, pages);
      if (abs !== null && fs.statSync(abs).isDirectory()) return true;
    } catch {
      // no such directory
    }
  }
  return false;
}

function checkGetInitialProps(context: RepoContext, files: InstructionFile[], manifests: Manifests): PromptCiIssue[] {
  const hits = firstPerFile(apiMentions(files, GET_INITIAL_PROPS_RE, PAGES_ROUTER_RE, APP_ROUTER_API_RE));
  if (hits.length === 0) return [];
  // A Next app may live outside the conventional workspace directories.
  loadLazyFacts(context, manifests);
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
const STANDALONE_RE = /\bstandalone\b/i;

function hasNgModuleFiles(repoRoot: string): boolean {
  try {
    const found = fg.sync(['**/*.module.ts'], {
      cwd: repoRoot,
      ignore: EXTRA_MANIFEST_IGNORE,
      deep: 8,
      onlyFiles: true,
      followSymbolicLinks: false,
      suppressErrors: true,
    });
    return found.some((rel) => resolveReadableWithinRoot(repoRoot, rel) !== null);
  } catch {
    return true; // cannot tell: stay silent
  }
}

function checkNgModule(context: RepoContext, files: InstructionFile[], manifests: Manifests): PromptCiIssue[] {
  const hits = firstPerFile(apiMentions(files, NGMODULE_RE, STANDALONE_RE, STANDALONE_RE));
  if (hits.length === 0) return [];
  loadLazyFacts(context, manifests);
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
