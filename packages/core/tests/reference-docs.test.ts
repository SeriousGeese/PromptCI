/**
 * pcic-5rop.110: README, CONTRIBUTING and the other reference docs are scanned
 * but not counted as always-loaded context unless a CLAUDE.md imports them.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { scan } from '../src/scan.js';
import { generateMarkdownReport } from '../src/report.js';

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeRepo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-refdocs-'));
  cleanups.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return root;
}

const prose = (label: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${label} paragraph ${i}: describes the project for people who read it.`).join('\n\n');

const AGENTS = '# Agents\n\nRun pnpm test before you finish.\n';
const README = '# Project\n\n' + prose('readme', 60) + '\n';
const CONTRIBUTING = '# Contributing\n\n' + prose('contrib', 40) + '\n';

async function metricsOf(files: Record<string, string>) {
  const report = await scan({ repoPath: makeRepo(files) });
  return { report, m: report.metrics! };
}

const tokens = (text: string) => Math.round(text.length / 4);

describe('reference docs are not always-loaded context', () => {
  it('counts an un-imported README and CONTRIBUTING as reference docs only', async () => {
    const { m, report } = await metricsOf({ 'AGENTS.md': AGENTS, 'README.md': README, 'CONTRIBUTING.md': CONTRIBUTING });
    expect(m.estimatedInstructionTokens).toBe(tokens(AGENTS));
    expect(m.instructionFileCount).toBe(1);
    expect(m.largestInstructionFiles.map((f) => path.basename(f.path))).toEqual(['AGENTS.md']);
    expect(m.referenceDocFileCount).toBe(2);
    expect(m.estimatedReferenceDocTokens).toBe(tokens(README) + tokens(CONTRIBUTING));
    // Still scanned.
    expect(report.filesScanned.map((f) => path.basename(f.path))).toEqual(expect.arrayContaining(['README.md', 'CONTRIBUTING.md']));
    const md = generateMarkdownReport(report);
    expect(md).toContain('(always-loaded)');
    expect(md).toContain('**Reference docs:**');
  });

  it('omits the reference fields when there are none', async () => {
    const { m } = await metricsOf({ 'AGENTS.md': AGENTS });
    expect(m.referenceDocFileCount).toBeUndefined();
    expect(m.estimatedReferenceDocTokens).toBeUndefined();
  });

  it('counts a README that CLAUDE.md imports with a bare @README.md as always-loaded', async () => {
    const claude = '# Claude\n\n@README.md\n';
    const { m } = await metricsOf({ 'CLAUDE.md': claude, 'README.md': README, 'CONTRIBUTING.md': CONTRIBUTING });
    expect(m.estimatedInstructionTokens).toBe(tokens(claude) + tokens(README));
    expect(m.estimatedReferenceDocTokens).toBe(tokens(CONTRIBUTING));
    expect(m.referenceDocFileCount).toBe(1);
  });

  it.each([
    ['a backticked @README.md', '# Claude\n\nSee `@README.md` for more.\n'],
    ['a markdown link', '# Claude\n\nSee [the readme](README.md) for more.\n'],
    ['a fenced @README.md', '# Claude\n\n```\n@README.md\n```\n'],
  ])('does not count a README behind %s', async (_label, claude) => {
    const { m } = await metricsOf({ 'CLAUDE.md': claude, 'README.md': README });
    expect(m.estimatedInstructionTokens).toBe(tokens(claude));
    expect(m.estimatedReferenceDocTokens).toBe(tokens(README));
  });

  it('follows an import chain through other files, up to 4 hops', async () => {
    const chain = (n: number) => ({
      'CLAUDE.md': '@.claude/a1.md\n',
      ...Object.fromEntries(
        Array.from({ length: n }, (_, i) => [`.claude/a${i + 1}.md`, i + 1 < n ? `@a${i + 2}.md\n` : '@../README.md\n']),
      ),
      'README.md': README,
    });
    // CLAUDE.md -> a1 -> a2 -> a3 -> README: README is hop 4.
    const four = await metricsOf(chain(3));
    expect(four.m.estimatedReferenceDocTokens).toBeUndefined();
    // CLAUDE.md -> a1 .. a4 -> README: README is hop 5, past the limit.
    const five = await metricsOf(chain(4));
    expect(five.m.estimatedReferenceDocTokens).toBe(tokens(README));
  });

  it('does not fire README dominance for an un-imported README, and does when it is imported', async () => {
    const dominates = (r: { report: { issues: Array<{ id: string; title: string }> } }) =>
      r.report.issues.some((i) => i.title === 'README dominates scanned instruction context');
    const big = '# Project\n\n' + prose('readme', 120) + '\n';
    const off = await metricsOf({ 'AGENTS.md': AGENTS, 'README.md': big });
    expect(dominates(off)).toBe(false);
    const on = await metricsOf({ 'CLAUDE.md': '@README.md\n', 'README.md': big });
    expect(dominates(on)).toBe(true);
  });
});
