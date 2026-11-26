/**
 * pcic-k1t3.13: round-2 mechanical fix recipes.
 *
 * - pip-vs-poetry: a `pip install -r requirements.txt` in a Poetry project with no
 *   requirements.txt becomes `poetry install`.
 * - skill hidden-unicode: zero-width characters (and their Latin-1 mojibake) in a Markdown skill
 *   document are removed.
 *
 * Each recipe is all-or-nothing and refuses on any doubt: every refusal has a case that must stay
 * advisory (no `fixEdits`, no `autoApplySafe`). The applied output is asserted
 * byte-for-byte, and the rescan must no longer report the finding.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { scan } from '../src/scan.js';
import { applyFixRecipe, isRepairable, requiresOptIn } from '../src/fix-engine.js';
import { pipToPoetryEdits, MAX_RECIPE_EDITS } from '../src/manifest-fix-edits.js';
import type { PipRequirementsHit } from '../src/manifest-fix-edits.js';
import { hiddenUnicodeEdits } from '../src/skill-supply-chain.js';
import type { InstructionFile, PromptCiIssue } from '../src/types.js';
import { makeTempRepo, writeFile } from './ai-config-helpers.js';

const tempRepos: string[] = [];
afterEach(() => {
  for (const dir of tempRepos.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function repoWith(files: Record<string, string>): string {
  const repo = makeTempRepo('promptci-fix-r2-');
  tempRepos.push(repo);
  for (const [rel, content] of Object.entries(files)) writeFile(repo, rel, content);
  return repo;
}

/** Applies the finding's recipe the way `promptci fix` does (no opt-in) and returns the file. */
async function applied(repo: string, issue: PromptCiIssue, rel: string): Promise<string> {
  expect(isRepairable(issue)).toBe(true);
  expect(requiresOptIn(issue)).toBe(false);
  for (const change of await applyFixRecipe(issue, repo)) fs.writeFileSync(change.filePath, change.newContent, 'utf-8');
  return fs.readFileSync(path.join(repo, rel), 'utf-8');
}

function expectAdvisory(issue: PromptCiIssue): void {
  expect(issue.fixEdits).toBeUndefined();
  expect(issue.autoApplySafe).toBeUndefined();
}

describe('fixture-fix-recipes-round2', () => {
  it('carries both recipes, and applying them leaves neither finding', async () => {
    const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../examples/fixture-fix-recipes-round2');
    const repo = makeTempRepo('promptci-fix-r2-fixture-');
    tempRepos.push(repo);
    fs.cpSync(fixture, repo, { recursive: true });
    const issues = (await scan({ repoPath: repo })).issues;
    const pip = issues.find(isPip);
    const hidden = issues.find(isHidden);
    expect(pip?.autoApplySafe).toBe(true);
    expect(hidden?.autoApplySafe).toBe(true);
    expect(await applied(repo, pip!, 'CLAUDE.md')).toContain('\npoetry install\n');
    expect(await applied(repo, hidden!, '.claude/skills/scraped-docs/references/events.md')).toBe(
      ['# Events', '', '## ready[](#ready "Direct link to ready")', '', 'Emitted once the app has started.', '', '## quit[](#quit "Direct link to quit")', '', 'Emitted when the app quits.', ''].join('\n'),
    );
    const after = (await scan({ repoPath: repo })).issues;
    expect(after.find(isPip)).toBeUndefined();
    expect(after.find(isHidden)).toBeUndefined();
  });
});

// ── pip against Poetry ──────────────────────────────────────────────────────

const POETRY_PYPROJECT = ['[tool.poetry]', 'name = "demo"', 'version = "0.1.0"', '', '[tool.poetry.dependencies]', 'python = "^3.11"', ''].join('\n');

const PIP = 'pip install -r requirements.txt';

function poetryRepo(claude: string, extra: Record<string, string> = {}): string {
  return repoWith({ 'pyproject.toml': POETRY_PYPROJECT, 'CLAUDE.md': claude, ...extra });
}

const isPip = (i: PromptCiIssue) => i.title === 'Tooling mismatch: instruction uses pip but project uses Poetry';

async function pipFinding(repo: string): Promise<PromptCiIssue> {
  const issue = (await scan({ repoPath: repo })).issues.find(isPip);
  expect(issue).toBeDefined();
  return issue!;
}

describe('pip-vs-poetry recipe', () => {
  it('rewrites a fenced command and a code span, and the rescan no longer reports it', async () => {
    const before = ['# Demo', '', '## Setup', '', 'Install dependencies:', '', '```bash', PIP, '```', '', 'Then run `' + PIP + '`.', ''].join('\n');
    const repo = poetryRepo(before);
    const issue = await pipFinding(repo);
    expect(issue.autoApplySafe).toBe(true);
    expect(issue.fixEdits).toHaveLength(2);
    expect(await applied(repo, issue, 'CLAUDE.md')).toBe(before.split(PIP).join('poetry install'));
    expect((await scan({ repoPath: repo })).issues.find(isPip)).toBeUndefined();
  });

  it('rewrites a prompt, a numbered step and a label, and keeps CRLF line endings', async () => {
    const before = ['# Demo', '', '1. ' + PIP, '', '    ' + PIP, '', 'Install: ' + PIP + ' && pytest', ''].join('\r\n');
    const repo = poetryRepo(before);
    const issue = await pipFinding(repo);
    expect(await applied(repo, issue, 'CLAUDE.md')).toBe(before.split(PIP).join('poetry install'));
  });

  it('also rewrites a root dot-directory instruction file', async () => {
    const repo = poetryRepo('# Demo\n\nRun `' + PIP + '`.\n', {
      '.github/copilot-instructions.md': '# Copilot\n\nInstall with `' + PIP + '`.\n',
    });
    const issue = await pipFinding(repo);
    expect(issue.autoApplySafe).toBe(true);
    expect(issue.fixEdits).toHaveLength(2);
  });

  const refusals: Array<[string, string, Record<string, string>?]> = [
    ['python -m pip', 'Run `python -m ' + PIP + '`.'],
    ['sudo', 'Run `sudo ' + PIP + '`.'],
    ['uv pip', 'Run `uv ' + PIP + '`.'],
    ['a pip path', 'Run `.venv/bin/' + PIP + '`.'],
    ['a flag after the file', 'Run `' + PIP + ' --no-deps`.'],
    ['a second requirements file', 'Run `' + PIP + ' -r requirements-dev.txt`.'],
    ['a longer file name', 'Run `' + PIP + '.lock`.'],
    ['other spacing', 'Run `pip  install -r requirements.txt`.'],
    ['other case', 'Run `PIP install -r requirements.txt`.'],
    ['a Dockerfile fence', '```dockerfile\nRUN ' + PIP + '\n```'],
    ['a Dockerfile RUN in an unlabelled fence', '```\nRUN ' + PIP + '\n```'],
    ['an HTML comment', '<!--\n' + PIP + '\n-->'],
    ['a workflow sample fence', '```yaml\n- run: ' + PIP + '\n```'],
    ['a quoted command in a config sample', 'Set `"setup": "' + PIP + '"` in the task file.'],
    ['a second requirements.txt on the line', 'Run `' + PIP + '` (see requirements.txt for pins).'],
    ['a line past the length limit', 'x'.repeat(2000) + ' `' + PIP + '`'],
    ['a lead past the frame limit', 'x'.repeat(9000) + '\n\n`' + PIP + '`'],
    ['another directory in the lead', 'Inside `backend/`:\n\n```bash\n' + PIP + '\n```'],
    ['a negation', "Don't run `" + PIP + '`.'],
    ['an activated virtualenv on the line', '`source .venv/bin/activate && ' + PIP + '`'],
    ['a virtualenv in the lead', 'Create a virtualenv first, then:\n\n```bash\n' + PIP + '\n```'],
    ['another directory', '`cd backend && ' + PIP + '`'],
    ['directory wording', 'In the backend directory, run `' + PIP + '`.'],
    ['a heading naming pip', '## Using pip\n\n`' + PIP + '`'],
    ['a legacy heading', '## Legacy setup\n\n`' + PIP + '`'],
    ['a fallback', 'If Poetry is unavailable, run `' + PIP + '`.'],
    ['Poetry named on the line', 'Run `' + PIP + '` (Poetry users skip this).'],
    ['consumer wording', 'To use this library in your own project, run `' + PIP + '`.'],
    ['a link', 'Run `' + PIP + '` ([docs](https://pip.pypa.io)).'],
    ['poetry export', '`poetry export -f requirements.txt && ' + PIP + '`'],
    ['a second pip on the line', 'Run `' + PIP + '` with pip 23 or newer.'],
    ['uv.lock in the repository', 'Run `' + PIP + '`.', { 'uv.lock': 'version = 1\n' }],
    ['another requirements file below the root', 'Install: `' + PIP + '`.', { 'services/api/requirements.txt': 'fastapi\n' }],
    ['a setup script in the repository', 'Install: `' + PIP + '`.', { 'setup.py': 'from setuptools import setup\n' }],
    ['a workflow step in an unlabelled fence', '```\n- run: ' + PIP + '\n```'],
    ['a console transcript', '```console\n$ ' + PIP + '\nCollecting fastapi\n```'],
    ['a prompt in an unlabelled fence (a transcript)', '```\n$ ' + PIP + '\nCollecting fastapi\n```'],
    ['a text-fence transcript', '```text\n' + PIP + '\nCollecting fastapi\n```'],
    ['a prompt before the command', 'Then: $ ' + PIP],
    ['a dev-requirements file at the root', 'Install: `' + PIP + '`.', { 'dev-requirements.txt': 'pytest\n' }],
    ['a Nix shell', 'Inside the nix develop shell, run `' + PIP + '`.'],
    ['the system interpreter', 'With the system Python, run `' + PIP + '`.'],
    ['a Pipfile in the repository', 'Run `' + PIP + '`.', { Pipfile: '[packages]\n' }],
    ['a [tool.uv] table', 'Run `' + PIP + '`.', { 'pyproject.toml': POETRY_PYPROJECT + '\n[tool.uv]\ndev-dependencies = []\n' }],
  ];
  for (const [label, text, extra] of refusals) {
    it(`stays advisory: ${label}`, async () => {
      // A qualifying mention first, so the refusal is what keeps the finding advisory.
      const qualifying = '# Demo\n\n## Install\n\nRun `' + PIP + '`.\n\n## Notes\n\n';
      expectAdvisory(await pipFinding(poetryRepo(qualifying + text + '\n', extra)));
    });
  }

  it('stays advisory when one of several mentions does not qualify (all or nothing)', async () => {
    const repo = poetryRepo('# Demo\n\nRun `' + PIP + '`.\n\nOr `sudo ' + PIP + '`.\n');
    expectAdvisory(await pipFinding(repo));
  });

  it('stays advisory for an instruction file below the root (its requirements.txt may be another one)', async () => {
    const repo = poetryRepo('# Demo\n\nRun `' + PIP + '`.\n', {
      'ai/backend.md': '# Backend\n\nRun `' + PIP + '`.\n',
    });
    expectAdvisory(await pipFinding(repo));
  });

  it('stays advisory past the edit limit', async () => {
    const lines = Array.from({ length: MAX_RECIPE_EDITS + 1 }, () => '- `' + PIP + '`');
    expectAdvisory(await pipFinding(poetryRepo('# Demo\n\n' + lines.join('\n') + '\n')));
  });

  it('refuses more hits than one finding may carry', () => {
    const content = Array.from({ length: MAX_RECIPE_EDITS + 1 }, () => PIP).join('\n') + '\n';
    const f = { path: '/repo/CLAUDE.md', content } as InstructionFile;
    const hits = content.split('\n').slice(0, -1).map((_, i) => ({ file: f, index: i * (PIP.length + 1), text: PIP }));
    expect(pipToPoetryEdits([f], hits.slice(0, MAX_RECIPE_EDITS), () => false)).toHaveLength(MAX_RECIPE_EDITS);
    expect(pipToPoetryEdits([f], hits, () => false)).toBeUndefined();
  });

  it('answers hostile input in linear time', () => {
    const file = (content: string): InstructionFile => ({ path: '/repo/CLAUDE.md', content }) as InstructionFile;
    const hitsIn = (f: InstructionFile): PipRequirementsHit[] => {
      const hits: PipRequirementsHit[] = [];
      const re = /pip\s+install\s+-r\s+requirements\.txt/gi;
      for (let m = re.exec(f.content); m !== null && hits.length < MAX_RECIPE_EDITS; m = re.exec(f.content)) {
        hits.push({ file: f, index: m.index, text: m[0] });
      }
      return hits;
    };
    const shapes = [
      // One very long line of commands, and one of backticks and spaces before a command.
      (PIP + ' && ').repeat(6000),
      '` '.repeat(60_000) + PIP,
      // Half a million lines: a deep heading chain and lead lines above one command.
      Array.from({ length: 500_000 }, (_, i) => (i % 2 === 0 ? '#'.repeat(1 + (i % 6)) + ' h' : 'x')).join('\n') + '\n' + PIP + '\n',
      // Many short commands, each a hit.
      Array.from({ length: 200_000 }, () => PIP).join('\n'),
    ];
    for (const content of shapes) {
      const f = file(content);
      const started = performance.now();
      pipToPoetryEdits([f], hitsIn(f), () => true);
      expect(performance.now() - started).toBeLessThan(1500);
    }
  });
});

// ── skill hidden-unicode ────────────────────────────────────────────────────

const ZWSP = '​';
/** A zero-width space whose UTF-8 bytes were read as Latin-1 and saved again. */
const MOJIBAKE_ZWSP = 'â\u0080\u008b';

const SKILL_MD = ['---', 'name: demo', 'description: Demo skill used when the user asks for a demo run.', '---', '', 'Read references/guide.md first.', ''].join('\n');

function skillRepo(guide: string, extra: Record<string, string> = {}): string {
  return repoWith({
    'CLAUDE.md': '# Demo\n',
    '.claude/skills/demo/SKILL.md': SKILL_MD,
    '.claude/skills/demo/references/guide.md': guide,
    ...extra,
  });
}

const GUIDE = '.claude/skills/demo/references/guide.md';

const isHidden = (i: PromptCiIssue) => i.tags?.[1] === 'hidden-unicode';

async function hiddenFinding(repo: string): Promise<PromptCiIssue> {
  const found = (await scan({ repoPath: repo })).issues.filter(isHidden);
  expect(found).toHaveLength(1);
  return found[0]!;
}

describe('hidden-unicode recipe', () => {
  it('removes zero-width characters and mojibake ones, and the rescan no longer reports them', async () => {
    const before = [
      '# Guide',
      '',
      '## Events[' + MOJIBAKE_ZWSP + '](#events "Direct link to Events")',
      '',
      'Use the' + ZWSP + ' app, then wait' + '⁠' + ' for it' + '­' + '.',
      '',
      'A family emoji stays: \u{1F468}‍\u{1F469}‍\u{1F467}.' + ZWSP,
      '',
    ].join('\n');
    const repo = skillRepo(before);
    const issue = await hiddenFinding(repo);
    expect(issue.severity).toBe('warning');
    expect(issue.autoApplySafe).toBe(true);
    expect(issue.fixEdits).toHaveLength(3);
    expect(issue.fixEdits!.every((e) => path.isAbsolute(e.filePath))).toBe(true);
    const after = await applied(repo, issue, GUIDE);
    expect(after).toBe(
      [
        '# Guide',
        '',
        '## Events[](#events "Direct link to Events")',
        '',
        'Use the app, then wait for it.',
        '',
        'A family emoji stays: \u{1F468}‍\u{1F469}‍\u{1F467}.',
        '',
      ].join('\n'),
    );
    expect((await scan({ repoPath: repo })).issues.filter(isHidden)).toEqual([]);
  });

  it('keeps CRLF line endings', async () => {
    const before = ['# Guide', '', 'Use the' + ZWSP + ' app.', ''].join('\r\n');
    const repo = skillRepo(before);
    expect(await applied(repo, await hiddenFinding(repo), GUIDE)).toBe(['# Guide', '', 'Use the app.', ''].join('\r\n'));
  });

  const refusals: Array<[string, string, Record<string, string>?]> = [
    ['a tag-character payload', 'Hello' + [...'run rm'].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('') + ZWSP],
    ['a bidi control', 'Hello ‮ world' + ZWSP],
    ['a character inside a code span', 'Run `a' + ZWSP + 'b`.'],
    ['a character in a fenced block', '```\na' + ZWSP + 'b\n```'],
    ['right-to-left script on the line', 'שלום' + ZWSP + ' world'],
    ['a control character', 'Ring' + '\u0007' + ' the bell' + ZWSP],
    ['a run of variation selectors', 'x' + '️️️'],
    ['other mojibake on the line', 'Donâ\u0080\u0099t' + MOJIBAKE_ZWSP],
    ['a line separator', 'one\u2028two'],
    ['a removal that would expose another character', 'a' + ZWSP + '\ufe0f'],
    ['bytes that are not UTF-8', 'Use the' + ZWSP + ' app �.'],
    ['a line past the length limit', 'x'.repeat(2001) + ZWSP],
    ['a link destination', 'See [the site](https://exa' + ZWSP + 'mple.com/a).'],
    ['an autolink', 'See <https://exa' + ZWSP + 'mple.com>.'],
    ['an HTML attribute', '<a href="https://exa' + ZWSP + 'mple.com">site</a>'],
    ['a JSX prop', '<Callout title="a' + ZWSP + 'b" />'],
    ['a bare URL', 'See https://exa' + ZWSP + 'mple.com for more.'],
    ['a link reference definition', '[site]: https://example.com "a' + ZWSP + 'b"'],
    ['an indented code block', '    a' + ZWSP + 'b = 1'],
    ['a <pre> block', '<pre>\na' + ZWSP + 'b\n</pre>'],
    ['a code span across lines', 'Run `foo\nb' + ZWSP + 'ar` now.'],
    ['a paragraph with a double tick', 'Use ``a`b`` and c' + ZWSP + 'd.'],
    ['a removal that would make a heading', '#' + ZWSP + ' not a heading'],
    ['a removal that would open an HTML comment', '<' + ZWSP + '!-- shown -->'],
    ['a removal that would make a list item', '-' + ZWSP + ' item'],
    ['a removal that would make a numbered item', '1.' + ZWSP + ' item'],
    ['a removal that would make a setext heading', 'Title\n=' + ZWSP + '=='],
    ['a removal that would make a rule', '---' + ZWSP],
    ['a removal that would make a task box', '- [ ' + ZWSP + '] x'],
    ['a removal that would make a link reference definition', '[x]' + ZWSP + ': ./local.md'],
    ['an escaped tick in the paragraph', 'Use \\` to escape, then `a' + ZWSP + 'b` x'],
    ['a removal that would form a bare URL', 'ww' + ZWSP + 'w.example.com'],
    ['a removal that would form an address', 'a@b' + ZWSP + '.com'],
    ['a dot inside a word', 'file' + ZWSP + '.name here'],
    ['a <script> body', '<script>\nvar a = "x' + ZWSP + 'y";\n</script>'],
    ['a <kbd> element', 'Press <kbd>Ctrl' + ZWSP + 'C</kbd>.'],
    ['math', 'The sum $a' + ZWSP + 'b$ holds.'],
    ['a removal that would join emoji', '\u{1F469}' + ZWSP + '\u200d\u{1F4BB}'],
  ];
  for (const [label, line] of refusals) {
    it(`stays advisory: ${label}`, async () => {
      expectAdvisory(await hiddenFinding(skillRepo('# Guide\n\nFine' + ZWSP + ' line.\n\n' + line + '\n')));
    });
  }

  it('stays advisory for a character in the SKILL.md frontmatter', async () => {
    const repo = repoWith({
      'CLAUDE.md': '# Demo\n',
      '.claude/skills/demo/SKILL.md': ['---', 'name: demo', 'description: Demo' + ZWSP + ' skill used when the user asks for a demo run.', '---', '', 'Body.', ''].join('\n'),
    });
    expectAdvisory(await hiddenFinding(repo));
  });

  it('stays advisory for a reference document frontmatter', async () => {
    expectAdvisory(await hiddenFinding(skillRepo(['---', 'title: a' + ZWSP + 'b', '---', '', '# Guide', ''].join('\n'))));
  });

  for (const ext of ['txt', 'mdx']) {
    it(`stays advisory for a .${ext} document`, async () => {
      const repo = skillRepo('# Guide\n', { [`.claude/skills/demo/references/notes.${ext}`]: 'Use the' + ZWSP + ' app.\n' });
      expectAdvisory(await hiddenFinding(repo));
    });
  }

  it('stays advisory for a script (a zero-width character in code may be data)', async () => {
    const repo = skillRepo('# Guide\n', { '.claude/skills/demo/scripts/split.py': 'print("a' + ZWSP + 'b".split("' + ZWSP + '"))\n' });
    expectAdvisory(await hiddenFinding(repo));
  });

  it('stays advisory past the edit limit', async () => {
    const lines = Array.from({ length: 51 }, (_, i) => 'Line ' + i + ZWSP);
    expectAdvisory(await hiddenFinding(skillRepo('# Guide\n\n' + lines.join('\n') + '\n')));
  });

  it('answers hostile input in linear time', () => {
    const plan = (content: string) => {
      const lines = content.split(/\r?\n/);
      const started = performance.now();
      hiddenUnicodeEdits({ filePath: 'guide.md', content, lines, fenced: new Uint8Array(lines.length) });
      expect(performance.now() - started).toBeLessThan(1500);
    };
    plan(ZWSP.repeat(120_000));
    plan(('`' + ZWSP).repeat(60_000));
    plan(MOJIBAKE_ZWSP.repeat(40_000));
    plan(Array.from({ length: 300_000 }, () => 'a' + ZWSP).join('\n'));
    plan(Array.from({ length: 300_000 }, () => 'plain line').join('\n') + '\n' + ZWSP);
    // Openers and URL markers with no closer or space, on a line of the longest edited length.
    plan('see ' + ZWSP + ' ' + ']('.repeat(998));
    plan('see ' + ZWSP + ' ' + '<'.repeat(1996));
    plan('see ' + ZWSP + ' ' + '://'.repeat(665));
    plan(Array.from({ length: 49 }, () => 'a' + ZWSP + ' ' + '](x'.repeat(600)).join('\n'));
    plan(Array.from({ length: 200_000 }, () => '`').join('\n') + '\n' + ZWSP);
    // A long marker run and a gap after each character of a line.
    plan('-'.repeat(1990) + ZWSP + 'x');
    plan(Array.from({ length: 50 }, () => ('a' + ZWSP).repeat(1000)).join('\n'));
  });
});
