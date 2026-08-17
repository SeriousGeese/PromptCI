import type { RepoContext } from './repo-context.js';
import type { PromptCiIssue } from './types.js';
import { matchEvidence } from './evidence.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';

/**
 * B4: id was keyed by `${file.fileType}` — two files sharing a fileType (e.g.
 * CLAUDE.md and .claude/notes.md, both 'claude') collided on the same id.
 */
function expensivePatternIssueId(expName: string, filePath: string): string {
  const hash = crypto.createHash('sha1').update(`mcp-tooling-expensive:${expName}:${filePath}`).digest('hex').slice(0, 12);
  return `mcp-tooling-expensive-${expName.replace(/\s+/g, '-')}-${hash}`;
}

const EXPENSIVE_PATTERNS = [
  {
    pattern: /\bread\s+all\s+(?:docs|documentation)\b/i,
    name: 'read all docs',
    signal: 'docs',
    title: 'Instructions command reading all documentation at once',
    recommendation: 'Recommend using ripgrep (rg) to find relevant docs or linking to docs and asking the agent to open only relevant sections on-demand.',
    fixRecipe: 'Use local search tools (like rg) to find relevant documentation instead of loading all docs at once.'
  },
  {
    pattern: /\bload\s+the\s+entire\s+codebase\b/i,
    name: 'load the entire codebase',
    signal: 'any',
    title: 'Instructions command loading the entire codebase',
    recommendation: 'Recommend using search tools (like rg) or file listing tools instead of reading the entire codebase into context.',
    fixRecipe: 'Do not read all files in the codebase. Use ripgrep or file search to locate files of interest.'
  },
  {
    pattern: /\balways\s+include\s+all\s+(?:db\s+)?schema\b/i,
    name: 'always include all schema files',
    signal: 'database',
    title: 'Instructions command loading all database schemas',
    recommendation: 'Recommend querying database schemas via a database MCP server or searching for specific schema definitions on-demand.',
    fixRecipe: 'Do not load entire database schemas. Query the specific table structures using local search or schema files on-demand.'
  },
  {
    pattern: /\bpaste\s+the\s+full\s+logs\b/i,
    name: 'paste the full logs',
    signal: 'any',
    title: 'Instructions command pasting full logs',
    recommendation: 'Recommend summarizing logs or sharing only key error traces instead of pasting complete logs.',
    fixRecipe: 'Summarize command failures and paste only the relevant error lines rather than full logs.'
  },
  {
    pattern: /\bread\s+every\s+file\b/i,
    name: 'read every file',
    signal: 'any',
    title: 'Instructions command reading every source file',
    recommendation: 'Recommend using search tools or targeted file reading tools to find relevant code sections.',
    fixRecipe: 'Use ripgrep to find target code instead of reading every file.'
  }
];

export function detectMcpTooling(context: RepoContext): PromptCiIssue[] {
  const issues: PromptCiIssue[] = [];
  const { repoRoot, files } = context;

  if (files.length === 0) {
    return [];
  }

  const hasDocsDir = fs.existsSync(path.join(repoRoot, 'docs')) || fs.existsSync(path.join(repoRoot, 'doc'));
  const deps = {
    ...context.packageJson.dependencies,
    ...context.packageJson.devDependencies,
  };
  const hasSupabaseDependency = Object.keys(deps).some((name) => name.startsWith('@supabase/'));
  const hasScannedSupabasePackage = context.files.some(
    (f) => f.path.endsWith('package.json') && f.content.includes('@supabase/supabase-js'),
  );
  const hasDbDir = fs.existsSync(path.join(repoRoot, 'supabase')) ||
                    fs.existsSync(path.join(repoRoot, 'prisma')) ||
                    fs.existsSync(path.join(repoRoot, 'db')) ||
                    hasSupabaseDependency ||
                    hasScannedSupabasePackage;

  const hasMonorepo = fs.existsSync(path.join(repoRoot, 'packages')) || 
                      fs.existsSync(path.join(repoRoot, 'apps')) || 
                      fs.existsSync(path.join(repoRoot, 'pnpm-workspace.yaml'));

  const hasMcpConfig = fs.existsSync(path.join(repoRoot, 'mcp-config.json')) ||
                       fs.existsSync(path.join(repoRoot, '.cursor', 'mcp.json')) ||
                       fs.existsSync(path.join(repoRoot, '.claudegpt', 'mcp.json'));

  const hasSchemas = fs.existsSync(path.join(repoRoot, 'schema.graphql')) ||
                     fs.existsSync(path.join(repoRoot, 'openapi.json')) ||
                     fs.existsSync(path.join(repoRoot, 'swagger.json')) ||
                     context.files.some(f => f.path.endsWith('schema.prisma'));

  for (const file of files) {
    const fileName = path.basename(file.path);
    for (const exp of EXPENSIVE_PATTERNS) {
      if (exp.pattern.test(file.content)) {
        if (exp.signal === 'docs' && !hasDocsDir) continue;
        if (exp.signal === 'database' && !hasDbDir) continue;

        let recommendation = exp.recommendation;
        let fixRecipe = exp.fixRecipe;

        // Customise based on filesystem signals
        if (exp.name === 'load the entire codebase' || exp.name === 'read every file') {
          if (hasMonorepo) {
            recommendation = 'This monorepo has multiple packages/apps. Reading or loading the entire codebase is extremely expensive. Recommend using file search (like rg), file listing tools, or a workspace MCP server instead.';
            fixRecipe = 'Do not read all files in the codebase. Use ripgrep (rg) or a directory listing MCP to search for relevant files.';
          } else if (hasMcpConfig) {
            recommendation = 'Recommend using your configured MCP server tools (like filesystem search) instead of instructing the agent to load or read the entire codebase.';
            fixRecipe = 'Use filesystem search or MCP tools to read files of interest instead of loading the entire codebase.';
          }
        } else if (exp.name === 'always include all schema files') {
          if (hasMcpConfig) {
            recommendation = 'Recommend querying database schemas via your configured database MCP server instead of pasting or loading schema files on-demand.';
            fixRecipe = 'Do not load entire database schemas. Query the specific table structures using your database MCP server tools.';
          } else if (hasSchemas) {
            recommendation = 'Recommend querying specific schema definitions or APIs on-demand instead of loading all schema files at once.';
            fixRecipe = 'Do not load entire schema files. Use local search or file reads to view only the relevant schema files on-demand.';
          }
        }

        issues.push({
          id: expensivePatternIssueId(exp.name, file.path),
          severity: 'warning',
          category: 'context_bloat',
          title: exp.title,
          summary: `The instruction file "${fileName}" commands the agent to "${exp.name}". This encourages expensive broad context loading instead of using targeted search or MCP tools.`,
          filePaths: [file.path],
          locations: [],
          // BUG-20: quote the offending instruction text, not the regex source.
          evidence: [matchEvidence(file.content, exp.pattern, `Instruction to "${exp.name}"`)],
          recommendation,
          fixRecipe,
          confidence: 0.8,
        });
      }
    }
  }

  return issues;
}
