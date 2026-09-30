/**
 * pcic-2b6.10: documented `make <target>` commands are validated against the
 * Makefile make would read — only in code spans and shell fences, never prose,
 * and never when the Makefile can define targets this reader cannot see.
 */

import * as fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { makefileDefines, parseMakefileTargets } from '../src/makefile.js';
import { scan } from '../src/scan.js';
import type { PromptCiIssue } from '../src/types.js';
import { makeTempRepo, writeFile } from './ai-config-helpers.js';

const tempRepos: string[] = [];
afterEach(() => {
  for (const dir of tempRepos.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function commandFindings(files: Record<string, string>): Promise<string[]> {
  const repo = makeTempRepo('promptci-make-');
  tempRepos.push(repo);
  for (const [rel, content] of Object.entries(files)) writeFile(repo, rel, content);
  const issues: PromptCiIssue[] = (await scan({ repoPath: repo, projectType: 'unknown' })).issues;
  return issues.filter((i) => i.category === 'command_validity').map((i) => i.summary);
}

const MAKEFILE = [
  'CC ?= cc',
  'CFLAGS := -O2',
  'URL = http://example.com:8080',
  'export PATH := $(PATH):/opt/bin',
  '',
  '.PHONY: lint fmt \\',
  '        docs',
  '',
  'build test: deps',
  '\t@echo build: $(CC)',
  '',
  'deps:',
  '\t@echo deps',
  '',
  'check::',
  '\t@echo one',
  '',
  'release: VERSION = 1.0',
  '',
  '%.o: %.c',
  '\t$(CC) -c $<',
  '',
  'define HELP',
  'fake: target',
  'endef',
  '',
].join('\n');

describe('parseMakefileTargets', () => {
  const facts = parseMakefileTargets(MAKEFILE);

  it('collects explicit, multi-target, double-colon and .PHONY targets', () => {
    expect(facts.targets).toEqual(['build', 'check', 'deps', 'docs', 'fmt', 'lint', 'release', 'test']);
    expect(facts.patterns).toEqual(['%.o']);
    expect(facts.unverifiable).toBe(false);
  });

  it('ignores variable assignments, recipe lines and define blocks', () => {
    for (const name of ['CC', 'CFLAGS', 'URL', 'PATH', 'export PATH', 'fake', '@echo build']) {
      expect(facts.targets).not.toContain(name);
    }
  });

  it('matches pattern rules', () => {
    expect(makefileDefines(facts, 'main.o')).toBe(true);
    expect(makefileDefines(facts, '.o')).toBe(false);
    expect(makefileDefines(facts, 'deploy')).toBe(false);
  });

  it.each([
    ['include', 'include common.mk\nbuild:\n'],
    ['-include', '-include .env.mk\nbuild:\n'],
    ['sinclude', 'sinclude local.mk\nbuild:\n'],
    ['a computed target', '$(BIN): main.o\n\tcc -o $@ $^\n'],
    ['$(eval)', '$(eval $(call rule,x))\n'],
    ['a .DEFAULT rule', '.DEFAULT:\n\t@echo any\n'],
  ])('marks a Makefile with %s unverifiable', (_label, content) => {
    expect(parseMakefileTargets(content).unverifiable).toBe(true);
  });
});

describe('make target validation', () => {
  const agents = (commands: string[], prose = ''): string =>
    ['# Agents', '', '```bash', ...commands, '```', '', prose].join('\n');

  it('reports a target the Makefile does not define', async () => {
    const summaries = await commandFindings({
      Makefile: MAKEFILE,
      'AGENTS.md': agents(['make build', 'make deploy']),
    });
    expect(summaries).toEqual(['make target "deploy" does not appear in Makefile']);
  });

  it('accepts defined, .PHONY, pattern, variable-assignment and flag forms', async () => {
    const summaries = await commandFindings({
      Makefile: MAKEFILE,
      'AGENTS.md': agents([
        'make',
        'make test lint',
        'make fmt docs',
        'make main.o',
        'make CC=clang build',
        'make -j4 test',
        'make -j 8 check',
        'make -k -s deps',
        'make build 2>&1 | tee build.log',
        'make build/app.o',
      ]),
    });
    expect(summaries).toEqual([]);
  });

  it('validates code spans but never prose', async () => {
    const summaries = await commandFindings({
      Makefile: MAKEFILE,
      'AGENTS.md': '# Agents\n\nRun `make ship` to publish. Then make deploy happen.\n',
    });
    expect(summaries).toEqual(['make target "ship" does not appear in Makefile']);
  });

  it('resolves `make -C dir` and `cd dir && make` against that directory', async () => {
    const summaries = await commandFindings({
      Makefile: MAKEFILE,
      'tools/Makefile': 'package:\n\t@echo package\n',
      'AGENTS.md': agents([
        'make -C tools package',
        'make --directory=tools release',
        'cd tools && make package',
        'cd tools && make build',
      ]),
    });
    expect(summaries).toEqual([
      'make target "release" does not appear in tools/Makefile',
      'make target "build" does not appear in tools/Makefile',
    ]);
  });

  it('stays silent without a Makefile, with -f, with include, or in an unknown directory', async () => {
    const summaries = await commandFindings({
      Makefile: 'include rules.mk\nbuild:\n',
      'AGENTS.md': agents([
        'make deploy',
        'make -f other.mk deploy',
        'make -C missing-dir deploy',
        'cd /srv/app && make deploy',
        'cd $APP && make deploy',
      ]),
    });
    expect(summaries).toEqual([]);
  });

  it('accepts a goal make builds from a same-stem source with its implicit rules', async () => {
    const summaries = await commandFindings({
      Makefile: 'all:\n\t@echo all\n',
      'hello.c': 'int main(void) { return 0; }\n',
      'AGENTS.md': agents(['make hello']),
    });
    expect(summaries).toEqual([]);
  });

  it('reads GNUmakefile / makefile too', async () => {
    const summaries = await commandFindings({
      makefile: 'all:\n\t@echo all\n',
      'AGENTS.md': agents(['make all', 'make nope']),
    });
    expect(summaries).toEqual(['make target "nope" does not appear in makefile']);
  });
});
