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
  truffleOpenRouter: { url: 'https://raw.githubusercontent.com/trufflesecurity/trufflehog/main/pkg/detectors/openrouter/openrouter.go', title: 'trufflehog OpenRouter detector' },
  truffleGroq: { url: 'https://raw.githubusercontent.com/trufflesecurity/trufflehog/main/pkg/detectors/groq/groq.go', title: 'trufflehog Groq detector' },
  supabaseCliDefaults: { url: 'https://raw.githubusercontent.com/supabase/cli/develop/packages/stack/src/Defaults.ts', title: 'Supabase CLI: local stack default keys' },
  supabaseApiKeys: { url: 'https://supabase.com/docs/guides/getting-started/api-keys', title: 'Supabase: API keys' },
  neonConnect: { url: 'https://neon.com/docs/connect/connect-from-any-app', title: 'Neon: Connect from any application' },
  atlasDrivers: { url: 'https://www.mongodb.com/docs/atlas/driver-connection/', title: 'MongoDB Atlas: Connect via drivers' },
  kiroSteering: { url: 'https://kiro.dev/docs/steering/', title: 'Kiro: Steering' },
} satisfies Record<string, Page>;

const cite = (page: Page, stance: SourceStance, note: string): ProvenanceSource => ({ ...page, readOn: READ_ON, stance, note });

/** A source read on a later date than the rest of this file (pcic-180m, PromptCI#253 review). */
const citeOn = (page: Page, readOn: string, stance: SourceStance, note: string): ProvenanceSource => ({ ...page, readOn, stance, note });

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
      'A string with the fixed prefix, alphabet and length a vendor issues (AWS AKIA/ASIA access key IDs, GitHub gh*_ tokens, GitLab glpat-, Slack xox*-, Stripe sk_live_/rk_live_, Anthropic sk-ant-, OpenAI sk-...T3BlbkFJ, Google AIza, npm_, hf_, SendGrid SG., OpenRouter sk-or-v1-, Groq gsk_, Supabase sb_secret_) or a Supabase service_role JWT (payload role claim service_role) or a database connection string with a non-placeholder password (postgres, mysql, mongodb) or a PEM block with a BEGIN-PRIVATE-KEY header line and a base64 body is a credential, not prose about one.',
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
      citeOn(PAGES.truffleOpenRouter, '2026-11-27', 'supports', 'Matches \\b(sk-or-v1-[0-9a-f]{64})\\b: the OpenRouter shape (gitleaks has no OpenRouter rule).'),
      citeOn(PAGES.truffleGroq, '2026-11-27', 'supports', 'Matches \\b(gsk_[a-zA-Z0-9]{52})\\b: the Groq shape (gitleaks has no Groq rule).'),
      citeOn(
        PAGES.supabaseCliDefaults,
        '2026-11-27',
        'context',
        'DEFAULT_LOCAL_SECRET_KEY is sb_secret_ plus 22 characters, an underscore and 8 more (31 after the prefix): the only length evidence for the Supabase secret key, and a published local key the detector skips.',
      ),
      citeOn(
        PAGES.supabaseApiKeys,
        '2026-11-27',
        'context',
        'Calls service_role a long-lived JWT with elevated privileges and the sb_secret_ key a short string, not a JWT; it gives the sb_secret_ prefix but no length, and does not name the role claim (the JWT check reads it from the payload).',
      ),
      citeOn(
        PAGES.neonConnect,
        '2026-11-27',
        'context',
        'Its example postgresql://alex:AbC123dEf@ep-cool-darkness-a1b2c3d4-pooler... shows that a documented stand-in password is shaped like a real one, so the detector skips placeholder words (abc123, replace, change, todo, ...) and ALL_CAPS_SNAKE values.',
      ),
      citeOn(
        PAGES.atlasDrivers,
        '2026-11-27',
        'context',
        'Shows mongodb+srv://<db_username>:<db_password>@... and mongodb://username:password@host1:port1 as the URI form; both carry stand-ins the detector does not report.',
      ),
    ],
    thresholds: [
      unverified('MIN_DISTINCT_CHARS', 12, 'inline-secrets.ts:MIN_DISTINCT_CHARS', 'distinct characters in the random part'),
      unverified('OpenAI marker-less key length', 100, 'inline-secrets.ts:SECRET_SHAPES (sk-proj-/sk-svcacct- body, 100 to 200)', 'base64url characters, lower bound (upper bound 200)'),
      unverified('Supabase secret key length', 22, 'inline-secrets.ts:SECRET_SHAPES (sb_secret_ body, 22 to 48)', 'base64url characters, lower bound (upper bound 48); the CLI default key has 31'),
      unverified('Connection string minimum password length', 8, 'inline-secrets.ts:isRealConnectionString', 'characters'),
      unverified('Connection string minimum distinct password characters', 5, 'inline-secrets.ts:SECRET_SHAPES (connection string minDistinct)', 'distinct characters in the password'),
      unverified('OpenRouter minimum distinct characters', 10, 'inline-secrets.ts:SECRET_SHAPES (OpenRouter minDistinct)', 'distinct hex characters of 64'),
      unverified('MIN_DISTINCT_CHARS_AWS', 8, 'inline-secrets.ts:MIN_DISTINCT_CHARS_AWS', 'distinct characters in an AWS key ID random part'),
      {
        name: 'MIN_PRIVATE_KEY_BODY',
        value: 64,
        unit: 'base64 characters',
        where: 'inline-secrets.ts:MIN_PRIVATE_KEY_BODY',
        source: cite(PAGES.gitleaks, 'supports', 'The private-key rule requires at least 64 characters between the BEGIN and END lines.'),
      },
    ],
    lastVerified: { date: '2026-11-27', by: 'agent run 2026-11-27 (pcic-180m, PromptCI#253 review), pending human review' },
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
        'Says bypassPermissions skips permission prompts and to use it only in isolated environments such as containers or VMs, that Bash, like Bash(*), matches all Bash commands, that a * in a Bash rule matches any text, and that the :* suffix is an equivalent trailing wildcard.',
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
