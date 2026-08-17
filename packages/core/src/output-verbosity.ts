import type { InstructionFile, PromptCiIssue } from './types.js';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

/**
 * B4: id was keyed by `${file.fileType}` — two files sharing a fileType (e.g.
 * CLAUDE.md and .claude/notes.md, both 'claude') collided on the same id.
 */
function verbosityEncouragedIssueId(filePath: string): string {
  const hash = crypto.createHash('sha1').update(`cost-verbosity-encouraged:${filePath}`).digest('hex').slice(0, 12);
  return `cost-verbosity-encouraged-${hash}`;
}

const VERBOSITY_ENCOURAGED_PATTERNS = [
  /explain\s+everything\s+in\s+detail/i,
  /explain\s+in\s+detail/i,
  /always\s+include\s+full\s+command\s+output/i,
  /provide\s+exhaustive\s+summaries/i,
  /print\s+the\s+entire\s+report/i,
  /include\s+all\s+logs/i,
  /\b(?:provide|include|write|give)\s+(?:a\s+)?detailed\s+explanation\b/i,
];

const CONCISENESS_PATTERNS = [
  /summarize\s+command/i,
  /do\s+not\s+paste\s+(?:full\s+)?logs/i,
  /keep\s+final\s+answers\s+concise/i,
  /be\s+concise/i,
  /brief\s+summary/i,
  /only\s+key\s+failures/i,
  /use\s+links\s+to\s+generated\s+artifacts/i,
];

export function detectOutputVerbosity(files: InstructionFile[]): PromptCiIssue[] {
  const issues: PromptCiIssue[] = [];

  const targetFiles = files.filter((f) =>
    ['claude', 'agents', 'cursor', 'windsurf', 'copilot', 'prompt'].includes(f.fileType)
  );

  if (targetFiles.length === 0) {
    return [];
  }

  const combinedContent = targetFiles.map((f) => f.content).join('\n');

  // 1. Check for verbosity encouraged (e.g. demanding full logs, verbose explanations)
  for (const file of targetFiles) {
    const fileName = path.basename(file.path);
    const lines = file.content.split(/\r?\n/);

    for (const line of lines) {
      const matchesVerbosity = VERBOSITY_ENCOURAGED_PATTERNS.some((pat) => pat.test(line));
      if (matchesVerbosity) {
        // Exclude conditional debugging rules (e.g., "include logs when failing")
        const isConditional = /fail|error|debug|crash|when\s+failing/i.test(line);
        if (!isConditional) {
          issues.push({
            id: verbosityEncouragedIssueId(file.path),
            severity: 'warning',
            category: 'agent_practices',
            title: 'Verbose output behavior encouraged',
            summary: `The instruction file "${fileName}" encourages the agent to produce overly verbose outputs or print excessive logs, increasing output-token costs.`,
            filePaths: [file.path],
            locations: [],
            evidence: [`Matched verbose instruction line: "${line.trim()}"`],
            recommendation: 'Encourage concise status updates and final answers to reduce output token cost. Summarize logs and command results instead of pasting them in full.',
            fixRecipe: 'Replace verbosity demands with instructions like: "Be concise and summarize results, linking to files instead of printing them in full."',
            confidence: 0.85,
          });
          break; // one issue per file is enough
        }
      }
    }
  }

  // 2. Check for missing conciseness guidelines
  const hasConcisenessGuidelines = CONCISENESS_PATTERNS.some((pat) => pat.test(combinedContent));
  if (!hasConcisenessGuidelines) {
    issues.push({
      id: 'cost-missing-verbosity-discipline',
      severity: 'info',
      category: 'agent_practices',
      title: 'Missing output verbosity discipline',
      summary: 'No conciseness or verbosity discipline guidelines found in instruction files. Verbose agents write redundant code dumps and explanations, bloating output tokens.',
      filePaths: targetFiles.map((f) => f.path),
      locations: [],
      evidence: ['No guidelines found encouraging conciseness, log summarization, or artifact linking.'],
      recommendation: 'Add guidance to keep answers concise, summarize command output, and link to files instead of pasting large content.',
      fixRecipe: 'Add a section: "Summarize command results. Do not paste full logs unless requested. Keep final answers concise."',
      confidence: 0.8,
    });
  }

  return issues;
}
