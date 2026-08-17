import { describe, it, expect, vi } from 'vitest';
import { scan } from '../src/scan.js';
import * as repoContext from '../src/repo-context.js';
import * as detectors from '../src/detectors.js';
import * as suppression from '../src/suppression.js';
import * as healthScore from '../src/health-score.js';
import * as baselineModule from '../src/baseline.js';
import type { RepoContext, PromptCiIssue, TopFix, Baseline } from '../src/types.js';

vi.mock('../src/repo-context.js');
vi.mock('../src/detectors.js');
vi.mock('../src/suppression.js');
vi.mock('../src/health-score.js');
vi.mock('../src/baseline.js');

describe('scan pipeline', () => {
  it('correctly runs detectors, maps suppressions, baseline, and health scores', async () => {
    const mockContext = {
      repoRoot: '/repo',
      projectType: 'typescript',
      files: [],
      metrics: { estimatedInstructionTokens: 100 },
    };

    const mockIssues = [{ id: 'issue-1', severity: 'warning' }];
    const mockAnnotations = [{ category: 'all', line: 10 }];
    const mockValidationIssues = [];
    const mockActiveIssues = [{ id: 'issue-1', severity: 'warning' }];
    const mockSuppressedIssues = [];

    vi.mocked(repoContext.buildRepoContext).mockResolvedValue(mockContext as unknown as RepoContext);
    vi.mocked(detectors.runDetectors).mockReturnValue(mockIssues as unknown as PromptCiIssue[]);
    vi.mocked(suppression.parseSuppressions).mockReturnValue(mockAnnotations as unknown as suppression.SuppressionAnnotation[]);
    vi.mocked(suppression.buildValidationIssues).mockReturnValue(mockValidationIssues as unknown as PromptCiIssue[]);
    vi.mocked(suppression.applySuppressions).mockReturnValue({
      active: mockActiveIssues,
      suppressed: mockSuppressedIssues,
    } as unknown as suppression.SuppressionsApplied);

    vi.mocked(healthScore.computeHealthScore).mockReturnValue(95);
    vi.mocked(healthScore.selectTopFixes).mockReturnValue([{ title: 'Fix something', reason: 'Because', suggestedAction: 'Do it' }] as unknown as TopFix[]);

    const report = await scan({ repoPath: '/repo' });

    expect(report.schemaVersion).toBe('0.1');
    expect(report.healthScore).toBe(95);
    expect(report.issues).toEqual(mockActiveIssues);
    expect(report.topFixes.length).toBe(1);
    expect(report.newIssues).toBeUndefined();
    expect(report.baselinedIssues).toBeUndefined();
  });

  it('filters baseline issues when a baseline is provided', async () => {
    const mockContext = {
      repoRoot: '/repo',
      projectType: 'typescript',
      files: [],
      metrics: { estimatedInstructionTokens: 100 },
    };

    vi.mocked(repoContext.buildRepoContext).mockResolvedValue(mockContext as unknown as RepoContext);
    vi.mocked(detectors.runDetectors).mockReturnValue([]);
    vi.mocked(suppression.parseSuppressions).mockReturnValue([]);
    vi.mocked(suppression.buildValidationIssues).mockReturnValue([]);
    vi.mocked(suppression.applySuppressions).mockReturnValue({ active: [], suppressed: [] } as unknown as suppression.SuppressionsApplied);
    vi.mocked(healthScore.computeHealthScore).mockReturnValue(100);
    vi.mocked(healthScore.selectTopFixes).mockReturnValue([]);

    const mockBaseline = [{ id: 'issue-1', category: 'duplicate', title: 'test', filePaths: ['/repo/CLAUDE.md'], severity: 'warning', fingerprint: 'xyz' }];
    vi.mocked(baselineModule.filterNewIssues).mockReturnValue({
      newIssues: [],
      baselinedIssues: [],
    } as unknown as baselineModule.FilterNewIssuesResult);

    const report = await scan({ repoPath: '/repo', baseline: mockBaseline as unknown as Baseline });

    expect(baselineModule.filterNewIssues).toHaveBeenCalled();
    expect(report.newIssues).toBeDefined();
    expect(report.baselinedIssues).toBeDefined();
  });
});
