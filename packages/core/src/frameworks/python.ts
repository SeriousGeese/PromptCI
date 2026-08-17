import type { RepoContext } from '../repo-context.js';
import type { PromptCiIssue } from '../types.js';
import * as path from 'node:path';
import * as fs from 'node:fs';

export function detectPython(context: RepoContext): PromptCiIssue[] {
  const issues: PromptCiIssue[] = [];
  const { manifests, repoRoot, files } = context;

  const hasPyProject = !!manifests.pyproject;
  const hasRequirements = fs.existsSync(path.join(repoRoot, 'requirements.txt'));
  const hasPipfile = fs.existsSync(path.join(repoRoot, 'Pipfile'));
  const hasCondaYaml = fs.existsSync(path.join(repoRoot, 'environment.yml'));

  if (!hasPyProject && !hasRequirements && !hasPipfile && !hasCondaYaml) {
    return [];
  }

  // Check for missing pytest guidance if pytest is in deps
  const isPytestInDeps = (manifests.pyproject?.includes('pytest') || 
                          (hasRequirements && fs.readFileSync(path.join(repoRoot, 'requirements.txt'), 'utf-8').includes('pytest')));

  if (isPytestInDeps) {
    const hasPytestGuidance = files.some(file => 
      file.content.toLowerCase().includes('pytest') || 
      file.content.toLowerCase().includes('test guidance')
    );

    if (!hasPytestGuidance) {
      issues.push({
        id: 'python-missing-pytest-guidance',
        severity: 'info',
        category: 'structure',
        title: 'Missing Pytest Guidance',
        summary: 'The project uses pytest, but no testing guidance was found in the instructions.',
        filePaths: files.map(f => f.path),
        locations: [],
        evidence: ['pytest detected in dependencies, but no mention in instructions.'],
        recommendation: 'Add guidance on how to run and write tests using pytest.',
        confidence: 0.8,
      });
    }
  }

  // Check for environment manager mismatch
  // If we have multiple env managers, it might be confusing
  const envManagers = [];
  const envManagerPaths: string[] = [];
  if (hasPipfile) envManagers.push('Pipenv (Pipfile)');
  if (hasPipfile) envManagerPaths.push(path.join(repoRoot, 'Pipfile'));
  if (hasCondaYaml) envManagers.push('Conda (environment.yml)');
  if (hasCondaYaml) envManagerPaths.push(path.join(repoRoot, 'environment.yml'));
  if (hasPyProject && manifests.pyproject?.includes('[tool.poetry]')) envManagers.push('Poetry (pyproject.toml)');
  if (hasPyProject && manifests.pyproject?.includes('[tool.poetry]')) envManagerPaths.push(path.join(repoRoot, 'pyproject.toml'));

  if (envManagers.length > 1) {
    issues.push({
      id: 'python-multiple-env-managers',
      severity: 'warning',
      category: 'conflict',
      title: 'Multiple Python Environment Managers',
      summary: `Multiple environment managers detected: ${envManagers.join(', ')}. This can lead to conflicting instructions.`,
      filePaths: envManagerPaths.length > 0 ? envManagerPaths : files.map(f => f.path),
      locations: [],
      evidence: [`Detected: ${envManagers.join(', ')}`],
      recommendation: 'Decide on a single environment manager and remove the others, or clearly document when to use each.',
      confidence: 0.9,
    });
  }

  return issues;
}
