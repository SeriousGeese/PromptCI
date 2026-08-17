import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { scan, filterNewIssues, createBaseline } from '@promptci/core';
import type { PromptCiIssue, ProjectType } from '@promptci/core';
import { loadConfig } from '../config.js';

export type ReviewDiffOptions = {
  baseBranch: string;
  scanPath?: string;
  json: boolean;
  failOnRegression: boolean;
};

/**
 * Checks if a file path is relevant to the scanner configuration and detectors.
 */
function isScannerFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  
  const parts = normalized.split('/');
  const ignoredDirs = ['.git', 'node_modules', 'dist', 'build', 'temp', 'tmp', 'bin', 'obj', 'library'];
  if (parts.some(p => ignoredDirs.includes(p))) {
    return false;
  }

  if (normalized.endsWith('.md')) {
    return true;
  }

  const exactFiles = [
    '.cursorrules',
    '.windsurfrules',
    'package.json',
    'pyproject.toml',
    '.gitignore',
    'tsconfig.json',
  ];
  if (normalized.endsWith('.promptci/config.json') || normalized === '.promptci/config.json') {
    return true;
  }

  const baseName = path.basename(normalized);
  if (exactFiles.includes(baseName)) {
    return true;
  }

  if (normalized.startsWith('.github/workflows/')) {
    return normalized.endsWith('.yml') || normalized.endsWith('.yaml');
  }

  if (normalized.startsWith('supabase/migrations/')) {
    return true;
  }

  if (normalized.endsWith('.sln') || normalized.endsWith('.csproj')) {
    return true;
  }

  if (normalized === 'assets/projectsettings/projectversion.txt') {
    return true;
  }

  return false;
}

export async function runReviewDiff(options: ReviewDiffOptions): Promise<void> {
  const rawPath = options.scanPath ?? process.cwd();
  const resolvedPath = path.resolve(rawPath);

  // 1. Verify Git Repository
  try {
    const isGit = execSync('git rev-parse --is-inside-work-tree', {
      cwd: resolvedPath,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    if (isGit !== 'true') {
      throw new Error();
    }
  } catch {
    console.error(`Error: Path "${resolvedPath}" is not inside a git repository, or git is not installed.`);
    process.exit(1);
  }

  // 2. Retrieve Base Branch Files
  let baseFilesRaw: string;
  try {
    baseFilesRaw = execSync(`git ls-tree -r --name-only ${options.baseBranch}`, {
      cwd: resolvedPath,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
  } catch {
    console.error(`Error: Could not retrieve file list for base branch/commit "${options.baseBranch}".`);
    process.exit(1);
  }

  const baseFilesList = baseFilesRaw.split('\n').map(f => f.trim()).filter(Boolean);
  const relevantBaseFiles = baseFilesList.filter(isScannerFile);

  // 3. Stream Base Files into a Temporary Directory
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'promptci-review-'));
  
  try {
    for (const relFile of relevantBaseFiles) {
      try {
        const fileContent = execSync(`git show ${options.baseBranch}:${relFile}`, {
          cwd: resolvedPath,
          stdio: ['ignore', 'pipe', 'ignore'],
          maxBuffer: 10 * 1024 * 1024,
        });
        
        const tempFilePath = path.join(tempDir, relFile);
        await fs.mkdir(path.dirname(tempFilePath), { recursive: true });
        await fs.writeFile(tempFilePath, fileContent);
      } catch {
        // Skip files that failed to show (e.g. symlinks, submodules, or missing)
      }
    }

    // 4. Scan Base Branch Temp Repo
    const baseReport = await scan({
      repoPath: tempDir,
      projectType: 'auto' as ProjectType,
    });

    // 5. Load Current Branch Config and Scan Current Repo
    let config;
    try {
      config = await loadConfig(resolvedPath);
    } catch {
      config = { projectType: 'auto' as ProjectType };
    }

    const currentReport = await scan({
      repoPath: resolvedPath,
      projectType: config.projectType as ProjectType,
      include: config.include,
      exclude: config.exclude,
    });

    // 6. Compute Deltas
    const makeIssuesRelative = (issues: PromptCiIssue[], rootPath: string): PromptCiIssue[] => {
      return issues.map(issue => {
        const relativeFilePaths = issue.filePaths.map(fp => {
          const rel = path.relative(rootPath, fp);
          return rel.replace(/\\/g, '/');
        });
        const relativeLocations = issue.locations.map(loc => {
          const rel = path.relative(rootPath, loc.filePath);
          return {
            ...loc,
            filePath: rel.replace(/\\/g, '/'),
          };
        });
        return {
          ...issue,
          filePaths: relativeFilePaths,
          locations: relativeLocations,
        };
      });
    };

    const makeIssuesAbsolute = (issues: PromptCiIssue[], rootPath: string): PromptCiIssue[] => {
      return issues.map(issue => {
        const absoluteFilePaths = issue.filePaths.map(fp => path.resolve(rootPath, fp));
        const absoluteLocations = issue.locations.map(loc => ({
          ...loc,
          filePath: path.resolve(rootPath, loc.filePath),
        }));
        return {
          ...issue,
          filePaths: absoluteFilePaths,
          locations: absoluteLocations,
        };
      });
    };

    const relativeBaseIssues = makeIssuesRelative(baseReport.issues, tempDir);
    const relativeCurrentIssues = makeIssuesRelative(currentReport.issues, resolvedPath);

    const baseScore = baseReport.healthScore;
    const currentScore = currentReport.healthScore;
    const scoreDelta = currentScore - baseScore;

    const baseBaseline = createBaseline(relativeBaseIssues);
    const currentBaseline = createBaseline(relativeCurrentIssues);

    const { newIssues: relativeNewIssues } = filterNewIssues(relativeCurrentIssues, baseBaseline);
    const { newIssues: relativeResolvedIssues } = filterNewIssues(relativeBaseIssues, currentBaseline);

    const newIssues = makeIssuesAbsolute(relativeNewIssues, resolvedPath);
    const resolvedIssues = makeIssuesAbsolute(relativeResolvedIssues, resolvedPath);

    // 7. Output Results
    if (options.json) {
      const output = {
        baseScore,
        currentScore,
        scoreDelta,
        newIssuesCount: newIssues.length,
        resolvedIssuesCount: resolvedIssues.length,
        newIssues: newIssues.map(i => ({
          id: i.id,
          category: i.category,
          severity: i.severity,
          title: i.title,
          summary: i.summary,
          filePaths: i.filePaths,
          locations: i.locations,
        })),
        resolvedIssues: resolvedIssues.map(i => ({
          id: i.id,
          category: i.category,
          severity: i.severity,
          title: i.title,
        })),
      };
      process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    } else {
      console.log(`PromptCI Branch Review (compared to ${options.baseBranch})`);
      console.log('--------------------------------------------------');
      
      let scoreColor = '\x1b[32m'; // green
      if (scoreDelta < 0) scoreColor = '\x1b[31m'; // red
      else if (scoreDelta === 0) scoreColor = '\x1b[0m'; // normal

      console.log(`Health Score:  ${baseScore} -> ${currentScore} (${scoreColor}${scoreDelta >= 0 ? '+' : ''}${scoreDelta}\x1b[0m points)`);
      console.log(`New Issues:    ${newIssues.length}`);
      console.log(`Resolved:      ${resolvedIssues.length}`);
      
      if (newIssues.length > 0) {
        console.log('\n[+] New Issues:');
        for (const issue of newIssues) {
          const locStr = issue.locations.length > 0 
            ? `${issue.locations[0].filePath}:${issue.locations[0].startLine ?? ''}`
            : issue.filePaths.join(', ');
          
          const sevColor = issue.severity === 'critical' || issue.severity === 'high' ? '\x1b[31m' : '\x1b[33m';
          console.log(`  - ${sevColor}${issue.severity.toUpperCase()}\x1b[0m: ${issue.title} (${locStr})`);
          console.log(`    Summary:   ${issue.summary}`);
          console.log(`    Recommend: ${issue.recommendation}`);
        }
      }

      if (resolvedIssues.length > 0) {
        console.log('\n[-] Resolved Issues:');
        for (const issue of resolvedIssues) {
          console.log(`  - \x1b[32mRESOLVED\x1b[0m: ${issue.title}`);
        }
      }
    }

    // 8. Exit Code Regression Enforcement
    if (options.failOnRegression) {
      if (scoreDelta < 0 || newIssues.length > 0) {
        if (!options.json) {
          console.error('\n\x1b[31mFailed: Regression detected in instruction files.\x1b[0m');
        }
        process.exit(1);
      }
    }
  } finally {
    // 9. Clean up temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
