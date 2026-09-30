/**
 * pcic-0r0: skill file references resolve beside the skill OR from the repo
 * root, leading-slash references mean repo root, and the structural skill
 * checks cover every skill location (.claude/, .agents/skills/, plugins).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { detectSkills, extractFileRefs } from '../src/skills-detector.js';
import { createGitIgnoreChecker } from '../src/gitignore.js';
import { scan } from '../src/scan.js';
import { ctx, makeTempRepo, writeFile } from './ai-config-helpers.js';

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../examples/fixture-path-references',
);

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function repo(): string {
  const dir = makeTempRepo('promptci-skillrefs-');
  cleanups.push(dir);
  return dir;
}

const FRONTMATTER = ['---', 'name: demo', 'description: Demonstrates skill reference resolution rules', '---'];

function skill(dir: string, body: string[], rel = '.claude/skills/demo/SKILL.md'): void {
  writeFile(dir, rel, [...FRONTMATTER, ...body].join('\n'));
}

function deadRefs(dir: string): string[] {
  return detectSkills(ctx(dir))
    .filter((i) => i.title.includes('bundled file'))
    .flatMap((i) => i.evidence.filter((e) => e.startsWith('Reference: ')).map((e) => e.slice('Reference: '.length)))
    .sort();
}

describe('skill references resolve from the skill directory or the repo root', () => {
  it.each(['.claude/skills/demo/SKILL.md', '.agents/skills/demo/SKILL.md'])(
    'does not flag repo-root-relative paths (%s)',
    (rel) => {
      const dir = repo();
      writeFile(dir, 'Docs/contract.md', '# contract');
      writeFile(dir, '.github/workflows/ci.yml', 'name: ci');
      writeFile(dir, 'src/app/page.tsx', 'export default function Page() { return null; }');
      skill(dir, ['See `Docs/contract.md`, `.github/workflows/ci.yml` and [page](src/app/page.tsx).'], rel);
      expect(deadRefs(dir)).toEqual([]);
    },
  );

  it('still resolves bundled files beside the skill', () => {
    const dir = repo();
    writeFile(dir, '.claude/skills/demo/scripts/run.py', 'print(1)');
    skill(dir, ['Run `scripts/run.py` first.']);
    expect(deadRefs(dir)).toEqual([]);
  });

  it('flags a reference that resolves from neither place, and says so', () => {
    const dir = repo();
    skill(dir, ['Read `Docs/gone.md`.']);
    const finding = detectSkills(ctx(dir)).find((i) => i.title.includes('bundled file'));
    expect(finding).toBeDefined();
    expect(finding!.summary).toContain('skill directory or the repository root');
    expect(finding!.evidence.join(' ')).toContain('.claude/skills/demo/Docs/gone.md');
    expect(finding!.evidence.join(' ')).toContain('Docs/gone.md');
  });

  it('resolves a plugin skill against its plugin root too', () => {
    const dir = repo();
    writeFile(dir, 'plugins/p/scripts/tool.sh', '#!/bin/sh');
    skill(dir, ['Run `scripts/tool.sh`.'], 'plugins/p/skills/demo/SKILL.md');
    expect(deadRefs(dir)).toEqual([]);
  });
});

describe('leading-slash references are repo-root-relative', () => {
  it('does not flag an existing /Docs/x.md', () => {
    const dir = repo();
    writeFile(dir, 'Docs/contract.md', '# contract');
    skill(dir, ['Read `/Docs/contract.md` and [ci](/Docs/contract.md).']);
    expect(deadRefs(dir)).toEqual([]);
  });

  it('flags /Docs/gone.md when Docs/ exists but the file does not', () => {
    const dir = repo();
    writeFile(dir, 'Docs/contract.md', '# contract');
    skill(dir, ['Read `/Docs/gone.md`.']);
    const finding = detectSkills(ctx(dir)).find((i) => i.title.includes('bundled file'));
    expect(finding).toBeDefined();
    expect(finding!.summary).toContain('from the repository root');
    expect(deadRefs(dir)).toEqual(['/Docs/gone.md']);
  });

  it('ignores a leading-slash path whose first segment is not in the repo (system path)', () => {
    const dir = repo();
    skill(dir, ['Logs go to `/var/log/app/output.log`; the binary is `/usr/local/bin/tool.sh`.']);
    expect(deadRefs(dir)).toEqual([]);
  });

  it('extractFileRefs keeps leading-slash paths and still drops URLs and protocol-relative links', () => {
    const refs = extractFileRefs('`/Docs/a.md` [b](//cdn.example.com/x.js) [c](https://e.com/y.md) `C:\\x\\y.md`');
    expect(refs.map((r) => r.ref)).toEqual(['/Docs/a.md']);
  });
});

describe('paths that are not part of a checkout are not dead references', () => {
  it('skips home-directory, .git and prohibition references', () => {
    const dir = repo();
    skill(dir, [
      'Token in `~/.tool/token.json` or `$HOME/.tool/config.yaml`.',
      'Cache in `.git/tool/cache.json`.',
      'Never commit `state/local.json`; do not stage `out/report.html`.',
    ]);
    expect(deadRefs(dir)).toEqual([]);
  });

  it('skips files the repository ignores (root and nested .gitignore)', () => {
    const dir = repo();
    writeFile(dir, '.gitignore', '*.db\n/data/\n');
    writeFile(dir, '.beads/.gitignore', 'issues.jsonl\n');
    writeFile(dir, 'data/.keep', '');
    skill(dir, ['Reads `.beads/issues.jsonl`, `var/app.db` and `/data/app.sqlite`, plus `docs/gone.md`.']);
    expect(deadRefs(dir)).toEqual(['docs/gone.md']);
  });
});

describe('structural skill checks cover every skill location', () => {
  it('audits .agents/skills and plugin skills, not just .claude/', () => {
    const dir = repo();
    writeFile(dir, '.agents/skills/a/SKILL.md', '# no frontmatter');
    writeFile(dir, 'skills/b/SKILL.md', '---\nname: other\ndescription: Mismatched name and directory\n---\nbody');
    writeFile(dir, 'plugins/p/skills/c/SKILL.md', '---\nname: c\n---\nbody');
    const titles = detectSkills(ctx(dir)).map((i) => i.title).sort();
    expect(titles).toEqual([
      'Skill `name` does not match its directory',
      'Skill frontmatter is missing `description`',
      'Skill is missing YAML frontmatter',
    ]);
  });
});

describe('createGitIgnoreChecker', () => {
  function checker(files: Record<string, string>): (p: string) => boolean {
    const dir = repo();
    for (const [rel, content] of Object.entries(files)) writeFile(dir, rel, content);
    return createGitIgnoreChecker(dir);
  }

  it('matches basename globs at any depth, anchored paths, and directory rules', () => {
    const ignored = checker({ '.gitignore': '*.log\n/build\nnode_modules/\ndocs/*.tmp\n# comment\n' });
    expect(ignored('a/b/c.log')).toBe(true);
    expect(ignored('build/out.js')).toBe(true);
    expect(ignored('src/build/out.js')).toBe(false); // anchored to the root
    expect(ignored('pkg/node_modules/x/y.js')).toBe(true);
    expect(ignored('docs/scratch.tmp')).toBe(true);
    expect(ignored('docs/nested/scratch.tmp')).toBe(false);
    expect(ignored('src/index.ts')).toBe(false);
  });

  it('honors negation and does not re-include under an ignored directory', () => {
    const ignored = checker({ '.gitignore': '*.env\n!keep.env\nvendor/\n!vendor/lib.js\n' });
    expect(ignored('a.env')).toBe(true);
    expect(ignored('keep.env')).toBe(false);
    expect(ignored('vendor/lib.js')).toBe(true);
  });

  it('applies a nested .gitignore only below its own directory', () => {
    const ignored = checker({ 'sub/.gitignore': 'secret.txt\n' });
    expect(ignored('sub/secret.txt')).toBe(true);
    expect(ignored('sub/deep/secret.txt')).toBe(true);
    expect(ignored('secret.txt')).toBe(false);
  });

  it('treats a repo with no .gitignore as ignoring nothing', () => {
    expect(checker({})('anything/at/all.txt')).toBe(false);
  });
});

describe('fixture-path-references', () => {
  it('reports only the genuinely broken references: one in CLAUDE.md, one in a skill', async () => {
    const report = await scan({ repoPath: FIXTURE, projectType: 'typescript' });
    const broken = report.issues.filter((i) => i.category === 'structure' && i.title.startsWith('Broken file reference'));
    expect(broken.map((i) => i.title)).toEqual(['Broken file reference: missing-guide.md']);

    const skillRefs = report.issues.filter((i) => i.title.includes('bundled file'));
    expect(skillRefs).toHaveLength(1);
    expect(skillRefs[0]!.evidence.join(' ')).toContain('references/gone.md');
  });
});
