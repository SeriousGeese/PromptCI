import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { scan, callLlm } from '@promptci/core';
import { loadConfig } from '../config.js';

export type ExplainOptions = {
  scanPath?: string;
};

export async function runExplain(options: ExplainOptions): Promise<void> {
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

  // Run scan
  const report = await scan({
    repoPath: resolvedPath,
    projectType: config.projectType,
    include: config.include,
    exclude: config.exclude,
  });

  if (report.issues.length === 0) {
    console.log('No issues found. Your instruction files are clean!');
    return;
  }

  // Formulate category counts
  const categoryCounts: Record<string, number> = {};
  for (const issue of report.issues) {
    categoryCounts[issue.category] = (categoryCounts[issue.category] || 0) + 1;
  }

  // Warn about what data is being sent
  console.warn(
    'Warning: PromptCI is sending scan results metadata (issue categories, counts, file sizes) to the LLM. No source code or instruction file contents are sent.\n'
  );

  const systemPrompt =
    'You are PromptCI, an AI assistant analyzing instruction-health scan reports. ' +
    'Write a concise, prioritized human-readable cleanup plan (3-5 items) with actionable advice for the developer based on the scan results. ' +
    'Focus on the most important issues and make your suggestions brief.';

  const filesSummary = report.filesScanned
    .map(f => `- ${path.relative(resolvedPath, f.path)} (${f.charCount} characters)`)
    .join('\n');

  const issuesSummary = report.issues
    .map(i => {
      const relPaths = i.filePaths.map(p => path.relative(resolvedPath, p)).join(', ');
      return `- [${i.severity.toUpperCase()}] ${i.title} (${relPaths}): ${i.summary}`;
    })
    .join('\n');

  const userPrompt =
    `Scan Results:\n` +
    `Total Health Score: ${report.healthScore}/100\n\n` +
    `Category Counts:\n${JSON.stringify(categoryCounts, null, 2)}\n\n` +
    `Scanned Files:\n${filesSummary}\n\n` +
    `Issues Identified:\n${issuesSummary}`;

  try {
    const plan = await callLlm(systemPrompt, userPrompt);
    console.log('PromptCI LLM Cleanup Roadmap:');
    console.log('--------------------------------------------------');
    console.log(plan.trim());
  } catch (err) {
    console.error(`Error generating LLM explanation: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
