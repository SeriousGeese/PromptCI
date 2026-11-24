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
import type { FixEdit, InstructionFile, PromptCiIssue } from './types.js';
import type { RepoContext } from './repo-context.js';
import { buildCodeMask } from './markdown-fences.js';
import { fileIdPath } from './finding-id.js';
import { BUILTINS_BY_TOOL, BUN_BUILTINS, analyzeCommands } from './command-validity.js';
import { anyWorkspaceHasScript, isKnownBinary } from './workspace-manifests.js';
import { treeFor } from './repo-tree.js';
import { collectCiPackageManagers } from './ci-alignment.js';
import type { RepoTree } from './repo-tree.js';
import { packageManagerSwapEdits, versionMentionEdits } from './manifest-fix-edits.js';
import type { PackageManagerHit } from './manifest-fix-edits.js';
import {
  formatVersion,
  isBelowFloor,
  readJsLibraryVersion,
  readNodeEngineVersion,
  readPythonLibraryVersion,
  readPythonVersion,
  type ManifestVersionReading,
} from './manifest-versions.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ManifestData = {
  /** Raw text content of package.json, if present. */
  packageJson?: string;
  /** Raw text content of pyproject.toml, if present. */
  pyproject?: string;
  /**
   * BUG-004: raw text content of requirements.txt, if present. Read once
   * (asynchronously) while building the RepoContext so detectors never do
   * synchronous disk I/O inside the scan pipeline.
   */
  requirements?: string;
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
  tree: RepoTree,
): PromptCiIssue | null {
  const isPoetry =
    /\[tool\.poetry\]/.test(pyprojectContent) ||
    /build-backend\s*=\s*["'][^"']*poetry[^"']*["']/i.test(pyprojectContent);
  if (!isPoetry) return null;

  // Only flag when requirements.txt is genuinely absent — some Poetry projects
  // export a requirements.txt as an artefact; if it exists the instruction is valid.
  //
  // pcic-e6xa: asked through the scan's tree. The name is fixed, but a
  // `requirements.txt` committed as a link out of the repository used to decide
  // whether this `high` finding fires, and in the hosted product the scan root
  // is a server temp directory. The tree also lets a caller's file inventory
  // answer when the repository is not on disk (pcic-csf).
  if (tree.exists('requirements.txt')) return null;

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
  // The minimum Python version from pyproject.toml: requires-python and Poetry's python constraint
  // (pcic-1ik0.24: ">3.8" excludes 3.8, and a rewrite needs both to agree; manifest-versions.ts).
  const reading = readPythonVersion(pyprojectContent);
  if (!reading) return [];
  const manifestLabel = reading.label;
  const rewriteTo = reading.rewriteTo ? formatVersion(reading.rewriteTo) : undefined;

  const issues: PromptCiIssue[] = [];
  const reported = new Set<string>();

  // Match "Python X.Y" or "python X.Y" in instruction files (prose mentions)
  const PYTHON_VERSION_RE = /\bPython\s+(\d+)\.(\d+)\b/gi;

  const mayPlanRecipe = recipeBudget();
  for (const file of files) {
    let m: RegExpExecArray | null;
    const re = new RegExp(PYTHON_VERSION_RE.source, PYTHON_VERSION_RE.flags);
    const negated = negationTester(file.content);
    while ((m = re.exec(file.content)) !== null) {
      const instrMajor = parseInt(m[1]!, 10);
      const instrMinor = parseInt(m[2]!, 10);

      if (negated(m.index)) continue;

      // Only flag when the instruction version is below the manifest minimum
      if (!isBelowFloor([instrMajor, instrMinor], reading.floor)) continue;

      const instrVersion = `${instrMajor}.${instrMinor}`;
      const dedupeKey = `${file.path}:${instrVersion}`;
      if (reported.has(dedupeKey)) continue;
      reported.add(dedupeKey);

      // pcic-k1t3.12: every mention of this version in the file, as this loop flags them.
      const mentionsOf = (content: string) => {
        const negatedIn = content === file.content ? negated : negationTester(content);
        return [...content.matchAll(PYTHON_VERSION_RE)].filter(
          (mm) => !negatedIn(mm.index) && `${parseInt(mm[1]!, 10)}.${parseInt(mm[2]!, 10)}` === instrVersion,
        );
      };
      // pcic-1ik0.24: no rewrite unless the manifest settles one version (`rewriteTo`).
      const fixEdits =
        rewriteTo === undefined || !mayPlanRecipe(file)
          ? undefined
          : versionMentionEdits(
              file,
              mentionsOf(file.content).map((mm) => ({
                index: mm.index,
                text: mm[0],
                replacement: mm[0].slice(0, mm[0].length - `${mm[1]}.${mm[2]}`.length) + rewriteTo,
              })),
              PYTHON_VERSION_RE,
              true,
              (next) => mentionsOf(next).length > 0,
            );

      issues.push({
        id: issueId(`python-version:${fileIdPath(file)}:${instrVersion}`),
        severity: 'high',
        category: 'stale_instruction',
        title: `Python version mismatch: instruction says ${instrVersion}, pyproject.toml requires ${manifestLabel}`,
        summary:
          `An instruction file refers to Python ${instrVersion}, but pyproject.toml requires ` +
          `Python ${manifestLabel}. An agent following this instruction ` +
          `would target an older interpreter and may avoid language features or APIs that are ` +
          `safe to use in this project.`,
        filePaths: [file.path],
        locations: [{ filePath: file.path }],
        evidence: [
          `Instruction says "Python ${instrVersion}"; pyproject.toml requires ${manifestLabel}`,
        ],
        recommendation:
          `Update the instruction file to reference ${rewriteTo ? `Python ${rewriteTo}` : `a Python version pyproject.toml allows (${manifestLabel})`} (or remove the ` +
          `version claim and rely on pyproject.toml as the authoritative source).`,
        ...versionFix(fixEdits),
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

/**
 * How many version-mismatch findings in one file get a rewrite planned, per check. Planning
 * re-reads the whole file, and the rewritten copy, for each finding, so a hostile file naming
 * thousands of distinct stale versions made a scan quadratic; past the budget a finding stays
 * advisory (no `fixEdits`), as it does when any mention needs a judgement call.
 */
const MAX_RECIPE_PLANS_PER_FILE = 10;

/** A per-file counter for {@link MAX_RECIPE_PLANS_PER_FILE}: true while `file` has budget left. */
function recipeBudget(): (file: InstructionFile) => boolean {
  const used = new Map<InstructionFile, number>();
  return (file) => {
    const count = used.get(file) ?? 0;
    if (count >= MAX_RECIPE_PLANS_PER_FILE) return false;
    used.set(file, count + 1);
    return true;
  };
}

/**
 * pcic-k1t3.12: the recipe fields of a version-mismatch finding whose every
 * mention can be rewritten to the manifest's version (`versionMentionEdits`);
 * none when one cannot, so the finding stays advisory.
 */
function versionFix(fixEdits: FixEdit[] | undefined): Partial<PromptCiIssue> {
  if (!fixEdits) return {};
  const shown = fixEdits.map((e) => `\`${e.find}\` -> \`${e.replace}\``);
  return {
    fixRecipe: `Rewrite the version to the one the manifest declares: ${[...new Set(shown)].join(', ')}.`,
    autoApplySafe: true,
    fixEdits,
  };
}

/**
 * pcic-k1t3.12: edits for one library-major finding: every mention of
 * `instructionVersion` in `file` that `libraryMentionRe` (global) matches and
 * `hasIntent` accepts, rewritten to `manifestMajor`. A mention with a numeric
 * minor (`Pandas 1.5`) has no plain rewrite (the manifest gives a major only).
 */
function libraryMajorEdits(
  file: InstructionFile,
  libraryMentionRe: RegExp,
  instructionVersion: string,
  manifestMajor: number,
  hasIntent: (content: string, index: number) => boolean,
): FixEdit[] | undefined {
  const versionOf = (m: RegExpMatchArray) => `${parseInt(m[1]!, 10)}.${m[2] ?? 'x'}`;
  const mentionsOf = (content: string) =>
    [...content.matchAll(libraryMentionRe)].filter(
      (m) => hasIntent(content, m.index) && parseInt(m[1]!, 10) < manifestMajor && versionOf(m) === instructionVersion,
    );
  return versionMentionEdits(
    file,
    mentionsOf(file.content).map((m) => {
      if (m[2] !== undefined && m[2].toLowerCase() !== 'x') return { index: m.index, text: m[0], replacement: undefined };
      const majorEnd = m[0].length - (m[2] === undefined ? 0 : m[2].length + 1);
      const majorStart = majorEnd - m[1]!.length;
      return {
        index: m.index,
        text: m[0],
        replacement: m[0].slice(0, majorStart) + String(manifestMajor) + m[0].slice(majorEnd),
      };
    }),
    libraryMentionRe,
    false,
    (next) => mentionsOf(next).length > 0,
  );
}

/** pcic-1ik0.24: each tracked library pyproject.toml declares, main dependencies over extras. */
function extractManifestLibraryVersions(pyprojectContent: string): Map<TrackedPythonLibrary, ManifestVersionReading> {
  const versions = new Map<TrackedPythonLibrary, ManifestVersionReading>();
  for (const library of TRACKED_PYTHON_LIBRARIES) {
    const reading = readPythonLibraryVersion(pyprojectContent, library);
    if (reading) versions.set(library, reading);
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
  const manifestVersions = extractManifestLibraryVersions(pyprojectContent);
  if (manifestVersions.size === 0) return [];

  const issues: PromptCiIssue[] = [];
  const reported = new Set<string>();

  const mayPlanRecipe = recipeBudget();
  for (const [library, reading] of manifestVersions) {
    const manifestMajor = reading.declared[0]!;
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
        if (!isBelowFloor([instructionMajor], reading.floor)) continue;

        const instructionVersion = match[2]
          ? `${instructionMajor}.${match[2]}`
          : `${instructionMajor}.x`;
        const dedupeKey = `${file.path}:${library}:${instructionVersion}`;
        if (reported.has(dedupeKey)) continue;
        reported.add(dedupeKey);

        const fixEdits =
          reading.rewriteTo && mayPlanRecipe(file)
            ? libraryMajorEdits(file, libraryMentionRe, instructionVersion, reading.rewriteTo[0]!, hasCompatibilityIntent)
            : undefined;

        issues.push({
          id: issueId(`library-version:${fileIdPath(file)}:${library}:${instructionVersion}`),
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
          ...versionFix(fixEdits),
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

/**
 * pcic-1ik0.24: each tracked library package.json declares. dependencies and devDependencies are
 * what the project installs; a peerDependencies range is a compatibility claim, read for the floor
 * only (it used to win because it was read last).
 */
function parsePackageJsonVersions(packageJsonContent: string): Map<TrackedJsLibrary, ManifestVersionReading> {
  const versions = new Map<TrackedJsLibrary, ManifestVersionReading>();
  for (const library of TRACKED_JS_LIBRARIES) {
    const reading = readJsLibraryVersion(packageJsonContent, library);
    if (reading) versions.set(library, reading);
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

  const mayPlanRecipe = recipeBudget();
  for (const [library, reading] of manifestVersions) {
    const manifestMajor = reading.declared[0]!;
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
        if (!isBelowFloor([instructionMajor], reading.floor)) continue;

        const instructionVersion = match[2]
          ? `${instructionMajor}.${match[2]}`
          : `${instructionMajor}.x`;
        const dedupeKey = `${file.path}:${library}:${instructionVersion}`;
        if (reported.has(dedupeKey)) continue;
        reported.add(dedupeKey);

        const fixEdits =
          reading.rewriteTo && mayPlanRecipe(file)
            ? libraryMajorEdits(file, libraryMentionRe, instructionVersion, reading.rewriteTo[0]!, hasJsVersionIntent)
            : undefined;

        issues.push({
          id: issueId(`js-library-version:${fileIdPath(file)}:${library}:${instructionVersion}`),
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
          ...versionFix(fixEdits),
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
 * Returns true when a line (the one holding a match) reads as a negation or
 * advisory non-use (e.g. "do not use npm", "avoid npm", "don't use npm").
 * Used to avoid false-positives on correct guidance.
 */
function isNegationContext(line: string): boolean {
  return /\b(?:do\s+not|don'?t|avoid|never|instead\s+of|not\s+use|refrain\s+from)\b/i.test(line);
}

/**
 * `test` applied to the line (without its "\n") holding an offset of `content`, each line tested
 * at most once. Testing the line afresh at every match was quadratic on a long line holding
 * thousands of matches, the shape a hostile instruction file takes.
 */
function lineTester(content: string, test: (line: string) => boolean): (index: number) => boolean {
  const starts = [0];
  for (let at = content.indexOf('\n'); at !== -1; at = content.indexOf('\n', at + 1)) starts.push(at + 1);
  const memo = new Map<number, boolean>();
  return (index) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    let result = memo.get(lo);
    if (result === undefined) {
      const end = lo + 1 < starts.length ? starts[lo + 1]! - 1 : content.length;
      result = test(content.slice(starts[lo], end));
      memo.set(lo, result);
    }
    return result;
  };
}

/** {@link isNegationContext} for the line holding each offset of `content`. */
function negationTester(content: string): (index: number) => boolean {
  return lineTester(content, isNegationContext);
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

  /** Every command-like mention of another manager in `content` that counts against it. */
  const hitsIn = (file: InstructionFile, content: string): PackageManagerHit[] => {
    const hits: PackageManagerHit[] = [];
    const negated = negationTester(content);
    const installsPnpm = lineTester(content, (line) => /\bnpm\s+(?:install|i)\s+-g\s+pnpm\b/i.test(line));
    for (const alt of alternatives) {
      // Match commands like "npm install", "yarn add", "bun run"
      const re = new RegExp(`\\b${alt.name}\\s+(?:install|add|run|exec|dlx|i)\\b`, 'gi');
      let match: RegExpExecArray | null;
      while ((match = re.exec(content)) !== null) {
        if (preferred === 'pnpm' && installsPnpm(match.index)) continue;
        if (!negated(match.index)) hits.push({ file, index: match.index, text: match[0] });
      }
    }
    return hits;
  };

  const hits = files.flatMap((file) => hitsIn(file, file.content));
  const offendingFiles = files.filter((file) => hits.some((h) => h.file === file));
  if (offendingFiles.length === 0) return null;

  // pcic-k1t3.12: when every counted mention is a plain swap (a defined script
  // run without flags, or a bare install), the finding carries the edits.
  const fixEdits = packageManagerSwapEdits(
    files,
    hits,
    preferred,
    (name) => anyWorkspaceHasScript(context, name),
    (file, next) => hitsIn(file, next).length > 0,
  );

  // pcic-1ik0.5: the CI-alignment check defers to this one when the manifest
  // names the package manager, so say here when CI agrees. Summary only: the
  // evidence is part of the baseline fingerprint and stays as it was.
  const ciAgrees =
    context.workflows.files.length > 0 && collectCiPackageManagers(context.workflows.commands).has(preferred);

  return {
    id: 'manifest-package-manager-mismatch',
    severity: 'warning',
    category: 'conflict',
    title: `Possible package manager mismatch: instructions use alternatives to ${preferred}`,
    summary:
      `Instruction files refer to other package managers, but this project appears to use ${preferred} ` +
      `(based on ${packageJson.lockfiles.join(', ') || 'package.json'}). ` +
      (ciAgrees ? `The CI workflows use ${preferred} too. ` : '') +
      `Mixing package managers can lead to inconsistent lockfiles and installation errors.`,
    filePaths: offendingFiles.map((f) => f.path),
    locations: offendingFiles.map((f) => ({ filePath: f.path })),
    evidence: [
      `Project appears to use ${preferred}`,
      `Instruction files mention other package managers in command-like contexts`,
    ],
    recommendation: `Update instruction files to consistently use ${preferred} commands.`,
    fixRecipe: `This repo uses ${preferred}. Use \`${preferred} install\`, \`${preferred} test\`, and \`${preferred} build\`; do not substitute npm/yarn commands.`,
    ...(fixEdits ? { autoApplySafe: true, fixEdits } : {}),
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
  // pcic-1ik0.23: the gaps are spaces or tabs, never a newline. `\s+` read the end of one line and the
  // start of the next as one command ("... publish to npm\ncd packages/x" named a script "cd",
  // "npm install -g pnpm\npnpm install" one named "pnpm").
  const SCRIPT_RUN_RE = /\b(npm|yarn|pnpm|bun)[ \t\u00a0]+(run(?:-script)?(?:[ \t\u00a0]+|[ \t\u00a0]*\r?\n[ \t\u00a0]*))?([a-z0-9][a-z0-9:_-]*)\b/gi;
  // Only the scope that governs THIS command counts: a `cd <dir> &&` chained
  // directly before it, or a workspace/directory flag later in the same command
  // (`npm run build -w web`). A `-r` or `cd` belonging to an earlier command on
  // the line says nothing about this one.
  const CD_CHAIN_BEFORE_RE = /\bcd\s+\S+\s*&&\s*(?:[^&;|\n]*&&\s*)*$/;
  const SCOPE_FLAG_RE = /(?:^|\s)(?:--filter\b|-F\b|--cwd\b|-C\b|--prefix\b|--dir\b|-w\b|--workspaces?\b|-ws\b|-r\b|--recursive\b)/;
  const isScopedInvocation = (content: string, matchStart: number, matchEnd: number): boolean => {
    const lineStart = content.lastIndexOf('\n', matchStart - 1) + 1;
    if (CD_CHAIN_BEFORE_RE.test(content.slice(lineStart, matchStart))) return true;
    const newline = content.indexOf('\n', matchEnd);
    const after = content.slice(matchEnd, newline === -1 ? undefined : newline);
    return SCOPE_FLAG_RE.test(after.split(/&&|\|\||;|\||`|,\s|\.\s|\bthen\b/)[0]!);
  };

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
  // pcic-1ik0.23: words after a package manager that are never a user script whichever manager it is:
  // another tool's name ("npx pnpm ...", "corepack enable pnpm"), the shell's `cd` and the `latest`
  // dist-tag. The manager's own commands (`npm config set prefix`, `npm trust`, `pnpm root -g`) come
  // from command-validity's per-manager sets. Only the bare form (<pm> <word>) is skipped: an
  // explicit `npm run config` still names a script.
  const NON_SCRIPT_WORDS = new Set([
    'npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx', 'corepack', 'node', 'cd', 'latest',
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

  // One command -> at most one finding. command-validity resolves `cd`/`--filter`/
  // workspace scoping for every command it extracts; whatever it evaluated is
  // its to report, so this check only speaks for mentions it never parsed
  // (plain prose such as "then run npm run build").
  const commandAnalysis = analyzeCommands(context);

  for (const file of files) {
    const codeMask = buildCodeMask(file.content);
    const evaluatedByCommandValidity = commandAnalysis.evaluatedScripts.get(file.path);
    let match: RegExpExecArray | null;
    const re = new RegExp(SCRIPT_RUN_RE.source, SCRIPT_RUN_RE.flags);
    while ((match = re.exec(file.content)) !== null) {
      const packageManager = match[1]!.toLowerCase();
      const explicitRun = match[2] !== undefined;
      const scriptName = match[3]!;
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
      if (SKIP_SUBCOMMANDS.has(scriptName.toLowerCase())) {
        continue;
      }
      // A bare `npm <word>` is an npm command, never a script (command-validity reads it the same way).
      if (!explicitRun && packageManager === 'npm') {
        continue;
      }
      if (
        !explicitRun &&
        (NON_SCRIPT_WORDS.has(scriptName.toLowerCase()) ||
          BUILTINS_BY_TOOL[packageManager as keyof typeof BUILTINS_BY_TOOL].has(scriptName.toLowerCase()))
      ) {
        continue;
      }
      // `<pm> <word>@1.2` / `<pm> <word>/x`: a package spec or a path, not a script. (`npm run lint/fix`
      // is the slash shorthand for two scripts, so an explicit run keeps being judged.)
      if (!explicitRun && /^[@/]/.test(file.content.charAt(match.index + match[0].length))) {
        continue;
      }
      if (ENGLISH_FILLER_WORDS.has(scriptName.toLowerCase())) {
        continue;
      }

      if (packageManager === 'bun' && !explicitRun && BUN_BUILTINS.has(scriptName)) {
        continue;
      }

      if (!availableScripts.has(scriptName)) {
        // This exact occurrence was already judged by command-validity.
        if (evaluatedByCommandValidity?.size) {
          const line = file.content.slice(0, match.index).split('\n').length;
          if (evaluatedByCommandValidity.has(`${line}:${scriptName}`)) continue;
        }
        // A script defined by a workspace package (monorepo) is runnable via
        // `--filter`/`-r`/`cd`; the root manifest is not the only place to look.
        if (anyWorkspaceHasScript(context, scriptName)) continue;
        // `pnpm vitest run` / `yarn tsc`: not a script, an installed binary.
        // (`npm run` and `pnpm run` accept scripts only.)
        const scriptsOnly = explicitRun && (packageManager === 'npm' || packageManager === 'pnpm');
        if (!scriptsOnly && isKnownBinary(context, scriptName)) continue;
        if (isScopedInvocation(file.content, match.index, match.index + match[0].length)) continue;

        const dedupeKey = `${file.path}:${scriptName}`;
        if (reported.has(dedupeKey)) continue;
        reported.add(dedupeKey);

        issues.push({
          id: `manifest-missing-script:${fileIdPath(file)}:${scriptName}`,
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

  // pcic-1ik0.24: the whole range (manifest-versions.ts): alternatives floor at the lowest
  // ("^18.18 || >=20" used to read as 20), ">18" excludes 18, and a rewrite needs one inclusive floor.
  const reading = readNodeEngineVersion(packageJson.enginesNode);
  if (!reading) return [];
  const rewriteTo = reading.rewriteTo?.[0];
  const issues: PromptCiIssue[] = [];
  // MF3 / B2: no dedupe set, unlike every sibling check in this file — "Node 12"
  // mentioned twice in one file emitted two issues sharing the identical id
  // `manifest-node-version-mismatch:<path>:12`, corrupting downstream id-based
  // dedup/trend logic.
  const reported = new Set<string>();

  const NODE_VERSION_RE = /\bNode(?:\.js)?\s*(?:v)?(\d+)\b/gi;

  const mayPlanRecipe = recipeBudget();
  for (const file of files) {
    let match: RegExpExecArray | null;
    const re = new RegExp(NODE_VERSION_RE.source, NODE_VERSION_RE.flags);
    const negated = negationTester(file.content);
    while ((match = re.exec(file.content)) !== null) {
      const instrVersion = parseInt(match[1]!, 10);
      // MF3: no sibling check fires on a negated mention ("Do not use Node
      // 14") — this one did, since it had no negation-context guard at all.
      if (negated(match.index)) continue;
      if (isBelowFloor([instrVersion], reading.floor)) {
        const dedupeKey = `${file.path}:${instrVersion}`;
        if (reported.has(dedupeKey)) continue;
        reported.add(dedupeKey);

        // pcic-k1t3.12: every mention of this version in the file, as this loop flags them.
        const mentionsOf = (content: string) => {
          const negatedIn = content === file.content ? negated : negationTester(content);
          return [...content.matchAll(NODE_VERSION_RE)].filter(
            (mm) => !negatedIn(mm.index) && parseInt(mm[1]!, 10) === instrVersion,
          );
        };
        const fixEdits =
          rewriteTo === undefined || !mayPlanRecipe(file)
            ? undefined
            : versionMentionEdits(
                file,
                mentionsOf(file.content).map((mm) => ({
                  index: mm.index,
                  text: mm[0],
                  replacement: mm[0].slice(0, mm[0].length - mm[1]!.length) + String(rewriteTo),
                })),
                NODE_VERSION_RE,
                true,
                (next) => mentionsOf(next).length > 0,
              );

        issues.push({
          id: `manifest-node-version-mismatch:${fileIdPath(file)}:${instrVersion}`,
          severity: 'warning',
          category: 'stale_instruction',
          title: `Node.js version mismatch: instruction says ${instrVersion}, project requires ${reading.label}`,
          summary:
            `Instructions mention Node.js ${instrVersion}, but package.json requires Node.js ${reading.label} in \`engines.node\`.`,
          filePaths: [file.path],
          locations: [{ filePath: file.path }],
          evidence: [`Instruction says Node ${instrVersion}; engines.node says ${packageJson.enginesNode}`],
          recommendation: `Update instructions to reflect the minimum supported Node.js version (${reading.label}).`,
          ...versionFix(fixEdits),
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
 * File-existence checks go through `context.tree` (pcic-e6xa).
 */
export function detectManifestConsistency(context: RepoContext): PromptCiIssue[] {
  const { files, manifests } = context;
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
    const toolingIssue = checkPipVsPoetry(files, manifests.pyproject, treeFor(context));
    if (toolingIssue) issues.push(toolingIssue);

    issues.push(...checkPythonVersionMismatch(files, manifests.pyproject));
    issues.push(...checkLibraryVersionMismatch(files, manifests.pyproject));
  }

  return issues;
}
