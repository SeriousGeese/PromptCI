import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type { PromptCiIssue } from './types.js';
import type { RepoContext } from './repo-context.js';
import { matchEvidence } from './evidence.js';
import { PROMPTCI_GITIGNORE_BLOCK, PROMPTCI_GITIGNORE_LINES } from './promptci-gitignore.js';
import { fileIdPath } from './finding-id.js';
import { treeFor } from './repo-tree.js';

interface SecurityCheck {
  id: string;
  title: string;
  summary: string;
  /** At least one pattern must match somewhere across all files to pass. */
  patterns: RegExp[];
  recommendation: string;
  severity: PromptCiIssue['severity'];
  confidence: number;
  fixRecipe?: string;
}

const SECURITY_CHECKS: SecurityCheck[] = [
  {
    id: 'no-secret-safeguard',
    title: 'Missing secret safeguard instruction',
    summary:
      'Environment variables are used in this repository, but no instruction found ' +
      'warning the agent never to print or commit secrets.',
    patterns: [
      /never\s+.*(print|commit|log|expose)\s+.*(secret|password|token|key|credential)/i,
      /do\s+not\s+.*(print|commit|log|expose)\s+.*(secret|password|token|key|credential)/i,
      /secrets?\s+must\s+never\s+be/i,
      /keep\s+secrets?\s+secure/i,
    ],
    recommendation:
      'Add a rule such as: "Never print or commit secrets, API keys, or credentials. ' +
      'If you need to use an environment variable, use it silently without echoing its value."',
    severity: 'warning',
    confidence: 0.8,
    fixRecipe: 'Never print or commit secrets, API keys, or credentials. If you need to use an environment variable, use it silently without echoing its value.',
  },
  {
    id: 'no-supabase-service-role-rule',
    title: 'Missing Supabase service role safeguard',
    summary:
      'Supabase is used in this repository, but no instruction found warning that ' +
      'the service role key must only be used server-side.',
    patterns: [
      /service\s+role\s+key\s+must\s+(stay|only\s+be\s+used)\s+server-side/i,
      /never\s+expose\s+supabase\s+service\s+role/i,
      /supabase\s+service\s+role\s+key.*server-side/i,
    ],
    recommendation:
      'Add a rule such as: "The Supabase service role key must stay server-side and never be exposed to the client."',
    severity: 'warning',
    confidence: 0.85,
    fixRecipe: 'Keep SUPABASE_SERVICE_ROLE_KEY server-side only. Never expose it in browser code, logs, or committed files.',
  },
  {
    id: 'no-upload-boundary-docs',
    title: 'Missing data boundary documentation for uploads',
    summary:
      'Upload features detected, but no instruction found defining data boundaries ' +
      'or validation requirements for user-provided files.',
    patterns: [
      /validate\s+user\s+(provided|uploaded)\s+files/i,
      /data\s+boundary\s+for\s+uploads/i,
      /upload\s+validation/i,
      /limit\s+upload\s+size/i,
    ],
    recommendation:
      'Add guidance on how to safely handle and validate user uploads to prevent security risks.',
    severity: 'info',
    confidence: 0.7,
    fixRecipe: 'Before handling user uploads, document what file types are allowed, the max file size, and the sanitization steps required.',
  },
  {
    id: 'no-promptci-report-safeguard',
    title: 'Missing safeguard for .promptci/ reports',
    summary:
      '.promptci/ folder exists, but no instruction found warning the agent ' +
      'not to commit generated reports to the repository.',
    patterns: [
      /do\s+not\s+commit\s+\.promptci/i,
      /never\s+commit\s+\.promptci/i,
      /\.promptci\/\s+reports\s+should\s+not\s+be\s+committed/i,
    ],
    recommendation:
      'Add a rule such as: "Do not commit .promptci/ reports to the repository."',
    severity: 'info',
    confidence: 0.8,
    fixRecipe: 'Do not commit .promptci/ reports to the repository.',
  },
];

const DESTRUCTIVE_COMMANDS = [
  {
    // SP2: no longer requires TRAILING whitespace — `rm\s+-rf\s+` missed
    // "...never run rm -rf" (end of sentence) and backticked "`rm -rf`" (end
    // of span, followed by a backtick, not whitespace). `\b` handles both.
    // Also covers the equivalent flag order `rm -fr`.
    pattern: /\brm\s+-(?:rf|fr)\b/i,
    name: 'rm -rf',
  },
  {
    pattern: /drop\s+table/i,
    name: 'drop table',
  },
  {
    pattern: /git\s+push\s+--force/i,
    name: 'git push --force',
  },
];

/** Names of the files (not directories) at the scan root. */
function rootFileNames(tree: ReturnType<typeof treeFor>): string[] {
  const entries = tree.entries(tree.root);
  if (typeof entries === 'string') return [];
  return [...entries.values()].filter((e) => !e.isDirectory()).map((e) => e.name);
}

const isDotnetBuildFile = (name: string) =>
  /\.(?:sln|slnx|csproj|fsproj|vbproj)$/i.test(name) || name === 'Directory.Build.props';
const isJvmBuildFile = (name: string) =>
  ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'].includes(name);

/**
 * Directories that are build output in some ecosystems and source in others
 * (#161). `bin` is where .NET and Gradle/Maven builds write compiled output,
 * but in Node, PHP and shell projects it holds hand-written, tracked entry
 * scripts (a package.json `bin` target, `bin/install-wp-tests.sh`): ignoring
 * it would silently keep the next script added there out of git. `obj` is
 * .NET's intermediate output. Each is reported only next to a root build file
 * of an ecosystem that writes it, and `bin` only when it is plainly output:
 * the root package.json does not name it as a `bin` target, and every file
 * under it looks compiled (#206, {@link holdsSourceFiles}). A repo can carry a
 * pom.xml or Directory.Build.props and a Node CLI side by side.
 */
type Tree = ReturnType<typeof treeFor>;
const ECOSYSTEM_OUTPUT_DIRS: Record<string, (tree: Tree, rootNames: string[]) => boolean> = {
  bin: (tree, names) =>
    names.some((n) => isDotnetBuildFile(n) || isJvmBuildFile(n)) &&
    !packageJsonNamesBinDir(tree) &&
    !holdsSourceFiles(tree, 'bin'),
  obj: (_tree, names) => names.some(isDotnetBuildFile),
};

/**
 * True when the root package.json's `bin` field (string or map) or
 * `directories.bin` points into `bin/`. A package.json that exists but cannot
 * be read or parsed counts as true too: the cost of guessing wrong is a
 * `bin/` line in .gitignore that silently drops the next script added there.
 */
function packageJsonNamesBinDir(tree: Tree): boolean {
  const read = tree.readText('package.json', { maxBytes: 1_000_000 });
  if (read.state === 'missing' || read.state === 'outside') return false;
  if (read.state !== 'found') return true;
  let pkg: unknown;
  try {
    pkg = JSON.parse(read.content);
  } catch {
    return true;
  }
  if (typeof pkg !== 'object' || pkg === null || Array.isArray(pkg)) return true;
  const { bin, directories } = pkg as { bin?: unknown; directories?: { bin?: unknown } };
  const targets: unknown[] = typeof bin === 'string' ? [bin] : typeof bin === 'object' && bin !== null ? Object.values(bin) : [];
  if (directories && typeof directories === 'object') targets.push(directories.bin);
  return targets.some((t) => {
    if (typeof t !== 'string') return false;
    // Resolve `.` and `..` first: `bin/../dist/cli.js` lives in dist/, not bin/.
    const normalized = path.posix.normalize(t.replace(/\\/g, '/'));
    return normalized === 'bin' || normalized.startsWith('bin/');
  });
}

/**
 * #206: what a .NET or JVM build writes into `bin/`: compiled classes and
 * archives, assemblies, symbols, native libraries, and the .NET files generated
 * beside an assembly. Nothing else counts as evidence of build output.
 */
const COMPILER_OUTPUT_RE =
  /\.(?:class|jar|war|ear|dll|exe|pdb|mdb|winmd|so|dylib|deps\.json|runtimeconfig\.json|runtimeconfig\.dev\.json|dll\.config|exe\.config)$/i;

/** Bounds on the walk under `bin/`; past either, its contents are unknown, so it counts as source. */
const BIN_WALK_MAX_DEPTH = 8;
const BIN_WALK_MAX_FILES = 2000;

/**
 * True unless every file under the directory, at any depth, is compiler output
 * (#206). The earlier test looked only at the directory's own files and called
 * anything that was not a recognised script build output, so `bin/linux/start.sh`,
 * `bin/tool.groovy`, `bin/app.properties` and an extensionless `bin/setup` were
 * all reported as safe to ignore. Now a file must look compiled: an extension in
 * {@link COMPILER_OUTPUT_RE}, or an extensionless file without a `#!` line
 * that is binary (a NUL byte or an ELF header) or too large to be a script.
 * Dotfiles (`.gitkeep`) carry no evidence either way. A directory or
 * extensionless file that cannot be listed or read (a hosted scan that listed
 * but did not fetch it), a tree past the walk's bounds, and a scan whose
 * caller declared its file inventory incomplete all count as source, since a
 * wrong `bin/` line in .gitignore is the costlier mistake. An empty directory
 * holds nothing hand-written.
 */
function holdsSourceFiles(tree: Tree, dir: string): boolean {
  let seen = 0;
  const walk = (rel: string, depth: number): boolean => {
    const entries = tree.entries(rel);
    if (typeof entries === 'string') return true;
    for (const entry of entries.values()) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (depth >= BIN_WALK_MAX_DEPTH) return true;
        if (walk(child, depth + 1)) return true;
        continue;
      }
      if (entry.name.startsWith('.')) continue;
      if (++seen > BIN_WALK_MAX_FILES) return true;
      if (COMPILER_OUTPUT_RE.test(entry.name)) continue;
      if (entry.name.includes('.')) return true;
      const head = tree.readText(child, { maxBytes: 256 * 1024 });
      if (head.state === 'too-large') continue;
      if (head.state !== 'found') return true;
      // A `#!` line is hand-written even when binary follows (an executable-jar
      // stub is a shell script with a zip appended, PR #210 review).
      const binary = head.content.includes('\u0000') || head.content.startsWith('\u007fELF');
      if (!binary || head.content.startsWith('#!')) return true;
    }
    return false;
  };
  // A caller's partial inventory may leave out what else is in bin/, so what
  // the walk sees is not the whole directory (PR #210 review).
  if (tree.inventory?.complete === false) return true;
  return walk(dir, 1);
}

/**
 * #212: what sits under a reported directory, at any depth. `files` counts the
 * non-dotfiles, `dotfiles` the placeholders (`.gitkeep`); `partial` is true when
 * the walk stopped at its bounds or could not list a directory, so the counts
 * are a lower bound.
 */
function contentsOf(tree: Tree, dir: string): { files: number; dotfiles: number; partial: boolean } {
  const out = { files: 0, dotfiles: 0, partial: false };
  const walk = (rel: string, depth: number): void => {
    const entries = tree.entries(rel);
    if (typeof entries === 'string') {
      out.partial = true;
      return;
    }
    for (const entry of entries.values()) {
      if (out.files + out.dotfiles > BIN_WALK_MAX_FILES) {
        out.partial = true;
        return;
      }
      if (entry.isDirectory()) {
        if (depth >= BIN_WALK_MAX_DEPTH) out.partial = true;
        else walk(`${rel}/${entry.name}`, depth + 1);
      } else if (entry.name.startsWith('.')) out.dotfiles++;
      else out.files++;
    }
  };
  walk(dir, 1);
  return out;
}

/** `p` as a repo-relative POSIX path without `./`, a leading slash or glob tail; the first segment names the directory. */
function firstSegment(p: string): string {
  const normalized = path.posix.normalize(p.replace(/\\/g, '/').replace(/^!/, '')).replace(/^(?:\.\/)+/, '').replace(/^\/+/, '');
  return normalized.split('/')[0] ?? '';
}

function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out);
  else if (typeof value === 'object' && value !== null) for (const v of Object.values(value)) stringsIn(v, out);
  return out;
}

/**
 * #212: directories the repository's own manifests point into on purpose, so
 * the directory is committed deliberately and is not a stray build artifact:
 * a package.json `main` / `module` / `types` / `bin` / `files` / `exports`
 * (and `directories.bin`) target, and an Action's `runs.main` / `pre` / `post`.
 * Unreadable or unfetched files name nothing: a hosted scan that listed them
 * without fetching them is covered by the tracked-content rule instead.
 */
function manifestTargetDirs(tree: Tree): Set<string> {
  const dirs = new Set<string>();
  const add = (target: string): void => {
    const first = firstSegment(target);
    if (first && first !== '..' && first !== '.') dirs.add(first);
  };
  const pkg = tree.readText('package.json', { maxBytes: 1_000_000 });
  if (pkg.state === 'found') {
    try {
      const parsed = JSON.parse(pkg.content) as Record<string, unknown> | null;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        for (const key of ['main', 'module', 'types', 'typings', 'browser', 'bin', 'files', 'exports']) {
          for (const target of stringsIn(parsed[key])) add(target);
        }
        const directories = parsed.directories;
        if (typeof directories === 'object' && directories !== null) {
          for (const target of stringsIn((directories as Record<string, unknown>).bin)) add(target);
        }
      }
    } catch {
      // not JSON: names nothing
    }
  }
  for (const name of ['action.yml', 'action.yaml']) {
    const action = tree.readText(name, { maxBytes: 256 * 1024 });
    if (action.state !== 'found') continue;
    for (const line of action.content.split(/\r?\n/)) {
      const m = /^\s+(?:main|pre|post)\s*:\s*['"]?([^'"\s#]+)/.exec(line);
      if (m?.[1]) add(m[1]);
    }
  }
  return dirs;
}

/** Markdown files read for links into a directory: the root's own, plus the instruction files. */
const MARKDOWN_LINK_FILES = 30;

/**
 * #212: true when a markdown file links or embeds a file under `dir` that the
 * repository holds (a coverage badge: `![coverage](coverage/badge.svg)`).
 * Only link and image targets count; a sentence that merely names `dist/cli.js`
 * is not a reference, and the target must exist.
 */
function markdownLinksInto(tree: Tree, dir: string, texts: string[]): boolean {
  const escaped = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:\\]\\(\\s*<?|(?:src|href)\\s*=\\s*["'])(?:\\./)?(${escaped}/[^)\\s>"'#?]+)`, 'gi');
  for (const text of texts) {
    for (const m of text.matchAll(re)) {
      const found = tree.lookup(m[1]!);
      if (found.state === 'found' && !found.isDir) return true;
    }
  }
  return false;
}

/**
 * #212: `bin/` holding a tool the build needs and the repository commits on
 * purpose (a Gradle `files('bin/google-java-format.jar')`, a Maven `systemPath`
 * into `bin/`, a .NET target running `bin\nuget.exe`). A build file naming a
 * FILE under `bin/` is a dependency; an `OutputPath` such as `bin\Debug\` is the
 * output location and names no file, and a `Debug`/`Release` path is output.
 */
function buildFileNamesToolInBin(tree: Tree, rootNames: string[]): boolean {
  const re = /(?:^|[\s"'>(=,]|[})][\\/]?)bin[\\/]([^\s"'<>)]*\.\w+)/g;
  for (const name of rootNames) {
    if (!isDotnetBuildFile(name) && !isJvmBuildFile(name)) continue;
    const read = tree.readText(name, { maxBytes: 1_000_000 });
    if (read.state !== 'found') continue;
    for (const m of read.content.matchAll(re)) {
      if (!/(?:^|[\\/])(?:Debug|Release)[\\/]/i.test(m[1]!)) return true;
    }
  }
  return false;
}

function issueId(checkId: string): string {
  const hash = crypto.createHash('sha1').update(checkId).digest('hex').slice(0, 12);
  return `security-pack-${hash}`;
}

function destructiveCommandIssueId(filePath: string, command: string): string {
  const hash = crypto.createHash('sha1').update(`destructive-command:${filePath}:${command}`).digest('hex').slice(0, 12);
  return `destructive-command-${hash}`;
}

/** SP1 / B3: per-FILE id — see call site for why this replaced a constant id. */
function inspectReportsFirstIssueId(filePath: string): string {
  const hash = crypto.createHash('sha1').update(`inspect-reports-first:${filePath}`).digest('hex').slice(0, 12);
  return `security-pack-inspect-reports-first-${hash}`;
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

/**
 * SP3: does this .gitignore LINE actually ignore `target` (a bare directory
 * or dotfile name, no slashes)?
 *
 * Old behavior used `clean.includes(target)` as a catch-all fallback, which
 * was wrong two ways:
 *   1. A NEGATION line ("!.promptci/") re-includes a path (un-ignores it) in
 *      gitignore syntax, but `"!.promptci".includes(".promptci")` is true, so
 *      the negation was misread as "yes, this is ignored".
 *   2. Substring matching let an unrelated entry satisfy the check —
 *      "distribution.md".includes("dist") and "builds-notes/".includes("build")
 *      are both true, so those unrelated lines were misread as ignoring
 *      "dist"/"build", masking a real unignored-directory finding (FN).
 *
 * Fixed by rejecting negation lines outright, then requiring an EXACT path
 * SEGMENT match (splitting on '/' so a leading globstar segment doesn't
 * block the match, but a differently-named file/dir never accidentally
 * satisfies it).
 */
export function gitignoreLineMatchesTarget(line: string, target: string): boolean {
  if (line.startsWith('!')) return false;
  const clean = line.replace(/^\/+|\/+$/g, '');
  const segments = clean.split('/');
  return segments.includes(target);
}

export function detectSecurityPack(context: RepoContext): PromptCiIssue[] {
  const { files, repoRoot } = context;
  if (files.length === 0) return [];

  /**
   * pcic-e6xa: every existence signal below is a FIXED name, but the tree
   * around it is the scanned repository's own: a `.env` or `.promptci`
   * committed as a link out of the tree used to decide whether a finding
   * fires, and in the hosted product the scan root is a server temp
   * directory. Asking through the tree keeps all of it inside the root — and
   * lets a caller's file inventory answer first, so a server scan that holds
   * only the instruction files still knows what the repository contains
   * (pcic-csf).
   */
  const tree = treeFor(context);
  const issues: PromptCiIssue[] = [];
  const combinedContent = files.map((f) => f.content).join('\n');
  const allFilePaths = files.map((f) => f.path);

  // 1. Secret Safeguard Signal
  const envFiles = ['.env', '.env.example', '.env.local', '.env.development', '.env.production'];
  const hasEnvVars = envFiles.some((f) => tree.exists(f)) ||
    context.files.some(f => /env\s+vars|environment\s+variables/i.test(f.content));

  if (hasEnvVars) {
    const check = SECURITY_CHECKS.find(c => c.id === 'no-secret-safeguard')!;
    if (!matchesAny(combinedContent, check.patterns)) {
      issues.push({
        id: issueId(check.id),
        severity: check.severity,
        category: 'security',
        title: check.title,
        summary: check.summary,
        filePaths: allFilePaths,
        locations: [],
        evidence: ['Environment variables detected but no safeguard instruction found.'],
        recommendation: check.recommendation,
        fixRecipe: check.fixRecipe,
        confidence: check.confidence,
      });
    }
  }

  // 2. Supabase Signal
  const supabaseDeps = {
    ...context.packageJson.dependencies,
    ...context.packageJson.devDependencies,
    ...context.packageJson.peerDependencies,
  };
  const hasSupabase = tree.exists('supabase/migrations') ||
    Object.keys(supabaseDeps).some((dep) => dep === '@supabase/supabase-js' || dep.startsWith('@supabase/'));

  if (hasSupabase) {
    const check = SECURITY_CHECKS.find(c => c.id === 'no-supabase-service-role-rule')!;
    if (!matchesAny(combinedContent, check.patterns)) {
      issues.push({
        id: issueId(check.id),
        severity: check.severity,
        category: 'security',
        title: check.title,
        summary: check.summary,
        filePaths: allFilePaths,
        locations: [],
        evidence: ['Supabase detected but no service role safeguard instruction found.'],
        recommendation: check.recommendation,
        fixRecipe: check.fixRecipe,
        confidence: check.confidence,
      });
    }
  }

  // 3. Upload Signal
  // Basic heuristic: look for common upload-related paths or keywords in file paths
  // SP4: normalize backslashes first — on win32, f.path uses `\`, so a bare
  // `/api/upload` substring check never matched an absolute Windows path.
  const hasUploadFeatures = context.files.some(f => {
    const normalizedPath = f.path.replace(/\\/g, '/');
    return (
      normalizedPath.includes('/api/upload') ||
      normalizedPath.includes('/uploads/') ||
      /multer|busboy|formidable/i.test(f.content)
    );
  });

  if (hasUploadFeatures) {
    const check = SECURITY_CHECKS.find(c => c.id === 'no-upload-boundary-docs')!;
    if (!matchesAny(combinedContent, check.patterns)) {
      issues.push({
        id: issueId(check.id),
        severity: check.severity,
        category: 'security',
        title: check.title,
        summary: check.summary,
        filePaths: allFilePaths,
        locations: [],
        evidence: ['Upload features detected but no data boundary documentation found.'],
        recommendation: check.recommendation,
        fixRecipe: check.fixRecipe,
        confidence: check.confidence,
      });
    }
  }

  // 4. .promptci/ Signal
  const hasPromptCiFolder = tree.exists('.promptci');
  if (hasPromptCiFolder) {
    const check = SECURITY_CHECKS.find(c => c.id === 'no-promptci-report-safeguard')!;
    if (!matchesAny(combinedContent, check.patterns)) {
      issues.push({
        id: issueId(check.id),
        severity: check.severity,
        category: 'security',
        title: check.title,
        summary: check.summary,
        filePaths: allFilePaths,
        locations: [],
        evidence: ['.promptci/ folder detected but no report safeguard instruction found.'],
        recommendation: check.recommendation,
        fixRecipe: check.fixRecipe,
        confidence: check.confidence,
      });
    }
  }

  // 5. Destructive Commands in instructions
  for (const file of files) {
    for (const cmd of DESTRUCTIVE_COMMANDS) {
      if (cmd.pattern.test(file.content)) {
        // Check if there is safety language nearby or in the same file
        const safetyPatterns = [
          /ask\s+(before|for\s+approval)/i,
          /confirm\s+before/i,
          /be\s+careful\s+with/i,
          /destructive\s+operation/i,
          /\bdanger(?:ous)?\b/i,
        ];

        if (!matchesAny(file.content, safetyPatterns)) {
          issues.push({
            id: destructiveCommandIssueId(fileIdPath(file), cmd.name),
            severity: 'warning',
            category: 'security',
            title: `Destructive command "${cmd.name}" without safety language`,
            summary:
              `Instruction file contains a destructive command "${cmd.name}" but lacks ` +
              `safety language (e.g., "Ask before running").`,
            filePaths: [file.path],
            locations: [], // Could be improved with line numbers
            evidence: [`Destructive command "${cmd.name}" found in ${path.basename(file.path)} without safety language.`],
            recommendation:
              `Add safety language such as "Ask for confirmation before running ${cmd.name}" ` +
              `to ensure destructive operations are not performed accidentally.`,
            confidence: 0.7,
          });
        }
      }
    }
  }

  // 6. .gitignore Checks (Cost 9)
  // Read through the tree, so this is the same `.gitignore` the dead-reference
  // and skill checks consult (createGitIgnoreChecker). `unreadable` means the
  // scan knows the file is there but cannot read it — a caller's inventory
  // listed it without fetching it (pcic-csf) — so the two findings below say
  // nothing rather than claiming an entry is absent from text nobody read.
  const gitignoreRead = tree.readText('.gitignore');
  const gitignoreUnknown = gitignoreRead.state === 'unreadable'
    || gitignoreRead.state === 'unfetched'
    || gitignoreRead.state === 'too-large';
  const gitignoreContent = gitignoreRead.state === 'found' ? gitignoreRead.content : '';

  const gitignoreLines = gitignoreContent
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  const hasPromptCiGitignore = gitignoreLines.some((line) => gitignoreLineMatchesTarget(line, '.promptci'));

  if (!hasPromptCiGitignore && !gitignoreUnknown) {
    issues.push({
      id: 'security-pack-no-promptci-gitignore',
      severity: 'info',
      category: 'security',
      title: 'Missing .promptci/ ignore in .gitignore',
      summary:
        'The .promptci/ directory is not ignored in .gitignore, which may lead to ' +
        'committing large generated scan reports to the repository.',
      filePaths: ['.gitignore'],
      locations: [],
      evidence: ['.promptci/ entry not found in .gitignore'],
      // BUG-7: recommend the carve-out, not a bare `.promptci/`. Ignoring the
      // whole directory also ignores baseline.json, and `--baseline` /
      // `--fail-on-new` need that file committed and readable in CI.
      recommendation:
        'Add the following to `.gitignore` so generated reports stay out of git while the shared ' +
        'baseline and config remain committed:\n' +
        PROMPTCI_GITIGNORE_LINES.map((l) => `    ${l}`).join('\n') +
        '\n\nUse `.promptci/*` rather than `.promptci/` — git does not descend into an ignored ' +
        'directory, so the `!` negations only work against the directory\'s contents.',
      fixRecipe: PROMPTCI_GITIGNORE_BLOCK,
      // `applyFixRecipe` appends the baseline-preserving stanza deterministically
      // — a mechanical, reversible edit, so `promptci fix` may auto-apply it.
      autoApplySafe: true,
      confidence: 0.9,
    });
  }

  // 7. Unignored build, output, or coverage directories (Cost 9)
  const commonDirs = ['coverage', 'dist', 'build', '.next', 'bin', 'obj', 'temp', 'tmp', 'logs'];
  const rootNames = rootFileNames(tree);
  // #188: Cursor skips .gitignore paths, its default list (.env*, *.lock, node_modules/, .git/) and
  // .cursorignore for Agent and Tab, but not what its terminal and MCP tools read.
  const cursorignoreRead = tree.readText('.cursorignore');
  const cursorignoreLines = (cursorignoreRead.state === 'found' ? cursorignoreRead.content : '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const onlyCursorEvidenced = files.length > 0 && files.every((f) => f.fileType === 'cursor');
  // #212: what a repository's own files say is committed on purpose.
  let deliberateDirs: Set<string> | undefined;
  let markdownTexts: string[] | undefined;
  const loadMarkdown = (): string[] => {
    if (markdownTexts) return markdownTexts;
    const texts = files.filter((f) => /\.(?:md|mdx|markdown)$/i.test(f.path)).map((f) => f.content);
    const rootEntries = tree.entries(tree.root);
    if (typeof rootEntries !== 'string') {
      for (const entry of rootEntries.values()) {
        if (texts.length >= MARKDOWN_LINK_FILES) break;
        if (entry.isDirectory() || !/\.(?:md|mdx|markdown)$/i.test(entry.name)) continue;
        const read = tree.readText(entry.name, { maxBytes: 256 * 1024 });
        if (read.state === 'found') texts.push(read.content);
      }
    }
    markdownTexts = texts;
    return texts;
  };
  const trackedCounts = new Map<string, number>();
  const cursorExcluded = new Set<string>();
  const unignoredDirs = gitignoreUnknown ? [] : commonDirs.filter((d) => {
    if (!tree.isDir(d)) return false;
    // #161: `bin`/`obj` are build output only where the build that writes them lives.
    const gate = ECOSYSTEM_OUTPUT_DIRS[d];
    if (gate && !gate(tree, rootNames)) return false;
    if (gitignoreLines.some((line) => gitignoreLineMatchesTarget(line, d))) return false;
    // #188: a directory .cursorignore lists is not read by Cursor's Agent or Tab. When Cursor is the only
    // tool the instruction files evidence there is nothing left to report; otherwise say so and keep it.
    if (cursorignoreLines.some((line) => gitignoreLineMatchesTarget(line, d))) {
      if (onlyCursorEvidenced) return false;
      cursorExcluded.add(d);
    }
    // #212: a directory holding only placeholder dotfiles (`logs/.gitkeep`) is committed on purpose.
    const contents = contentsOf(tree, d);
    if (contents.files === 0 && contents.dotfiles > 0 && !contents.partial) return false;
    // #212: a directory a manifest, an Action, a markdown link or a build file points into is deliberate.
    deliberateDirs ??= manifestTargetDirs(tree);
    if (deliberateDirs.has(d)) return false;
    if (markdownLinksInto(tree, d, loadMarkdown())) return false;
    if (d === 'bin' && buildFileNamesToolInBin(tree, rootNames)) return false;
    // #212: with a complete inventory, files listed under the directory are tracked by definition.
    if (tree.inventory?.complete === true && (contents.files > 0 || contents.partial)) {
      trackedCounts.set(d, contents.files);
    }
    return true;
  });

  if (unignoredDirs.length > 0) {
    issues.push({
      id: 'security-pack-unignored-dirs',
      severity: 'warning',
      category: 'context_bloat',
      title: 'Unignored build, output, or coverage directories',
      summary:
        `The repository contains directory/directories (${unignoredDirs.join(', ')}) that are ` +
        `commonly generated but not ignored in .gitignore. AI coding tools may read these into ` +
        `their context, inflating token costs; each tool decides what it skips (Cursor skips ` +
        `.gitignore, .cursorignore and a default list, but not what its terminal and MCP tools read).` +
        (trackedCounts.size > 0
          ? ` ${[...trackedCounts.keys()].join(', ')} already holds tracked files, which a .gitignore entry does not untrack.`
          : ''),
      filePaths: ['.gitignore'],
      locations: [],
      evidence: unignoredDirs.map((d) => {
        const tracked = trackedCounts.get(d);
        const base = `Directory "${d}" exists but is not ignored in .gitignore`;
        const parts: string[] = [];
        if (tracked !== undefined) parts.push(`it holds ${tracked > 0 ? `${tracked} ` : ''}tracked file(s), so ignoring it does not untrack them`);
        if (cursorExcluded.has(d)) parts.push('Cursor already skips it through .cursorignore, other tools may not');
        return parts.length > 0 ? `${base}; ${parts.join('; ')}.` : `${base}.`;
      }),
      recommendation:
        `Add generated directories to .gitignore. For example: "${unignoredDirs.map((d) => `${d}/`).join(', ')}"` +
        (trackedCounts.size > 0
          ? `. Files already committed stay committed: run \`git rm -r --cached ${[...trackedCounts.keys()].join(' ')}\` as well, ` +
            'or leave the directory out of .gitignore if it is committed on purpose.'
          : ''),
      fixRecipe: unignoredDirs.map((d) => `echo "${d}/" >> .gitignore`).join('\n'),
      // `applyFixRecipe` appends each missing directory to .gitignore — a
      // mechanical, reversible edit, so `promptci fix` may auto-apply it.
      // pcic-1ik0.19: but not when the caller declared its file inventory
      // incomplete: the listing may leave out tracked files inside the
      // directory, so the finding is still reported (`bin` is withheld above)
      // and the human decides. There is no `fixEdits` to drop: the edit is
      // derived from the id and evidence, which only `autoApplySafe` gates.
      // #212: and not when a reported directory holds tracked files: the recipe is then not the complete fix.
      autoApplySafe: tree.inventory?.complete !== false && trackedCounts.size === 0,
      confidence: 0.8,
    });
  }

  // 8. Broad include patterns scanning generated directories (Cost 9)
  let hasBroadInclude = false;
  try {
    const configRead = tree.readText('.promptci/config.json');
    if (configRead.state === 'found') {
      const config = JSON.parse(configRead.content);
      if (Array.isArray(config.include)) {
        const broadPatterns = ['**/*', '**/*.md', '*', '*.*', '**'];
        hasBroadInclude = config.include.some((p: string) => broadPatterns.includes(p.trim()));
      }
    }
  } catch {
    // malformed config — the scan's own loader reports it
  }

  if (hasBroadInclude) {
    const scannedGenerated = files.filter((f) => {
      const rel = path.relative(/*turbopackIgnore: true*/ repoRoot, f.path).replace(/\\/g, '/');
      return (
        rel.includes('.promptci/') ||
        rel.includes('coverage/') ||
        rel.includes('.next/')
      );
    });

    if (scannedGenerated.length > 0) {
      issues.push({
        id: 'security-pack-broad-include',
        severity: 'warning',
        category: 'context_bloat',
        title: 'Broad include pattern scanning generated directories',
        summary:
          'PromptCI configuration has a broad include pattern that matches generated directories ' +
          'such as .promptci/ or coverage/, causing them to be unnecessarily scanned.',
        filePaths: ['.promptci/config.json'],
        locations: [],
        evidence: scannedGenerated.map((f) => `Scanned generated file: ${path.relative(/*turbopackIgnore: true*/ repoRoot, f.path).replace(/\\/g, '/')}`),
        recommendation: 'Refine the include patterns in .promptci/config.json or add exclusions to avoid scanning generated/temporary documents.',
        fixRecipe: 'Modify .promptci/config.json to restrict "include" to specific instruction files, or add exclusions to "exclude".',
        confidence: 0.95,
      });
    }
  }

  // 9. Inspect generated reports before source docs (Cost 9)
  for (const file of files) {
    // BUG-20: each pattern carries a human label so evidence can quote the
    // matched instruction text instead of the regex source.
    const inspectBeforePatterns: Array<{ re: RegExp; label: string }> = [
      { re: /read\s+.*\.promptci\s+before/i, label: 'Instruction to read .promptci reports first' },
      { re: /inspect\s+.*\.promptci\s+before/i, label: 'Instruction to inspect .promptci reports first' },
      { re: /check\s+.*\.promptci\s+before/i, label: 'Instruction to check .promptci reports first' },
      { re: /read\s+.*report.*\s+before\s+.*(source|docs|code)/i, label: 'Instruction to read generated reports before source' },
      { re: /inspect\s+.*report.*\s+before\s+.*(source|docs|code)/i, label: 'Instruction to inspect generated reports before source' },
    ];

    for (const pat of inspectBeforePatterns) {
      if (pat.re.test(file.content)) {
        issues.push({
          // SP1 / B3: was a constant id inside this per-file loop — the
          // `break` below only exits the pattern loop, not the file loop, so
          // two matching files produced two issues sharing ONE id.
          id: inspectReportsFirstIssueId(fileIdPath(file)),
          severity: 'info',
          category: 'context_bloat',
          title: 'Instruction prioritizing generated reports over source docs',
          summary:
            `Instruction file "${path.basename(file.path)}" tells the agent to inspect ` +
            `generated reports before source files, which can cause circular or outdated guidance ingestion.`,
          filePaths: [file.path],
          locations: [],
          evidence: [matchEvidence(file.content, pat.re, pat.label)],
          recommendation: 'Recommend linking to latest reports or directing the agent to read source documents first instead of generated reports.',
          fixRecipe: 'Update the instruction to prioritize reading source files and configuration rather than relying on generated reports.',
          confidence: 0.7,
        });
        break; // one issue per file
      }
    }
  }

  return issues;
}
