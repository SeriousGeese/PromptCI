/**
 * Missing-context detector for PromptCI.
 *
 * Flags files when they fail to mention project-specific keywords
 * required for its detected type (Unity, TypeScript, etc.).
 *
 * The detector fires only when NONE of the required keywords are present,
 * minimising false positives on repos that use custom tooling with different
 * command names.
 *
 * All findings are heuristic — wording is cautious.
 */

import * as crypto from 'node:crypto';
import type { InstructionFile, ProjectType, PromptCiIssue } from './types.js';

const PROJECT_TYPE_RULES: Record<
  Exclude<ProjectType, 'auto' | 'unknown'>,
  { keywords: string[]; label: string; minimumPresent: number }
> = {
  unity: {
    // Any one of these signals Unity-specific coverage
    keywords: ['unity', 'monobehaviour', 'gameobject', 'c#', 'unity editor', 'prefab'],
    label: 'Unity',
    minimumPresent: 1,
  },
  typescript: {
    // Broad signals: build command, test runner, or tsconfig reference
    keywords: [
      'npm run build', 'pnpm run build', 'yarn run build', 'pnpm build', 'npm run test',
      'npm test', 'pnpm test', 'yarn test', 'vitest', 'jest', 'typescript', 'tsconfig',
      'tsc ', 'ts-node',
    ],
    label: 'TypeScript',
    minimumPresent: 1,
  },
  dotnet: {
    keywords: ['dotnet', '.sln', '.csproj', 'xunit', 'nunit', 'mstest', 'dotnet test', 'dotnet build'],
    label: '.NET',
    minimumPresent: 1,
  },
  nextjs: {
    keywords: ['next.js', 'nextjs', 'next build', 'next dev', 'app router', 'pages router', 'vercel'],
    label: 'Next.js',
    minimumPresent: 1,
  },
  python: {
    keywords: ['python', 'pip', 'poetry', 'venv', 'pytest', 'pyproject.toml'],
    label: 'Python',
    minimumPresent: 1,
  },
  go: {
    keywords: ['golang', 'go.mod', 'go test', 'go build'],
    label: 'Go',
    minimumPresent: 1,
  },
  rust: {
    keywords: ['rust', 'cargo', 'cargo build', 'cargo test', 'rustc'],
    label: 'Rust',
    minimumPresent: 1,
  },
};

function issueId(key: string): string {
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
  return `missing-context-${hash}`;
}

/**
 * MC1: raw `String.includes` let bare single-word keywords match as a
 * substring of an unrelated word — 'go' inside "algorithm"/"logo"/"django"/
 * "good", 'pip' inside "pipeline", 'rust' inside "trust", 'unity' inside
 * "community"/"opportunity" — making the "Missing X-specific context" check
 * effectively unable to ever fire for those project types.
 * Multi-word/punctuated keywords ("go test", "go.mod", "c#") are specific
 * enough that plain substring matching is safe and stays unchanged; only a
 * BARE alphanumeric word gets a `\b` word-boundary regex instead.
 */
function keywordPresent(content: string, keyword: string): boolean {
  const kw = keyword.toLowerCase();
  if (/[^a-z0-9]/.test(kw)) return content.includes(kw);
  return new RegExp(`\\b${kw}\\b`).test(content);
}

// ── Global checks (independent of project type) ───────────────────────────────

/**
 * MC2: extracts the CONTENT of closed fenced code blocks (``` or ~~~,
 * matching fence char/length per CommonMark) so setup-command patterns can be
 * tested against real block content only.
 *
 * The old approach used a single regex per pattern like
 * `` ` ```[\s\S]*?command` `` (non-greedy but unbounded) — it could skip
 * straight past the block's OWN closing fence and match a command mentioned
 * arbitrarily later in the file, in prose or in a completely different code
 * block. A tempered-dot rewrite (`` `(?:(?!```)[\s\S])*?` ``) looked like a
 * fix but has the same underlying flaw for a file with an EVEN number of
 * fences: the regex engine, unable to start a match at the true opening
 * fence (blocked by the closing fence ahead), backtracks to start at the
 * CLOSING fence instead and treats IT as a new opener — with no third fence
 * left to bound it, everything after is fair game again. Regex alone can't
 * reliably track "am I inside a block" across a variable number of fences;
 * a real line-by-line scan (the same fence-tracking approach used 5x
 * elsewhere in this codebase) does.
 */
function extractFencedBlockContents(content: string): string {
  const lines = content.split('\n');
  const blocks: string[] = [];
  let inBlock = false;
  let fenceChar: string | null = null;
  let fenceLen = 0;
  let current: string[] = [];

  for (const line of lines) {
    if (!inBlock) {
      const openMatch = /^ {0,3}([`~]{3,})/.exec(line);
      if (openMatch) {
        inBlock = true;
        fenceChar = openMatch[1]![0] ?? null;
        fenceLen = openMatch[1]!.length;
        current = [];
      }
      continue;
    }
    const closeMatch = /^ {0,3}([`~]{3,})\s*$/.exec(line);
    if (closeMatch && closeMatch[1]![0] === fenceChar && closeMatch[1]!.length >= fenceLen) {
      inBlock = false;
      blocks.push(current.join('\n'));
      fenceChar = null;
      fenceLen = 0;
      continue;
    }
    current.push(line);
  }
  // An unclosed trailing fence's partial content is intentionally excluded —
  // this check only counts CONFIRMED, closed blocks as real documentation.

  return blocks.join('\n');
}

/** Patterns that only count when found INSIDE a fenced code block's content. */
const FENCED_SETUP_COMMAND_PATTERNS = [
  /(npm|pnpm|yarn|uv)\s+(install|ci|run|sync|test|build|lint|add)/,
  /dotnet\s+(build|test|restore)/,
  /make\s+(build|test|install)/,
  /cargo\s+(build|test)/,
  /go\s+(build|test)/,
  /uv\s+(run|sync|install|add)\b/,
  // BUG-011: Python
  /pip\s+(install|sync|download)\b/,
  /python\s+-m\s+(venv|pytest|pip|build)\b/,
  /python\s+setup\.py\b/,
  /\bpytest\b/,
];

/**
 * Patterns that signal a setup/validation command via inline backticks or
 * plain prose — these are legitimate signals regardless of surrounding
 * fence context, so they're tested against the FULL content, not just
 * extracted block contents.
 */
const PROSE_SETUP_COMMAND_PATTERNS = [
  // Inline backtick commands: `npm run build`, `pnpm test`, `uv sync`, etc.
  /`(npm|pnpm|yarn)\s+(run\s+)?(build|test|lint|install)/,
  /`(uv|dotnet)\s+(run|sync|install|test|build)/,
  // BUG-011: Python — inline backtick
  /`pip\s+(install|sync)/,
  /`python\s+-m\s+(venv|pytest|pip)/,
  /`pytest\b/,
  // BUG-011: Go — inline backtick (fenced block pattern exists above but not inline)
  /`go\s+(build|test|run|install)\b/,
  // Plain prose with explicit command names
  /(npm|pnpm|yarn)\s+run\s+(build|test|lint)/i,
  /pnpm\s+(build|test|install|lint)/i,
  /\buv\s+(run|sync|install|add)\b/i,
  /\b(install|build|test)\s+(command|step|instruction)/i,
  /how\s+to\s+(install|build|run|test)/i,
  /getting\s+started/i,
  // BUG-011: Python — plain prose
  /\bpip\s+install\b/i,
  /\bpython\s+-m\s+(venv|pytest|pip|build)\b/i,
  /\bpytest\b/i,
  /\bpython\s+setup\.py\b/i,
  // BUG-011: Go — plain prose
  /\bgo\s+(test|build|run)\s/i,
];

/**
 * Patterns that signal security / secret-handling awareness in instructions.
 * Use non-word-boundary suffixes so plurals match: "secrets", "credentials", etc.
 */
const SECURITY_PATTERNS = [
  /\b(auth(entication|orization)?|rls|row.?level.?security)\b/i,
  // Plurals: secrets, credentials, passwords, tokens, api keys
  /\bsecrets?\b/i,
  /\bcredentials?\b/i,
  /\bpasswords?\b/i,
  /\bapi.?keys?\b/i,
  /\btokens?\b/i,
  /\b(sanitize|sanitises?|injection)\b/i,
  /\bvalidate\b.{0,50}\b(input|param)s?\b/i,
  /\b(never\s+commit|do\s+not\s+commit|don.?t\s+commit).{0,50}\b(secret|key|credential)s?\b/i,
  /\b(env(ironment)?\s+var|\.env)\b/i,
  /\b(ssm|parameter\s+store|vault|keychain)\b/i,
];

function checkSetupCommands(files: InstructionFile[]): PromptCiIssue | null {
  const combined = files.map((f) => f.content).join('\n');
  const fencedContent = extractFencedBlockContents(combined);
  const hasSetup =
    FENCED_SETUP_COMMAND_PATTERNS.some((p) => p.test(fencedContent)) ||
    PROSE_SETUP_COMMAND_PATTERNS.some((p) => p.test(combined));
  if (hasSetup) return null;

  return {
    id: issueId('missing-setup-commands'),
    severity: 'warning',
    category: 'missing_context',
    title: 'No setup or validation commands found',
    summary:
      'No instruction file appears to document how to install dependencies, build, or run tests. ' +
      'Agents cannot reliably set up or validate the project without this.',
    filePaths: files.map((f) => f.path),
    locations: [],
    evidence: ['No install/build/test commands found in any instruction file.'],
    recommendation:
      'Add a "Setup" or "Getting Started" section with the exact commands to install, build, and test: ' +
      'e.g. "pnpm install && pnpm build && pnpm test".',
    confidence: 0.75,
  };
}

/**
 * BUG-007: Detect credential sections that describe storage but omit the security
 * surface (token scopes, validation, expiry/rotation).
 *
 * Fires when:
 *   1. At least one instruction file mentions credential/token/OAuth handling
 *      (indicating there IS a credentials section)
 *   2. But none of the files document scopes, token validation, or expiry handling
 *
 * This catches the pattern from GraftCLI: Security/Credentials sections that tell
 * agents WHERE tokens are stored but not what scopes they need or how they expire.
 */
const CREDENTIAL_SECTION_PATTERNS = [
  /\b(?:oauth|api\s*key|access\s*token|bearer\s*token|personal\s*access\s*token|github\s+token|gitlab\s+token)/i,
  /\bPAT\b/,
  /\b(?:store[sd]?\s+(?:in|to)\s+(?:keychain|config|file)|credential\s+storage|token\s+storage)/i,
];

const CREDENTIAL_SURFACE_PATTERNS = [
  // Token scopes / permissions documented
  /\b(?:scope[sd]?|permission[sd]?|required\s+scope|token\s+scope)/i,
  // Validation / verification in any form (validate, validated, verifying, verified, etc.)
  /\b(?:validat(?:e[sd]?|ion|ing)|verif(?:y|ied|ies|ication|ying))\b/i,
  // Expiry or rotation documented
  /\btoken\s+(?:expir[yi]|refresh|rotat)/i,
  /\b(?:expir(?:y|ation|e[sd]?|ing)|refresh\s+token|token\s+rotation)\b/i,
];

function checkCredentialSurface(files: InstructionFile[]): PromptCiIssue | null {
  const combined = files.map((f) => f.content).join('\n');

  const hasCredentialSection = CREDENTIAL_SECTION_PATTERNS.some((p) => p.test(combined));
  if (!hasCredentialSection) return null;

  const hasSurfaceDoc = CREDENTIAL_SURFACE_PATTERNS.some((p) => p.test(combined));
  if (hasSurfaceDoc) return null;

  return {
    id: issueId('missing-credential-surface'),
    severity: 'warning',
    category: 'missing_context',
    title: 'Credential section missing scope/validation/expiry documentation',
    summary:
      'Instruction files describe credential or token storage but do not document ' +
      'required token scopes, how tokens are validated on first use, or how token ' +
      'expiry and rotation are handled. Agents cannot safely handle auth edge cases ' +
      'without this information.',
    filePaths: files.map((f) => f.path),
    locations: [],
    evidence: ['Credential/token handling found, but no mention of scopes, validation, or expiry.'],
    recommendation:
      'Add documentation covering: (1) which OAuth scopes or API permissions are required, ' +
      '(2) how tokens are validated on first use or after rotation, ' +
      '(3) what happens when a token expires (error message, re-auth flow).',
    confidence: 0.65,
  };
}

function checkSecurityRules(files: InstructionFile[]): PromptCiIssue | null {
  const combined = files.map((f) => f.content).join('\n');
  const hasSecurity = SECURITY_PATTERNS.some((p) => p.test(combined));
  if (hasSecurity) return null;

  return {
    id: issueId('missing-security-rules'),
    severity: 'info',
    category: 'missing_context',
    title: 'No security or secret-handling rules found',
    summary:
      'No instruction file mentions authentication, secrets, API keys, RLS policies, or input validation. ' +
      'Agents that handle user data or credentials benefit from explicit security guidelines.',
    filePaths: files.map((f) => f.path),
    locations: [],
    evidence: ['No auth, secrets, RLS, or input validation keywords found.'],
    recommendation:
      'Add a security section covering: how auth is handled, where secrets live (.env, vault), ' +
      'RLS/data-isolation requirements, and what agents must never commit or log.',
    confidence: 0.65,
  };
}

// ── BUG-008: Secret rotation / incident response check ───────────────────────

/**
 * Patterns indicating the project handles security-sensitive credentials or keys
 * (JWT, TLS, API signing keys, etc.) that require rotation procedures.
 */
const SECURITY_SENSITIVE_PATTERNS = [
  /\b(?:jwt|jwks|json\s+web\s+token)\b/i,
  /\b(?:tls|ssl)\s+(?:cert(?:ificate)?|key)\b/i,
  /\bsigning\s+key\b/i,
  /\b(?:private|secret)\s+key\b/i,
  /\bapi\s+(?:secret|signing)\b/i,
  /\b(?:redis|kafka|broker)\s+(?:credential|password|secret|auth)\b/i,
  /\bkey\s+(?:store|vault|ring)\b/i,
];

/**
 * Patterns indicating rotation, key compromise response, or incident procedures
 * are documented.
 */
const SECRET_ROTATION_PATTERNS = [
  /\b(?:rotat(?:e[sd]?|ion|ing)|key\s+rotation|secret\s+rotation|credential\s+rotation)\b/i,
  /\b(?:compromis(?:e[sd]?|ing)|key\s+compromise|breach)\b/i,
  /\b(?:incident\s+response|security\s+incident)\b/i,
  /\b(?:revo(?:ke[sd]?|cation)|invalidat(?:e[sd]?|ion))\b/i,
  /\bwhat\s+to\s+do\s+(?:if|when)\s+.{0,40}(?:key|secret|credential|token)\b/i,
  /\b(?:key|secret|token|cert(?:ificate)?)\s+expir(?:y|ation|es?|ing)\b/i,
  /\brenew(?:ing|al|ed)?\s+(?:cert(?:ificate)?|key|token)\b/i,
];

function checkSecretRotation(files: InstructionFile[]): PromptCiIssue | null {
  const combined = files.map((f) => f.content).join('\n');
  const hasSensitiveKeys = SECURITY_SENSITIVE_PATTERNS.some((p) => p.test(combined));
  if (!hasSensitiveKeys) return null;

  const hasRotationDocs = SECRET_ROTATION_PATTERNS.some((p) => p.test(combined));
  if (hasRotationDocs) return null;

  return {
    id: issueId('missing-secret-rotation'),
    severity: 'warning',
    category: 'missing_context',
    title: 'Security-sensitive project missing secret rotation / incident response guidance',
    summary:
      'Instruction files reference security-sensitive credentials or cryptographic keys (JWT, TLS, signing keys, etc.) ' +
      'but do not document how to rotate them, what to do on suspected compromise, or how to handle expiry. ' +
      'Agents cannot safely manage security events without this information.',
    filePaths: files.map((f) => f.path),
    locations: [],
    evidence: [
      'Security-sensitive key/credential references found, but no rotation, compromise, or incident-response procedure documented.',
    ],
    recommendation:
      'Add a section covering: (1) how to rotate secrets or API keys, ' +
      '(2) what to do if a key is suspected compromised (revoke, re-issue, notify), ' +
      '(3) how certificate/token expiry is handled.',
    confidence: 0.65,
  };
}

// ── BUG-009: Environment variable list completeness check ─────────────────────

/**
 * Pattern for environment variable names: ALL_CAPS identifiers of ≥ 4 chars.
 * Common enough to appear in any project that uses env vars.
 */
const ENV_VAR_NAME_RE = /\b([A-Z][A-Z0-9_]{3,})\b/g;

/**
 * Patterns that indicate a comprehensive env var section exists.
 */
const ENV_SECTION_PATTERNS = [
  /\b(?:environment\s+variables?|env\s+vars?|required\s+(?:env(?:ironment)?\s+)?variables?)\b/i,
  /\.env\.example\b/i,
  /\benv(?:ironment)?\s+(?:setup|configuration|config)\b/i,
  /\bconfigure\s+(?:your\s+)?environment\b/i,
];

/** Common all-caps words that are not environment variable names. */
const ENV_VAR_STOP_WORDS = new Set([
  'API', 'URL', 'HTTP', 'HTML', 'JSON', 'SQL', 'JWT', 'TLS', 'SSL', 'RLS',
  'CRUD', 'REST', 'CORS', 'UUID', 'AUTH', 'NOTE', 'TODO', 'HACK', 'FIXME',
  'WARN', 'INFO', 'NULL', 'TRUE', 'FALSE', 'NONE', 'VOID', 'ENUM', 'TYPE',
  'TEST', 'PROD', 'DEV', 'DOCS', 'SKIP', 'PASS', 'FAIL', 'DONE', 'STOP',
]);

function checkEnvVarList(files: InstructionFile[]): PromptCiIssue | null {
  const combined = files.map((f) => f.content).join('\n');
  const hasEnvSection = ENV_SECTION_PATTERNS.some((p) => p.test(combined));
  if (hasEnvSection) return null;

  // Count distinct env-var-like names, excluding common false-positive caps words
  const envVarNames = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(ENV_VAR_NAME_RE.source, ENV_VAR_NAME_RE.flags);
  while ((m = re.exec(combined)) !== null) {
    const name = m[1]!;
    if (!ENV_VAR_STOP_WORDS.has(name) && name.includes('_')) {
      // Must contain an underscore — distinguishes real env vars from acronyms
      envVarNames.add(name);
    }
  }

  // Only flag when ≥ 3 distinct env vars are named but there's no dedicated section
  if (envVarNames.size < 3) return null;

  const examples = [...envVarNames].slice(0, 4).join(', ');

  return {
    id: issueId('missing-env-var-list'),
    severity: 'info',
    category: 'missing_context',
    title: 'Environment variables referenced but no comprehensive list documented',
    summary:
      `Instruction files mention ${envVarNames.size} environment variable name(s) (e.g. ${examples}) ` +
      `but do not have a dedicated section listing all required variables. ` +
      `Agents and new developers cannot reliably set up the project without a complete env var reference.`,
    filePaths: files.map((f) => f.path),
    locations: [],
    evidence: [`${envVarNames.size} env-var-like names found: ${examples}…`],
    recommendation:
      'Add an "Environment Variables" or "Required Environment" section listing every required variable, ' +
      'its purpose, and a safe example value. A .env.example file reference also satisfies this check.',
    confidence: 0.6,
  };
}

// ── BUG-010: Copilot topic-silence check ──────────────────────────────────────

/**
 * Topics that agents commonly need guidance on. Each entry defines:
 *   - label:    Human-readable topic name (used in the issue title/summary)
 *   - patterns: At least one must match in a file for it to "cover" the topic
 *   - recommendation: Specific advice for the copilot-instructions.md author
 *
 * Only fires when at least one OTHER instruction file covers the topic —
 * the point is that copilot-instructions.md is the lone silent outlier.
 */
const CROSS_FILE_TOPICS: Array<{
  label: string;
  patterns: RegExp[];
  recommendation: string;
}> = [
  {
    label: 'file naming convention',
    patterns: [
      /\b(?:kebab-case|camelCase|camelcase|PascalCase|pascalcase|snake_case|naming\s+convention)\b/i,
    ],
    recommendation:
      'Add a file naming rule to copilot-instructions.md (e.g. "Use kebab-case for all ' +
      'files") so Copilot agents apply the same convention as the rest of the codebase.',
  },
];

/**
 * BUG-010: Detect when copilot-instructions.md is present but completely silent
 * on a topic that is covered — and possibly in conflict — across other files.
 *
 * A Copilot agent reads only its own instruction file and has no guidance on the
 * topic, even though human/Claude/Cursor agents are told what to do (or disagree
 * about it).
 */
function checkCopilotTopicSilences(files: InstructionFile[]): PromptCiIssue[] {
  const normalizedPath = (file: InstructionFile) => file.path.replace(/\\/g, '/').toLowerCase();
  const isRootCopilotFile = (file: InstructionFile) => {
    const normalized = normalizedPath(file);
    return normalized === '.github/copilot-instructions.md' ||
      normalized.endsWith('/.github/copilot-instructions.md');
  };
  const isCopilotInstructionFile = (file: InstructionFile) =>
    file.fileType === 'copilot' || normalizedPath(file).includes('/.github/instructions/');

  const copilotFile = files.find(isRootCopilotFile);
  if (!copilotFile) return [];

  const copilotFiles = files.filter(isCopilotInstructionFile);
  const otherFiles = files.filter((f) => !copilotFiles.includes(f));
  if (otherFiles.length === 0) return [];

  const issues: PromptCiIssue[] = [];

  for (const { label, patterns, recommendation } of CROSS_FILE_TOPICS) {
    const mentionedInOthers = otherFiles.some((f) =>
      patterns.some((p) => p.test(f.content)),
    );
    if (!mentionedInOthers) continue; // topic not documented anywhere — skip

    const mentionedInCopilot = copilotFiles.some((f) =>
      patterns.some((p) => p.test(f.content)),
    );
    if (mentionedInCopilot) continue; // copilot already covers it — skip

    issues.push({
      id: issueId(`copilot-topic-silence:${label}`),
      severity: 'info',
      category: 'missing_context',
      title: `copilot-instructions.md is silent on: ${label}`,
      summary:
        `Other instruction files document the ${label}, but Copilot instruction files ` +
        `do not mention it. Copilot agents will have no guidance on this topic.`,
      filePaths: [copilotFile.path],
      locations: [{ filePath: copilotFile.path }],
      evidence: [
        `"${label}" is documented in other instruction files but absent from Copilot instruction files.`,
      ],
      recommendation,
      confidence: 0.6,
    });
  }

  return issues;
}

export function detectMissingContext(
  files: InstructionFile[],
  projectType: ProjectType,
): PromptCiIssue[] {
  const issues: PromptCiIssue[] = [];

  // ── Global checks (always run) ────────────────────────────────────────────
  const setupIssue = checkSetupCommands(files);
  if (setupIssue) issues.push(setupIssue);

  const securityIssue = checkSecurityRules(files);
  if (securityIssue) issues.push(securityIssue);

  // BUG-007: credential section present but security surface (scopes/validation/expiry) absent
  const credSurfaceIssue = checkCredentialSurface(files);
  if (credSurfaceIssue) issues.push(credSurfaceIssue);

  // BUG-008: security-sensitive keys referenced but no rotation / incident-response docs
  const secretRotationIssue = checkSecretRotation(files);
  if (secretRotationIssue) issues.push(secretRotationIssue);

  // BUG-009: env vars referenced but no comprehensive env var list / section
  const envVarIssue = checkEnvVarList(files);
  if (envVarIssue) issues.push(envVarIssue);

  // BUG-010: copilot-instructions.md missing topics covered by other files
  issues.push(...checkCopilotTopicSilences(files));

  // ── Project-type-specific checks ──────────────────────────────────────────
  if (projectType === 'auto' || projectType === 'unknown') return issues;

  const rules = PROJECT_TYPE_RULES[projectType as keyof typeof PROJECT_TYPE_RULES];
  if (!rules) return issues;

  const allContent = files.map((f) => f.content.toLowerCase()).join('\n');
  const present = rules.keywords.filter((kw) => keywordPresent(allContent, kw));

  if (present.length < rules.minimumPresent) {
    const exampleKeywords = rules.keywords.slice(0, 3).join(', ');
    issues.push({
      id: issueId(projectType),
      severity: 'warning',
      category: 'missing_context',
      title: `Missing ${rules.label}-specific context`,
      summary:
        `This appears to be a ${rules.label} project, but the instruction files do not mention ` +
        `any ${rules.label}-specific context (e.g. build commands, test runner, tooling).`,
      filePaths: files.map((f) => f.path),
      locations: [],
      evidence: [`No keywords found matching: ${exampleKeywords}…`],
      recommendation:
        `Add a section covering ${rules.label}-specific build commands, testing conventions, ` +
        `and common project patterns so AI assistants have enough context to help effectively.`,
      confidence: 0.75,
    });
  }

  return issues;
}
