/**
 * Manifest-consistency detector for PromptCI.
 *
 * Cross-references instruction file content against project manifest files
 * (pyproject.toml, package.json) and flags mismatches that would cause an
 * agent to follow an instruction that conflicts with the actual build setup.
 *
 * BUG-001: Tooling mismatch — instruction says `pip install -r requirements.txt`
 *          but pyproject.toml declares Poetry as the build backend and there is
 *          no requirements.txt in the repo.
 *
 * BUG-002: Python version mismatch — instruction file claims an older Python
 *          version than the one pinned in pyproject.toml's `python` constraint.
 *
 * BUG-003: Library version mismatch — instruction file claims compatibility
 *          with an older major library version than the one pinned in pyproject.toml.
 *
 * Findings are heuristic — wording is intentionally cautious.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { InstructionFile, PromptCiIssue } from './types.js';
import type { RepoContext } from './repo-context.js';
import { buildCodeMask } from './markdown-fences.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ManifestData = {
  /** Raw text content of package.json, if present. */
  packageJson?: string;
  /** Raw text content of pyproject.toml, if present. */
  pyproject?: string;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function issueId(key: string): string {
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
  return `manifest-${hash}`;
}

// ── BUG-001: pip vs Poetry tooling mismatch ───────────────────────────────────

/**
 * Detect when instruction files tell the agent to run `pip install -r requirements.txt`
 * but the project actually uses Poetry (pyproject.toml with [tool.poetry]) and has no
 * requirements.txt. Running the pip command would immediately fail.
 */
function checkPipVsPoetry(
  files: InstructionFile[],
  pyprojectContent: string,
  repoRoot: string,
): PromptCiIssue | null {
  const isPoetry =
    /\[tool\.poetry\]/.test(pyprojectContent) ||
    /build-backend\s*=\s*["'][^"']*poetry[^"']*["']/i.test(pyprojectContent);
  if (!isPoetry) return null;

  // Only flag when requirements.txt is genuinely absent — some Poetry projects
  // export a requirements.txt as an artefact; if it exists the instruction is valid.
  const reqTxtPath = path.join(repoRoot, 'requirements.txt');
  if (fs.existsSync(reqTxtPath)) return null;

  const PIP_INSTALL_REQUIREMENTS_RE = /pip\s+install\s+-r\s+requirements\.txt/i;
  const offendingFiles = files.filter((f) => PIP_INSTALL_REQUIREMENTS_RE.test(f.content));
  if (offendingFiles.length === 0) return null;

  return {
    id: issueId('pip-vs-poetry'),
    severity: 'high',
    category: 'conflict',
    title: 'Tooling mismatch: instruction uses pip but project uses Poetry',
    summary:
      'Instruction files tell the agent to run `pip install -r requirements.txt`, but this ' +
      'project uses Poetry as its build system (pyproject.toml with [tool.poetry]) and has no ' +
      'requirements.txt. Running this command would fail immediately.',
    filePaths: offendingFiles.map((f) => f.path),
    locations: offendingFiles.map((f) => ({ filePath: f.path })),
    evidence: [
      '`pip install -r requirements.txt` found in instruction file(s)',
      'pyproject.toml declares Poetry as the build system',
      'requirements.txt does not exist in the repo',
    ],
    recommendation:
      'Update the instruction files to use Poetry commands instead: ' +
      '`poetry install` (or `uv sync` if the project has migrated to uv). ' +
      'Remove the `pip install -r requirements.txt` reference.',
    confidence: 0.9,
  };
}

// ── BUG-002: Python version mismatch ─────────────────────────────────────────

/**
 * Detect when an instruction file states a Python version that is lower than
 * the minimum declared in pyproject.toml's `python` constraint.
 *
 * Example: CLAUDE.md says "We target Python 3.9" but pyproject.toml declares
 * `python = "^3.11"` — an agent following the instruction would target the
 * wrong interpreter and miss 3.10–3.11 language features and APIs.
 */
function checkPythonVersionMismatch(
  files: InstructionFile[],
  pyprojectContent: string,
): PromptCiIssue[] {
  // Extract the minimum Python version from pyproject.toml.
  // Handles: python = "^3.11", ">=3.10", "~=3.9", "3.11.*"
  const manifestMatch =
    /^python\s*=\s*["'][\^~>=<*]*(\d+)\.(\d+)/m.exec(pyprojectContent) ||
    /^requires-python\s*=\s*["'][\^~>=<*]*(\d+)\.(\d+)/m.exec(pyprojectContent);
  if (!manifestMatch) return [];

  const manifestMajor = parseInt(manifestMatch[1]!, 10);
  const manifestMinor = parseInt(manifestMatch[2]!, 10);

  const issues: PromptCiIssue[] = [];
  const reported = new Set<string>();

  // Match "Python X.Y" or "python X.Y" in instruction files (prose mentions)
  const PYTHON_VERSION_RE = /\bPython\s+(\d+)\.(\d+)\b/gi;

  for (const file of files) {
    let m: RegExpExecArray | null;
    const re = new RegExp(PYTHON_VERSION_RE.source, PYTHON_VERSION_RE.flags);
    while ((m = re.exec(file.content)) !== null) {
      const instrMajor = parseInt(m[1]!, 10);
      const instrMinor = parseInt(m[2]!, 10);

      if (isNegationContext(file.content, m.index)) continue;

      // Only flag when the instruction version is strictly older than the manifest minimum
      const isOlder =
        instrMajor < manifestMajor ||
        (instrMajor === manifestMajor && instrMinor < manifestMinor);
      if (!isOlder) continue;

      const instrVersion = `${instrMajor}.${instrMinor}`;
      const manifestVersion = `${manifestMajor}.${manifestMinor}`;
      const dedupeKey = `${file.path}:${instrVersion}`;
      if (reported.has(dedupeKey)) continue;
      reported.add(dedupeKey);

      issues.push({
        id: issueId(`python-version:${file.path}:${instrVersion}`),
        severity: 'high',
        category: 'stale_instruction',
        title: `Python version mismatch: instruction says ${instrVersion}, pyproject.toml requires ≥${manifestVersion}`,
        summary:
          `An instruction file refers to Python ${instrVersion}, but pyproject.toml declares ` +
          `\`python = "^${manifestVersion}"\` (or newer). An agent following this instruction ` +
          `would target an older interpreter and may avoid language features or APIs that are ` +
          `safe to use in this project.`,
        filePaths: [file.path],
        locations: [{ filePath: file.path }],
        evidence: [
          `Instruction says "Python ${instrVersion}"; pyproject.toml requires ≥${manifestVersion}`,
        ],
        recommendation:
          `Update the instruction file to reference Python ${manifestVersion} (or remove the ` +
          `version claim and rely on pyproject.toml as the authoritative source).`,
        confidence: 0.85,
      });
    }
  }

  return issues;
}

// ── BUG-003: Library version mismatch ────────────────────────────────────────

const TRACKED_PYTHON_LIBRARIES = [
  'pandas',
  'numpy',
  'sqlalchemy',
  'fastapi',
  'django',
  'flask',
  'pydantic',
] as const;

type TrackedPythonLibrary = (typeof TRACKED_PYTHON_LIBRARIES)[number];

function displayLibraryName(library: TrackedPythonLibrary): string {
  if (library === 'sqlalchemy') return 'SQLAlchemy';
  if (library === 'fastapi') return 'FastAPI';
  return library[0]!.toUpperCase() + library.slice(1);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseAuthoritativeMajorVersion(versionSpec: string): number | null {
  const spec = versionSpec.trim();

  // Upper-bound-only constraints do not prove the project has moved to that major.
  if (/^<=?\s*\d+/.test(spec)) return null;

  const match = /^(?:\^|~=|==|>=|>|=)?\s*(\d+)(?:\.\d+)?/.exec(spec);
  if (!match) return null;

  return parseInt(match[1]!, 10);
}

function extractManifestLibraryMajors(pyprojectContent: string): Map<TrackedPythonLibrary, number> {
  const versions = new Map<TrackedPythonLibrary, number>();

  for (const library of TRACKED_PYTHON_LIBRARIES) {
    const name = escapeRegExp(library);

    // [tool.poetry.dependencies]
    // pandas = "^2.1"
    const poetryLineRe = new RegExp(`^\\s*${name}\\s*=\\s*["']([^"']+)["']`, 'im');
    const poetryMatch = poetryLineRe.exec(pyprojectContent);
    if (poetryMatch) {
      const major = parseAuthoritativeMajorVersion(poetryMatch[1]!);
      if (major !== null) {
        versions.set(library, major);
        continue;
      }
    }

    // [project]
    // dependencies = ["pandas>=2.1", "numpy==1.26", "pandas[performance]>=2.1"]
    const projectDependencyRe = new RegExp(
      `["']${name}(?:\\[[^\\]]+\\])?\\s*([~^=<>!]{1,2}\\s*\\d+(?:\\.\\d+)?)`,
      'gim',
    );
    let match: RegExpExecArray | null;
    while ((match = projectDependencyRe.exec(pyprojectContent)) !== null) {
      const major = parseAuthoritativeMajorVersion(match[1]!);
      if (major === null) continue;
      versions.set(library, major);
      break;
    }
  }

  return versions;
}

function hasCompatibilityIntent(content: string, index: number): boolean {
  const windowStart = Math.max(0, index - 80);
  const windowEnd = Math.min(content.length, index + 120);
  const window = content.slice(windowStart, windowEnd);
  return /\b(target|support|supports|compatibility|compatible|avoid|maintain|maintains)\b/i.test(window);
}

/**
 * Detect when instruction files reference an older major version of a common
 * Python data/web library than the major version declared in pyproject.toml.
 *
 * Example: CLAUDE.md says "Target Pandas 1.5 compatibility" but pyproject.toml
 * declares `pandas = "^2.1"` — an agent following the instruction may avoid
 * APIs that are safe for this project.
 */
function checkLibraryVersionMismatch(
  files: InstructionFile[],
  pyprojectContent: string,
): PromptCiIssue[] {
  const manifestVersions = extractManifestLibraryMajors(pyprojectContent);
  if (manifestVersions.size === 0) return [];

  const issues: PromptCiIssue[] = [];
  const reported = new Set<string>();

  for (const [library, manifestMajor] of manifestVersions) {
    const displayName = displayLibraryName(library);
    const libraryMentionRe = new RegExp(
      `\\b${escapeRegExp(displayName)}\\s+(?:v(?:ersion)?\\s*)?(\\d+)(?:\\.(\\d+|x))?\\b`,
      'gi',
    );

    for (const file of files) {
      let match: RegExpExecArray | null;
      const re = new RegExp(libraryMentionRe.source, libraryMentionRe.flags);
      while ((match = re.exec(file.content)) !== null) {
        if (!hasCompatibilityIntent(file.content, match.index)) continue;

        const instructionMajor = parseInt(match[1]!, 10);
        if (instructionMajor >= manifestMajor) continue;

        const instructionVersion = match[2]
          ? `${instructionMajor}.${match[2]}`
          : `${instructionMajor}.x`;
        const dedupeKey = `${file.path}:${library}:${instructionVersion}`;
        if (reported.has(dedupeKey)) continue;
        reported.add(dedupeKey);

        issues.push({
          id: issueId(`library-version:${file.path}:${library}:${instructionVersion}`),
          severity: 'high',
          category: 'stale_instruction',
          title:
            `${displayName} version mismatch: instruction says ${instructionVersion}, ` +
            `pyproject.toml uses ${manifestMajor}.x`,
          summary:
            `An instruction file refers to ${displayName} ${instructionVersion}, but ` +
            `pyproject.toml declares ${library} ${manifestMajor}.x. An agent following ` +
            `this instruction may avoid APIs that are valid for the installed dependency ` +
            `or target compatibility behavior that no longer matches the project manifest.`,
          filePaths: [file.path],
          locations: [{ filePath: file.path }],
          evidence: [
            `Instruction says "${displayName} ${instructionVersion}"; pyproject.toml uses ${library} ${manifestMajor}.x`,
          ],
          recommendation:
            `Update the instruction file to match ${displayName} ${manifestMajor}.x, or remove ` +
            `the version-specific guidance and rely on pyproject.toml as the authoritative source.`,
          confidence: 0.85,
        });
      }
    }
  }

  return issues;
}

// ── Public detector ───────────────────────────────────────────────────────────

// ── JavaScript / TypeScript manifest checks ──────────────────────────────────

const TRACKED_JS_LIBRARIES = [
  'react',
  'next',
  'typescript',
  'vite',
  'vitest',
  'jest',
] as const;

type TrackedJsLibrary = (typeof TRACKED_JS_LIBRARIES)[number];

const JS_DISPLAY_NAMES: Record<TrackedJsLibrary, string> = {
  react: 'React',
  next: 'Next.js',
  typescript: 'TypeScript',
  vite: 'Vite',
  vitest: 'Vitest',
  jest: 'Jest',
};

function parsePackageJsonVersions(packageJsonContent: string): Map<TrackedJsLibrary, number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJsonContent);
  } catch {
    return new Map();
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return new Map();
  }

  const obj = parsed as Record<string, unknown>;
  const versions = new Map<TrackedJsLibrary, number>();
  const dependencyBlocks = [obj.dependencies, obj.devDependencies, obj.peerDependencies];

  for (const block of dependencyBlocks) {
    if (typeof block !== 'object' || block === null || Array.isArray(block)) continue;
    const deps = block as Record<string, unknown>;
    for (const library of TRACKED_JS_LIBRARIES) {
      const spec = deps[library];
      if (typeof spec !== 'string') continue;
      const major = parseAuthoritativeMajorVersion(spec);
      if (major !== null) versions.set(library, major);
    }
  }

  return versions;
}

function checkJsLibraryVersionMismatch(
  files: InstructionFile[],
  packageJsonContent: string,
): PromptCiIssue[] {
  const manifestVersions = parsePackageJsonVersions(packageJsonContent);
  if (manifestVersions.size === 0) return [];

  const issues: PromptCiIssue[] = [];
  const reported = new Set<string>();

  for (const [library, manifestMajor] of manifestVersions) {
    const displayName = JS_DISPLAY_NAMES[library];
    const libraryMentionRe = new RegExp(
      `\\b${escapeRegExp(displayName)}\\s+(?:v(?:ersion)?\\s*)?(\\d+)(?:\\.(\\d+|x))?\\b`,
      'gi',
    );

    for (const file of files) {
      let match: RegExpExecArray | null;
      const re = new RegExp(libraryMentionRe.source, libraryMentionRe.flags);
      while ((match = re.exec(file.content)) !== null) {
        if (!hasJsVersionIntent(file.content, match.index)) continue;

        const instructionMajor = parseInt(match[1]!, 10);
        if (instructionMajor >= manifestMajor) continue;

        const instructionVersion = match[2]
          ? `${instructionMajor}.${match[2]}`
          : `${instructionMajor}.x`;
        const dedupeKey = `${file.path}:${library}:${instructionVersion}`;
        if (reported.has(dedupeKey)) continue;
        reported.add(dedupeKey);

        issues.push({
          id: issueId(`js-library-version:${file.path}:${library}:${instructionVersion}`),
          severity: 'high',
          category: 'stale_instruction',
          title:
            `${displayName} version mismatch: instruction says ${instructionVersion}, ` +
            `package.json uses ${manifestMajor}.x`,
          summary:
            `An instruction file refers to ${displayName} ${instructionVersion}, but ` +
            `package.json declares ${library} ${manifestMajor}.x. An agent following ` +
            `this instruction may target compatibility behavior or APIs that no longer ` +
            `match the installed dependency.`,
          filePaths: [file.path],
          locations: [{ filePath: file.path }],
          evidence: [
            `Instruction says "${displayName} ${instructionVersion}"; package.json uses ${library} ${manifestMajor}.x`,
          ],
          recommendation:
            `Update the instruction file to match ${displayName} ${manifestMajor}.x, or remove ` +
            `the version-specific guidance and rely on package.json as the authoritative source.`,
          confidence: 0.85,
        });
      }
    }
  }

  return issues;
}

function hasJsVersionIntent(content: string, index: number): boolean {
  const windowStart = Math.max(0, index - 100);
  const windowEnd = Math.min(content.length, index + 140);
  const window = content.slice(windowStart, windowEnd);
  return /\b(use|using|target|support|supports|compatibility|compatible|avoid|maintain|migration|migrate|features?|apis?)\b/i.test(window);
}

/**
 * Returns true when a line around the match position reads as a negation or
 * advisory non-use (e.g. "do not use npm", "avoid npm", "don't use npm").
 * Used to avoid false-positives on correct guidance.
 */
function isNegationContext(content: string, matchIndex: number): boolean {
  const lineStart = content.lastIndexOf('\n', matchIndex - 1) + 1;
  const lineEnd = content.indexOf('\n', matchIndex);
  const line = content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
  return /\b(?:do\s+not|don'?t|avoid|never|instead\s+of|not\s+use|refrain\s+from)\b/i.test(line);
}

/**
 * Detect when instructions tell the agent to use a different package manager
 * than the one indicated by the repo's lockfile/package.json.
 *
 * Negation context ("do not use npm", "avoid yarn") is intentionally skipped
 * because that kind of advisory guidance is correct in a pnpm project, not a
 * mismatch.
 */
function checkPackageManagerMismatch(context: RepoContext): PromptCiIssue | null {
  const { packageJson, files } = context;
  const preferred = packageJson.packageManagerName;
  if (preferred === 'unknown') return null;

  const alternatives: { name: string; label: string }[] = [
    { name: 'npm', label: 'npm' },
    { name: 'pnpm', label: 'pnpm' },
    { name: 'yarn', label: 'Yarn' },
    { name: 'bun', label: 'Bun' },
  ].filter((a) => a.name !== preferred);

  const offendingFiles: InstructionFile[] = [];
  for (const file of files) {
    for (const alt of alternatives) {
      // Match commands like "npm install", "yarn add", "bun run"
      const re = new RegExp(`\\b${alt.name}\\s+(?:install|add|run|exec|dlx|i)\\b`, 'gi');
      let match: RegExpExecArray | null;
      let positiveHit = false;
      while ((match = re.exec(file.content)) !== null) {
        const lineStart = file.content.lastIndexOf('\n', match.index - 1) + 1;
        const lineEnd = file.content.indexOf('\n', match.index);
        const line = file.content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
        if (preferred === 'pnpm' && /\bnpm\s+(?:install|i)\s+-g\s+pnpm\b/i.test(line)) continue;
        if (!isNegationContext(file.content, match.index)) {
          positiveHit = true;
          break;
        }
      }
      if (positiveHit) {
        offendingFiles.push(file);
        break;
      }
    }
  }

  if (offendingFiles.length === 0) return null;

  return {
    id: 'manifest-package-manager-mismatch',
    severity: 'warning',
    category: 'conflict',
    title: `Possible package manager mismatch: instructions use alternatives to ${preferred}`,
    summary:
      `Instruction files refer to other package managers, but this project appears to use ${preferred} ` +
      `(based on ${packageJson.lockfiles.join(', ') || 'package.json'}). ` +
      `Mixing package managers can lead to inconsistent lockfiles and installation errors.`,
    filePaths: offendingFiles.map((f) => f.path),
    locations: offendingFiles.map((f) => ({ filePath: f.path })),
    evidence: [
      `Project appears to use ${preferred}`,
      `Instruction files mention other package managers in command-like contexts`,
    ],
    recommendation: `Update instruction files to consistently use ${preferred} commands.`,
    fixRecipe: `This repo uses ${preferred}. Use \`${preferred} install\`, \`${preferred} test\`, and \`${preferred} build\`; do not substitute npm/yarn commands.`,
    confidence: 0.8,
  };
}

/**
 * Detect when instructions reference scripts that do not exist in package.json.
 */
function checkMissingScripts(context: RepoContext): PromptCiIssue[] {
  const { packageJson, files } = context;
  const availableScripts = new Set(Object.keys(packageJson.scripts));
  if (availableScripts.size === 0) return [];

  const issues: PromptCiIssue[] = [];
  // MF2: '_' was excluded from the script-name char class, so `pnpm build_all`
  // could never match at all (the regex has nowhere to complete once it hits
  // the underscore) — always silently skipped, never validated.
  // MF4: `run` is captured rather than skipped, so an explicit `npm run <name>`
  // can be told apart from a bare `pnpm <token>` — the latter needs code
  // context before it counts as an invocation.
  const SCRIPT_RUN_RE = /\b(?:npm|yarn|pnpm|bun)\s+(run\s+)?([a-z0-9][a-z0-9:_-]*)\b/gi;

  const reported = new Set<string>();

  // MF1: skip list was missing common built-in subcommands/prose verbs, so
  // "npm ci" reported a missing script "ci", and bare "pnpm run" (prose, no
  // actual script name following it) reported a missing script "run".
  const SKIP_SUBCOMMANDS = new Set([
    'install', 'add', 'remove', 'init', 'test', 'start', 'stop', 'restart',
    'exec', 'dlx', 'i', 'help', 'run', 'run-script', 'ci', 'audit', 'update',
    'outdated', 'publish', 'create', 'link', 'why', 'workspace', 'workspaces',
    'store', 'ls', 'list', 'pack', 'unlink', 'uninstall', 'up', 'prune',
    'package', 'packages', 'project', 'repo', 'repository', 'version',
  ]);
  const ENGLISH_FILLER_WORDS = new Set([
    'instead', 'of', 'packages', 'package', 'scripts', 'script', 'ecosystem',
    'are', 'is', 'the', 'a', 'an', 'that', 'this', 'for', 'to', 'and', 'or',
    'not', 'with', 'without', 'via', 'because', 'since', 'before', 'after',
    'than', 'as', 'like', 'but', 'so',
    // MF4: determiners and pronouns that can follow an explicit `run` in prose
    // ("you can pnpm run any of the scripts below").
    'any', 'all', 'each', 'every', 'either', 'both', 'one', 'it', 'them',
    'these', 'those', 'my', 'our', 'your', 'their', 'its',
  ]);

  for (const file of files) {
    const codeMask = buildCodeMask(file.content);
    let match: RegExpExecArray | null;
    const re = new RegExp(SCRIPT_RUN_RE.source, SCRIPT_RUN_RE.flags);
    while ((match = re.exec(file.content)) !== null) {
      const explicitRun = match[1] !== undefined;
      const scriptName = match[2]!;
      if (scriptName.startsWith('-')) {
        continue;
      }
      // MF4: "Node.js 22+, pnpm 9+" is a version requirement, not a script
      // named "9" — no package.json script starts with a digit in practice.
      if (/^[0-9]/.test(scriptName)) {
        continue;
      }
      // MF4: outside a code span or fenced block, `<pm> <word>` is ordinary
      // prose ("consumed from the npm registry", "this is an npm package").
      // Only the explicit `run` form reads as an invocation there.
      if (!explicitRun && !codeMask[match.index]) {
        continue;
      }
      // Skip common standard subcommands that aren't necessarily scripts
      if (SKIP_SUBCOMMANDS.has(scriptName)) {
        continue;
      }
      if (ENGLISH_FILLER_WORDS.has(scriptName.toLowerCase())) {
        continue;
      }

      if (!availableScripts.has(scriptName)) {
        const dedupeKey = `${file.path}:${scriptName}`;
        if (reported.has(dedupeKey)) continue;
        reported.add(dedupeKey);

        issues.push({
          id: `manifest-missing-script:${file.path}:${scriptName}`,
          severity: 'warning',
          category: 'stale_instruction',
          title: `Reference to missing script: "${scriptName}"`,
          summary:
            `Instructions tell the agent to run \`${scriptName}\`, but this script is not defined in package.json. ` +
            `The agent might attempt to run a command that fails.`,
          filePaths: [file.path],
          locations: [{ filePath: file.path }],
          evidence: [`Found reference to \`${scriptName}\` in ${file.path}`],
          recommendation: `Verify if the script name is correct or add the missing script to package.json.`,
          confidence: 0.7,
        });
      }
    }
  }

  return issues;
}

/**
 * Detect when instructions mention a Node.js version lower than engines.node.
 */
function checkNodeVersionMismatch(context: RepoContext): PromptCiIssue[] {
  const { packageJson, files } = context;
  if (!packageJson.enginesNode) return [];

  // Simplified version parsing: look for >= or ^ followed by a number
  const minVersionMatch = />=\s*(\d+)/.exec(packageJson.enginesNode) || /\^\s*(\d+)/.exec(packageJson.enginesNode);
  if (!minVersionMatch) return [];

  const minNodeVersion = parseInt(minVersionMatch[1]!, 10);
  const issues: PromptCiIssue[] = [];
  // MF3 / B2: no dedupe set, unlike every sibling check in this file — "Node 12"
  // mentioned twice in one file emitted two issues sharing the identical id
  // `manifest-node-version-mismatch:<path>:12`, corrupting downstream id-based
  // dedup/trend logic.
  const reported = new Set<string>();

  const NODE_VERSION_RE = /\bNode(?:\.js)?\s*(?:v)?(\d+)\b/gi;

  for (const file of files) {
    let match: RegExpExecArray | null;
    const re = new RegExp(NODE_VERSION_RE.source, NODE_VERSION_RE.flags);
    while ((match = re.exec(file.content)) !== null) {
      const instrVersion = parseInt(match[1]!, 10);
      // MF3: no sibling check fires on a negated mention ("Do not use Node
      // 14") — this one did, since it had no negation-context guard at all.
      if (isNegationContext(file.content, match.index)) continue;
      if (instrVersion < minNodeVersion) {
        const dedupeKey = `${file.path}:${instrVersion}`;
        if (reported.has(dedupeKey)) continue;
        reported.add(dedupeKey);

        issues.push({
          id: `manifest-node-version-mismatch:${file.path}:${instrVersion}`,
          severity: 'warning',
          category: 'stale_instruction',
          title: `Node.js version mismatch: instruction says ${instrVersion}, project requires ≥${minNodeVersion}`,
          summary:
            `Instructions mention Node.js ${instrVersion}, but package.json specifies a minimum version of ${minNodeVersion} in \`engines.node\`.`,
          filePaths: [file.path],
          locations: [{ filePath: file.path }],
          evidence: [`Instruction says Node ${instrVersion}; engines.node says ${packageJson.enginesNode}`],
          recommendation: `Update instructions to reflect the minimum supported Node.js version (${minNodeVersion}).`,
          confidence: 0.8,
        });
      }
    }
  }

  return issues;
}

/**
 * Returns true when the tool mention at `matchIndex` appears to be a negation
 * or migration-history reference rather than an active instruction to use it.
 *
 * Examples that should NOT produce a finding:
 *   - "Do not use Jest; we use Vitest."
 *   - "We migrated from Jest to Vitest last quarter."
 *   - "Avoid Cypress — we use Playwright instead."
 */
function isToolNegationOrHistoryContext(content: string, matchIndex: number, toolName: string): boolean {
  const lineStart = content.lastIndexOf('\n', matchIndex - 1) + 1;
  const lineEnd = content.indexOf('\n', matchIndex);
  const line = content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);

  // Negation phrases before the tool name
  if (/\b(?:do\s+not|don'?t|avoid|never|refrain\s+from|not\s+use)\b/i.test(line.slice(0, matchIndex - lineStart + toolName.length + 5))) {
    return true;
  }
  // Migration/history phrases anywhere in the line
  if (/\b(?:migrat(?:ed?|ing)|replaced?|switched?\s+(?:from|away)|moved?\s+(?:from|away)|no\s+longer\s+use|previously\s+used?)\b/i.test(line)) {
    return true;
  }
  return false;
}

/**
 * Detect when instructions reference one JS tool when another similar tool is used.
 *
 * Skips negation contexts ("do not use Jest") and migration-history prose
 * ("migrated from Jest to Vitest") to avoid false positives on correct
 * advisory guidance.
 */
function checkJsToolingMismatch(context: RepoContext): PromptCiIssue[] {
  const { packageJson, files } = context;
  const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
  const issues: PromptCiIssue[] = [];

  const toolPairs = [
    { name: 'Jest', package: 'jest', alternatives: ['vitest'] },
    { name: 'Vitest', package: 'vitest', alternatives: ['jest'] },
    { name: 'Playwright', package: '@playwright/test', alternatives: ['cypress'] },
    { name: 'Cypress', package: 'cypress', alternatives: ['@playwright/test'] },
  ];

  for (const tool of toolPairs) {
    if (!deps[tool.package]) {
      // Tool is NOT in dependencies. Check if any alternative IS.
      const usedAlt = tool.alternatives.find((alt) => deps[alt]);
      if (usedAlt) {
        // Tool not used, but alternative is. Check if instructions positively mention the unused tool.
        const toolRe = new RegExp(`\\b${tool.name}\\b`, 'gi');
        const offendingFiles = files.filter((f) => {
          let match: RegExpExecArray | null;
          const re = new RegExp(toolRe.source, toolRe.flags);
          while ((match = re.exec(f.content)) !== null) {
            if (!isToolNegationOrHistoryContext(f.content, match.index, tool.name)) {
              return true; // At least one positive mention found
            }
          }
          return false;
        });
        if (offendingFiles.length > 0) {
          issues.push({
            id: `manifest-js-tooling-mismatch:${tool.package}`,
            severity: 'warning',
            category: 'conflict',
            title: `Possible tooling mismatch: instructions mention ${tool.name} but project uses ${usedAlt}`,
            summary:
              `Instructions appear to reference ${tool.name}, but this package is not in dependencies. ` +
              `${usedAlt} is present instead. Consider reviewing whether the instructions are current.`,
            filePaths: offendingFiles.map((f) => f.path),
            locations: offendingFiles.map((f) => ({ filePath: f.path })),
            evidence: [
              `Instructions mention ${tool.name}`,
              `${usedAlt} found in dependencies`,
              `${tool.package} not found in dependencies`,
            ],
            recommendation: `Update instructions to reference ${usedAlt} instead of ${tool.name}, or confirm migration is complete.`,
            confidence: 0.75,
          });
        }
      }
    }
  }

  return issues;
}

/**
 * Cross-reference instruction files against project manifests and flag
 * inconsistencies that would mislead an agent about the build setup.
 *
 * @param files    Scanned instruction files.
 * @param manifests Raw text of any manifest files that were read by the scanner.
 * @param repoRoot  Absolute path to the repo root (used for file existence checks).
 */
export function detectManifestConsistency(context: RepoContext): PromptCiIssue[] {
  const { files, manifests, repoRoot } = context;
  const issues: PromptCiIssue[] = [];

  if (manifests.packageJson) {
    issues.push(...checkJsLibraryVersionMismatch(files, manifests.packageJson));
    issues.push(...checkMissingScripts(context));
    issues.push(...checkNodeVersionMismatch(context));
    issues.push(...checkJsToolingMismatch(context));
  }

  const pmIssue = checkPackageManagerMismatch(context);
  if (pmIssue) issues.push(pmIssue);

  if (manifests.pyproject) {
    const toolingIssue = checkPipVsPoetry(files, manifests.pyproject, repoRoot);
    if (toolingIssue) issues.push(toolingIssue);

    issues.push(...checkPythonVersionMismatch(files, manifests.pyproject));
    issues.push(...checkLibraryVersionMismatch(files, manifests.pyproject));
  }

  return issues;
}
