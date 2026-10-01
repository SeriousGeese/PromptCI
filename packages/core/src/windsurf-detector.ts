/**
 * Windsurf Rules Detector (issue #67)
 *
 * `.windsurfrules` is Windsurf's legacy, always-on, workspace-wide rules file:
 * every rule in it is fed to the model on every request for the whole
 * workspace. Windsurf also supports scoped `.windsurf/rules/*.md` files with
 * glob / manual / model-decision activation.
 *
 * This detector flags one thing the generic prose detectors miss: a workspace
 * `.windsurfrules` that clearly carries language- or framework-specific rules,
 * which are cheaper as glob-scoped rules that load only for matching files. It
 * emits a single cautious `info` suggesting the author clarify intended scope.
 *
 * The Windsurf-specific size/truncation check for `.windsurfrules` lives in
 * `context-bloat.ts`, alongside the other file-type-specific size thresholds.
 *
 * Deterministic and offline.
 */

import type { RepoContext } from './repo-context.js';
import type { FileType, InstructionFile, PromptCiIssue } from './types.js';
import { shortHash } from './ai-config.js';
import { fileIdPath } from './finding-id.js';
import { aliasesWithNewType, groupAliasesByTarget } from './alias-files.js';

/**
 * Language / framework signals that, when they appear as SECTION HEADINGS in an
 * always-on workspace file, indicate rules scoped to only part of the codebase.
 * Heading-only matching keeps this precise: a passing mention of "python" in
 * prose does not count, but a `## Python` section does. Terms are chosen to be
 * unambiguous in a heading (e.g. `golang`, not bare `go`).
 */
const SCOPED_TOPICS: Array<{ label: string; re: RegExp }> = [
  { label: 'TypeScript', re: /\btypescript\b/i },
  { label: 'JavaScript', re: /\bjavascript\b/i },
  { label: 'Python', re: /\bpython\b/i },
  { label: 'Rust', re: /\brust\b/i },
  { label: 'Go', re: /\bgolang\b/i },
  { label: 'Ruby', re: /\bruby\b|\brails\b/i },
  { label: 'Java', re: /\bjava\b(?!script)/i },
  { label: 'Kotlin', re: /\bkotlin\b/i },
  { label: 'Swift', re: /\bswift\b/i },
  { label: 'C#', re: /\bc#|\bcsharp\b|\bdotnet\b|\.net\b/i },
  { label: 'React', re: /\breact\b/i },
  { label: 'Vue', re: /\bvue\b/i },
  { label: 'Svelte', re: /\bsvelte\b/i },
  { label: 'Django', re: /\bdjango\b/i },
];

/**
 * Two or more distinct scoped topics in headings is a strong, low-noise signal
 * that an always-on file mixes rule sets that would be better glob-scoped. One
 * topic is left alone — a single `## Python` section in a Python repo is normal.
 */
const MIN_DISTINCT_TOPICS = 2;

export function detectWindsurfRules(context: RepoContext): PromptCiIssue[] {
  const issues: PromptCiIssue[] = [];

  // `.windsurfrules -> AGENTS.md`: Windsurf loads that content always-on under the alias's name, so the
  // check runs for the alias (against the real content) unless the real file is already a Windsurf file.
  // Several links to one file are one finding listing every link, not one per link.
  const isWindsurf = (type: FileType) => type === 'windsurf';
  const groups: InstructionFile[][] = [
    ...context.files.filter((file) => file.fileType === 'windsurf').map((file) => [file]),
    ...groupAliasesByTarget(aliasesWithNewType(context.files, context.aliasFiles ?? [], isWindsurf)),
  ];

  for (const group of groups) {
    const file = group[0]!;

    const topics = new Set<string>();
    for (const section of file.sections) {
      const heading = section.heading;
      if (!heading) continue;
      for (const topic of SCOPED_TOPICS) {
        if (topic.re.test(heading)) topics.add(topic.label);
      }
    }

    if (topics.size >= MIN_DISTINCT_TOPICS) {
      const found = [...topics].sort();
      issues.push({
        id: `ai-config-windsurf-scope-${shortHash(fileIdPath(file))}`,
        severity: 'info',
        category: 'ai_config',
        title: '.windsurfrules mixes language-specific rules in a workspace-wide file',
        summary:
          `This \`.windsurfrules\` has headings for multiple languages/frameworks ` +
          `(${found.join(', ')}), but it applies to the whole workspace on every ` +
          `request. Language- or framework-specific rules are cheaper as glob-scoped ` +
          `rules that load only for matching files.`,
        filePaths: group.map((f) => f.path),
        locations: group.map((f) => ({ filePath: f.path, startLine: 1 })),
        evidence: [`Scoped topics found in headings: ${found.join(', ')}`],
        recommendation:
          'Clarify the intended scope: keep genuinely workspace-wide conventions in ' +
          '`.windsurfrules`, and move language- or framework-specific rules into ' +
          'glob-scoped `.windsurf/rules/*.md` files, each with a glob trigger.',
        confidence: 0.6,
      });
    }
  }

  return issues;
}
