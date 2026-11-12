import type { RepoContext } from '../repo-context.js';
import type { PromptCiIssue } from '../types.js';
import { treeFor } from '../repo-tree.js';

export function detectNextJs(context: RepoContext): PromptCiIssue[] {
  const issues: PromptCiIssue[] = [];
  const { packageJson, files } = context;

  const hasNextDep = !!(packageJson.dependencies['next'] || packageJson.devDependencies['next']);
  // pcic-e6xa: see the note in frameworks/go.ts.
  const tree = treeFor(context);
  const hasNextConfig = ['', 'apps/web/'].some((prefix) =>
    ['js', 'mjs', 'ts'].some((ext) => tree.isFile(`${prefix}next.config.${ext}`)));

  if (!hasNextDep && !hasNextConfig) {
    return [];
  }

  const routerDir = (name: string): boolean =>
    ['', 'src/', 'apps/web/', 'apps/web/src/'].some((prefix) => tree.isDir(`${prefix}${name}`));
  const hasAppDir = routerDir('app');
  const hasPagesDir = routerDir('pages');

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
