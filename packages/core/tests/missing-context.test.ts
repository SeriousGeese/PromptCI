/**
 * Tests for the missing-context detector, including BUG-007 fix.
 */

import { describe, it, expect } from 'vitest';
import { detectMissingContext } from '../src/missing-context.js';
import type { InstructionFile } from '../src/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFile(content: string, filePath = '/repo/CLAUDE.md'): InstructionFile {
  return {
    path: filePath,
    fileType: 'claude',
    content,
    sections: [],
    lineCount: content.split('\n').length,
    charCount: content.length,
    estimatedTokens: Math.round(content.length / 4),
  };
}

// ── BUG-007: Credential surface check ────────────────────────────────────────

describe('detectMissingContext — BUG-007 credential surface check', () => {
  it('flags a credentials section that omits scope, validation, and expiry', () => {
    const file = makeFile(
      '# Credentials\n' +
      'GitHub and GitLab OAuth tokens are stored in ~/.config/graft/config.yaml, ' +
      'masked with internal/config/mask.go. Never log token values.',
    );
    const issues = detectMissingContext([file], 'unknown');
    const surfaceIssue = issues.find((i) =>
      i.title.toLowerCase().includes('credential') && i.title.toLowerCase().includes('scope'),
    );
    expect(surfaceIssue).toBeDefined();
    expect(surfaceIssue!.severity).toBe('warning');
    expect(surfaceIssue!.category).toBe('missing_context');
  });

  it('does NOT flag when scopes are documented alongside credentials', () => {
    const file = makeFile(
      '# Credentials\n' +
      'GitHub tokens require the `repo` scope. Tokens are validated on first use ' +
      'by calling /user. Token expiry is handled by re-prompting the user.',
    );
    const issues = detectMissingContext([file], 'unknown');
    expect(
      issues.some((i) => i.title.toLowerCase().includes('credential') && i.title.toLowerCase().includes('scope')),
    ).toBe(false);
  });

  it('does NOT flag when validation is mentioned alongside credentials', () => {
    const file = makeFile(
      '# Auth\nPersonal access tokens are verified by calling the GitHub API /user endpoint on first use.',
    );
    const issues = detectMissingContext([file], 'unknown');
    expect(
      issues.some((i) => i.title.toLowerCase().includes('credential') && i.title.toLowerCase().includes('scope')),
    ).toBe(false);
  });

  it('does NOT flag when no credential section exists', () => {
    const file = makeFile(
      '# Style\nUse TypeScript strict mode. Run pnpm test before committing.',
    );
    const issues = detectMissingContext([file], 'unknown');
    expect(
      issues.some((i) => i.title.toLowerCase().includes('credential')),
    ).toBe(false);
  });

  it('does NOT treat the name "Pat" as a personal access token section', () => {
    const file = makeFile(
      '# Credits\nThanks to Pat for the setup guide. Run pnpm test before committing.',
    );
    const issues = detectMissingContext([file], 'unknown');
    expect(
      issues.some((i) => i.title.toLowerCase().includes('credential') && i.title.toLowerCase().includes('scope')),
    ).toBe(false);
  });

  it('does NOT flag when expiry handling is documented', () => {
    const file = makeFile(
      '# Credentials\n' +
      'OAuth tokens expire after 8 hours. When a token expires, the CLI re-prompts ' +
      'for authentication. GitHub tokens are stored in the OS keychain.',
    );
    const issues = detectMissingContext([file], 'unknown');
    expect(
      issues.some((i) => i.title.toLowerCase().includes('credential') && i.title.toLowerCase().includes('scope')),
    ).toBe(false);
  });
});

// ── BUG-008: Secret rotation / incident response check ───────────────────────

describe('detectMissingContext — BUG-008 secret rotation', () => {
  it('flags JWT-handling project with no rotation docs', () => {
    const file = makeFile(
      '## Security\n' +
      'Auth tokens are JWT signed with a private signing key. ' +
      'The JWKS endpoint serves the public keys. ' +
      'Redis credentials are stored in Vault. ' +
      'TLS certificates terminate at the load balancer.',
    );
    const issues = detectMissingContext([file], 'unknown');
    const rotationIssue = issues.find((i) => i.title.toLowerCase().includes('rotation'));
    expect(rotationIssue).toBeDefined();
    expect(rotationIssue!.severity).toBe('warning');
    expect(rotationIssue!.category).toBe('missing_context');
  });

  it('does NOT flag when rotation procedure is documented', () => {
    const file = makeFile(
      '## Security\n' +
      'Auth tokens are JWT signed with a private signing key. ' +
      'Key rotation procedure: revoke the old key in Vault, issue a new signing key, ' +
      'restart the auth service. On compromise, immediately revoke all active tokens.',
    );
    const issues = detectMissingContext([file], 'unknown');
    expect(issues.some((i) => i.title.toLowerCase().includes('rotation'))).toBe(false);
  });

  it('does NOT flag a project with no security-sensitive keys at all', () => {
    const file = makeFile(
      '# A simple static site generator.\nRun `pnpm build` to build. Output goes to dist/.',
    );
    const issues = detectMissingContext([file], 'unknown');
    expect(issues.some((i) => i.title.toLowerCase().includes('rotation'))).toBe(false);
  });
});

// ── BUG-009: Environment variable list completeness ───────────────────────────

describe('detectMissingContext — BUG-009 env var list', () => {
  it('flags when ≥ 3 env vars are named but no env section exists', () => {
    const file = makeFile(
      '## Setup\n' +
      'Run `mix deps.get && mix ecto.setup`. ' +
      'Set GUARDIAN_SECRET_KEY, DATABASE_URL, and SECRET_KEY_BASE before running. ' +
      'The REDIS_URL is optional for local dev.',
    );
    const issues = detectMissingContext([file], 'unknown');
    const envIssue = issues.find((i) => i.title.toLowerCase().includes('environment variable'));
    expect(envIssue).toBeDefined();
    expect(envIssue!.category).toBe('missing_context');
  });

  it('does NOT flag when an Environment Variables section exists', () => {
    const file = makeFile(
      '## Environment Variables\n' +
      'DATABASE_URL — PostgreSQL connection string.\n' +
      'SECRET_KEY_BASE — Phoenix secret key base.\n' +
      'GUARDIAN_SECRET_KEY — JWT signing key.\n' +
      'REDIS_URL — optional Redis cache URL.',
    );
    const issues = detectMissingContext([file], 'unknown');
    expect(issues.some((i) => i.title.toLowerCase().includes('environment variable'))).toBe(false);
  });

  it('does NOT flag when a .env.example is referenced', () => {
    const file = makeFile(
      '## Setup\nCopy `.env.example` to `.env` and fill in DATABASE_URL, SECRET_KEY_BASE, and REDIS_URL.',
    );
    const issues = detectMissingContext([file], 'unknown');
    expect(issues.some((i) => i.title.toLowerCase().includes('environment variable'))).toBe(false);
  });

  it('does NOT flag when fewer than 3 env vars are mentioned', () => {
    const file = makeFile('## Security\nSet DATABASE_URL and SECRET_KEY_BASE before running.');
    const issues = detectMissingContext([file], 'unknown');
    expect(issues.some((i) => i.title.toLowerCase().includes('environment variable'))).toBe(false);
  });
});

// ── BUG-010: Copilot topic-silence check ──────────────────────────────────────

describe('detectMissingContext — BUG-010 copilot topic silence', () => {
  function makeCopilotFile(content: string): InstructionFile {
    return {
      path: '/repo/.github/copilot-instructions.md',
      fileType: 'copilot',
      content,
      sections: [],
      lineCount: content.split('\n').length,
      charCount: content.length,
      estimatedTokens: Math.round(content.length / 4),
    };
  }

  it('flags copilot-instructions.md as silent on file naming when other files document it', () => {
    const claudeFile = makeFile(
      '## File Naming\nUse kebab-case for all file and directory names in this project.',
    );
    const copilotFile = makeCopilotFile(
      '## Tech Stack\nThis is a Next.js project. We use TypeScript and Tailwind CSS.',
    );
    const issues = detectMissingContext([claudeFile, copilotFile], 'unknown');
    const silenceIssue = issues.find(
      (i) => i.title.toLowerCase().includes('copilot') && i.title.toLowerCase().includes('naming'),
    );
    expect(silenceIssue).toBeDefined();
    expect(silenceIssue!.severity).toBe('info');
  });

  it('does NOT flag copilot-instructions.md when it mentions the naming convention', () => {
    const claudeFile = makeFile('Use kebab-case for all file names.');
    const copilotFile = makeCopilotFile(
      '## Style\nAlways use kebab-case for file names. TypeScript strict mode is required.',
    );
    const issues = detectMissingContext([claudeFile, copilotFile], 'unknown');
    const silenceIssue = issues.find(
      (i) => i.title.toLowerCase().includes('copilot') && i.title.toLowerCase().includes('naming'),
    );
    expect(silenceIssue).toBeUndefined();
  });

  it('does NOT flag when a per-file Copilot instruction covers the topic', () => {
    const claudeFile = makeFile('Use kebab-case for all file names.');
    const copilotFile = makeCopilotFile(
      '## Tech Stack\nThis is a TypeScript project.',
    );
    const perFileCopilot: InstructionFile = {
      path: '/repo/.github/instructions/naming.md',
      fileType: 'copilot',
      content: '## Naming\nAlways use kebab-case for file names.',
      sections: [],
      lineCount: 2,
      charCount: 48,
      estimatedTokens: 12,
    };
    const issues = detectMissingContext([claudeFile, copilotFile, perFileCopilot], 'unknown');
    const silenceIssue = issues.find(
      (i) => i.title.toLowerCase().includes('copilot') && i.title.toLowerCase().includes('naming'),
    );
    expect(silenceIssue).toBeUndefined();
  });

  it('does NOT flag when no other files cover the topic either', () => {
    const claudeFile = makeFile('Write tests. Use TypeScript strict mode.');
    const copilotFile = makeCopilotFile('This is a Node.js REST API built with Express.');
    const issues = detectMissingContext([claudeFile, copilotFile], 'unknown');
    const silenceIssue = issues.find(
      (i) => i.title?.toLowerCase().includes('naming'),
    );
    expect(silenceIssue).toBeUndefined();
  });
});

// ── MC1: bare single-word keywords need word boundaries ──────────────────────

describe('detectMissingContext — MC1 word-boundary keyword matching', () => {
  it('flags a Go project whose instructions never mention Go tooling (only "algorithm")', () => {
    const file = makeFile('## Notes\nThis service implements a custom load-balancing algorithm.');
    const issues = detectMissingContext([file], 'go');
    expect(issues.some((i) => i.title.includes('Missing Go-specific context'))).toBe(true);
  });

  it('flags a Go project whose instructions only use "go" as an English verb', () => {
    const file = makeFile('## Review\nGo through the pull request checklist before merging.');
    const issues = detectMissingContext([file], 'go');
    expect(issues.some((i) => i.title.includes('Missing Go-specific context'))).toBe(true);
  });

  it('flags a Python project whose instructions never mention Python tooling (only "pipeline")', () => {
    const file = makeFile('## CI\nThe deployment pipeline runs on every merge to main.');
    const issues = detectMissingContext([file], 'python');
    expect(issues.some((i) => i.title.includes('Missing Python-specific context'))).toBe(true);
  });

  it('flags a Rust project whose instructions never mention Rust tooling (only "trust")', () => {
    const file = makeFile('## Culture\nWe trust reviewers to catch issues before merge.');
    const issues = detectMissingContext([file], 'rust');
    expect(issues.some((i) => i.title.includes('Missing Rust-specific context'))).toBe(true);
  });

  it('flags a Unity project whose instructions never mention Unity tooling (only "community")', () => {
    const file = makeFile('## Culture\nWe value community contributions and code review.');
    const issues = detectMissingContext([file], 'unity');
    expect(issues.some((i) => i.title.includes('Missing Unity-specific context'))).toBe(true);
  });

  it('does NOT flag a Go project that genuinely mentions Go tooling', () => {
    const file = makeFile('## Build\nRun `go build ./...` and `go test ./...` before committing.');
    const issues = detectMissingContext([file], 'go');
    expect(issues.some((i) => i.title.includes('Missing Go-specific context'))).toBe(false);
  });
});

// ── MC2: fenced-block setup-command scope must not leak past the block ───────

describe('detectMissingContext — MC2 fenced-block command scope', () => {
  it('still flags missing setup commands when the only match is unrelated prose after an unrelated fence', () => {
    const file = makeFile(
      [
        '## Example',
        '```json',
        '{ "name": "demo" }',
        '```',
        '',
        'Elsewhere, some other project uses npm install for its own setup (not this one).',
      ].join('\n'),
    );
    const issues = detectMissingContext([file], 'unknown');
    // The old unbounded pattern would let the ```json fence + the later prose
    // "npm install" satisfy the fenced-command check even though no fenced
    // block actually documents a setup command for THIS project.
    expect(issues.some((i) => i.title.includes('No setup or validation commands found'))).toBe(true);
  });

  it('does NOT flag when the setup command is genuinely inside its own fenced block', () => {
    const file = makeFile(['## Setup', '```bash', 'npm install', 'npm run build', '```'].join('\n'));
    const issues = detectMissingContext([file], 'unknown');
    expect(issues.some((i) => i.title.includes('No setup or validation commands found'))).toBe(false);
  });
});
