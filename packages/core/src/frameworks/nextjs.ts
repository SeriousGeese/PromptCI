import type { RepoContext } from '../repo-context.js';
import type { PromptCiIssue } from '../types.js';
import * as path from 'node:path';
import * as fs from 'node:fs';

export function detectNextJs(context: RepoContext): PromptCiIssue[] {
  const issues: PromptCiIssue[] = [];
  const { packageJson, repoRoot, files } = context;

  const hasNextDep = !!(packageJson.dependencies['next'] || packageJson.devDependencies['next']);
  const hasNextConfig = fs.existsSync(path.join(repoRoot, 'next.config.js')) || 
                        fs.existsSync(path.join(repoRoot, 'next.config.mjs')) ||
                        fs.existsSync(path.join(repoRoot, 'next.config.ts')) ||
                        fs.existsSync(path.join(repoRoot, 'apps', 'web', 'next.config.js')) ||
                        fs.existsSync(path.join(repoRoot, 'apps', 'web', 'next.config.mjs')) ||
                        fs.existsSync(path.join(repoRoot, 'apps', 'web', 'next.config.ts'));

  if (!hasNextDep && !hasNextConfig) {
    return [];
  }

  const hasAppDir =
    fs.existsSync(path.join(repoRoot, 'app')) ||
    fs.existsSync(path.join(repoRoot, 'src', 'app')) ||
    fs.existsSync(path.join(repoRoot, 'apps', 'web', 'app')) ||
    fs.existsSync(path.join(repoRoot, 'apps', 'web', 'src', 'app'));
  const hasPagesDir =
    fs.existsSync(path.join(repoRoot, 'pages')) ||
    fs.existsSync(path.join(repoRoot, 'src', 'pages')) ||
    fs.existsSync(path.join(repoRoot, 'apps', 'web', 'pages')) ||
    fs.existsSync(path.join(repoRoot, 'apps', 'web', 'src', 'pages'));

  // Check for missing App Router guidance
  if (hasAppDir) {
    const hasAppRouterGuidance = files.some(file => 
      file.content.toLowerCase().includes('app router') || 
      file.content.toLowerCase().includes('server component') ||
      file.content.toLowerCase().includes('client component')
    );

    if (!hasAppRouterGuidance) {
      issues.push({
        id: 'nextjs-missing-app-router-guidance',
        severity: 'warning',
        category: 'structure',
        title: 'Missing Next.js App Router Guidance',
        summary: 'The project uses the App Router, but the instructions do not mention App Router specific rules like Server vs Client components.',
        filePaths: files.map(f => f.path),
        locations: [],
        evidence: ['App directory detected, but no "App Router" or "Server/Client Component" mention in instructions.'],
        recommendation: 'Add guidance for Next.js App Router, specifically regarding Server and Client Component usage.',
        confidence: 0.9,
      });
    }
  }

  // Check for stale Pages Router references in App Router only project
  if (hasAppDir && !hasPagesDir) {
    const pagesRouterFiles = files.filter(file => 
      file.content.toLowerCase().includes('pages router') || 
      file.content.toLowerCase().includes('getstaticprops') ||
      file.content.toLowerCase().includes('getserversideprops')
    );

    if (pagesRouterFiles.length > 0) {
      issues.push({
        id: 'nextjs-stale-pages-router-guidance',
        severity: 'warning',
        category: 'stale_instruction',
        title: 'Stale Pages Router Guidance',
        summary: 'The project uses the App Router exclusively, but instructions still reference Pages Router concepts like getStaticProps.',
        filePaths: pagesRouterFiles.map(f => f.path),
        locations: pagesRouterFiles.map(f => ({ filePath: f.path })),
        evidence: ['Pages Router specific terms found in an App Router project.'],
        recommendation: 'Remove or update Pages Router specific instructions to align with App Router.',
        confidence: 0.8,
      });
    }
  }

  return issues;
}
