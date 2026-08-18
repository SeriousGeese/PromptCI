import { describe, it, expect, vi } from 'vitest';
import { analyzeContext } from '../src/context-analysis.js';
import * as repoContext from '../src/repo-context.js';

import type { RepoContext, PromptCiIssue } from '../src/types.js';

vi.mock('../src/repo-context.js');

const mockIssues = [
  { id: 'some-issue', severity: 'warning', category: 'context_bloat' },
];

// analyzeContext runs exactly the context-bloat registry entry — not the full
// detector set — so the mock replaces that one entry's run.
vi.mock('../src/detectors.js', () => ({
  DETECTORS: [
    { id: 'duplicates', run: () => { throw new Error('analyzeContext must not run non-context detectors'); } },
    { id: 'context-bloat', run: () => mockIssues as unknown as PromptCiIssue[] },
  ],
}));

describe('analyzeContext', () => {
  it('correctly maps the context analysis output structure', async () => {
    const mockContext = {
      repoRoot: '/repo',
      metrics: { estimatedInstructionTokens: 100 },
      packageJson: {
        packageManagerName: 'pnpm',
        packageManager: 'pnpm@9.0.0',
        enginesNode: '>=20',
        lockfiles: ['pnpm-lock.yaml'],
        scripts: { test: 'vitest', build: 'tsc' },
        dependencies: { next: '15.0.0' },
        devDependencies: { typescript: '5.0.0' },
        peerDependencies: {},
      },
      workflows: { files: ['ci.yml'], commands: [] },
    };

    vi.mocked(repoContext.buildRepoContext).mockResolvedValue(mockContext as unknown as RepoContext);

    const result = await analyzeContext({ repoPath: '/repo' });

    expect(result.repoPath).toBe('/repo');
    expect(result.metrics.estimatedInstructionTokens).toBe(100);
    expect(result.packageJson.packageManagerName).toBe('pnpm');
    expect(result.packageJson.scriptNames).toEqual(['build', 'test']);
    expect(result.packageJson.dependencyCount).toBe(2);
    expect(result.workflows.files).toEqual(['ci.yml']);
    expect(result.issues).toEqual(mockIssues);
    expect(result.generatedAt).toBeDefined();
  });
});
