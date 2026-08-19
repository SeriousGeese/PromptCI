import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { scan, applyFixRecipe, callLlm, isWithinRoot } from '@promptci/core';
import type { PromptCiIssue, FileChange } from '@promptci/core';
import { loadConfig } from '../config.js';

export type FixOptions = {
  scanPath?: string;
  issueId?: string;
  interactive?: boolean;
  dryRun?: boolean;
  llm?: boolean;
  answers?: string[];
};

export async function runFix(options: FixOptions): Promise<void> {
  const rawPath = options.scanPath ?? process.cwd();
  const resolvedPath = path.resolve(rawPath);

  // Validate path
  try {
    const stat = await fs.stat(resolvedPath);
    if (!stat.isDirectory()) {
      console.error(`Error: "${resolvedPath}" is not a directory.`);
      process.exit(1);
    }
  } catch {
    console.error(`Error: path does not exist: "${resolvedPath}"`);
    process.exit(1);
  }

  // Load config
  let config;
  try {
    config = await loadConfig(resolvedPath);
  } catch (err) {
    console.error(`Error loading config: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Run initial scan
  if (!options.dryRun) {
    console.log('Scanning repository to identify issues...');
  }
  const report = await scan({
    repoPath: resolvedPath,
    projectType: config.projectType,
    include: config.include,
    exclude: config.exclude,
    vagueGuidanceSeverity: config.vagueGuidanceSeverity,
  });

  let targetIssues: PromptCiIssue[];

  if (options.llm) {
    if (!options.issueId) {
      console.error('Error: Please specify the issue to resolve using --issue <issue-id> when using --llm.');
      process.exit(1);
    }
    const target = report.issues.find(issue => issue.id === options.issueId);
    if (!target) {
      console.error(`Error: No issue found with ID "${options.issueId}".`);
      process.exit(1);
    }
    if (target.category !== 'vague_guidance' && target.category !== 'conflict') {
      console.error('Error: LLM-based fixes are only supported for vague guidance or conflicting instructions.');
      process.exit(1);
    }
    targetIssues = [target];
  } else {
    let repairable = report.issues.filter(issue => isRepairable(issue));
    if (options.issueId) {
      const target = repairable.find(issue => issue.id === options.issueId);
      if (!target) {
        console.error(`Error: No repairable issue found with ID "${options.issueId}".`);
        process.exit(1);
      }
      repairable = [target];
    }
    if (repairable.length === 0) {
      console.log('No repairable issues found.');
      return;
    }
    targetIssues = repairable;
  }

  const isInteractive = options.interactive !== false;
  // Only create readline interface if interactive and no answers array provided
  const rl = isInteractive && !options.answers
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : null;
  let appliedCount = 0;
  let answerIndex = 0;

  try {
    for (const issue of targetIssues) {
      let changes: FileChange[] = [];
      if (options.llm) {
        changes = await runLlmFix(issue, resolvedPath);
      } else {
        changes = await applyFixRecipe(issue, resolvedPath);
      }

      if (changes.length === 0) {
        continue;
      }

      console.log('\n================================================================================');
      console.log(`Issue ID:   ${issue.id}`);
      console.log(`Title:      ${issue.title}`);
      console.log(`Severity:   ${issue.severity.toUpperCase()}`);
      console.log(`Summary:    ${issue.summary}`);
      console.log('--------------------------------------------------------------------------------');

      // Show diff preview for each proposed file change
      for (const change of changes) {
        showDiffPreview(change, resolvedPath);
      }

      if (options.dryRun) {
        console.log(`\n[Dry Run] Simulating fix for issue ${issue.id}. No changes written.`);
        continue;
      }

      let apply = true;
      if (isInteractive) {
        const promptText = options.llm ? '\nApply this LLM patch? (y/N): ' : '\nApply this fix? (y/N): ';
        if (options.answers && answerIndex < options.answers.length) {
          const ans = options.answers[answerIndex]!;
          answerIndex++;
          console.log(`${promptText}${ans}`);
          apply = ans.toLowerCase().trim() === 'y';
        } else if (rl) {
          const answer = await rl.question(promptText);
          apply = answer.toLowerCase().trim() === 'y';
        } else {
          apply = false;
        }
      }

      if (apply) {
        for (const change of changes) {
          // Double-check file path security before writing
          const resolvedFile = path.resolve(resolvedPath, change.filePath);
          if (!isWithinRoot(resolvedPath, resolvedFile)) {
            throw new Error(`Path traversal guard triggered: "${change.filePath}" is outside repo root.`);
          }
          await fs.writeFile(resolvedFile, change.newContent, 'utf-8');
          console.log(`Applied change to ${path.relative(resolvedPath, resolvedFile)}`);
        }
        appliedCount++;
      } else {
        console.log('Skipped.');
      }
    }
  } finally {
    rl?.close();
  }

  // Run rescan if any changes were made
  if (appliedCount > 0 && !options.dryRun) {
    console.log('\nRe-scanning repository...');
    const finalReport = await scan({
      repoPath: resolvedPath,
      projectType: config.projectType,
      include: config.include,
      exclude: config.exclude,
      vagueGuidanceSeverity: config.vagueGuidanceSeverity,
    });
    console.log(`\nFixes complete. Initial score: ${report.healthScore}/100 -> New score: ${finalReport.healthScore}/100`);
  } else if (options.dryRun) {
    console.log('\nDry run complete. No changes were made.');
  } else {
    console.log('\nNo changes applied.');
  }
}

/**
 * Checks if an issue has a deterministic auto-fix recipe.
 */
function isRepairable(issue: PromptCiIssue): boolean {
  if (issue.id === 'security-pack-no-promptci-gitignore') return true;
  if (issue.id === 'security-pack-unignored-dirs') return true;
  if (issue.category === 'duplicate' && issue.locations.length >= 2) return true;

  // BUG-14: stale_instruction findings used to be auto-repairable via a blind
  // year substitution. They are advisory now — `fixRecipe` tells the reader
  // what to edit, but `promptci fix` will not rewrite years on their behalf.
  return false;
}

/**
 * Displays a colorful, clean terminal preview of file changes.
 */
function showDiffPreview(change: FileChange, repoRoot: string) {
  const relPath = path.relative(repoRoot, change.filePath);
  console.log(`File: ${relPath}`);
  
  const origLines = change.originalContent.split(/\r?\n/);
  const newLines = change.newContent.split(/\r?\n/);
  
  if (origLines.length === newLines.length) {
    // Check line-by-line diff (e.g. stale years)
    for (let i = 0; i < origLines.length; i++) {
      if (origLines[i] !== newLines[i]) {
        console.log(`  Line ${i + 1}:`);
        console.log(`\x1b[31m- ${origLines[i]}\x1b[0m`);
        console.log(`\x1b[32m+ ${newLines[i]}\x1b[0m`);
      }
    }
  } else if (newLines.length > origLines.length && change.newContent.startsWith(change.originalContent)) {
    // Append (e.g. gitignore additions)
    const extra = change.newContent.slice(change.originalContent.length);
    const extraLines = extra.split(/\r?\n/).filter(Boolean);
    console.log(`  Append to end of file:`);
    for (const el of extraLines) {
      console.log(`\x1b[32m+ ${el}\x1b[0m`);
    }
  } else {
    // Replacement (e.g. duplicate Markdown section pointers)
    let startDiverge = 0;
    while (startDiverge < origLines.length && startDiverge < newLines.length && origLines[startDiverge] === newLines[startDiverge]) {
      startDiverge++;
    }
    
    let endDivergeOrig = origLines.length - 1;
    let endDivergeNew = newLines.length - 1;
    while (endDivergeOrig >= startDiverge && endDivergeNew >= startDiverge && origLines[endDivergeOrig] === newLines[endDivergeNew]) {
      endDivergeOrig--;
      endDivergeNew--;
    }
    
    console.log(`  Replacement in lines ${startDiverge + 1} to ${endDivergeOrig + 1}:`);
    for (let i = startDiverge; i <= endDivergeOrig; i++) {
      if (origLines[i] !== undefined) {
        console.log(`\x1b[31m- ${origLines[i]}\x1b[0m`);
      }
    }
    for (let i = startDiverge; i <= endDivergeNew; i++) {
      if (newLines[i] !== undefined) {
        console.log(`\x1b[32m+ ${newLines[i]}\x1b[0m`);
      }
    }
  }
}

async function runLlmFix(issue: PromptCiIssue, resolvedPath: string): Promise<FileChange[]> {
  const changes: FileChange[] = [];
  
  console.warn(
    'Warning: PromptCI is sending the target instruction file section and issue description to the LLM to generate a safe fix. No other project codebase files are sent.\n'
  );

  let locationContextsString = '';
  const extractedSections: Array<{
    filePath: string;
    startLine: number;
    endLine: number;
    contextText: string;
  }> = [];

  for (let i = 0; i < issue.locations.length; i++) {
    const loc = issue.locations[i];
    if (!loc.startLine || !loc.endLine) continue;
    
    const { contextText, sectionStartLine, sectionEndLine } = await extractLocationContext(
      resolvedPath,
      loc.filePath,
      loc.startLine,
      loc.endLine
    );

    extractedSections.push({
      filePath: loc.filePath,
      startLine: sectionStartLine,
      endLine: sectionEndLine,
      contextText,
    });

    locationContextsString += `\nTarget File Section ${i + 1} (lines ${sectionStartLine}-${sectionEndLine} of ${loc.filePath}):\n\`\`\`markdown\n${contextText}\n\`\`\`\n`;
  }

  if (extractedSections.length === 0) {
    console.error('Error: No issue location line information available to perform LLM repair.');
    return [];
  }

  const systemPrompt =
    'You are PromptCI, an expert AI instruction file repair tool. Rewrite the vague or conflicting section(s) of the AI instruction file(s) to resolve the specific issue, while retaining all safety constraints and rules.\n' +
    'You must output a JSON object in this format:\n' +
    '{\n' +
    '  "changes": [\n' +
    '    {\n' +
    '      "filePath": "relative/path/to/file.md",\n' +
    '      "newSection": "the rewritten section text"\n' +
    '    }\n' +
    '  ]\n' +
    '}';

  const userPrompt =
    `Issue to resolve:\n` +
    `Category: ${issue.category}\n` +
    `Title: ${issue.title}\n` +
    `Summary: ${issue.summary}\n\n` +
    `Context Section(s):\n${locationContextsString}\n` +
    `Please rewrite each section to resolve the issue while keeping all other rules intact. Return the JSON object containing the replacement patch.`;

  const llmOutput = await callLlm(systemPrompt, userPrompt, true);
  
  let resultJson;
  try {
    resultJson = JSON.parse(llmOutput.trim());
  } catch {
    const match = llmOutput.match(/\{[\s\S]*\}/);
    if (match) {
      resultJson = JSON.parse(match[0]);
    } else {
      throw new Error('LLM output was not valid JSON.');
    }
  }

  if (!resultJson.changes || !Array.isArray(resultJson.changes)) {
    throw new Error('LLM output JSON structure is missing "changes" array.');
  }

  for (const change of resultJson.changes) {
    if (typeof change.filePath !== 'string' || typeof change.newSection !== 'string') {
      throw new Error('Invalid changes structure in LLM output JSON.');
    }

    const isInstruction = isInstructionFile(change.filePath);
    if (!isInstruction) {
      throw new Error(`Safety Guard: Editing non-instruction file "${change.filePath}" is blocked.`);
    }

    const targetFileResolved = path.resolve(resolvedPath, change.filePath);
    if (!isWithinRoot(resolvedPath, targetFileResolved)) {
      throw new Error(`Path traversal guard triggered: "${change.filePath}" is outside repo root.`);
    }

    const normTarget = targetFileResolved.replace(/\\/g, '/').toLowerCase();
    const ext = extractedSections.find(s => {
      const normExt = path.resolve(resolvedPath, s.filePath).replace(/\\/g, '/').toLowerCase();
      return normExt === normTarget;
    });
    if (!ext) {
      throw new Error(`LLM returned change for file "${change.filePath}" which was not scanned.`);
    }

    const fileContent = await fs.readFile(targetFileResolved, 'utf-8');
    const fileLines = fileContent.split(/\r?\n/);
    const newFileLines = [
      ...fileLines.slice(0, ext.startLine - 1),
      change.newSection,
      ...fileLines.slice(ext.endLine)
    ];
    const newContent = newFileLines.join('\n');

    changes.push({
      filePath: change.filePath,
      originalContent: fileContent,
      newContent,
    });
  }

  return changes;
}

async function extractLocationContext(
  resolvedPath: string,
  filePath: string,
  startLine: number,
  endLine: number
): Promise<{ contextText: string; sectionStartLine: number; sectionEndLine: number }> {
  const absolutePath = path.resolve(resolvedPath, filePath);
  const content = await fs.readFile(absolutePath, 'utf-8');
  const lines = content.split(/\r?\n/);

  let headingStart = 1;
  for (let i = startLine - 1; i >= 0; i--) {
    if (lines[i].trim().startsWith('#')) {
      headingStart = i + 1;
      break;
    }
  }

  let headingEnd = lines.length;
  for (let i = endLine; i < lines.length; i++) {
    if (lines[i].trim().startsWith('#')) {
      headingEnd = i;
      break;
    }
  }

  const contextText = lines.slice(headingStart - 1, headingEnd).join('\n');
  return {
    contextText,
    sectionStartLine: headingStart,
    sectionEndLine: headingEnd,
  };
}

function isInstructionFile(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, '/').toLowerCase();
  const base = path.basename(norm);
  return norm.endsWith('.md') || base === '.cursorrules' || base === '.windsurfrules';
}
