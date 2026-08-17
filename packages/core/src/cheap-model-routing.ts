import type { RepoContext } from './repo-context.js';
import type { PromptCiIssue } from './types.js';

const ROUTING_KEYWORDS = [
  /\b(?:cheap|cheaper|smaller|cost-aware|routing)\b.*\b(?:model|models|route|routing)\b/i,
  /\b(?:escalate\s+to|escalation\s+path|stronger\s+model|expensive\s+model)\b/i,
  /\bgpt-4o-mini\b/i,
  /\bclaude-3-5-haiku\b|\bhaiku\b/i,
  /\bgemini-2\.5-flash\b|\bgemini\s+flash\b|\bflash\s+model\b/i,
  /\bmodel\s+routing\b/i,
];

export function detectCheapModelRouting(context: RepoContext): PromptCiIssue[] {
  const { files, metrics } = context;

  if (files.length === 0) {
    return [];
  }

  // Skip for small/simple repositories to avoid noise
  if (metrics.estimatedInstructionTokens < 500) {
    return [];
  }

  const combinedContent = files.map((f) => f.content).join('\n');
  const hasRoutingMentions = ROUTING_KEYWORDS.some((pat) => pat.test(combinedContent));

  if (!hasRoutingMentions) {
    return [
      {
        id: 'cheap-model-routing-missing',
        severity: 'info',
        category: 'agent_practices',
        title: 'Missing model routing guidance',
        summary: 'No model routing guidelines found in instruction files. Using expensive frontier models for simple tasks (like linting or formatting) unnecessarily increases AI costs.',
        filePaths: files.map((f) => f.path),
        locations: [],
        evidence: ['No mentions of cheaper models, model routing, or escalation conditions found in instructions.'],
        recommendation: 'Add guidelines specifying when to use cheaper/smaller models (e.g. Gemini 2.5 Flash, GPT-4o-mini) versus escalating to stronger models.',
        fixRecipe: [
          '### Model Routing Guidance',
          '- Use cheaper/smaller models (e.g. Gemini 2.5 Flash, GPT-4o-mini) for: formatting, linting, simple test additions, mechanical renames, and documentation updates.',
          '- Escalate to stronger models (e.g. Gemini 2.5 Pro, Claude 3.5 Sonnet) for: complex multi-file debugging, security-sensitive changes, and core architecture decisions.'
        ].join('\n'),
        confidence: 0.8,
      },
    ];
  }

  return [];
}
