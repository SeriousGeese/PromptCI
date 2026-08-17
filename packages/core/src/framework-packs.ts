import type { RepoContext } from './repo-context.js';
import type { PromptCiIssue } from './types.js';
import { detectNextJs } from './frameworks/nextjs.js';
import { detectPython } from './frameworks/python.js';
import { detectUnity } from './frameworks/unity.js';
import { detectDotnet } from './frameworks/dotnet.js';
import { detectGo } from './frameworks/go.js';
import { detectRust } from './frameworks/rust.js';

/**
 * Framework-specific detectors are aggregated here.
 * This allows for easy extension to new frameworks like Unity, .NET, Go, etc.
 */
export function runFrameworkPacks(context: RepoContext): PromptCiIssue[] {
  const issues: PromptCiIssue[] = [];

  // Run all registered framework detectors
  issues.push(...detectNextJs(context));
  issues.push(...detectPython(context));
  issues.push(...detectUnity(context));
  issues.push(...detectDotnet(context));
  issues.push(...detectGo(context));
  issues.push(...detectRust(context));

  return issues;
}
