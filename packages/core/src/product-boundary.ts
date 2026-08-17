import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { RepoContext } from './repo-context.js';
import type { PromptCiIssue } from './types.js';


/**
 * Product-Boundary Drift Detector
 *
 * Detects when instruction files contain stale "X does not exist" or
 * "do not build X" guidance that contradicts clear filesystem evidence of X
 * already existing in the repo.
 *
 * Philosophy:
 *  - Require STRONG filesystem evidence before flagging (multiple corroborating
 *    signals where possible).
 *  - Matched text from the instruction file is shown in evidence — the raw
 *    regex source is never exposed to users.
 *  - One finding per (capability × file), regardless of how many patterns match.
 *  - Wording is cautious throughout ("appears to", "may be stale").
 *
 * Findings are heuristic — cautious wording is intentional.
 */

function issueId(key: string): string {
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
  return `prod-bound-${hash}`;
}

// ── Filesystem helpers ────────────────────────────────────────────────────────

/** Returns true when at least one of the repo-relative paths exists on disk. */
function anyPathExists(repoRoot: string, relativePaths: string[]): boolean {
  return relativePaths.some((p) => fs.existsSync(path.join(repoRoot, p)));
}

// ── Capability definitions ────────────────────────────────────────────────────

type Capability = {
  /** Human-readable name for the feature. */
  name: string;
  /**
   * Filesystem paths (relative to repo root) whose existence proves the
   * capability is present.  At least one must exist.
   */
  fsPaths: string[];
  /**
   * package.json dependency/devDependency name prefixes that also prove the
   * capability is present (checked against deps keys).
   */
  depPrefixes?: string[];
  /**
   * Regex patterns that, if found in an instruction file, contradict the
   * presence of this capability.
   *
   * Design notes:
   *  - Each pattern must match only strong, unambiguous stale claims.
   *  - Avoid broad patterns that would catch historical or forward-looking
   *    prose ("we plan to add a web app later").
   *  - Patterns may not overlap with patterns from other capabilities.
   */
  contradictoryPatterns: RegExp[];
  severity: 'high' | 'warning';
  /** Short title for the issue. */
  title: string;
  /** Human-readable description of the found evidence (used in summary). */
  evidenceLabel: string;
  recommendation: string;
};

const CAPABILITIES: Capability[] = [
  // ── Web App ───────────────────────────────────────────────────────────────
  {
    name: 'Web App',
    fsPaths: [
      'apps/web',
      'next.config.ts',
      'next.config.js',
      'next.config.mjs',
      'next.config.cjs',
    ],
    depPrefixes: ['next'],
    contradictoryPatterns: [
      // "do not add web app" / "don't add web app"
      /\b(?:do\s+not|don'?t)\s+add\s+(?:a\s+)?web\s+app\b/i,
      // "no web app exists yet" / "no web app yet"
      /\bno\s+web\s+app\s+(?:exists?\s+)?yet\b/i,
      // "no web app" as a standalone factual claim (not "no web app logic" etc.)
      /\bno\s+web\s+app\b(?!\s+(?:logic|code|component|route|page|specific))/i,
      // "web app pending" / "web app not yet built"
      /\bweb\s+app\s+(?:pending|not\s+(?:yet\s+)?(?:built|implemented|created))\b/i,
    ],
    severity: 'high',
    title: 'Possible stale boundary: instruction appears to deny a web app that exists',
    evidenceLabel: 'web app (apps/web or next.config.*)',
    recommendation:
      'Update the instruction file to reflect that the web app is now present. ' +
      'Replace the stale non-goal statement with current guidance about the web app.',
  },

  // ── Supabase ──────────────────────────────────────────────────────────────
  {
    name: 'Supabase',
    fsPaths: ['supabase/migrations', 'supabase'],
    depPrefixes: ['@supabase/'],
    contradictoryPatterns: [
      /\bno\s+supabase\b/i,
      /\bsupabase\s+(?:pending|not\s+(?:yet\s+)?(?:set\s+up|configured|added|integrated))\b/i,
      /\bno\s+(?:supabase\s+)?(?:database|db)\s+yet\b/i,
    ],
    severity: 'high',
    title: 'Possible stale boundary: instruction appears to deny Supabase that is configured',
    evidenceLabel: 'Supabase (supabase/ directory or @supabase/* dependency)',
    recommendation:
      'Update the instruction file to reflect that Supabase is now configured. ' +
      'Replace the stale non-goal statement with current guidance about the database.',
  },

  // ── Database ──────────────────────────────────────────────────────────────
  {
    name: 'Database',
    fsPaths: ['supabase/migrations', 'drizzle', 'prisma', 'prisma/schema.prisma'],
    depPrefixes: ['drizzle-orm', 'prisma', '@prisma/'],
    contradictoryPatterns: [
      /\bno\s+database\b/i,
      /\bdatabase\s+pending\b/i,
      /\bno\s+db\b/i,
      /\bwithout\s+a\s+database\b/i,
    ],
    severity: 'high',
    title: 'Possible stale boundary: instruction appears to deny a database that exists',
    evidenceLabel: 'database schema/migrations (supabase/migrations, drizzle, or prisma)',
    recommendation:
      'Update the instruction file to reflect the current database setup. ' +
      'Replace the stale non-goal statement with current guidance about data access.',
  },

  // ── Dashboard ─────────────────────────────────────────────────────────────
  {
    name: 'Dashboard',
    fsPaths: [
      'apps/web/src/app/dashboard',
      'apps/web/src/app/(dashboard)',
      'apps/web/src/app/api/upload/route.ts',
      'src/app/dashboard',
      'src/app/(dashboard)',
      'app/dashboard',
      'app/(dashboard)',
      'src/pages/dashboard',
      'pages/dashboard',
    ],
    contradictoryPatterns: [
      /\bdashboard\s+(?:pending|not\s+(?:yet\s+)?(?:built|implemented|created|started))\b/i,
      /\bno\s+dashboard\b/i,
      /\bdashboard\s+does\s+not\s+exist\b/i,
    ],
    severity: 'warning',
    title: 'Possible stale boundary: instruction appears to deny a dashboard that exists',
    evidenceLabel: 'dashboard routes (apps/web/src/app/dashboard or upload API route)',
    recommendation:
      'Update the instruction file to reflect that the dashboard is now implemented.',
  },

  // ── Upload API ────────────────────────────────────────────────────────────
  {
    name: 'Upload API',
    fsPaths: [
      'apps/web/src/app/api/upload/route.ts',
      'apps/web/src/app/api/upload',
      'src/app/api/upload/route.ts',
      'src/app/api/upload',
      'app/api/upload/route.ts',
      'app/api/upload',
      'pages/api/upload.ts',
    ],
    contradictoryPatterns: [
      /\bupload\s+not\s+(?:yet\s+)?implemented\b/i,
      /\bno\s+upload\s+(?:route|api|endpoint)\b/i,
      /\bupload\s+(?:api|route|endpoint)\s+(?:pending|does\s+not\s+exist)\b/i,
    ],
    severity: 'warning',
    title: 'Possible stale boundary: instruction appears to deny an upload API that exists',
    evidenceLabel: 'upload API route (apps/web/src/app/api/upload/route.ts)',
    recommendation:
      'Update the instruction file to reflect that the upload API is implemented. ' +
      'Document what data is uploaded and any relevant security guidance.',
  },

  // ── Playwright / E2E ──────────────────────────────────────────────────────
  {
    name: 'Playwright/E2E',
    fsPaths: [
      'playwright.config.ts',
      'playwright.config.js',
      'playwright.config.mjs',
      'playwright.config.cjs',
    ],
    depPrefixes: ['@playwright/test'],
    contradictoryPatterns: [
      /\bno\s+(?:e2e|end.to.end)\s+tests?\b/i,
      /\bno\s+playwright\b/i,
      /\bplaywright\s+(?:pending|not\s+(?:yet\s+)?(?:set\s+up|configured|added))\b/i,
    ],
    severity: 'warning',
    title: 'Possible stale boundary: instruction appears to deny E2E tests that are configured',
    evidenceLabel: 'Playwright config (playwright.config.*)',
    recommendation:
      'Update the instruction file to include E2E testing guidance. ' +
      'Document how to run Playwright tests and any relevant setup steps.',
  },

  // ── GitHub OAuth ──────────────────────────────────────────────────────────
  {
    name: 'GitHub OAuth',
    fsPaths: [
      'apps/web/src/app/auth',
      'apps/web/src/app/api/auth',
      'apps/web/src/app/(auth)',
      'src/app/auth',
      'src/app/api/auth',
      'src/app/(auth)',
      'app/auth',
      'app/api/auth',
      'app/(auth)',
      'pages/api/auth',
    ],
    contradictoryPatterns: [
      // PB1: exclude scoped prose like "no auth required for public
      // endpoints" — that's a SCOPING statement about a specific route, not
      // a claim that auth doesn't exist anywhere in the project. Without
      // this exclusion, any repo with auth routes AND a scoped "no auth
      // required" note anywhere would always get flagged.
      /\bno\s+(?:github\s+)?(?:oauth|auth(?:entication)?)\b(?!\s+(?:is\s+)?(?:required|needed|necessary)\b)/i,
      /\bauth(?:entication)?\s+(?:pending|not\s+(?:yet\s+)?(?:built|implemented|added))\b/i,
      /\bno\s+login\b(?!\s+(?:is\s+)?(?:required|needed|necessary)\b)/i,
    ],
    severity: 'warning',
    title: 'Possible stale boundary: instruction appears to deny auth that is implemented',
    evidenceLabel: 'auth routes (apps/web/src/app/auth or apps/web/src/app/api/auth)',
    recommendation:
      'Update the instruction file to reflect that authentication is now implemented.',
  },
];

// ── Capability presence check ─────────────────────────────────────────────────

/**
 * Returns true when the repo shows strong evidence of the capability, either
 * via filesystem paths or via package.json dependencies.
 */
function capabilityIsPresent(cap: Capability, context: RepoContext): boolean {
  if (anyPathExists(context.repoRoot, cap.fsPaths)) return true;

  if (cap.depPrefixes && cap.depPrefixes.length > 0) {
    const allDeps = {
      ...context.packageJson.dependencies,
      ...context.packageJson.devDependencies,
    };
    return cap.depPrefixes.some((prefix) =>
      Object.keys(allDeps).some((dep) => dep === prefix || dep.startsWith(prefix)),
    );
  }

  return false;
}

// ── First-match evidence extraction ──────────────────────────────────────────

/**
 * PB2: strips fenced code blocks (``` or ~~~, matching fence char/length per
 * CommonMark) and inline `code spans` before contradiction matching. Without
 * this, a fenced example that QUOTES a contradictory phrase (e.g.
 * documenting the OLD wording of a non-goal statement as a "before" example)
 * was read as a live claim and flagged — the same class of bug fixed for
 * vague-guidance.ts, stale-instructions.ts, and conflicts.ts.
 */
function stripCodeBlocks(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  let inBlock = false;
  let fenceChar: string | null = null;
  let fenceLen = 0;

  for (const line of lines) {
    if (!inBlock) {
      const openMatch = /^ {0,3}([`~]{3,})/.exec(line);
      if (openMatch) {
        inBlock = true;
        fenceChar = openMatch[1]![0] ?? null;
        fenceLen = openMatch[1]!.length;
        continue;
      }
      kept.push(line);
    } else {
      const closeMatch = /^ {0,3}([`~]{3,})\s*$/.exec(line);
      if (closeMatch && closeMatch[1]![0] === fenceChar && closeMatch[1]!.length >= fenceLen) {
        inBlock = false;
        fenceChar = null;
        fenceLen = 0;
      }
      // else: still inside the fence — drop the line
    }
  }

  return kept.join('\n').replace(/`[^`\n]+`/g, '');
}

/**
 * Finds the first contradictory phrase in `content` and returns the matched
 * text (the actual instruction wording), or undefined if none match.
 */
function findFirstContradiction(
  content: string,
  patterns: RegExp[],
): { pattern: RegExp; matched: string } | undefined {
  for (const pattern of patterns) {
    // Use a fresh non-global copy to find the first match position
    const re = new RegExp(pattern.source, pattern.flags.replace('g', ''));
    const m = re.exec(content);
    if (m) return { pattern, matched: m[0] };
  }
  return undefined;
}

// ── Public detector ───────────────────────────────────────────────────────────

/**
 * Detects stale product-boundary instructions that contradict filesystem
 * evidence of a feature already existing in the repo.
 *
 * One finding is emitted per (capability × file) regardless of how many
 * contradictory patterns match in that file, to keep the report actionable.
 */
export function detectProductBoundary(context: RepoContext): PromptCiIssue[] {
  const issues: PromptCiIssue[] = [];
  const { repoRoot, files } = context;

  for (const cap of CAPABILITIES) {
    if (!capabilityIsPresent(cap, context)) continue;

    // Collect all existing evidence paths for the finding
    const existingPaths = cap.fsPaths.filter((p) => fs.existsSync(path.join(repoRoot, p)));
    const evidencePaths = existingPaths.length > 0 ? existingPaths : [cap.evidenceLabel];

    for (const file of files) {
      const contradiction = findFirstContradiction(stripCodeBlocks(file.content), cap.contradictoryPatterns);
      if (!contradiction) continue;

      issues.push({
        id: issueId(`${cap.name}:${file.path}`),
        severity: cap.severity,
        category: 'stale_instruction',
        title: cap.title,
        summary:
          `The instruction file appears to contain a stale product-boundary statement ` +
          `that contradicts ${cap.evidenceLabel} found in the repository. ` +
          `The phrase "${contradiction.matched}" may no longer reflect the current state of the project.`,
        filePaths: [file.path],
        locations: [{ filePath: file.path }],
        evidence: [
          `Contradictory phrase found: "${contradiction.matched}"`,
          `Repository evidence: ${evidencePaths.join(', ')}`,
        ],
        recommendation: cap.recommendation,
        confidence: 0.85,
      });
    }
  }

  return issues;
}
