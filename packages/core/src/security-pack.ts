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
 * of an ecosystem that writes it.
 */
const ECOSYSTEM_OUTPUT_DIRS: Record<string, (rootNames: string[]) => boolean> = {
  bin: (names) => names.some((n) => isDotnetBuildFile(n) || isJvmBuildFile(n)),
  obj: (names) => names.some(isDotnetBuildFile),
};

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
  const unignoredDirs = gitignoreUnknown ? [] : commonDirs.filter((d) => {
    if (!tree.isDir(d)) return false;
    // #161: `bin`/`obj` are build output only where the build that writes them lives.
    const gate = ECOSYSTEM_OUTPUT_DIRS[d];
    if (gate && !gate(rootNames)) return false;
    return !gitignoreLines.some((line) => gitignoreLineMatchesTarget(line, d));
  });

  if (unignoredDirs.length > 0) {
    issues.push({
      id: 'security-pack-unignored-dirs',
      severity: 'warning',
      category: 'context_bloat',
      title: 'Unignored build, output, or coverage directories',
      summary:
        `The repository contains directory/directories (${unignoredDirs.join(', ')}) that are ` +
        `commonly generated but not ignored in .gitignore. AI tools may ingest these, ` +
        `inflating token costs.`,
      filePaths: ['.gitignore'],
      locations: [],
      evidence: unignoredDirs.map((d) => `Directory "${d}" exists but is not ignored in .gitignore.`),
      recommendation: `Add generated directories to .gitignore. For example: "${unignoredDirs.map((d) => `${d}/`).join(', ')}"`,
      fixRecipe: unignoredDirs.map((d) => `echo "${d}/" >> .gitignore`).join('\n'),
      // `applyFixRecipe` appends each missing directory to .gitignore — a
      // mechanical, reversible edit, so `promptci fix` may auto-apply it.
      autoApplySafe: true,
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
