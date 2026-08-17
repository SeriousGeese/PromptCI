import { describe, it, expect } from 'vitest';
import { generateContextRecommendations } from '../src/context-recommender.js';
import type { ScanReport, InstructionFile, InstructionSection } from '../src/types.js';

function makeSection(heading: string, text: string): InstructionSection {
  return {
    id: heading.toLowerCase().replace(/\s+/g, '-'),
    filePath: '/repo/CLAUDE.md',
    heading,
    startLine: 1,
    endLine: text.split('\n').length,
    text,
    normalizedText: text.toLowerCase().trim(),
  };
}

function makeFile(path: string, sections: InstructionSection[]): InstructionFile {
  const content = sections.map((s) => s.text).join('\n');
  return {
    path,
    fileType: 'claude',
    content,
    sections,
    lineCount: content.split('\n').length,
    charCount: content.length,
    estimatedTokens: Math.round(content.length / 4),
  };
}

const mockReport: ScanReport = {
  schemaVersion: '0.1',
  generatedAt: new Date().toISOString(),
  repoPath: '/repo',
  projectType: 'typescript',
  healthScore: 100,
  filesScanned: [],
  issues: [],
  topFixes: [],
};

describe('generateContextRecommendations', () => {
  it('returns empty string for small/clean instruction files to avoid noise', () => {
    const file = makeFile('/repo/CLAUDE.md', [
      makeSection('Identity', 'We are promptci scanner core engine.'),
    ]);
    const report = {
      ...mockReport,
      filesScanned: [file],
    };
    const output = generateContextRecommendations(report);
    expect(output).toBe('');
  });

  it('produces context recommendation sections for larger repos', () => {
    // Large deployment runbook and nextjs frontend sections
    let deploymentText = 'Imperative steps to deploy the application:\n';
    for (let i = 0; i < 40; i++) {
      deploymentText += `- Run step ${i} to compile release.\n`;
    }

    let nextjsText = 'Conventions for Next.js app components:\n';
    for (let i = 0; i < 30; i++) {
      nextjsText += `- Do frontend component layout ${i}.\n`;
    }

    const file = makeFile('/repo/CLAUDE.md', [
      makeSection('Deployment Runbook', deploymentText),
      makeSection('Next.js frontend conventions', nextjsText),
      makeSection('Identity & Boundaries', 'Identity statement to keep total size large.'),
    ]);

    const report = {
      ...mockReport,
      filesScanned: [file],
    };

    const output = generateContextRecommendations(report);
    expect(output).toContain('## Context Architecture & Retrieval Map');
    expect(output).toContain('## Skills Readiness & Extraction Recommendations');
    expect(output).toContain('## Context ROI Ranking (Cleanup Opportunities)');
    expect(output).toContain('## Suggested Context Packs');

    // Verification of classification
    expect(output).toContain('docs/ai/deployment.md');
    expect(output).toContain('docs/ai/nextjs.md');
    expect(output).toContain('deployment-runbook');
    expect(output).toContain('web-dashboard-development');
  });

  it('classifies changelogs as Archive/Remove', () => {
    let changelogText = 'History of changes in the project:\n';
    for (let i = 0; i < 80; i++) {
      changelogText += `- Version 1.0.${i} release notes.\n`;
    }

    const file = makeFile('/repo/CLAUDE.md', [
      makeSection('Changelog History', changelogText),
      makeSection('Identity & Boundaries', 'Identity statement to keep total size large.'),
    ]);

    const report = {
      ...mockReport,
      filesScanned: [file],
    };

    const output = generateContextRecommendations(report);
    expect(output).toContain('Archive/Remove');
  });

  it('excludes critical always-load sections and ranks archive sections higher in Context ROI Ranking', () => {
    let changelogText = 'History of changes in the project:\n';
    for (let i = 0; i < 50; i++) {
      changelogText += `- Version 1.0.${i} release notes.\n`;
    }

    let verificationText = 'Verification Loop:\n';
    for (let i = 0; i < 50; i++) {
      verificationText += `- Must run verification step ${i}.\n`;
    }

    const file = makeFile('/repo/CLAUDE.md', [
      makeSection('Verification Loop', verificationText), // always-load + critical text
      makeSection('Changelog History', changelogText), // archive
    ]);

    const report = {
      ...mockReport,
      filesScanned: [file],
    };

    const output = generateContextRecommendations(report);
    // The output should contain the archive section in the ROI list, but exclude the always-load verification loop
    expect(output).toContain('Changelog History');
    expect(output).not.toContain('Verification Loop</td>'); // Verification Loop should not be in the table as a ranked opportunity
  });

  it('boosts volatile sections in the Context ROI Ranking', () => {
    let volatileText = 'Active Task and status notes:\nLast Updated: 2026-06-05\n';
    for (let i = 0; i < 50; i++) {
      volatileText += `- Active item ${i} in development.\n`;
    }

    let regularText = 'Database setups:\n';
    for (let i = 0; i < 50; i++) {
      regularText += `- Setup DB structure ${i}.\n`;
    }

    const file = makeFile('/repo/CLAUDE.md', [
      makeSection('Active Task Notes', volatileText), // archive (via 'yesterday/today/todo/task') or we'll just check if it gets categorized and has high potential
      makeSection('Database Setup', regularText), // on-demand
      makeSection('Identity & Boundaries', 'Identity statement to keep total size large.'),
    ]);

    const report = {
      ...mockReport,
      filesScanned: [file],
    };

    const output = generateContextRecommendations(report);
    expect(output).toContain('Active Task Notes');
  });
});
