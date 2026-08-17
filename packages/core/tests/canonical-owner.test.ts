import { describe, it, expect } from 'vitest';
import { detectCanonicalOwner } from '../src/canonical-owner.js';
import type { InstructionFile } from '../src/types.js';

function makeFile(path: string, content: string, lineCount = 10): InstructionFile {
  return {
    path,
    fileType: 'unknown',
    content,
    sections: [],
    lineCount,
    charCount: content.length,
    estimatedTokens: Math.round(content.length / 4),
  };
}

describe('detectCanonicalOwner', () => {
  it('flags ambiguous authority when multiple files claim to be canonical', () => {
    const agents = makeFile('AGENTS.md', 'This is the canonical source of truth for all agents.');
    const claude = makeFile('CLAUDE.md', 'This file is the authoritative source of truth.');
    
    const issues = detectCanonicalOwner([agents, claude]);
    const issue = issues.find(i => i.id.includes('ambiguous-authority'));
    
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('warning');
    expect(issue!.filePaths).toContain('AGENTS.md');
    expect(issue!.filePaths).toContain('CLAUDE.md');
  });

  it('does NOT flag when only one file claims to be canonical', () => {
    const agents = makeFile('AGENTS.md', 'This is the canonical source of truth.');
    const claude = makeFile('CLAUDE.md', 'Use AGENTS.md as canonical.');
    
    const issues = detectCanonicalOwner([agents, claude]);
    expect(issues.find(i => i.id.includes('ambiguous-authority'))).toBeUndefined();
  });

  it('flags large duplication between tool-specific file and canonical file', () => {
    const commonSection = 'Always use TypeScript. Write tests for every feature. Follow the style guide. '.repeat(10);
    const agents: InstructionFile = {
      path: 'AGENTS.md',
      fileType: 'agents',
      content: '# Common Rules\n' + commonSection,
      sections: [{
        id: 'common-rules',
        filePath: 'AGENTS.md',
        heading: 'Common Rules',
        startLine: 1,
        endLine: 60,
        text: '# Common Rules\n' + commonSection,
        normalizedText: ('# common rules\n' + commonSection).toLowerCase().trim()
      }],
      lineCount: 60,
      charCount: 1000,
      estimatedTokens: 250
    };
    
    const claude: InstructionFile = {
      path: 'CLAUDE.md',
      fileType: 'claude',
      content: '# Claude Rules\n' + commonSection,
      sections: [{
        id: 'claude-rules',
        filePath: 'CLAUDE.md',
        heading: 'Claude Rules',
        startLine: 1,
        endLine: 60,
        text: '# Claude Rules\n' + commonSection,
        normalizedText: ('# claude rules\n' + commonSection).toLowerCase().trim()
      }],
      lineCount: 60,
      charCount: 1000,
      estimatedTokens: 250
    };

    const issues = detectCanonicalOwner([agents, claude]);
    const issue = issues.find(i => i.id.includes('behavior-duplication'));
    
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('info');
    expect(issue!.filePaths).toContain('CLAUDE.md');
    expect(issue!.filePaths).toContain('AGENTS.md');
  });

  it('does NOT flag duplication for short files', () => {
    const agents = makeFile('AGENTS.md', 'Use TypeScript.', 5);
    const claude = makeFile('CLAUDE.md', 'Use TypeScript.', 5);

    const issues = detectCanonicalOwner([agents, claude]);
    expect(issues.find(i => i.id.includes('behavior-duplication'))).toBeUndefined();
  });
});

// ── Authority phrase variant coverage ─────────────────────────────────────────

describe('detectCanonicalOwner — authority phrase variants', () => {
  it.each([
    ['canonical instruction', 'This is the canonical instruction for the project.'],
    ['canonical guidance', 'Refer to this file as the canonical guidance for all agents.'],
    ['authoritative instruction', 'This file is the authoritative instruction.'],
    ['authoritative guidance', 'This is the authoritative guidance for contributors.'],
    ['primary source of truth', 'This file is the primary source of truth for the repo.'],
    ['primary instruction', 'This is the primary instruction document.'],
    ['primary guidance', 'This file contains the primary guidance for agents.'],
    ['source of truth for all agents', 'This is the source of truth for all agents.'],
    ['master instruction file', 'This is the master instruction file.'],
  ])('detects "%s" as an authority phrase that triggers ambiguous-authority', (_label, content) => {
    const fileA = makeFile('AGENTS.md', content);
    const fileB = makeFile('CLAUDE.md', content);
    const issues = detectCanonicalOwner([fileA, fileB]);
    expect(issues.find(i => i.id.includes('ambiguous-authority'))).toBeDefined();
  });

  it('does NOT flag a file with a forwarding pointer but no authority claim', () => {
    const agents = makeFile('AGENTS.md', 'This is the canonical source of truth.');
    const claude = makeFile('CLAUDE.md', 'Follow AGENTS.md for all instructions.');
    const issues = detectCanonicalOwner([agents, claude]);
    expect(issues.find(i => i.id.includes('ambiguous-authority'))).toBeUndefined();
  });
});

// ── AGENTS.md preference and forwarding behavior ───────────────────────────────

describe('detectCanonicalOwner — AGENTS.md preference', () => {
  it('does NOT flag ambiguity when only a non-AGENTS.md file claims authority', () => {
    // Only CLAUDE.md claims authority; filesWithAuthority.length === 1 → no ambiguous flag.
    // primaryCanonical is AGENTS.md (matched by name), not CLAUDE.md.
    const agents = makeFile('AGENTS.md', 'Follow these rules closely.');
    const claude = makeFile('CLAUDE.md', 'This is the canonical source of truth.');
    const issues = detectCanonicalOwner([agents, claude]);
    expect(issues.find(i => i.id.includes('ambiguous-authority'))).toBeUndefined();
  });

  it('flags behavior-duplication against AGENTS.md as the primary canonical', () => {
    const commonSection = 'Always use TypeScript. Write tests for every feature. Follow the style guide. '.repeat(10);
    const agents: InstructionFile = {
      path: '/repo/AGENTS.md',
      fileType: 'agents',
      content: '# Common Rules\n' + commonSection,
      sections: [{
        id: 'common-rules',
        filePath: '/repo/AGENTS.md',
        heading: 'Common Rules',
        startLine: 1,
        endLine: 60,
        text: '# Common Rules\n' + commonSection,
        normalizedText: ('# common rules\n' + commonSection).toLowerCase(),
      }],
      lineCount: 61,
      charCount: commonSection.length + 20,
      estimatedTokens: 250,
    };
    const claude: InstructionFile = {
      path: '/repo/CLAUDE.md',
      fileType: 'claude',
      content: '# Claude Rules\n' + commonSection,
      sections: [{
        id: 'claude-rules',
        filePath: '/repo/CLAUDE.md',
        heading: 'Claude Rules',
        startLine: 1,
        endLine: 60,
        text: '# Claude Rules\n' + commonSection,
        normalizedText: ('# claude rules\n' + commonSection).toLowerCase(),
      }],
      lineCount: 61,
      charCount: commonSection.length + 20,
      estimatedTokens: 250,
    };
    const issues = detectCanonicalOwner([agents, claude]);
    const dup = issues.find(i => i.id.includes('behavior-duplication'));
    expect(dup).toBeDefined();
    expect(dup!.filePaths).toContain('/repo/CLAUDE.md');
    expect(dup!.filePaths).toContain('/repo/AGENTS.md');
  });

  it('does NOT flag ambiguous authority when AGENTS.md is present and only it claims authority', () => {
    const agents = makeFile('AGENTS.md', 'This is the authoritative source for all agents.');
    const cursor = makeFile('.cursorrules', 'Follow AGENTS.md.');
    const issues = detectCanonicalOwner([agents, cursor]);
    expect(issues.find(i => i.id.includes('ambiguous-authority'))).toBeUndefined();
  });
});

// ── Non-tool-specific large duplicate suppression ─────────────────────────────

describe('detectCanonicalOwner — non-tool-specific large duplicate suppression', () => {
  const commonSection = 'Always use TypeScript. Write tests for every feature. Follow the style guide. '.repeat(10);

  function bigFile(filePath: string, heading: string, fileType: InstructionFile['fileType']): InstructionFile {
    return {
      path: filePath,
      fileType,
      content: `# ${heading}\n` + commonSection,
      sections: [{
        id: heading.toLowerCase().replace(/\s+/g, '-'),
        filePath,
        heading,
        startLine: 1,
        endLine: 60,
        text: `# ${heading}\n` + commonSection,
        normalizedText: (`# ${heading}\n` + commonSection).toLowerCase(),
      }],
      lineCount: 61,
      charCount: commonSection.length + heading.length + 5,
      estimatedTokens: 250,
    };
  }

  it('does NOT flag large duplication in a non-tool-specific file (e.g., CONTRIBUTING.md)', () => {
    const agents = bigFile('/repo/AGENTS.md', 'Common Rules', 'agents');
    const contributing = bigFile('/repo/CONTRIBUTING.md', 'Contributing Rules', 'docs');
    const issues = detectCanonicalOwner([agents, contributing]);
    expect(issues.find(i => i.id.includes('behavior-duplication'))).toBeUndefined();
  });

  it('DOES flag large duplication in a .cursorrules file', () => {
    const agents = bigFile('/repo/AGENTS.md', 'Common Rules', 'agents');
    const cursor = bigFile('/repo/.cursorrules', 'Cursor Rules', 'cursor');
    const issues = detectCanonicalOwner([agents, cursor]);
    expect(issues.find(i => i.id.includes('behavior-duplication'))).toBeDefined();
  });

  it('DOES flag large duplication in a file inside the .claude/ directory', () => {
    const agents = bigFile('/repo/AGENTS.md', 'Common Rules', 'agents');
    const claudeDirFile = bigFile('/repo/.claude/COMMANDS.md', 'Commands', 'claude');
    const issues = detectCanonicalOwner([agents, claudeDirFile]);
    expect(issues.find(i => i.id.includes('behavior-duplication'))).toBeDefined();
  });
});

// ── Edge cases ─────────────────────────────────────────────────────────────────

describe('detectCanonicalOwner — edge cases', () => {
  it('returns empty array for empty input', () => {
    expect(detectCanonicalOwner([])).toEqual([]);
  });

  it('returns empty array for a single file (no ambiguity possible)', () => {
    const file = makeFile('AGENTS.md', 'This is the canonical source of truth.');
    expect(detectCanonicalOwner([file])).toHaveLength(0);
  });

  it('reports all three file paths in ambiguous-authority when three files claim authority', () => {
    const f1 = makeFile('AGENTS.md', 'canonical source of truth for all agents');
    const f2 = makeFile('CLAUDE.md', 'canonical source of truth for all agents');
    const f3 = makeFile('.cursorrules', 'canonical source of truth for all agents');
    const issues = detectCanonicalOwner([f1, f2, f3]);
    const amb = issues.find(i => i.id.includes('ambiguous-authority'));
    expect(amb).toBeDefined();
    expect(amb!.filePaths).toHaveLength(3);
  });
});

// ── CO1: evidence extraction must not render the literal string "undefined" ──

describe('detectCanonicalOwner — CO1 evidence extraction for wrapped phrases', () => {
  it('extracts real evidence text when the authority phrase is wrapped across two lines', () => {
    const agents = makeFile('AGENTS.md', 'This is the\ncanonical source of truth for all agents.');
    const claude = makeFile('CLAUDE.md', 'This file is the authoritative source of truth.');

    const issues = detectCanonicalOwner([agents, claude]);
    const issue = issues.find((i) => i.id.includes('ambiguous-authority'));
    expect(issue).toBeDefined();
    const agentsEvidence = issue!.evidence.find((e) => e.startsWith('AGENTS.md:'));
    expect(agentsEvidence).toBeDefined();
    // Must NOT literally render the string "undefined" (the old bug), and
    // must contain the actual matched phrase text.
    expect(agentsEvidence).not.toContain('undefined');
    expect(agentsEvidence!.toLowerCase()).toContain('canonical source of truth');
  });
});

// ── CO2 / B1: distinct id from agent-practices.ts's duplication finding ─────

describe('detectCanonicalOwner — CO2/B1 id no longer collides with agent-practices.ts', () => {
  it('emits a behavior-duplication id, still prefixed the same way, for the tool-specific duplicate', () => {
    const commonSection = 'Always use TypeScript. Write tests for every feature. Follow the style guide. '.repeat(10);
    const agents: InstructionFile = {
      path: 'AGENTS.md',
      fileType: 'agents',
      content: '# Common Rules\n' + commonSection,
      sections: [{
        id: 'common-rules',
        filePath: 'AGENTS.md',
        heading: 'Common Rules',
        startLine: 1,
        endLine: 60,
        text: '# Common Rules\n' + commonSection,
        normalizedText: ('# common rules\n' + commonSection).toLowerCase().trim(),
      }],
      lineCount: 60,
      charCount: 1000,
      estimatedTokens: 250,
    };
    const claude: InstructionFile = {
      path: 'CLAUDE.md',
      fileType: 'claude',
      content: '# Claude Rules\n' + commonSection,
      sections: [{
        id: 'claude-rules',
        filePath: 'CLAUDE.md',
        heading: 'Claude Rules',
        startLine: 1,
        endLine: 60,
        text: '# Claude Rules\n' + commonSection,
        normalizedText: ('# claude rules\n' + commonSection).toLowerCase().trim(),
      }],
      lineCount: 60,
      charCount: 1000,
      estimatedTokens: 250,
    };

    const issues = detectCanonicalOwner([agents, claude]);
    const issue = issues.find((i) => i.id.includes('behavior-duplication'));
    expect(issue).toBeDefined();
    // Still uses the shared "behavior-duplication-" prefix, but the hash is
    // namespaced with "canonical-owner:" so it can never collide with
    // agent-practices.ts's "agent-practices:"-namespaced id for the same file.
    expect(issue!.id.startsWith('behavior-duplication-')).toBe(true);
  });
});
