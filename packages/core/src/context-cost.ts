import * as crypto from 'node:crypto';
import type { PromptCiIssue } from './types.js';
import type { RepoContext } from './repo-context.js';

const TOTAL_TOKEN_WARNING = 8_000;
const FILE_TOKEN_WARNING = 2_500;
const README_DOMINANCE_RATIO = 0.5;
const README_DOMINANCE_MIN_TOKENS = 1_000;

function issueId(input: string): string {
  const hash = crypto.createHash('sha1').update(input).digest('hex').slice(0, 12);
  return `context-cost-${hash}`;
}

export function detectContextCost(context: RepoContext): PromptCiIssue[] {
  const issues: PromptCiIssue[] = [];
  const totalTokens = context.metrics.estimatedInstructionTokens;

  if (totalTokens > TOTAL_TOKEN_WARNING) {
    issues.push({
      id: 'context-cost-total-token-budget',
      severity: 'warning',
      category: 'context_bloat',
      title: 'Instruction context may exceed a practical token budget',
      summary:
        `Scanned instruction context is approximately ${totalTokens} tokens. ` +
        'This may increase AI cost and make persistent context harder for agents to use.',
      filePaths: context.files.map((file) => file.path),
      locations: [],
      evidence: [`Estimated instruction tokens: ${totalTokens}`],
      recommendation:
        'Consider moving rarely needed examples, historical notes, and detailed runbooks into linked on-demand docs.',
      confidence: 0.8,
      tags: ['cost', 'context'],
    });
  }

  for (const file of context.files) {
    if (file.estimatedTokens <= FILE_TOKEN_WARNING) continue;
    issues.push({
      id: issueId(`large-file:${file.path}`),
      severity: 'info',
      category: 'context_bloat',
      title: `Large always-scanned instruction file: ${file.path.split(/[\\/]/).pop() ?? file.path}`,
      summary:
        `This file is approximately ${file.estimatedTokens} tokens. Large instruction files are often worth splitting into ` +
        'short always-loaded rules plus topic-specific reference docs.',
      filePaths: [file.path],
      locations: [{ filePath: file.path }],
      evidence: [`${file.path}: ~${file.estimatedTokens} tokens`],
      recommendation:
        'Keep critical rules in the instruction file and move deep examples or runbooks to linked docs.',
      confidence: 0.75,
      tags: ['cost', 'context'],
    });
  }

  if (totalTokens > 0) {
    const readme = context.files.find((file) => file.fileType === 'readme');
    if (
      readme &&
      readme.estimatedTokens >= README_DOMINANCE_MIN_TOKENS &&
      readme.estimatedTokens / totalTokens >= README_DOMINANCE_RATIO
    ) {
      issues.push({
        id: issueId(`readme-dominates:${readme.path}`),
        severity: 'info',
        category: 'context_bloat',
        title: 'README dominates scanned instruction context',
        summary:
          `README content accounts for about ${Math.round((readme.estimatedTokens / totalTokens) * 100)}% ` +
          'of scanned instruction tokens. That may be appropriate, but AI-specific guidance is usually cheaper in a smaller canonical file.',
        filePaths: [readme.path],
        locations: [{ filePath: readme.path }],
        evidence: [`README: ~${readme.estimatedTokens} of ~${totalTokens} scanned tokens`],
        recommendation:
          'Consider keeping AI rules in AGENTS.md and leaving README as project documentation linked only when relevant.',
        confidence: 0.65,
        tags: ['cost', 'context'],
      });
    }
  }

  return issues;
}
