import * as path from 'node:path';
import { existsSync } from 'node:fs';
import type { InstructionFile, InstructionSection } from './types.js';
import type { FileChange } from './fix-engine.js';

const DATE_PATTERNS = [
  /\b(?:last\s+updated|last\s+modified|updated\s+at|modified\s+at|date)\b\s*:\s*\b\d{4}-\d{2}-\d{2}\b/i,
  /\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}\b/i,
  /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?,\s+\d{4}\b/i,
];

const SCAN_REPORT_PATTERNS = [
  /health\s+score\s*:\s*\d+/i,
  /files\s+scanned\s*:\s*\d+/i,
  /promptci\s+report/i,
  /\bgenerated\s+by\s+promptci\b/i,
  /latest\s+scan\s+results/i,
  /scan\s+history/i,
];

const BRANCH_TASK_PATTERNS = [
  /current\s+branch\s*:\s*\S+/i,
  /git\s+branch\s*:\s*\S+/i,
  /current\s+task\s*:\s*\S+/i,
];

const LOCAL_PATH_PATTERN = /(?:[a-zA-Z]:\\users\\[a-zA-Z0-9_-]+)|(?:\/users\/[a-zA-Z0-9_-]+\/)|(?:\/home\/(?!runner)[a-zA-Z0-9_-]+\/)/i;

const VOLATILE_PATTERNS = [
  ...DATE_PATTERNS,
  ...SCAN_REPORT_PATTERNS,
  ...BRANCH_TASK_PATTERNS,
  LOCAL_PATH_PATTERN,
];

const VOLATILE_DATE_LINE_RE = /^\s*(?:[-*]\s+)?(?:last\s+)?(?:updated|modified|date|generated)\s*(?:at|on|date)?\s*:\s*(?:\d{4}-\d{2}-\d{2}|\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?,\s+\d{4}\b|\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}\b)/i;

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function cleanAbsolutePaths(content: string, repoRoot: string): string {
  const winRoot = repoRoot.replace(/\//g, '\\');
  const unixRoot = repoRoot.replace(/\\/g, '/');

  let updated = content;

  // Replace Windows absolute paths
  const winEscaped = escapeRegExp(winRoot);
  const winRegex = new RegExp(winEscaped + '([^\\s"\'\\)\\>]*)', 'gi');
  updated = updated.replace(winRegex, (match, suffix) => {
    const rel = suffix.replace(/\\/g, '/');
    return '.' + (rel.startsWith('/') ? rel : '/' + rel);
  });

  // Replace Unix absolute paths
  const unixEscaped = escapeRegExp(unixRoot);
  const unixRegex = new RegExp(unixEscaped + '([^\\s"\'\\)\\>]*)', 'gi');
  updated = updated.replace(unixRegex, (match, suffix) => {
    const rel = suffix;
    return '.' + (rel.startsWith('/') ? rel : '/' + rel);
  });

  return updated;
}

export function cleanVolatileDates(content: string): string {
  const lines = content.split(/\r?\n/);
  const filteredLines = lines.filter((line) => !VOLATILE_DATE_LINE_RE.test(line));
  const hasCRLF = content.includes('\r\n');
  return filteredLines.join(hasCRLF ? '\r\n' : '\n');
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function parseSections(content: string, filePath: string): InstructionSection[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const sections: InstructionSection[] = [];

  let currentHeading: string | undefined = undefined;
  let currentStartLine = 1;
  let currentLines: string[] = [];

  const flush = (endLine: number) => {
    const text = currentLines.join('\n');
    const id = currentHeading !== undefined ? slugify(currentHeading) : `${filePath}:0`;
    sections.push({
      id,
      filePath,
      heading: currentHeading,
      startLine: currentStartLine,
      endLine,
      text,
      normalizedText: text.toLowerCase().trim(),
    });
  };

  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i] ?? '';

    // Track fenced code blocks so bash comments (`# text`) are not treated as headings.
    if (/^[`~]{3}/.test(line)) {
      inCodeBlock = !inCodeBlock;
      currentLines.push(line);
      continue;
    }

    const headingMatch = !inCodeBlock && /^(#{1,3})\s+(.+)/.exec(line);

    if (headingMatch) {
      if (currentLines.length > 0 || currentHeading !== undefined) {
        flush(lineNum - 1);
      }
      currentHeading = headingMatch[2].trim();
      currentStartLine = lineNum;
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }

  if (currentLines.length > 0 || currentHeading !== undefined) {
    flush(lines.length);
  }

  return sections;
}

export interface OptimizeOptions {
  repoRoot: string;
  characterLimit?: number;
  docsDir?: string;
}

export interface OptimizeResult {
  changes: FileChange[];
}

export async function optimizeContext(
  files: InstructionFile[],
  options: OptimizeOptions
): Promise<OptimizeResult> {
  const repoRoot = path.resolve(options.repoRoot);
  const characterLimit = options.characterLimit ?? 2000;

  // Resolve targetDocsDir dynamically
  let targetDocsDir = options.docsDir;
  if (!targetDocsDir) {
    if (existsSync(path.join(repoRoot, 'Docs'))) {
      targetDocsDir = 'Docs';
    } else if (existsSync(path.join(repoRoot, 'docs'))) {
      targetDocsDir = 'docs/ai';
    } else {
      targetDocsDir = 'Docs'; // Default fallback
    }
  }
  const resolvedDocsDir = path.resolve(repoRoot, targetDocsDir);

  const generatedFilenames = new Set<string>();
  const changes: FileChange[] = [];

  // Focus only on instruction files
  const targetFiles = files.filter((f) =>
    ['claude', 'agents', 'cursor', 'copilot', 'readme', 'prompt'].includes(f.fileType)
  );

  for (const file of targetFiles) {
    const originalContent = file.content;

    // Apply cleaners to the entire file content
    let cleanedContent = cleanVolatileDates(originalContent);
    cleanedContent = cleanAbsolutePaths(cleanedContent, repoRoot);

    // Re-parse sections on cleaned content
    const sections = parseSections(cleanedContent, file.path);

    const sectionsToSplit: Array<{
      section: InstructionSection;
      targetPath: string;
      relPath: string;
    }> = [];

    for (const sec of sections) {
      if (!sec.heading) continue;

      const isLarge = sec.text.length > characterLimit;
      const isVolatile = VOLATILE_PATTERNS.some((pat) => pat.test(sec.text));

      if (isLarge || isVolatile) {
        let slug = slugify(sec.heading);
        if (!slug) slug = 'section';

        let candidateFilename = `${slug}.md`;
        let counter = 1;

        while (
          generatedFilenames.has(candidateFilename.toLowerCase()) ||
          existsSync(path.join(resolvedDocsDir, candidateFilename))
        ) {
          counter++;
          candidateFilename = `${slug}-${counter}.md`;
        }

        generatedFilenames.add(candidateFilename.toLowerCase());

        const newFilePath = path.join(resolvedDocsDir, candidateFilename);
        const relPath = path.relative(path.dirname(file.path), newFilePath).replace(/\\/g, '/');

        sectionsToSplit.push({
          section: sec,
          targetPath: newFilePath,
          relPath,
        });
      }
    }

    if (sectionsToSplit.length === 0) {
      // No splits, but check if content changed due to cleaners
      if (cleanedContent !== originalContent) {
        changes.push({
          filePath: file.path,
          originalContent,
          newContent: cleanedContent,
        });
      }
      continue;
    }

    const cleanedLines = cleanedContent.replace(/\r\n/g, '\n').split('\n');
    const hasCRLF = cleanedContent.includes('\r\n');
    const lineEnding = hasCRLF ? '\r\n' : '\n';

    // Sort splits in descending startLine to safely splice lines
    sectionsToSplit.sort((a, b) => b.section.startLine - a.section.startLine);

    for (const split of sectionsToSplit) {
      const { section, targetPath, relPath } = split;

      // Extracted text: promote heading to H1
      let sectionText = section.text;
      const headingMatch = /^(#{1,3})\s+(.+)$/m.exec(sectionText);
      if (headingMatch) {
        const headingText = headingMatch[2];
        sectionText = sectionText.replace(/^(#{1,3})\s+(.+)$/m, `# ${headingText}`);
      }

      // Add file change for new document
      changes.push({
        filePath: targetPath,
        originalContent: '',
        newContent: sectionText + lineEnding,
      });

      const startIdx = section.startLine - 1;
      const endIdx = section.endLine - 1;

      const originalHeadingLine = cleanedLines[startIdx];
      const replacement = [
        originalHeadingLine,
        '',
        `For details, see [${targetDocsDir}/${path.basename(targetPath)}](${relPath}).`,
      ];

      cleanedLines.splice(startIdx, endIdx - startIdx + 1, ...replacement);
    }

    const finalContent = cleanedLines.join(lineEnding);

    if (finalContent !== originalContent) {
      changes.push({
        filePath: file.path,
        originalContent,
        newContent: finalContent,
      });
    }
  }

  return { changes };
}
