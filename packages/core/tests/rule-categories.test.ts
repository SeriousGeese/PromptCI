/**
 * The rule categories added in pcic-k1t3.10 part 2 (inline secrets, agent permissions,
 * rule activation) and the two false positives that pass removed (a `process.env` code
 * span read as a file, a quoted "always/never" read as a directive).
 *
 * Credential-shaped strings are assembled at run time: a literal token in this
 * repository would be picked up by secret scanners and push protection.
 */

import * as fs from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { buildRepoContext } from '../src/repo-context.js';
import { detectInlineSecrets, findSecrets, looksMadeUp } from '../src/inline-secrets.js';
import { detectAgentPermissions } from '../src/agent-permissions.js';
import { detectRuleActivation } from '../src/rule-activation-detector.js';
import { detectDeadReferences } from '../src/dead-references.js';
import { detectConflicts } from '../src/conflicts.js';
import { parseSections } from '../src/scanner.js';
import type { InstructionFile } from '../src/types.js';
import { makeTempRepo, writeFile } from './ai-config-helpers.js';
import { scan } from '../src/scan.js';
import * as path from 'node:path';

const EXAMPLES = path.resolve(__dirname, '../../../examples');
const NEW_DETECTOR_ID = /^(?:inline-secret|agent-permissions|ai-config-rule-activation)-/;

describe('fixtures', () => {
  it('fixture-rule-categories raises each config finding once', async () => {
    const report = await scan({ repoPath: path.join(EXAMPLES, 'fixture-rule-categories') });
    const kinds = report.issues.filter((i) => NEW_DETECTOR_ID.test(i.id)).map((i) => i.tags?.[1] ?? i.id).sort();
    expect(kinds).toEqual(
      [
        'claude-allow-all-shell',
        'claude-bypass-mode',
        'codex-no-approval-no-sandbox',
        'kiro-auto-missing-fields',
        'kiro-file-ref-missing',
        'kiro-filematch-without-pattern',
        'kiro-frontmatter-not-first',
        'windsurf-glob-without-globs',
        'windsurf-unknown-trigger',
      ].sort(),
    );
  });

  it('fixture-rule-categories-clean raises none of them, and no process.env or quoted-claim noise', async () => {
    const report = await scan({ repoPath: path.join(EXAMPLES, 'fixture-rule-categories-clean') });
    expect(report.issues.filter((i) => NEW_DETECTOR_ID.test(i.id)).map((i) => i.title)).toEqual([]);
    expect(report.issues.filter((i) => i.category === 'conflict' || /process\.env|import\.meta/.test(i.title)).map((i) => i.title)).toEqual([]);
  });
});

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = makeTempRepo('promptci-rule-categories-');
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) writeFile(root, rel, content);
  return root;
}

async function run<T>(files: Record<string, string>, detector: (context: Awaited<ReturnType<typeof buildRepoContext>>) => T): Promise<T> {
  return detector(await buildRepoContext({ repoPath: repo(files) }));
}

/** A body that looks issued: varied characters, no run, no counting sequence. */
function body(length: number, alphabet = 'Zq8mT3vR7kPx2Lw9NcYb4Hs6Jd5Gf1Ue0QaVrXo'): string {
  let out = '';
  for (let i = 0; out.length < length; i++) out += alphabet[(i * 7 + 3) % alphabet.length];
  return out.slice(0, length);
}
const UPPER32 = 'QWERTYUPASDFGHJKLZXCVBNM234567';

const TOKENS: Array<[kind: string, token: string]> = [
  ['AWS access key ID', 'AK' + 'IA' + body(16, UPPER32)],
  ['GitHub token', 'gh' + 'p_' + body(36)],
  ['GitHub fine-grained token', 'github' + '_pat_' + body(82)],
  ['GitLab personal access token', 'glp' + 'at-' + body(20)],
  ['Slack token', 'xo' + 'xb-' + '73029485613' + '-' + '48261937052' + '-' + body(24)],
  ['Stripe live key', 'sk' + '_live_' + body(30)],
  ['Anthropic API key', 'sk-' + 'ant-api03-' + body(93) + 'AA'],
  ['OpenAI API key', 'sk-' + 'proj-' + body(58) + 'T3Blbk' + 'FJ' + body(58)],
  ['Google API key', 'AI' + 'za' + body(35)],
  ['npm access token', 'np' + 'm_' + body(36)],
  ['Hugging Face token', 'h' + 'f_' + body(34, 'ZqmTvRkPxLwNcYbHsJdGfUeQaVrXo')],
  ['SendGrid API key', 'S' + 'G.' + body(22) + '.' + body(43)],
];

describe('inline-secrets', () => {
  it.each(TOKENS)('finds a %s and never repeats it', async (kind, token) => {
    const issues = await run({ 'AGENTS.md': '# Setup\n\nexport KEY=' + token + '\n' }, detectInlineSecrets);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('high');
    expect(issues[0]!.category).toBe('security');
    expect(issues[0]!.evidence[0]).toContain(kind);
    expect(issues[0]!.locations[0]!.startLine).toBe(3);
    expect(JSON.stringify(issues[0])).not.toContain(token);
  });

  it('finds a PEM private key with a body', () => {
    const pem = ['-----BEGIN ' + 'RSA PRIVATE KEY-----', body(64), body(64), '-----END RSA PRIVATE KEY-----'].join('\n');
    expect(findSecrets('Key:\n' + pem + '\n').map((h) => h.kind)).toEqual(['private key']);
  });

  it('reads the shared agent config files, not the personal one', async () => {
    const token = 'gh' + 'p_' + body(36);
    const mcp = JSON.stringify({ mcpServers: { gh: { command: 'npx', env: { GITHUB_TOKEN: token } } } }, null, 2);
    const issues = await run(
      { 'AGENTS.md': '# Rules\n', '.mcp.json': mcp, '.claude/settings.local.json': JSON.stringify({ env: { T: token } }) },
      detectInlineSecrets,
    );
    expect(issues.map((i) => i.title)).toEqual(['Possible credential in .mcp.json']);
    expect(issues[0]!.locations[0]!.startLine).toBe(6);
  });

  it.each([
    ['prose about a prefix', 'AWS keys start with AKIA and GitHub tokens with ghp_; never paste one here.'],
    ["AWS's documentation key", 'export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE'],
    ['a placeholder of x', 'GITHUB_TOKEN=gh' + 'p_' + 'x'.repeat(36)],
    ['a counting placeholder', 'GITHUB_TOKEN=gh' + 'p_' + '1234567890abcdefghij1234567890abcdef'],
    ['a short prefix-only value', 'ANTHROPIC_API_KEY=sk-ant-api03-...'],
    ['an environment reference', 'Use $ANTHROPIC_API_KEY and ${env:GITHUB_TOKEN}.'],
    ['a test-mode Stripe key', 'STRIPE_KEY=sk' + '_test_' + body(30)],
    ['a key header with an elided body', '-----BEGIN ' + 'PRIVATE KEY-----\nMIIEv...\n-----END PRIVATE KEY-----'],
    ['a key header with no END line', '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----\n' + body(80)],
  ])('stays silent on %s', async (_label, text) => {
    expect(await run({ 'CLAUDE.md': '# Notes\n\n' + text + '\n' }, detectInlineSecrets)).toEqual([]);
  });

  it('treats few distinct characters as made up', () => {
    expect(looksMadeUp('gh' + 'p_' + 'abab'.repeat(9), 4)).toBe(true);
    expect(looksMadeUp('gh' + 'p_' + body(36), 4)).toBe(false);
  });
});

describe('agent-permissions', () => {
  it('reports bypassPermissions and an allow-all shell rule in the shared settings', async () => {
    const settings = JSON.stringify({ permissions: { defaultMode: 'bypassPermissions', allow: ['Bash(*)', 'Read'] } }, null, 2);
    const issues = await run({ '.claude/settings.json': settings }, detectAgentPermissions);
    expect(issues.map((i) => i.tags?.[1])).toEqual(['claude-bypass-mode', 'claude-allow-all-shell']);
    expect(issues.every((i) => i.severity === 'warning' && i.category === 'security')).toBe(true);
    expect(issues[0]!.locations[0]!.startLine).toBe(3);
  });

  it('reports a bare Bash allow rule', async () => {
    const issues = await run({ '.claude/settings.json': JSON.stringify({ permissions: { allow: ['Bash'] } }) }, detectAgentPermissions);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.title).toContain('allow every shell command');
  });

  it.each([
    ['the personal settings file', { '.claude/settings.local.json': JSON.stringify({ permissions: { defaultMode: 'bypassPermissions', allow: ['Bash'] } }) }],
    ['narrow allow rules', { '.claude/settings.json': JSON.stringify({ permissions: { defaultMode: 'acceptEdits', allow: ['Bash(npm run test *)', 'Bash(git diff *)'] } }) }],
    ['a deny rule of Bash', { '.claude/settings.json': JSON.stringify({ permissions: { deny: ['Bash'] } }) }],
    ['invalid JSON', { '.claude/settings.json': '{ "permissions": { "defaultMode": "bypassPermissions" ' }],
    ['Codex without approvals but sandboxed', { '.codex/config.toml': 'approval_policy = "never"\nsandbox_mode = "workspace-write"\n' }],
    ['Codex full access in a profile only', { '.codex/config.toml': 'model = "gpt-5"\n\n[profiles.ci]\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n' }],
  ])('stays silent on %s', async (_label, files) => {
    expect(await run(files as Record<string, string>, detectAgentPermissions)).toEqual([]);
  });

  it('reports a Codex config with no approval and no sandbox', async () => {
    const issues = await run(
      { '.codex/config.toml': '# shared\nmodel = "gpt-5"\napproval_policy = "never" # unattended\nsandbox_mode = \'danger-full-access\'\n' },
      detectAgentPermissions,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.locations[0]!.startLine).toBe(3);
    expect(issues[0]!.evidence).toEqual(['approval_policy = "never" (line 3)', 'sandbox_mode = "danger-full-access" (line 4)']);
  });
});

describe('ai-config-rule-activation', () => {
  const kinds = async (files: Record<string, string>) => (await run(files, detectRuleActivation)).map((i) => i.tags?.[1]);

  it('reports Windsurf triggers that cannot load as written', async () => {
    const found = await kinds({
        '.windsurf/rules/a.md': '---\ntrigger: glob\n---\n# Tests\n',
        '.windsurf/rules/b.md': '---\ntrigger: always\n---\n# Rules\n',
        '.devin/rules/c.md': '---\ntrigger: model_decision\n---\n# API\n',
      });
    expect(found).toHaveLength(3);
    expect(
      await kinds({
        '.windsurf/rules/a.md': '---\ntrigger: glob\n---\n# Tests\n',
        '.windsurf/rules/b.md': '---\ntrigger: always\n---\n# Rules\n',
        '.devin/rules/c.md': '---\ntrigger: model_decision\n---\n# API\n',
      }),
    ).toEqual(expect.arrayContaining(['windsurf-glob-without-globs', 'windsurf-unknown-trigger', 'windsurf-model-decision-without-description']));
  });

  it('accepts well-formed Windsurf and Kiro rules', async () => {
    expect(
      await kinds({
        '.windsurf/rules/a.md': '---\ntrigger: glob\nglobs: "**/*.test.ts"\n---\n# Tests\n',
        '.windsurf/rules/b.md': '---\ntrigger: always_on\n---\n# Rules\n',
        '.windsurf/rules/c.md': '---\ntrigger: model_decision\ndescription: API conventions\n---\n# API\n',
        '.windsurf/rules/d.md': '# No frontmatter at all\n',
        '.kiro/steering/a.md': '---\ninclusion: fileMatch\nfileMatchPattern: ["components/**/*.tsx"]\n---\n# UI\n',
        '.kiro/steering/b.md': '---\ninclusion: auto\nname: api\ndescription: REST conventions\n---\n# API\n',
        '.kiro/steering/c.md': '---\ninclusion: manual\n---\nSee #[[file:docs/api.md]] and #[[file:docs/api.md:10-20]].\n',
        'docs/api.md': '# API\n',
      }),
    ).toEqual([]);
  });

  it('reports Kiro inclusion modes that cannot load as written', async () => {
    const issues = await run(
      {
        '.kiro/steering/a.md': '---\ninclusion: fileMatch\n---\n# UI\n',
        '.kiro/steering/b.md': '---\ninclusion: auto\nname: api\n---\n# API\n',
        '.kiro/steering/c.md': '---\ninclusion: sometimes\n---\n# X\n',
        '.kiro/steering/d.md': '\n\n---\ninclusion: manual\n---\n# Y\n',
      },
      detectRuleActivation,
    );
    expect(issues.map((i) => i.tags?.[1]).sort()).toEqual(
      ['kiro-auto-missing-fields', 'kiro-filematch-without-pattern', 'kiro-frontmatter-not-first', 'kiro-unknown-inclusion'].sort(),
    );
    expect(issues.find((i) => i.tags?.[1] === 'kiro-frontmatter-not-first')!.locations[0]!.startLine).toBe(3);
  });

  it('reports a Kiro file reference to a missing file, once per path', async () => {
    const issues = await run(
      { '.kiro/steering/a.md': '# A\n\n#[[file:docs/gone.md]]\n#[[file:docs/gone.md]]\n#[[file:docs/here.md]]\n#[[file:../outside.md]]\n', 'docs/here.md': '# Here\n' },
      detectRuleActivation,
    );
    expect(issues.map((i) => i.title)).toEqual(['Kiro file reference to a missing file: docs/gone.md']);
    expect(issues[0]!.locations[0]!.startLine).toBe(3);
  });

  it('leaves other tools\' files alone', async () => {
    expect(await kinds({ 'AGENTS.md': '---\ntrigger: glob\ninclusion: fileMatch\n---\n#[[file:gone.md]]\n' })).toEqual([]);
  });
});

function instructionFile(path: string, content: string): InstructionFile {
  return {
    path,
    relativePath: path.replace(/^\/repo\//, ''),
    fileType: 'agents',
    content,
    sections: parseSections(content, path),
    lineCount: content.split('\n').length,
    charCount: content.length,
    estimatedTokens: Math.round(content.length / 4),
  };
}

describe('false positives part 1 found on the new rule files', () => {
  it('does not read a runtime env object in a code span as a file', async () => {
    const root = repo({ 'AGENTS.md': '# Env\n\nThe CLI reads `process.env`, Vite `import.meta.env`, Deno `Deno.env`. Copy `.env` to `config/app.env`.\n' });
    const context = await buildRepoContext({ repoPath: root });
    const refs = detectDeadReferences(context.files, root).flatMap((i) => i.evidence);
    expect(refs).toEqual(['Reference: `config/app.env`']);
  });

  it('does not read a quoted always/never as a directive', () => {
    const text = [
      '# Review',
      '',
      '- Is a "the repo always does X" claim actually checked across the repo?',
      '- Every "the repo always/never does X" claim: did I grep the other cases?',
      '- \u201CWe never do X\u201D is a claim to check, not a rule.',
    ].join('\n');
    expect(detectConflicts([instructionFile('/repo/AGENTS.md', text)])).toEqual([]);
  });

  it('still reports a conflict whose directives are not quoted', () => {
    const text = ['# Rules', '', 'Always use pnpm for installs.', '', '## Later', '', 'Never use pnpm for installs.'].join('\n');
    expect(detectConflicts([instructionFile('/repo/AGENTS.md', text)]).length).toBeGreaterThan(0);
  });

  it('a stray inch mark does not quote the rest of the line', () => {
    const text = ['# Rules', '', 'Use a 27" monitor. Always use pnpm for installs.', '', '## Later', '', 'Never use pnpm for installs.'].join('\n');
    expect(detectConflicts([instructionFile('/repo/AGENTS.md', text)]).length).toBeGreaterThan(0);
  });
});

/** Budget for one detector on one hostile file of about 120 KB, as in hostile-input-detectors.test.ts. */
const BUDGET_MS = 2000;
const SIZE = 120_000;
const oneLine = (unit: string) => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
const manyLines = (make: (i: number) => string) => {
  const lines: string[] = [];
  for (let i = 0, size = 0; size < SIZE; i++) {
    lines.push(make(i));
    size += lines[lines.length - 1]!.length + 1;
  }
  return lines.join('\n') + '\n';
};

describe('hostile input stays linear', () => {
  const HOSTILE: Array<[label: string, text: string]> = [
    ['one line of a token prefix', oneLine('sk-proj-')],
    ['one line of OpenAI-shaped fragments', oneLine('sk-proj-' + 'a'.repeat(150) + 'T3Blbk')],
    ['one line of AKIA', oneLine('AKIA')],
    ['lines of private-key headers with no END', manyLines(() => '-----BEGIN ' + 'RSA PRIVATE KEY-----')],
    ['private-key headers and one far END', manyLines(() => '-----BEGIN ' + 'PRIVATE KEY-----') + '-----END PRIVATE KEY-----'],
    ['one line of PRIVATE KEY', oneLine('PRIVATE KEY ')],
    ['one line of Kiro file references', oneLine('#[[file:docs/x.md]] ')],
    ['one line of unclosed Kiro references', oneLine('#[[file:')],
    ['one line of quotes and always', oneLine('"always ')],
    ['one line of curly-quoted directives', oneLine('\u201Calways use pnpm\u201D ')],
    ['one line of unclosed curly quotes', oneLine('\u201C')],
    ['lines of quoted directives', manyLines((i) => 'Never "always use tool' + i + '" here.')],
  ];

  it.each(HOSTILE)('%s', async (_label, text) => {
    const root = repo({
      'CLAUDE.md': text,
      '.kiro/steering/a.md': '---\ninclusion: always\n---\n' + text,
      '.windsurf/rules/a.md': '---\ntrigger: glob\n---\n' + text,
      '.mcp.json': text,
      '.codex/config.toml': manyLines((i) => 'key' + i + ' = "' + 'v'.repeat(i % 300) + '"'),
      '.claude/settings.json': JSON.stringify({ permissions: { allow: Array.from({ length: 5000 }, (_, i) => 'Bash(x' + i + ')') } }),
    });
    const context = await buildRepoContext({ repoPath: root });
    const slow: string[] = [];
    for (const [id, fn] of [
      ['inline-secrets', () => detectInlineSecrets(context)],
      ['agent-permissions', () => detectAgentPermissions(context)],
      ['rule-activation', () => detectRuleActivation(context)],
      ['conflicts', () => detectConflicts(context.files)],
      ['dead-references', () => detectDeadReferences(context.files, root)],
    ] as const) {
      const start = performance.now();
      fn();
      const ms = performance.now() - start;
      if (ms >= BUDGET_MS) slow.push(id + ' ' + Math.round(ms) + ' ms');
    }
    expect(slow).toEqual([]);
  }, 120_000);
});
