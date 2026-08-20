import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type { InstructionFile, PromptCiIssue } from './types.js';
import { snippet } from './evidence.js';

/**
 * Canonical Owner and Forwarding Detector.
 */

const AUTHORITY_PHRASES = [
  /canonical\s+(?:source\s+of\s+truth|instruction|guidance)/i,
  /authoritative\s+(?:source|instruction|guidance)/i,
  /primary\s+(?:source\s+of\s+truth|instruction|guidance)/i,
  /source\s+of\s+truth\s+for\s+all\s+agents/i,
  /master\s+instruction\s+file/i,
];

export function detectCanonicalOwner(files: InstructionFile[]): PromptCiIssue[] {
  if (files.length === 0) return [];

  const issues: PromptCiIssue[] = [];
  const filesWithAuthority: InstructionFile[] = [];

  for (const file of files) {
    if (AUTHORITY_PHRASES.some((re) => re.test(file.content))) {
      filesWithAuthority.push(file);
    }
  }

  function issueId(name: string): string {
    const hash = crypto.createHash('sha1').update(name).digest('hex').slice(0, 12);
    return `canonical-${name}-${hash}`;
  }

  if (filesWithAuthority.length > 1) {
    issues.push({
      id: issueId('ambiguous-authority'),
      severity: 'warning',
      category: 'structure',
      title: 'Ambiguous authority: multiple files claim to be canonical',
      summary:
        `Multiple files (${filesWithAuthority.map((f) => path.basename(f.path)).join(', ')}) ` +
        `claim to be the "canonical" or "authoritative" source of truth. ` +
        `This leads to confusion about which instructions take precedence.`,
      filePaths: filesWithAuthority.map((f) => f.path),
      locations: filesWithAuthority.map((f) => ({ filePath: f.path })),
      // CO1: extract evidence from the SAME whole-content match the gate
      // used, instead of re-scanning line-by-line. The gate tests against
      // `\s`-containing patterns (e.g. "canonical\s+source of truth"), and
      // `\s` matches newlines — so a phrase wrapped across two lines
      // ("canonical\nsource of truth") passes the gate but no SINGLE line
      // contains the whole phrase, so `lines.find(...)` returned `undefined`
      // and evidence literally rendered the string "undefined".
      evidence: filesWithAuthority.map((f) => {
        let matchText: string | undefined;
        for (const re of AUTHORITY_PHRASES) {
          const m = re.exec(f.content);
          if (m) {
            matchText = m[0];
            break;
          }
        }
        // Authority phrases are short fixed strings — well under the shared
        // snippet's default clip — so this only collapses whitespace + trims.
        return `${path.basename(f.path)}: "${snippet(matchText ?? '')}"`;
      }),
      recommendation:
        'Designate ONE file (usually AGENTS.md) as the canonical source. ' +
        'Other files should use forwarding pointers and only contain tool-specific reminders.',
      confidence: 0.9,
    });
  }

  const agentsFile = files.find((f) => path.basename(f.path).toLowerCase() === 'agents.md');
  const primaryCanonical = agentsFile || filesWithAuthority[0];

  if (primaryCanonical) {
    const getSectionBody = (text: string): string => {
      const lines = text.split('\n');
      if (lines.length > 0 && lines[0]!.trim().startsWith('#')) {
        return lines.slice(1).join('\n').trim();
      }
      return text.trim();
    };

    for (const file of files) {
      if (file === primaryCanonical) continue;
      
      // BUG-006: classify by the scanner-computed fileType (derived from the
      // repo-RELATIVE path) plus the location-independent basename — never by a
      // directory substring of the ABSOLUTE path. Matching `/.claude/` against
      // the absolute path let the checkout location leak in, so a repo checked
      // out under a Claude Code worktree (`.../.claude/worktrees/<branch>/`)
      // treated every file as tool-specific. deriveFileType already maps the
      // in-repo `.claude/`, `.cursor/rules/`, and `.github/instructions/`
      // directories, so fileType is the authoritative signal.
      const baseName = path.basename(file.path).toLowerCase();
      const isToolSpecific =
        file.fileType === 'claude' ||
        file.fileType === 'cursor' ||
        file.fileType === 'windsurf' ||
        file.fileType === 'copilot' ||
        baseName === 'claude.md' ||
        baseName === '.cursorrules' ||
        baseName === '.windsurfrules';

      if (!isToolSpecific) continue;

      if (file.lineCount > 50) {
        for (const section of file.sections) {
          if (section.endLine - section.startLine > 50) {
            const isDuplicate = primaryCanonical.sections.some(
              (s) => {
                const sBody = getSectionBody(s.text).toLowerCase().replace(/\s+/g, ' ').trim();
                const sectBody = getSectionBody(section.text).toLowerCase().replace(/\s+/g, ' ').trim();
                return (
                  sBody === sectBody ||
                  (sBody.length > 500 && sBody.slice(0, 500) === sectBody.slice(0, 500))
                );
              }
            );

            if (isDuplicate) {
              // CO2 / B1: agent-practices.ts independently derives an id from
              // the exact same `behavior-duplication:${filePath}` hash input
              // for a conceptually similar finding — the two detectors
              // collide on id for the same file. Namespaced per-detector
              // (mirroring the fix on the agent-practices.ts side) so ids
              // stay distinct even for the same file path; the public id
              // PREFIX is unchanged.
              const hash = crypto.createHash('sha1').update(`canonical-owner:behavior-duplication:${file.path}`).digest('hex').slice(0, 12);
              const canonicalLabel = path.basename(primaryCanonical.path);
              const duplicateTokens = Math.round(section.text.length / 4);
              issues.push({
                id: `behavior-duplication-${hash}`,
                severity: 'info',
                category: 'duplicate',
                title: 'Large duplicated behavior in tool-specific file',
                summary:
                  `The ${baseName} contains a large section (> 50 lines) that appears to be ` +
                  `duplicated from ${canonicalLabel}. This can lead to instruction drift.`,
                filePaths: [file.path, primaryCanonical.path],
                locations: [{ filePath: file.path, startLine: section.startLine, endLine: section.endLine }],
                evidence: [
                  `Section "${section.heading ?? 'Untitled'}" is near-identical to one in ${canonicalLabel}`,
                  `Duplicate size: ~${duplicateTokens} tokens`,
                ],
                recommendation:
                  `Consider moving shared rules to ${canonicalLabel} and using ` +
                  `a forwarding pointer (e.g., "Follow ${canonicalLabel}") to save ~${duplicateTokens} tokens per session.`,
                confidence: 0.8,
              });
              break;
            }
          }
        }
      }
    }
  }

  return issues;
}
