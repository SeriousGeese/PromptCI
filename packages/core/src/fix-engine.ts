import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type { PromptCiIssue } from './types.js';

export interface FileChange {
  filePath: string; // Absolute path
  originalContent: string;
  newContent: string;
}

/**
 * Validates and resolves a path relative to the repo root to prevent path traversal.
 */
export function resolveSafePath(repoRoot: string, relativeOrAbsolutePath: string): string {
  const resolvedRoot = path.resolve(repoRoot);
  const resolvedPath = path.isAbsolute(relativeOrAbsolutePath)
    ? path.resolve(relativeOrAbsolutePath)
    : path.resolve(resolvedRoot, relativeOrAbsolutePath);

  if (!resolvedPath.startsWith(resolvedRoot)) {
    throw new Error(`Path traversal detected: "${relativeOrAbsolutePath}" is outside repo root "${resolvedRoot}"`);
  }
  return resolvedPath;
}

/**
 * Computes the proposed file changes to fix a given PromptCiIssue.
 * Returns an array of FileChanges that would be applied.
 */
export async function applyFixRecipe(
  issue: PromptCiIssue,
  repoRoot: string
): Promise<FileChange[]> {
  const changes: FileChange[] = [];

  // 1. Missing .promptci/ in .gitignore
  if (issue.id === 'security-pack-no-promptci-gitignore') {
    const gitignorePath = resolveSafePath(repoRoot, '.gitignore');
    let content = '';
    try {
      content = await fs.readFile(gitignorePath, 'utf-8');
    } catch {
      // file doesn't exist, which is fine
    }

    if (!content.includes('.promptci/')) {
      const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
      const suffix = content.endsWith('\n') || content.endsWith('\r')
        ? `.promptci/${lineEnding}`
        : `${lineEnding}.promptci/${lineEnding}`;
      changes.push({
        filePath: gitignorePath,
        originalContent: content,
        newContent: content + suffix,
      });
    }
    return changes;
  }

  // 2. Unignored directories in .gitignore
  if (issue.id === 'security-pack-unignored-dirs') {
    const gitignorePath = resolveSafePath(repoRoot, '.gitignore');
    let content = '';
    try {
      content = await fs.readFile(gitignorePath, 'utf-8');
    } catch {
      // file doesn't exist
    }

    let newLines = '';
    const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';

    for (const ev of issue.evidence) {
      const m = /Directory "([^"]+)" exists/.exec(ev);
      if (m && m[1]) {
        const dirName = m[1];
        if (!content.includes(`${dirName}/`)) {
          newLines += `${dirName}/${lineEnding}`;
        }
      }
    }

    if (newLines) {
      const suffix = content.endsWith('\n') || content.endsWith('\r')
        ? newLines
        : `${lineEnding}${newLines}`;
      changes.push({
        filePath: gitignorePath,
        originalContent: content,
        newContent: content + suffix,
      });
    }
    return changes;
  }

  // 3. Outdated Stale Year Replacement (2019-2023 -> 2026)
  if (issue.id.startsWith('stale-') && issue.category === 'stale_instruction') {
    const STALE_YEAR_RE = /(?<![/-])\b(2019|2020|2021|2022|2023)\b(?![/-])/g;
    
    // Check if this issue is specifically about stale years
    const hasYearEvidence = issue.evidence.some(ev => ev.includes('Year reference(s) that may be outdated'));
    if (hasYearEvidence && issue.locations.length > 0) {
      const loc = issue.locations[0];
      const filePath = resolveSafePath(repoRoot, loc.filePath);
      
      let content = '';
      try {
        content = await fs.readFile(filePath, 'utf-8');
      } catch {
        return [];
      }

      const lines = content.split(/\r?\n/);
      const hasCRLF = content.includes('\r\n');
      const lineEnding = hasCRLF ? '\r\n' : '\n';

      const startIdx = (loc.startLine ?? 1) - 1;
      const endIdx = (loc.endLine ?? lines.length) - 1;

      let modified = false;
      for (let i = startIdx; i <= endIdx; i++) {
        if (i >= 0 && i < lines.length) {
          const original = lines[i];
          const updated = original.replace(STALE_YEAR_RE, '2026');
          if (updated !== original) {
            lines[i] = updated;
            modified = true;
          }
        }
      }

      if (modified) {
        changes.push({
          filePath,
          originalContent: content,
          newContent: lines.join(lineEnding),
        });
      }
    }
    return changes;
  }

  // 4. Duplicate Markdown Section Consolidation
  if (issue.category === 'duplicate' && issue.locations.length >= 2) {
    // 4a. Identify canonical path: AGENTS.md preferred, otherwise the first in location list
    let canonicalLoc = issue.locations.find(loc => 
      path.basename(loc.filePath).toLowerCase() === 'agents.md'
    );
    if (!canonicalLoc) {
      canonicalLoc = issue.locations[0];
    }
    const canonicalPath = resolveSafePath(repoRoot, canonicalLoc.filePath);
    const canonicalBase = path.basename(canonicalPath);

    // 4b. In all other files containing duplicates, replace the section body with a pointer link
    for (const loc of issue.locations) {
      const filePath = resolveSafePath(repoRoot, loc.filePath);
      if (filePath === canonicalPath) continue; // skip canonical file

      let content = '';
      try {
        content = await fs.readFile(filePath, 'utf-8');
      } catch {
        continue;
      }

      const lines = content.split(/\r?\n/);
      const hasCRLF = content.includes('\r\n');
      const lineEnding = hasCRLF ? '\r\n' : '\n';

      const startIdx = (loc.startLine ?? 1) - 1;
      const endIdx = (loc.endLine ?? lines.length) - 1;

      // Find relative path from current file to canonical file for clean Markdown links
      const relPath = path.relative(path.dirname(filePath), canonicalPath).replace(/\\/g, '/');
      const linkTarget = relPath.startsWith('.') ? relPath : `./${relPath}`;

      // Extract the section lines
      const sectionLines = lines.slice(startIdx, endIdx + 1);
      
      let headingLine = '';
      let replaceStartIdx = startIdx;

      // Check if the section starts with a heading line (e.g. "## Deployment")
      // If so, we preserve the heading and replace only the body below it.
      if (sectionLines.length > 0 && sectionLines[0].trim().startsWith('#')) {
        headingLine = sectionLines[0];
        replaceStartIdx = startIdx + 1;
      }

      const pointerText = `See canonical instructions in [${canonicalBase}](${linkTarget}) for details.`;
      
      // Construct the new lines
      const prefixLines = lines.slice(0, replaceStartIdx);
      const suffixLines = lines.slice(endIdx + 1);
      
      let newSectionContent: string[];
      if (headingLine) {
        newSectionContent = [pointerText];
      } else {
        newSectionContent = [pointerText];
      }

      const finalLines = [...prefixLines, ...newSectionContent, ...suffixLines];
      
      changes.push({
        filePath,
        originalContent: content,
        newContent: finalLines.join(lineEnding),
      });
    }
  }

  return changes;
}
