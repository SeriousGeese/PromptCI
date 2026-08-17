/**
 * Dead-reference detector for PromptCI.
 *
 * Scans instruction files for references to other local files and flags
 * ones that don't exist on disk. Catches:
 *   - Markdown links:  [text](./path/to/file.md)
 *   - Reference-style links: [text][ref] with a `[ref]: path` definition
 *   - @-file refs:     @AGENTS.md  |  @docs/guide.md
 *
 * External URLs (http/https), anchor-only links (#section), and mailto:
 * are always skipped. Only paths with a recognisable file extension are
 * checked to avoid false-positiving on badge shields, npm package names, etc.
 *
 * Findings are heuristic — wording is intentionally cautious.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { InstructionFile, PromptCiIssue } from './types.js';

// ── Patterns ──────────────────────────────────────────────────────────────────

/** Matches markdown inline links: [label](target) — captures target (may include a title). */
const MD_LINK_RE = /\[(?:[^\]]*)\]\(([^)]+)\)/g;
const NESTED_MD_LINK_RE = /\[(?:[^\]]|\]\([^)]*\))*\]\(([^)]+)\)/g;

/**
 * Matches markdown reference-style link definitions: `[ref]: path/to/file.md "Title"`
 * These are easy to miss because the usage site `[text][ref]` never carries the path —
 * only the definition line does.
 */
const LINK_REF_DEF_RE = /^[ \t]{0,3}\[[^\]]+\]:\s*(\S+)/gm;

/**
 * Matches @-file references: @AGENTS.md, @./path/file.ts, @docs/guide.md
 * Only captures paths that have a recognisable file extension.
 */
const AT_FILE_RE =
  /(?<!\w)@((?:\.{1,2}\/)?[\w./\\-]+\.(?:md|ts|js|mjs|cjs|tsx|jsx|json|yml|yaml|toml|txt|sh|py|cs|go|rs))/g;

/**
 * Matches backtick-enclosed file paths: `scripts/setup-dev.sh`, `Assets/Scripts/Foo.cs`
 * Only fires when the content looks like a file path:
 *   - No spaces (commands like `npm run build` are excluded)
 *   - Has a recognisable extension
 * This catches prose references like "see `docs/guide.md`" that aren't markdown links.
 * An optional trailing `:line` or `:line:col` suffix (e.g. `src/gone.ts:42`) is allowed
 * after the extension but excluded from the captured path.
 */
const BACKTICK_PATH_RE =
  /`([^\s`\n]+\.(?:md|sh|py|ts|js|tsx|jsx|mjs|cjs|json|yml|yaml|toml|cs|go|rs|txt|lock|env|png|jpg|jpeg|gif|svg|webp|pdf))(?::\d+(?::\d+)?)?`/g;

/**
 * BUG-004: Bullet-list bare file paths in Repository Layout / Project Structure sections.
 * Catches lines like:
 *   - docs/runbook.md
 *   * src/middleware/auth.rs
 * Requires at least one slash (directory component) to avoid false-positiving on
 * single-word filenames.
 */
const BULLET_PATH_RE =
  /^[ \t]*[-*+]\s+((?:[\w.-]+\/)+[\w.-]+\.(?:md|ts|js|tsx|jsx|mjs|cjs|json|yml|yaml|toml|sh|py|cs|go|rs|txt|png|jpg|jpeg|gif|svg|webp|pdf))\b/gm;

/**
 * BUG-004: ASCII/Unicode directory-tree listing paths.
 * Catches Unicode tree drawings:
 *   ├── docs/runbook.md
 *   └── rate-limiting.md
 * and their common ASCII-art equivalents:
 *   |-- docs/runbook.md
 *   `-- rate-limiting.md
 * The Unicode connector chars are unambiguous, so a bare space run after them is enough.
 * The ASCII fallback chars (`|`, `+`, backtick) are also ordinary punctuation elsewhere
 * (table pipes, code spans), so we require at least one dash in the connector to avoid
 * misreading a markdown table cell as a tree entry.
 */
/**
 * BUG-004: Headings that indicate a repository/file layout section.
 * When a file contains a heading matching this pattern, we also scan for
 * bare paths in bullet lists and directory tree listings.
 *
 * Matches both real markdown headings (`## Project Structure`) and bolded
 * pseudo-headings on their own line (`**Project Structure**`), since authors
 * commonly use bold text in lieu of a heading for this kind of section.
 */
const LAYOUT_KEYWORDS_SRC =
  'repository\\s+layout|project\\s+structure|file\\s+structure|folder\\s+structure|' +
  'directory\\s+(?:structure|layout|tree|overview)|project\\s+tree|repo\\s+(?:structure|layout|map)|' +
  'file\\s+tree|files?\\s+overview|codebase\\s+(?:map|overview|structure|layout)|layout';

const LAYOUT_SECTION_HEADING_RE = new RegExp(
  `^(?:#{1,4}\\s+.*\\b(?:${LAYOUT_KEYWORDS_SRC})\\b|\\*\\*[^*\\n]*\\b(?:${LAYOUT_KEYWORDS_SRC})\\b[^*\\n]*\\*\\*\\s*)`,
  'im',
);

/**
 * BUG-D1: Creation-intent phrasing. A reference introduced by an instruction to
 * CREATE a file ("Create a file named `.github/workflows/promptci.yml` in your
 * repository") is a template for the reader's own repo, not a claim that the
 * file exists here — so its absence must not be flagged as a broken reference.
 * Requires a creation verb + a file-ish noun + a connector, keeping it specific
 * enough to avoid suppressing ordinary "see `docs/guide.md`" references.
 *
 * The trailing group captures the introduced target path so ONLY that ref is
 * suppressed — an unrelated broken ref that merely shares the line (e.g.
 * "Create a file named `ci.yml`, like the one in `docs/other.md`") is still
 * flagged.
 */
const CREATION_INTENT_RE =
  /\b(?:create|add|generate|scaffold|place|put|save|make)\s+(?:a\s+|an\s+|the\s+|your\s+|this\s+|new\s+)*(?:file|workflow|config(?:uration)?|script|action|manifest|template|module|component)\b[^.\n]*?\b(?:named|called|at|as|in|to|like)\s+[`'"(]*([^\s`'"()]+)/i;

/** Normalizes a ref for creation-target comparison (slashes, ./ prefix, case). */
function normalizeRefPath(ref: string): string {
  return stripFragment(ref).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

/** File extensions we consider worth checking. */
const CHECKABLE_EXTENSIONS = new Set([
  '.md', '.ts', '.js', '.mjs', '.cjs', '.tsx', '.jsx',
  '.json', '.yml', '.yaml', '.toml', '.txt', '.sh', '.py', '.cs', '.go', '.rs',
  // BUG-006: image and document links (e.g. [./docs/architecture.png]) were previously
  // ignored because their extensions weren't in this set.
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.pdf',
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function isExternalRef(ref: string): boolean {
  return /^https?:\/\/|^mailto:|^#|^data:/.test(ref.trimStart());
}

/**
 * Strips a markdown link title from a raw link target.
 * `docs/missing.md "The Guide"` → `docs/missing.md`
 * `docs/missing.md 'The Guide'` → `docs/missing.md`
 * Titles are only recognised when quoted, per the CommonMark link title grammar.
 */
function stripLinkTitle(raw: string): string {
  const trimmed = raw.trim();
  const angleMatch = /^<([^>]+)>(?:\s+(?:"[^"]*"|'[^']*'))?\s*$/.exec(trimmed);
  if (angleMatch) return angleMatch[1]!;
  const titleMatch = /^(\S+)\s+(?:"[^"]*"|'[^']*')\s*$/.exec(trimmed);
  return titleMatch ? titleMatch[1]! : trimmed;
}

/**
 * BUG-009 / BUG-012: Placeholder / example filenames and template paths.
 *
 * Skipped cases:
 *   - Common placeholder stems: foo.ts, bar.go, example.py, sample.md
 *   - ComponentName-style templates: ComponentName.tsx, MyComponent.tsx
 *   - Angle-bracket templates: src/features/<domain>/slice.ts
 *   - Numeric-suffix patterns: file1.ts, file2.go
 */
const PLACEHOLDER_STEM_RE = /^(foo|bar|baz|qux|quux|example|sample|placeholder|stub|demo|test|your[-_]?file|my[-_]?file|filename|file[-_]?name)(\.\w+)?$/i;

/**
 * BUG-C2: Generic bare filenames that commonly appear as naming-convention examples
 * in instruction files (e.g. "name your files like `tokens.json`") rather than as
 * references to specific existing files. Only suppressed when the reference has NO
 * directory prefix — `src/tokens.json` is specific enough to check.
 */
const GENERIC_BARE_FILENAMES = new Set([
  'tokens.json', 'config.json', 'settings.json', 'schema.json', 'manifest.json',
  'types.ts', 'types.d.ts', 'index.ts', 'index.js', 'main.ts', 'main.go',
  'app.ts', 'app.js', 'constants.ts', 'utils.ts', 'helpers.ts', 'globals.ts',
  'routes.ts', 'store.ts', 'models.ts', 'services.ts',
  // Universal project root files — always present in their respective ecosystems;
  // flagging them as dead references is always a false positive in real projects.
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
  'tsconfig.json', 'tsconfig.base.json',
  'pyproject.toml', 'cargo.toml',
  // Framework config roots
  'next.config.js', 'next.config.ts', 'next.config.mjs',
  'vite.config.ts', 'vite.config.js', 'vite.config.mjs',
  'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs',
  '.eslintrc.json', '.eslintrc.js', '.eslintrc.yml',
  'jest.config.ts', 'jest.config.js', 'jest.config.mjs',
  'vitest.config.ts', 'vitest.config.mts',
]);

/**
 * BUG-012: Component/entity name templates used in naming-convention examples.
 * Matches PascalCase names that are clearly "fill in the blank" placeholders.
 */
// Allow multiple extension segments so ComponentName.test.tsx is also caught
const COMPONENT_TEMPLATE_RE = /^(ComponentName|MyComponent|YourComponent|WidgetName|FeatureName|ModuleName|ServiceName|ModelName|EntityName|ResourceName|DomainName|ControllerName|ScreenName|PageName)(?:\.\w+)*$/i;

function isPlaceholderRef(ref: string): boolean {
  // BUG-012: Angle-bracket template placeholders: src/features/<domain>/slice.ts
  if (/<[A-Za-z][A-Za-z0-9_-]*>/.test(ref)) return true;

  // BUG-009: Curly-brace template variables: public/locales/{locale}/{namespace}.json
  // These are pattern descriptions, not real file paths.
  if (/\{[A-Za-z][A-Za-z0-9_-]*\}/.test(ref)) return true;

  // BUG-006 (eval): Ellipsis segments ("...") are glob placeholders, not real path components.
  // e.g. "src/test/java/.../unit/" is a structural description, not a literal path.
  if (ref.split('/').includes('...')) return true;

  const base = path.basename(stripFragment(ref));
  // "Real" directory means a path segment beyond a bare `./` or `.\` prefix.
  // `./sample.md` → dir = '.' → no real directory (still a bare ref)
  // `scripts/test.sh` → dir = 'scripts' → real directory
  const dir = path.dirname(stripFragment(ref));
  const hasRealDirectory = dir !== '.' && dir !== '' && dir !== '.\\' && dir !== './';

  // Common generic placeholder stems — only suppress when there is no real directory prefix.
  // A path like `scripts/test.sh` is a real reference even though "test" is a generic stem;
  // a bare `test.sh` or `./test.sh` is almost certainly a naming-convention example.
  if (!hasRealDirectory && PLACEHOLDER_STEM_RE.test(base)) return true;

  // BUG-012: PascalCase component/entity name templates
  if (COMPONENT_TEMPLATE_RE.test(base)) return true;
  const hasDirectoryComponent = hasRealDirectory;
  if (!hasDirectoryComponent && GENERIC_BARE_FILENAMES.has(base.toLowerCase())) return true;

  // BUG-005 (eval): Filenames whose stem literally contains a naming-convention term
  // (camelCase, PascalCase, kebab-case, snake_case) are almost certainly illustrative
  // examples in a naming-convention section, not references to real project files.
  // e.g. "useCamelCase.ts", "camelCase.types.ts", "my-kebab-case-component.tsx"
  if (/camelCase|CamelCase|PascalCase|pascalCase|kebab[-_]?[Cc]ase|snake_?[Cc]ase/.test(base)) return true;

  return false;
}

/**
 * BUG-008: Commonly gitignored credential and environment config files, plus
 * known tool output directories whose contents are never committed.
 *
 * These files/paths are intentionally absent from the repo. Flagging them as
 * dead references is a false positive; instruction files legitimately reference
 * them as "where to put your credentials / local config / tool output".
 *
 * Matched against the full ref path (not just basename) so that
 * `config/secrets.py` and `secrets.py` are both caught.
 */
const GITIGNORED_CREDENTIAL_PATTERNS: RegExp[] = [
  // PromptCI output directory — config and reports are user-created, never committed
  /(?:^|[/\\])\.promptci[/\\]/,
  // Python secrets / credentials
  /(?:^|[\\/])secrets?\.\w+$/i,
  /(?:^|[\\/])credentials?\.\w+$/i,
  // .NET environment-specific appsettings (Development / Production are always gitignored)
  /appsettings\.(?:Development|Production|Staging|Local)\.\w+$/i,
  // .env files of any form
  /(?:^|[\\/])\.env(?:\.\w+)?$/i,
  // Generic local-override configs
  /(?:^|[\\/])local\.(?:json|yaml|yml|toml|ini|conf|config)$/i,
  /\.local\.\w+$/i,
  // Named private-key files without a cert/key extension (e.g. ~/.ssh/id_rsa)
  /(?:^|[\\/])(?:private(?:key)?|id_rsa|id_ed25519)(?:\.\w+)?$/i,
  // Certificate/key file EXTENSIONS, regardless of stem — `certs/server.pem`,
  // `config/client.key`, and a bare `.pem` must all be treated the same way.
  /\.(?:pem|key|pfx|p12)$/i,
];

function isGitignored(ref: string): boolean {
  const normalised = ref.replace(/\\/g, '/');
  return GITIGNORED_CREDENTIAL_PATTERNS.some((re) => re.test(normalised));
}

function hasCheckableExtension(ref: string): boolean {
  const ext = path.extname(ref.split('#')[0] ?? '').toLowerCase();
  return CHECKABLE_EXTENSIONS.has(ext);
}

/** Strip query strings and anchor fragments from a path reference. */
function stripFragment(ref: string): string {
  return ref.split('#')[0].split('?')[0].trim();
}

function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/**
 * BUG-C1: Source-code file extensions. When a path has one of these extensions
 * and its parent directory exists (but the file itself doesn't), the reference
 * is likely architecture documentation — reduce confidence accordingly.
 */
const SOURCE_CODE_EXTENSIONS = new Set([
  '.go', '.cs', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rs', '.sh', '.java', '.kt', '.swift',
]);

/**
 * BUG-002: Compiled/native source extensions that, when encountered as backtick
 * inline spans (NOT markdown links or @-refs) in any instruction file type,
 * should be skipped. These are almost always architecture documentation, not real
 * file references — e.g. `internal/client/errors.go`, `src/components/Button.tsx`,
 * `pkg/registry/`, `PlayerController.cs`.
 *
 * NOTE: .sh, .py, .js are intentionally excluded — shell/Python/JS scripts are often
 * legitimately referenced by name in instruction files (e.g. `scripts/setup-dev.sh`).
 */
const BACKTICK_SKIP_SOURCE_EXTENSIONS = new Set([
  '.go', '.rs', '.cs', '.java', '.kt', '.swift',
  '.ts', '.tsx',  // TypeScript source — not config/test scripts
]);

/**
 * Backtick source paths are usually architecture descriptions, but explicit
 * legacy/old/deprecated/archive examples are often stale file references that
 * should be checked.
 */
const STALE_SOURCE_REF_RE = /(?:^|[/\\])(?:legacy|old|deprecated|archive|archived)(?:[/\\]|[-_.])/i;

/**
 * File types for which backtick-enclosed compiled/native source paths should be
 * skipped. All instruction file types are included because architecture
 * descriptions appear in all of them.
 *
 * BUG-002: Expanded from readme-only to all instruction file types.
 *
 * NOTE: this covers every FileType value, which also means backtick-quoted bare
 * *directory* paths (no extension, e.g. `pkg/registry/`) are always treated as
 * architecture descriptions rather than checked — that is intentional per
 * BUG-002, not an oversight.
 */
const SKIP_SOURCE_BACKTICK_FILE_TYPES = new Set([
  'readme', 'claude', 'agents', 'cursor', 'windsurf', 'copilot', 'docs', 'prompt', 'unknown',
]);

/** Minimum confidence to emit a dead-reference issue. Below this the signal is too noisy. */
const MIN_CONFIDENCE = 0.45;

function parentDirExists(p: string): boolean {
  try {
    return fs.existsSync(path.dirname(p));
  } catch {
    return false;
  }
}

function issueId(normRef: string): string {
  const key = `dead-ref:${normRef}`;
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
  return `dead-ref-${hash}`;
}

// ── Line-number tracking ────────────────────────────────────────────────────

/** Offsets (into `content`) at which each line starts. `lineOffsets[i]` is line `i + 1`. */
function buildLineOffsets(content: string): number[] {
  const offsets = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') offsets.push(i + 1);
  }
  return offsets;
}

/** 1-indexed line number containing the given character offset. */
function lineForOffset(lineOffsets: number[], offset: number): number {
  let lo = 0;
  let hi = lineOffsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineOffsets[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * BUG-002 (eval): Extract implied documentation paths from fenced code blocks inside
 * Repository Layout sections. Handles listings where a parent directory line
 * ("docs/") is followed by indented child file entries ("  runbook.md").
 *
 * Only extracts .md files — source code file references in layout blocks are
 * intentionally skipped to avoid false positives in test/instruction-only repos
 * where no source files are present on disk.
 *
 * Called only when the file is known to have a layout section heading.
 */
const CODE_BLOCK_LAYOUT_EXT_RE = /\.(?:md|png|jpg|jpeg|gif|svg|webp|pdf)$/i;

type LayoutEntry = {
  entry: string;
  indent: number;
  hasConnector: boolean;
};

function parseLayoutEntry(rawLine: string): LayoutEntry | null {
  const withoutComment = rawLine.replace(/\s*#.*$/, '');
  const verticalPrefix = withoutComment.match(/^[ \t│|]*/)?.[0] ?? '';
  const indent = verticalPrefix.replace(/[│|]/g, '    ').length;
  const trimmed = withoutComment.trim();
  if (!trimmed) return null;

  const connectorMatch = /^(?:[│|]\s*)*(?:[├└][-─\s]+|[|+`][-─]+\s*)(.+)$/.exec(trimmed);
  const entry = (connectorMatch ? connectorMatch[1] : trimmed)?.trim() ?? '';
  if (!entry) return null;
  if (!connectorMatch && /\s/.test(entry)) return null;

  return {
    entry,
    indent,
    hasConnector: Boolean(connectorMatch),
  };
}

function collectLayoutEntryPaths(
  lines: string[],
  lineOffsets: number[],
  startOffset: number,
): Array<{ ref: string; evidence: string; line: number }> {
  const results: Array<{ ref: string; evidence: string; line: number }> = [];
  const stack: Array<{ indent: number; path: string; plain: boolean }> = [];
  let lineOffset = startOffset;

  for (const rawLine of lines) {
    const thisLineOffset = lineOffset;
    lineOffset += rawLine.length + 1;

    const parsed = parseLayoutEntry(rawLine);
    if (!parsed) continue;

    const entry = parsed.entry;
    const isDir = /\/$/.test(entry);
    if (isDir) {
      const parent = [...stack].reverse().find(
        (item) => item.indent < parsed.indent || (item.indent === parsed.indent && item.plain),
      );
      const dirPath = `${parent?.path ?? ''}${entry}`;
      while (stack.length > 0 && stack[stack.length - 1]!.indent >= parsed.indent) {
        stack.pop();
      }
      stack.push({ indent: parsed.indent, path: dirPath, plain: !parsed.hasConnector });
      continue;
    }

    if (!CODE_BLOCK_LAYOUT_EXT_RE.test(entry)) continue;
    const parent = [...stack].reverse().find(
      (item) => item.indent < parsed.indent || (item.indent === parsed.indent && item.plain),
    );
    const ref = /[/\\]/.test(entry) ? entry : `${parent?.path ?? ''}${entry}`;
    results.push({
      ref,
      evidence: rawLine.trim(),
      line: lineForOffset(lineOffsets, thisLineOffset),
    });
  }

  return results;
}

function extractCodeBlockLayoutPaths(
  content: string,
  lineOffsets: number[],
): Array<{ ref: string; evidence: string; line: number }> {
  const results: Array<{ ref: string; evidence: string; line: number }> = [];
  const fenceRe = /^```[^\n]*\n([\s\S]*?)^```/gm;
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = fenceRe.exec(content)) !== null) {
    const blockText = blockMatch[1] ?? '';
    const firstLineEnd = content.indexOf('\n', blockMatch.index);
    let lineOffset = firstLineEnd === -1 ? blockMatch.index : firstLineEnd + 1;

    const lines = blockText.split('\n');
    results.push(...collectLayoutEntryPaths(lines, lineOffsets, lineOffset));
  }

  return results;
}

function extractLayoutTreePaths(
  content: string,
  lineOffsets: number[],
): Array<{ ref: string; evidence: string; line: number }> {
  return collectLayoutEntryPaths(content.split('\n'), lineOffsets, 0);
}

function collectRefs(
  content: string,
  opts: { skipSourceBackticks?: boolean } = {},
): Array<{ ref: string; evidence: string; line: number }> {
  const found: Array<{ ref: string; evidence: string; line: number }> = [];
  const lineOffsets = buildLineOffsets(content);

  // Markdown links: [label](target) or [label](target "Title")
  let m: RegExpExecArray | null;
  const linkRe = new RegExp(MD_LINK_RE.source, MD_LINK_RE.flags);
  while ((m = linkRe.exec(content)) !== null) {
    if (m.index >= 2 && content[m.index - 2] === '[' && content[m.index - 1] === '!') continue;
    const raw = m[1] ?? '';
    const ref = stripFragment(stripLinkTitle(raw));
    if (ref && !isExternalRef(ref) && hasCheckableExtension(ref)) {
      found.push({ ref, evidence: `[...](${raw})`, line: lineForOffset(lineOffsets, m.index) });
    }
  }

  const nestedLinkRe = new RegExp(NESTED_MD_LINK_RE.source, NESTED_MD_LINK_RE.flags);
  while ((m = nestedLinkRe.exec(content)) !== null) {
    const labelPart = m[0].slice(0, m[0].lastIndexOf(']('));
    if (!labelPart.includes('](')) continue;
    const raw = m[1] ?? '';
    const ref = stripFragment(stripLinkTitle(raw));
    if (ref && !isExternalRef(ref) && hasCheckableExtension(ref)) {
      found.push({ ref, evidence: `[...](${raw})`, line: lineForOffset(lineOffsets, m.index) });
    }
  }

  // Reference-style link definitions: [ref]: docs/missing.md "Title"
  const linkDefRe = new RegExp(LINK_REF_DEF_RE.source, LINK_REF_DEF_RE.flags);
  while ((m = linkDefRe.exec(content)) !== null) {
    const raw = m[1] ?? '';
    const ref = stripFragment(raw);
    if (ref && !isExternalRef(ref) && hasCheckableExtension(ref)) {
      found.push({ ref, evidence: m[0].trim(), line: lineForOffset(lineOffsets, m.index) });
    }
  }

  // @-file refs
  const atRe = new RegExp(AT_FILE_RE.source, AT_FILE_RE.flags);
  while ((m = atRe.exec(content)) !== null) {
    const ref = m[1] ?? '';
    if (ref && !isExternalRef(ref)) {
      found.push({ ref, evidence: `@${ref}`, line: lineForOffset(lineOffsets, m.index) });
    }
  }

  // Backtick file paths: `scripts/setup-dev.sh`, `Assets/Scripts/Foo.cs`
  // No spaces = file path not a command; must have a recognisable extension.
  // Skip glob patterns (contain * or ?) — those are pattern documentation, not file refs.
  // BUG-002: In all instruction file types (CLAUDE.md, AGENTS.md, .cursorrules, copilot, etc.)
  // skip backtick-quoted compiled/native source files — they are almost always architecture
  // descriptions (e.g. `internal/client/errors.go`), not references to committed files.
  // Shell (.sh), Python (.py), and JS files are kept because they CAN be real script refs.
  const btRe = new RegExp(BACKTICK_PATH_RE.source, BACKTICK_PATH_RE.flags);
  while ((m = btRe.exec(content)) !== null) {
    const ref = m[1] ?? '';
    if (ref && !isExternalRef(ref) && !ref.includes('*') && !ref.includes('?')) {
      if (opts.skipSourceBackticks) {
        const ext = path.extname(ref).toLowerCase();
        if (BACKTICK_SKIP_SOURCE_EXTENSIONS.has(ext) && !STALE_SOURCE_REF_RE.test(ref)) continue;
      }
      found.push({ ref, evidence: `\`${ref}\``, line: lineForOffset(lineOffsets, m.index) });
    }
  }

  // BUG-004: Bare paths in Repository Layout / Project Structure sections.
  // These appear as bullet list items or ASCII tree lines without backticks.
  if (LAYOUT_SECTION_HEADING_RE.test(content)) {
    const bulletRe = new RegExp(BULLET_PATH_RE.source, BULLET_PATH_RE.flags);
    while ((m = bulletRe.exec(content)) !== null) {
      const ref = m[1] ?? '';
      if (ref && !isExternalRef(ref)) {
        found.push({ ref, evidence: m[0].trim(), line: lineForOffset(lineOffsets, m.index) });
      }
    }

    found.push(...extractLayoutTreePaths(content, lineOffsets));

    // BUG-002 (eval): Fenced code blocks in layout sections may list documentation
    // files as indented children under a parent directory line ("docs/\n  runbook.md").
    for (const item of extractCodeBlockLayoutPaths(content, lineOffsets)) {
      found.push(item);
    }
  }

  // BUG-D1: Drop only the reference the line instructs the reader to CREATE
  // (a template for their repo), not every ref that happens to share the line.
  const contentLines = content.split('\n');
  return found.filter(({ ref, line }) => {
    const lineText = contentLines[line - 1] ?? '';
    const m = CREATION_INTENT_RE.exec(lineText);
    if (!m) return true;
    const target = normalizeRefPath(m[1] ?? '');
    if (!target) return true;
    const refNorm = normalizeRefPath(ref);
    // Suppress the ref that IS the creation target (allow basename-level match so
    // a `path/to/x.yml` ref matches a captured `x.yml` and vice-versa).
    const isTarget =
      refNorm === target ||
      refNorm.endsWith(`/${target}`) ||
      target.endsWith(`/${refNorm}`);
    return !isTarget;
  });
}

// ── Detector ─────────────────────────────────────────────────────────────────

/**
 * Detect broken file references across all instruction files.
 *
 * @param files     Instruction files to scan.
 * @param repoRoot  Absolute path to repo root — used as a second resolution base.
 */
/**
 * BUG-004 / BUG-005: Group all unresolved references by their normalised path so
 * that the same dead reference appearing in multiple instruction files produces ONE
 * consolidated issue (listing all referencing files) instead of N separate issues.
 *
 * Previously each (filePath, ref) pair produced its own issue — a single dead path
 * referenced in both CLAUDE.md and AGENTS.md would fire twice, inflating issue counts
 * and health-score penalties.
 */
export function detectDeadReferences(
  files: InstructionFile[],
  repoRoot: string,
): PromptCiIssue[] {
  // normRef → { displayRef, filePaths, fileLines, evidenceLines, minConfidence }
  const byRef = new Map<string, {
    displayRef: string;
    filePaths: Set<string>;
    fileLines: Map<string, number>;
    evidenceLines: string[];
    minConfidence: number;
  }>();

  for (const file of files) {
    const fileDir = path.dirname(file.path);
    const refs = collectRefs(file.content, {
      skipSourceBackticks: SKIP_SOURCE_BACKTICK_FILE_TYPES.has(file.fileType),
    });

    for (const { ref, evidence, line } of refs) {
      // BUG-009: Skip obvious placeholder/example filenames (foo.ts, bar.go, etc.)
      if (isPlaceholderRef(ref)) continue;

      // BUG-008: Skip intentionally gitignored credential/config files.
      if (isGitignored(ref)) continue;

      // Resolve relative to the instruction file first, then repo root.
      const candidates = [
        path.resolve(fileDir, ref),
        path.resolve(repoRoot, ref),
      ];

      if (candidates.some(fileExists)) continue;

      // BUG-C1: Source-code paths whose parent directory exists → lower confidence
      // (likely documentation references, not broken links).
      const ext = path.extname(ref.split('#')[0] ?? '').toLowerCase();
      const isSourceCodeRef = SOURCE_CODE_EXTENSIONS.has(ext);
      const anyParentExists = candidates.some(parentDirExists);
      const confidence = isSourceCodeRef && anyParentExists ? 0.5 : 0.85;

      // Normalise for deduplication (case-insensitive, forward slashes)
      const normRef = ref.toLowerCase().replace(/\\/g, '/');
      const evidenceLine = `Reference: ${evidence}`;

      if (!byRef.has(normRef)) {
        byRef.set(normRef, {
          displayRef: ref,
          filePaths: new Set(),
          fileLines: new Map(),
          evidenceLines: [],
          minConfidence: confidence,
        });
      }
      const entry = byRef.get(normRef)!;
      entry.filePaths.add(file.path);
      const existingLine = entry.fileLines.get(file.path);
      if (existingLine === undefined || line < existingLine) {
        entry.fileLines.set(file.path, line);
      }
      if (!entry.evidenceLines.includes(evidenceLine)) {
        entry.evidenceLines.push(evidenceLine);
      }
      entry.minConfidence = Math.min(entry.minConfidence, confidence);
    }
  }

  const issues: PromptCiIssue[] = [];
  const MIN_CONFIDENCE_THRESHOLD = MIN_CONFIDENCE;

  for (const [normRef, { displayRef, filePaths, fileLines, evidenceLines, minConfidence }] of byRef) {
    // BUG-002: Skip findings below the minimum confidence threshold.
    // Low-confidence source-code path references are almost certainly architecture docs.
    if (minConfidence < MIN_CONFIDENCE_THRESHOLD) continue;

    const allFilePaths = [...filePaths];

    issues.push({
      id: issueId(normRef),
      severity: 'warning',
      category: 'structure',
      title: `Broken file reference: ${path.basename(stripFragment(displayRef))}`,
      summary:
        `This instruction file references "${displayRef}" which does not appear to exist. ` +
        `The file may have been renamed, moved, or deleted.`,
      filePaths: allFilePaths,
      locations: allFilePaths.map((fp) => {
        const startLine = fileLines.get(fp);
        return startLine !== undefined ? { filePath: fp, startLine } : { filePath: fp };
      }),
      evidence: evidenceLines,
      recommendation:
        'Verify the path is correct relative to the instruction file location, ' +
        'or remove the reference if the file no longer exists.',
      confidence: minConfidence,
    });
  }

  return issues;
}
