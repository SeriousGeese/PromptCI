import type { RepoContext } from '../repo-context.js';
import type { PromptCiIssue } from '../types.js';
import * as path from 'node:path';
import * as fs from 'node:fs';

export function detectDotnet(context: RepoContext): PromptCiIssue[] {
  const issues: PromptCiIssue[] = [];
  const { repoRoot, files } = context;

  // Detect if dotnet project
  let hasDotnet = context.projectType === 'dotnet';
  if (!hasDotnet) {
    try {
      hasDotnet = fs.readdirSync(repoRoot).some(f => f.endsWith('.sln') || f.endsWith('.csproj'));
    } catch {
      // ignore
    }
  }

  const combinedContent = files.map(f => f.content).join('\n');
  const hasDotnetMentions = /\bdotnet\b|\.sln\b|\.csproj\b|\bxunit\b|\bnunit\b|\bmstest\b/i.test(combinedContent);

  if (!hasDotnet && !hasDotnetMentions) {
    return [];
  }

  const allFilePaths = files.map(f => f.path);

  // 1. Missing dotnet build/test validation commands
  const hasDotnetCommands = /dotnet\s+(build|test|restore|run)/i.test(combinedContent);
  if (!hasDotnetCommands) {
    issues.push({
      id: 'dotnet-missing-validation-commands',
      severity: 'warning',
      category: 'structure',
      title: 'Missing .NET Validation Commands',
      summary: 'The project uses .NET, but instructions do not mention dotnet validation commands like "dotnet build" or "dotnet test".',
      filePaths: allFilePaths,
      locations: [],
      evidence: ['.NET detected, but no dotnet build/test commands found in instructions.'],
      recommendation: 'Add instructions telling the agent to run "dotnet build" and "dotnet test" to verify changes.',
      fixRecipe: 'Before saying work is complete, run dotnet build && dotnet test to verify changes.',
      confidence: 0.85,
    });
  }

  // 2. Framework target mismatch against project files
  // Let's find any csproj at the root to check target framework
  let targetFramework: string | undefined;
  try {
    const rootFiles = fs.readdirSync(repoRoot);
    const csprojFile = rootFiles.find(f => f.endsWith('.csproj'));
    if (csprojFile) {
      const csprojContent = fs.readFileSync(path.join(repoRoot, csprojFile), 'utf-8');
      const match = /<TargetFramework>(.*?)<\/TargetFramework>/.exec(csprojContent);
      if (match) {
        targetFramework = match[1]?.trim();
      }
    }
  } catch {
    // ignore
  }

  if (targetFramework) {
    const isObsoleteMention = /\b(netcoreapp\d+\.\d+|net5\.0|netcore)\b/i.test(combinedContent);
    const isModernProject = /^net(?:[6-9]|[1-9]\d+)\.0/.test(targetFramework);
    if (isModernProject && isObsoleteMention) {
      issues.push({
        id: 'dotnet-obsolete-framework-reference',
        severity: 'warning',
        category: 'stale_instruction',
        title: '.NET Obsolete Framework Reference',
        summary: `The project targets modern .NET (${targetFramework}), but instructions still reference obsolete versions like .NET Core 3.1 or .NET 5.0.`,
        filePaths: allFilePaths,
        locations: [],
        evidence: [`Project targets ${targetFramework}; obsolete framework references found in instructions.`],
        recommendation: `Update instructions to reference the current target framework version (${targetFramework}).`,
        fixRecipe: `Target .NET ${targetFramework} as the framework for this project. Do not use legacy .NET Core 3.1 or .NET 5.0 APIs.`,
        confidence: 0.8,
      });
    }
  }

  return issues;
}
