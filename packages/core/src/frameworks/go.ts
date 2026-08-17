import type { RepoContext } from '../repo-context.js';
import type { PromptCiIssue } from '../types.js';
import * as path from 'node:path';
import * as fs from 'node:fs';

export function detectGo(context: RepoContext): PromptCiIssue[] {
  const issues: PromptCiIssue[] = [];
  const { repoRoot, files } = context;

  const hasGoMod = fs.existsSync(path.join(repoRoot, 'go.mod'));
  const combinedContent = files.map(f => f.content).join('\n');
  // FW1: "go" is an ordinary English verb ("let's go build something"), so a
  // bare `\bgo\s+(build|test|run|get|mod)\b` match enabled the whole Go pack
  // (and its "Missing Go Testing Commands" warning) in non-Go repos with no
  // go.mod at all. "go.mod" (the literal filename) is unambiguous and safe
  // to match anywhere in prose; the command-verb form only counts as a real
  // signal when it appears in a command context (backtick-quoted).
  const hasGoMentions =
    /\bgo\.mod\b/i.test(combinedContent) ||
    /`[^`\n]*\bgo\s+(?:build|test|run|get|mod)\b[^`\n]*`/i.test(combinedContent);

  if (!hasGoMod && !hasGoMentions) {
    return [];
  }

  const allFilePaths = files.map(f => f.path);

  // 1. Missing go test command in validation instructions
  const hasGoTest = /\bgo\s+test\b/i.test(combinedContent);
  if (!hasGoTest) {
    issues.push({
      id: 'go-missing-testing-commands',
      severity: 'warning',
      category: 'structure',
      title: 'Missing Go Testing Commands',
      summary: 'Go project detected, but instructions do not mention Go testing commands like "go test ./...".',
      filePaths: allFilePaths,
      locations: [],
      evidence: ['Go detected, but no "go test" command found in instructions.'],
      recommendation: 'Add instructions telling the agent to run "go test ./..." to verify changes.',
      fixRecipe: 'Before saying work is complete, run go test ./... to verify all tests pass.',
      confidence: 0.85,
    });
  }

  return issues;
}
