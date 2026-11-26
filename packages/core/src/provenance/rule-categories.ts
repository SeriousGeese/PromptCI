import type { CheckProvenance, ProvenanceSource, ProvenanceThreshold, SourceStance } from './types.js';

/**
 * Provenance for the rule categories added in pcic-k1t3.10 part 2: inline secrets,
 * agent permissions and rule activation. Every page below was fetched and read by an
 * agent on 2026-11-25; the records are pending human review.
 */

const READ_ON = '2026-11-25';
const VERIFIED = { date: READ_ON, by: 'agent run 2026-11-25 (pcic-k1t3.10 part 2), pending human review' } as const;

type Page = { url: string; title: string };

const PAGES = {
  gitleaks: { url: 'https://raw.githubusercontent.com/gitleaks/gitleaks/master/config/gitleaks.toml', title: 'gitleaks default rule config' },
  githubTokens: {
    url: 'https://github.blog/engineering/platform-security/behind-githubs-new-authentication-token-formats/',
    title: "GitHub blog: Behind GitHub's new authentication token formats",
  },
  awsIdentifiers: { url: 'https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_identifiers.html', title: 'AWS IAM identifiers' },
  ctxlint: { url: 'https://github.com/YawLabs/ctxlint', title: 'YawLabs/ctxlint README' },
  agentlint: { url: 'https://github.com/0xmariowu/AgentLint', title: '0xmariowu/AgentLint README' },
  ccPermissions: { url: 'https://code.claude.com/docs/en/permissions', title: 'Claude Code: Configure permissions' },
  ccSettings: { url: 'https://code.claude.com/docs/en/settings', title: 'Claude Code: Settings files and precedence' },
  codexConfig: { url: 'https://learn.chatgpt.com/docs/config-file/config-reference', title: 'Codex: Configuration reference' },
  codexApprovals: { url: 'https://learn.chatgpt.com/docs/agent-approvals-security', title: 'Codex: Agent approvals and security' },
  geminiConfig: { url: 'https://geminicli.com/docs/reference/configuration/', title: 'Gemini CLI: Configuration' },
  devinRules: { url: 'https://docs.devin.ai/desktop/devin-local/customizations', title: 'Devin Local (Windsurf): Customizations' },
  kiroSteering: { url: 'https://kiro.dev/docs/steering/', title: 'Kiro: Steering' },
} satisfies Record<string, Page>;

const cite = (page: Page, stance: SourceStance, note: string): ProvenanceSource => ({ ...page, readOn: READ_ON, stance, note });

const unverified = (name: string, value: number, where: string, unit: string): ProvenanceThreshold => ({
  name,
  value,
  unit,
  where,
  source: 'unverified',
});

export const RULE_CATEGORIES_PROVENANCE: readonly CheckProvenance[] = [
  {
    id: 'inline-secrets/token-shapes',
    detector: 'inline-secrets',
    title: 'Credential shapes in instruction and agent config files',
    kind: 'tool-fact',
    claim:
      'A string with the fixed prefix, alphabet and length a vendor issues (AWS AKIA/ASIA access key IDs, GitHub gh*_ tokens, GitLab glpat-, Slack xox*-, Stripe sk_live_/rk_live_, Anthropic sk-ant-, OpenAI sk-...T3BlbkFJ, Google AIza, npm_, hf_, SendGrid SG.) or a PEM block with a BEGIN-PRIVATE-KEY header line and a base64 body is a credential, not prose about one.',
    appliesTo: 'n/a',
    sources: [
      cite(
        PAGES.gitleaks,
        'supports',
        'Ships these shapes as detection rules (aws-access-token, github-pat, github-fine-grained-pat, github-oauth, github-app-token, gitlab-pat, slack-bot-token, slack-user-token, stripe-access-token, anthropic-api-key, openai-api-key, gcp-api-key, npm-access-token, huggingface-access-token, sendgrid-api-token, private-key); the detector narrows Stripe to live keys and drops the gitleaks entropy-free generic rules.',
      ),
      cite(
        PAGES.githubTokens,
        'supports',
        'Lists the ghp, gho, ghu, ghs and ghr prefixes followed by an underscore, a base62 body and a checksum in the last six characters.',
      ),
      cite(PAGES.awsIdentifiers, 'supports', 'Lists AKIA as the prefix of an access key and ASIA as the prefix of temporary (STS) access key IDs.'),
      cite(
        PAGES.ctxlint,
        'context',
        'A competing linter checks the same thing (content-secrets: private-key headers and AWS, GitHub, Anthropic, OpenAI, npm, Slack, Google and Stripe token shapes in context files, shown redacted).',
      ),
      cite(PAGES.agentlint, 'context', 'A competing linter checks for hardcoded sk-, ghp_, AKIA and private-key patterns (S6 No hardcoded secrets).'),
    ],
    thresholds: [
      unverified('MIN_DISTINCT_CHARS', 12, 'inline-secrets.ts:MIN_DISTINCT_CHARS', 'distinct characters in the random part'),
      {
        name: 'MIN_PRIVATE_KEY_BODY',
        value: 64,
        unit: 'base64 characters',
        where: 'inline-secrets.ts:MIN_PRIVATE_KEY_BODY',
        source: cite(PAGES.gitleaks, 'supports', 'The private-key rule requires at least 64 characters between the BEGIN and END lines.'),
      },
    ],
    lastVerified: VERIFIED,
  },
  {
    id: 'agent-permissions/claude-code',
    detector: 'agent-permissions',
    title: 'Shared Claude Code settings that skip prompts',
    kind: 'tool-fact',
    claim:
      'In Claude Code, .claude/settings.json is the shared project settings file teammates get from git; permissions.defaultMode "bypassPermissions" skips permission prompts, and a permissions.allow rule of Bash or Bash(*) matches every Bash command.',
    appliesTo: ['claude-code'],
    sources: [
      cite(
        PAGES.ccPermissions,
        'supports',
        'Says bypassPermissions skips permission prompts and to use it only in isolated environments such as containers or VMs, and that Bash, like Bash(*), matches all Bash commands.',
      ),
      cite(
        PAGES.ccSettings,
        'supports',
        'Says .claude/settings.json is the shared project scope, committed so teammates get it, while .claude/settings.local.json is personal and kept out of git.',
      ),
      cite(PAGES.agentlint, 'context', 'A competing linter flags allow rules of * or .* as dangerous auto-approve (H4).'),
    ],
    lastVerified: VERIFIED,
  },
  {
    id: 'agent-permissions/codex',
    detector: 'agent-permissions',
    title: 'Project Codex config with no approval and no sandbox',
    kind: 'tool-fact',
    claim:
      'A project .codex/config.toml (read for trusted projects) with approval_policy = "never" and sandbox_mode = "danger-full-access" makes Codex run commands without approval prompts and without sandbox limits.',
    appliesTo: ['codex'],
    sources: [
      cite(
        PAGES.codexConfig,
        'supports',
        'Lists approval_policy values (on-request, never, granular) and sandbox_mode values (read-only, workspace-write, danger-full-access), and says project-scoped .codex/config.toml files load only when the project is trusted.',
      ),
      cite(
        PAGES.codexApprovals,
        'supports',
        'Says never disables approval prompts and works with every sandbox mode, and that danger-full-access lets Codex read, edit and run commands with network access without approval prompts.',
      ),
      cite(PAGES.geminiConfig, 'context', 'Gemini CLI is not checked: its YOLO mode can only be enabled on the command line, not in settings.json.'),
    ],
    lastVerified: VERIFIED,
  },
  {
    id: 'ai-config-rule-activation/windsurf',
    detector: 'ai-config-rule-activation',
    title: 'Windsurf / Devin Local rule triggers',
    kind: 'tool-fact',
    claim:
      'A Windsurf / Devin Local rule file has trigger always_on, manual, model_decision or glob; a glob rule needs globs to match any file, and a model_decision rule is chosen by its description.',
    appliesTo: ['windsurf', 'devin-local'],
    sources: [
      cite(
        PAGES.devinRules,
        'supports',
        'Lists the four triggers, shows a glob rule with a globs field, and says a model_decision rule applies when the agent decides its description is relevant (it does not call description required in so many words).',
      ),
    ],
    lastVerified: VERIFIED,
  },
  {
    id: 'ai-config-rule-activation/kiro',
    detector: 'ai-config-rule-activation',
    title: 'Kiro steering inclusion modes and file references',
    kind: 'tool-fact',
    claim:
      'A Kiro steering file has inclusion always, fileMatch, manual or auto; fileMatch needs fileMatchPattern, auto needs name and description, the frontmatter must be the first content of the file, and #[[file:path]] pulls a workspace file into the steering file.',
    appliesTo: ['kiro'],
    sources: [
      cite(
        PAGES.kiroSteering,
        'supports',
        'Documents the four inclusion modes, fileMatchPattern (string or list) for fileMatch, name and description as required for auto, that front matter must be the first content with no blank lines before it, and the #[[file:<relative_file_name>]] reference syntax.',
      ),
    ],
    lastVerified: VERIFIED,
  },
];
