/**
 * CLI output filter detector for PromptCI.
 *
 * Checks whether instruction files include guidance on filtering verbose CLI
 * output before it reaches the LLM context. Tools like RTK (Rust Token Killer)
 * transparently proxy commands such as `npm test`, `git diff`, and `cargo test`,
 * stripping boilerplate and keeping only signal — typically 60-90% token reduction
 * on those commands.
 *
 * Only fires for non-trivial projects (>500 estimated instruction tokens) that
 * have no existing output-filter guidance in any instruction file.
 */

import type { RepoContext } from './repo-context.js';
import type { PromptCiIssue } from './types.js';

// Signals that output-filter guidance already exists somewhere in the instructions.
const FILTER_SIGNALS = [
  /\brtk\b/i,
  /rust\s+token\s+killer/i,
  /output\s+filter/i,
  /token[- ]optimized\s+(cli|command|output)/i,
  /cli\s+proxy/i,
  /filter.*command.*output/i,
  /compact.*output/i,
  /--failures[- ]only/i,
];

// Commands that produce high-token output and benefit most from filtering.
// Used only to improve the evidence message — not a gate condition.
const NOISY_COMMANDS = [
  'npm test', 'npm run test', 'yarn test', 'pnpm test',
  'jest', 'vitest', 'pytest', 'cargo test', 'go test', 'rspec',
  'git diff', 'git log', 'git status',
  'next build', 'npm run build', 'tsc',
  'eslint', 'ruff check', 'cargo clippy', 'golangci-lint',
  'docker logs', 'kubectl logs',
  'gh pr list', 'gh run list',
];

export function detectCliOutputFilter(context: RepoContext): PromptCiIssue[] {
  const { files, metrics } = context;

  if (files.length === 0) return [];

  // Skip trivially small instruction sets — not worth the noise.
  if (metrics.estimatedInstructionTokens < 500) return [];

  const combinedContent = files.map((f) => f.content).join('\n');

  const hasFilterGuidance = FILTER_SIGNALS.some((pat) => pat.test(combinedContent));
  if (hasFilterGuidance) return [];

  // Surface whichever noisy commands are referenced in instructions (for evidence).
  const referencedNoisyCommands = NOISY_COMMANDS.filter((cmd) =>
    combinedContent.toLowerCase().includes(cmd.toLowerCase())
  );

  const evidenceLine =
    referencedNoisyCommands.length > 0
      ? `Noisy commands referenced in instructions: ${referencedNoisyCommands.slice(0, 5).join(', ')}${referencedNoisyCommands.length > 5 ? ` (+${referencedNoisyCommands.length - 5} more)` : ''}.`
      : 'No output-filter signals found across all instruction files.';

  return [
    {
      id: 'cli-output-filter-missing',
      severity: 'info',
      category: 'agent_practices',
      title: 'No CLI output filtering guidance',
      summary:
        'Instruction files contain no guidance on filtering verbose CLI output before it reaches ' +
        'the LLM context. Commands like `npm test`, `git diff`, and `cargo test` can produce ' +
        'hundreds of boilerplate lines. A CLI proxy such as RTK (Rust Token Killer) intercepts ' +
        'these transparently and reduces token consumption by 60-90% on affected commands.',
      filePaths: files.map((f) => f.path),
      locations: [],
      evidence: [evidenceLine],
      recommendation:
        'Install a CLI output filter (e.g. RTK: github.com/rtk-ai/rtk) and document it in your ' +
        'instruction files. For Claude Code, `rtk init -g` installs a PreToolUse hook that ' +
        'transparently rewrites Bash commands — no per-command changes needed.',
      fixRecipe: [
        '## CLI Output Filtering',
        '',
        'Use [RTK](https://github.com/rtk-ai/rtk) to reduce token consumption from verbose commands:',
        '',
        '```bash',
        'brew install rtk                    # macOS',
        '# or: cargo install --git https://github.com/rtk-ai/rtk',
        'rtk init -g                         # Claude Code (PreToolUse hook)',
        'rtk init -g --codex                 # Codex (AGENTS.md)',
        'rtk init --agent antigravity        # Antigravity (project-scoped rules)',
        '```',
        '',
        'The hook transparently rewrites `npm test` → `rtk npm test` (failures only),',
        '`git diff` → `rtk git diff` (condensed), etc. Run `rtk gain` to see token savings.',
      ].join('\n'),
      confidence: 0.75,
      impact: 'medium',
    },
  ];
}
