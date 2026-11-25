/**
 * Hostile-input harness for every detector (pcic-1ik0.25, pcic-1ik0.26).
 *
 * A scan runs on any repository, so an instruction file can be built to make a detector's text
 * work grow faster than the file: one long line, tens of thousands of short ones, deep nesting,
 * many headings, repeated command fragments. Core 0.4.10 took 6 to 60+ seconds on such files of
 * 100 to 300 KB (conflicts, dead references, agent practices, dependency staleness, stale
 * instructions, duplicate headings, command validity, the missing-script check, suppression
 * parsing, security pack), and one crashed with a stack overflow. Every detector, and the steps
 * scan() runs after them, must answer each shape well inside a budget, and the rewritten text
 * readers must give what the regexes they replace gave (checked against those regexes on
 * thousands of generated short inputs, where the regexes are fast).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildRepoContext } from '../src/repo-context.js';
import { DETECTORS } from '../src/detectors.js';
import { parseSuppressions } from '../src/suppression.js';
import { annotateIssueTokens } from '../src/token-estimates.js';
import { inOrderOnOneLine, lineNumberIndex, lineStartIndex } from '../src/linear-text.js';
import { creationTarget, linkReferenceDefinitions, markdownLinks, nestedMarkdownLinks } from '../src/dead-references.js';
import { htmlCommentDatedTodos } from '../src/stale-instructions.js';
import { scopedInvocationTester } from '../src/manifest-consistency.js';
import { headingChain, lineStructure, nearestHeading } from '../src/command-context.js';
import { htmlCommentLines, htmlCommentRanges, inRanges } from '../src/sample-text.js';
import { firstMatch, matchEvidence } from '../src/evidence.js';
import { normalizeSection } from '../src/duplicates.js';
import { normalizeParagraph } from '../src/within-section-dedup.js';
import { makeTempRepo, writeFile } from './ai-config-helpers.js';

/**
 * Budget for one detector (or post-detector step) on one hostile file of about 120 KB. Linear
 * code answers in tens of milliseconds; the code this replaced took seconds to minutes.
 */
const DETECTOR_BUDGET_MS = 2000;

/** A backtick, kept out of the string literals below. */
const BT = '\u0060';
const FENCE = BT.repeat(3);

/** Pseudo-random generator, so the generated inputs are the same on every run. */
function generator(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };
}

function randomText(pool: readonly string[], maxParts: number, next: () => number): string {
  const length = next() % (maxParts + 1);
  let text = '';
  for (let i = 0; i < length; i++) text += pool[next() % pool.length];
  return text;
}

const SIZE = 120_000;
const oneLine = (unit: string) => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
const manyLines = (make: (i: number) => string) => {
  const lines: string[] = [];
  let size = 0;
  for (let i = 0; size < SIZE; i++) {
    const line = make(i);
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join('\n') + '\n';
};
const distinct = (make: (i: number) => string) => {
  let text = '';
  for (let i = 0; text.length < SIZE; i++) text += make(i);
  return text;
};

/** Hostile instruction files: each shape made at least one detector of core 0.4.10 superlinear. */
const HOSTILE_FILES: Array<[label: string, content: string]> = [
  ['one line of prose', oneLine('Always run the tests before you commit. Never use yarn here. See docs/setup.md and README.md. ')],
  ['one line of "never "', oneLine('never ')],
  ['one line of "must never do X"', oneLine('You must never do X. ')],
  ['one line of "avoid "', oneLine('avoid ')],
  ['one line repeating one conflict', oneLine('Always use pnpm. Never use pnpm. ')],
  ['one line repeating one conflict on a method call', oneLine('Always use react. Never use react. ')],
  ['two sections of thousands of opposite directives', '## A\n' + manyLines(() => 'Always use pnpm react.') + '## B\n' + manyLines(() => 'Never use pnpm react.')],
  ['sections each holding one conflict', manyLines((i) => (i % 2 ? '## S' + i : 'Always use pnpm. Never use pnpm.'))],
  ['one line of "use X, not Y"', oneLine('use X — not Y ')],
  ['one line of "[a](b "', oneLine('[a](b ')],
  ['one line of "["', oneLine('[')],
  ['one line of "[a [b](c) "', oneLine('[a [b](c) ')],
  ['one line of code spans', oneLine(BT + 'npm test' + BT + ' ')],
  ['one line of "<!-- "', oneLine('<!-- ')],
  ['one line of "<!-- TODO "', oneLine('<!-- TODO ')],
  ['one line of "read before "', oneLine('read before ')],
  ['one line of "read report before "', oneLine('read report before ')],
  ['"read x report" and a long run of spaces', 'read x report' + ' '.repeat(SIZE)],
  ['blank lines', '\n'.repeat(SIZE)],
  ['lines of one space', ' \n'.repeat(SIZE / 2)],
  ['CRLF blank lines', '\r\n'.repeat(SIZE / 2)],
  ['one line of "never print "', oneLine('never print ')],
  ['one line of "supabase service role key "', oneLine('supabase service role key ')],
  ['one line of "unity "', oneLine('unity ')],
  ['one line of "create a file a.md"', oneLine('create a file ' + BT + 'a.md' + BT + ' ')],
  ['one line of "npm run x && "', oneLine('npm run x && ')],
  ['one line of distinct "pnpm run sN "', distinct((i) => 'pnpm run s' + i + ' ')],
  ['one line of distinct "npm run xN && "', distinct((i) => 'npm run x' + i + ' && ')],
  ['one line of "cd a && npm run xN && "', distinct((i) => 'cd a && npm run x' + i + ' && ')],
  ['"cd x" and a run of "&"', 'cd x ' + '&'.repeat(SIZE) + ' npm run y'],
  ['one line of "<!-- promptci-ignore: dup "', oneLine('<!-- promptci-ignore: dup ')],
  ['lines of distinct commands in code spans', manyLines((i) => BT + 'npm run s' + i + BT)],
  ['lines of commands with no punctuation', manyLines((i) => 'Run pnpm run build' + (i % 7))],
  ['lines of "Never use toolN."', manyLines((i) => 'Never use tool' + i + '.')],
  ['lines of "Never use toolN. Always use toolN."', manyLines((i) => 'Never use tool' + i + '. Always use tool' + i + '.')],
  ['lines of "As of YYYY use Node N"', manyLines((i) => 'As of ' + (1990 + (i % 40)) + ' use Node ' + (i % 30))],
  ['lines of headings', manyLines((i) => '# Heading ' + i)],
  ['lines of nested headings', manyLines((i) => '## aaaa' + ' b'.repeat(i % 50))],
  ['lines of links', manyLines((i) => '[a' + i + '](docs/a' + i + '.md)')],
  ['lines opening "[" with no "]"', manyLines((i) => '[abc' + i)],
  ['lines of "<!-- cN" with no close', manyLines((i) => '<!-- c' + i)],
  ['lines of closed HTML comments', manyLines((i) => '<!-- c' + i + ' -->')],
  ['lines of suppressions', manyLines((i) => '<!-- promptci-ignore: duplicate\n     reason: r' + i + ' -->')],
  ['lines of suppressions and commands', manyLines((i) => (i % 2 ? '<!-- promptci-ignore: all\n reason: r -->' : 'npm run x' + i))],
  ['deeply nested lists', manyLines((i) => '  '.repeat(i % 400) + '- item ' + i)],
  ['deep blockquotes', manyLines((i) => '>'.repeat(i % 500) + ' quote')],
  ['runs of backticks', manyLines((i) => BT.repeat(1 + (i % 20)) + 'x')],
  ['an unclosed fence of commands', FENCE + 'bash\n' + manyLines((i) => 'pnpm run s' + i)],
  ['table rows of commands', manyLines((i) => '| ' + BT + 'npm run x' + i + BT + ' | y |')],
  ['<details> blocks of commands', manyLines((i) => (i % 3 === 0 ? '<details>' : BT + 'pnpm run s' + i + BT))],
];

describe('every detector on hostile instruction files', () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  });

  /** A repository that turns on every signal a detector checks before reading the text. */
  function hostileRepo(claude: string): string {
    const root = makeTempRepo('promptci-hostile-all-');
    roots.push(root);
    writeFile(root, 'CLAUDE.md', claude);
    writeFile(root, '.env', 'A=1\n');
    writeFile(root, 'supabase/migrations/0001_init.sql', '-- init\n');
    writeFile(root, '.promptci/config.json', '{}\n');
    writeFile(root, 'ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 6000.0.1f1\n');
    writeFile(root, 'Assets/.keep', '');
    writeFile(root, 'uploads/.keep', '');
    writeFile(
      root,
      'package.json',
      JSON.stringify({
        name: 'x',
        packageManager: 'pnpm@9.0.0',
        engines: { node: '>=22' },
        scripts: { build: 'tsc', test: 'vitest', lint: 'eslint .' },
        dependencies: { react: '^19.0.0', next: '^16.0.0', '@supabase/supabase-js': '^2.0.0', multer: '^1.0.0' },
      }),
    );
    return root;
  }

  it.each(HOSTILE_FILES)('%s', async (_label, claude) => {
    const context = await buildRepoContext({ repoPath: hostileRepo(claude) });
    expect(context.files.map((f) => path.basename(f.path))).toContain('CLAUDE.md');
    const slow: string[] = [];
    const time = <T>(step: string, fn: () => T): T => {
      const start = performance.now();
      const value = fn();
      const ms = performance.now() - start;
      if (ms >= DETECTOR_BUDGET_MS) slow.push(step + ' ' + Math.round(ms) + ' ms');
      return value;
    };
    const issues = DETECTORS.flatMap((detector) => time(detector.id, () => detector.run(context)));
    const files = [...context.files, ...context.onDemandFiles];
    time('parseSuppressions', () => parseSuppressions(files));
    time('annotateIssueTokens', () => annotateIssueTokens(issues, files, context.aliasFiles));
    expect(slow).toEqual([]);
  }, 120_000);
});

describe('the linear readers give what the regexes they replace gave', () => {
  const RUNS = 4000;

  it.each([
    [/read\s+(the\s+|a\s+)?file.*before\s+(edit|modif|chang)/i, [/read\s+(the\s+|a\s+)?file/i, /before\s+(edit|modif|chang)/i]],
    [/read.*before.*edit/i, [/read/i, /before/i, /edit/i]],
    [/before\s+implement\w+.*\b(plan|outline|design)\b/i, [/before\s+implement\w+/i, /\b(plan|outline|design)\b/i]],
    [
      /never\s+.*(print|commit|log|expose)\s+.*(secret|password|token|key|credential)/i,
      [/never\s+/i, /(print|commit|log|expose)\s+/i, /(secret|password|token|key|credential)/i],
    ],
    [
      /do\s+not\s+.*(print|commit|log|expose)\s+.*(secret|password|token|key|credential)/i,
      [/do\s+not\s+/i, /(print|commit|log|expose)\s+/i, /(secret|password|token|key|credential)/i],
    ],
    [/supabase\s+service\s+role\s+key.*server-side/i, [/supabase\s+service\s+role\s+key/i, /server-side/i]],
    [/read\s+.*\.promptci\s+before/i, [/read\s+/i, /\.promptci\s+before/i]],
    [/read\s+.*report.*\s+before\s+.*(source|docs|code)/i, [/read\s+/i, /report/i, { afterSpace: /before\s+/i }, /(source|docs|code)/i]],
    [/inspect\s+.*report.*\s+before\s+.*(source|docs|code)/i, [/inspect\s+/i, /report/i, { afterSpace: /before\s+/i }, /(source|docs|code)/i]],
    [/check\s+.*\.promptci\s+before/i, [/check\s+/i, /\.promptci\s+before/i]],
    [/\bunity\b.*\b(lts|editor|hub|engine)\b/i, [/\bunity\b/i, /\b(lts|editor|hub|engine)\b/i]],
    [/instantiate\b.*monobehaviour/i, [/instantiate\b/i, /monobehaviour/i]],
    [/avoid\b.*update/i, [/avoid\b/i, /update/i]],
  ] as const)('%s', (regex, parts) => {
    const matcher = inOrderOnOneLine(...parts);
    const words = (regex.source.match(/[a-z.-]{2,}/gi) ?? []).map((w) => w.replace(/\\/g, ''));
    const pool = [...words, ' ', '  ', '\n', '\r', '\u2028', '\t', 'x', '.', 'the ', 'a ', 'file ', 'implementing', '_'];
    const next = generator(0x5eed + regex.source.length);
    for (let n = 0; n < RUNS; n++) {
      const text = randomText(pool, 12, next);
      const found = regex.exec(text);
      expect(matcher.test(text), JSON.stringify(text)).toBe(found !== null);
      expect(matcher.firstIndex(text), JSON.stringify(text)).toBe(found ? found.index : -1);
      expect(matchEvidence(text, regex, 'L', 120, matcher)).toBe(matchEvidence(text, regex, 'L'));
    }
  });

  const LINK_POOL = ['[', ']', '(', ')', 'a', ' ', '\n', ':', '\t', '!', '\r', '](', '[a]', '(b)', '^'];

  it('markdown links', () => {
    const next = generator(0x11a4);
    for (let n = 0; n < RUNS; n++) {
      const text = randomText(LINK_POOL, 14, next);
      const expected = [...text.matchAll(/\[(?:[^\]]*)\]\(([^)]+)\)/g)].map((m) => ({ index: m.index, text: m[0], target: m[1] }));
      expect(markdownLinks(text), JSON.stringify(text)).toEqual(expected);
    }
  });

  it('markdown links with a link in the label', () => {
    const next = generator(0x22b5);
    for (let n = 0; n < RUNS; n++) {
      const text = randomText(LINK_POOL, 14, next);
      const expected = [...text.matchAll(/\[(?:[^\]]|\]\([^)]*\))*\]\(([^)]+)\)/g)].map((m) => ({
        index: m.index,
        text: m[0],
        target: m[1],
      }));
      expect(nestedMarkdownLinks(text), JSON.stringify(text)).toEqual(expected);
    }
  });

  it('link reference definitions', () => {
    const next = generator(0x33c6);
    const pool = [...LINK_POOL, '   ', '  ', 'b.md', '\u2028'];
    for (let n = 0; n < RUNS; n++) {
      const text = randomText(pool, 14, next);
      const expected = [...text.matchAll(/^[ \t]{0,3}\[[^\]]+\]:\s*(\S+)/gm)].map((m) => ({ index: m.index, text: m[0], target: m[1] }));
      expect(linkReferenceDefinitions(text), JSON.stringify(text)).toEqual(expected);
    }
  });

  it('the file a line asks to create', () => {
    const regex = new RegExp(
      '\\b(?:create|add|generate|scaffold|place|put|save|make)\\s+(?:a\\s+|an\\s+|the\\s+|your\\s+|this\\s+|new\\s+)*' +
        '(?:file|workflow|config(?:uration)?|script|action|manifest|template|module|component)\\b[^.\\n]*?' +
        '\\b(?:named|called|at|as|in|to|like)\\s+[' + BT + '\'"(]*([^\\s' + BT + '\'"()]+)',
      'i',
    );
    const pool = ['create ', 'add ', 'a ', 'the ', 'new ', 'file', 'files', 'config', 'configuration', ' named ', ' at ', 'in', ' ', '.', '\n', 'x.yml', BT, '"', '(', 'make', 'component', 'to '];
    const next = generator(0x44d7);
    for (let n = 0; n < RUNS; n++) {
      const text = randomText(pool, 12, next);
      expect(creationTarget(text), JSON.stringify(text)).toBe(regex.exec(text)?.[1]);
    }
  });

  it('dated TODOs in HTML comments', () => {
    const regex = /<!--(?:(?!-->)[\s\S])*?\b(TODO|FIXME|WORKAROUND|HACK|NOTE)\b(?:(?!-->)[\s\S])*?\(\s*(\d{4})[-–\d]/gi;
    const pool = ['<!--', '-->', 'TODO', 'note', 'NOTES', '(', '2022', '-', '–', ' ', '\n', 'x', '1', '>', '<!', '--'];
    const next = generator(0x55e8);
    for (let n = 0; n < RUNS; n++) {
      const text = randomText(pool, 14, next);
      const expected = [...text.matchAll(regex)].map((m) => ({ match: m[0], keyword: m[1], year: m[2] }));
      expect(htmlCommentDatedTodos(text), JSON.stringify(text)).toEqual(expected);
    }
  });

  it('a script mention scoped by a cd chain or a workspace flag', () => {
    const CD_CHAIN_BEFORE_RE = /\bcd\s+\S+\s*&&\s*(?:[^&;|\n]*&&\s*)*$/;
    const SCOPE_FLAG_RE = /(?:^|\s)(?:--filter\b|-F\b|--cwd\b|-C\b|--prefix\b|--dir\b|-w\b|--workspaces?\b|-ws\b|-r\b|--recursive\b)/;
    const SEPARATOR_RE = new RegExp('&&|\\|\\||;|\\||' + BT + '|,\\s|\\.\\s|\\bthen\\b');
    const oracle = (content: string, matchStart: number, matchEnd: number): boolean => {
      const lineStart = content.lastIndexOf('\n', matchStart - 1) + 1;
      if (CD_CHAIN_BEFORE_RE.test(content.slice(lineStart, matchStart))) return true;
      const newline = content.indexOf('\n', matchEnd);
      const after = content.slice(matchEnd, newline === -1 ? undefined : newline);
      return SCOPE_FLAG_RE.test(after.split(SEPARATOR_RE)[0]!);
    };
    const mention = /\b(npm|yarn|pnpm|bun)[ \t\u00a0]+(run(?:-script)?(?:[ \t\u00a0]+|[ \t\u00a0]*\r?\n[ \t\u00a0]*))?([a-z0-9][a-z0-9:_-]*)\b/gi;
    const pool = ['cd', 'cd ', ' ', '&', '&&', ';', '|', 'x', 'npm run b', 'pnpm b', ' -w', ' -r', '--filter', ',', '.', ', ', '. ', 'then', '\n', BT, 'acd', '\t', '\r', '-'];
    const next = generator(0x66f9);
    for (let n = 0; n < RUNS * 2; n++) {
      const text = randomText(pool, 16, next);
      const scoped = scopedInvocationTester(text);
      for (const m of text.matchAll(mention)) {
        const end = m.index + m[0].length;
        expect(scoped(m.index, end), JSON.stringify({ text, at: m.index })).toBe(oracle(text, m.index, end));
      }
    }
  });

  it('heading chains and nearest headings', () => {
    const pool = ['# A', '## B', '### C', '#### D', 'Title', '===', '---', '- item', '> quote', '', 'text', FENCE, '    # indented'];
    const next = generator(0x7a0a);
    for (let n = 0; n < 1500; n++) {
      const content = Array.from({ length: 1 + (next() % 14) }, () => pool[next() % pool.length]).join('\n');
      const s = lineStructure(content);
      // The walk the index replaced, kept as the oracle.
      const level = (i: number): number | undefined => {
        if (i < 1 || i > s.lines.length || s.inFence[i - 1]) return undefined;
        const text = s.lines[i - 1]!;
        const atx = /^ {0,3}(#{1,6})(?:\s|$)/.exec(text);
        if (atx) return atx[1]!.length;
        if (text.trim() === '' || /^\s*(?:[-*+]|\d+[.)])\s/.test(text) || /^\s*>/.test(text)) return undefined;
        const below = s.lines[i];
        if (below === undefined || s.inFence[i]) return undefined;
        const underline = /^ {0,3}(=+|-{2,})\s*$/.exec(below);
        return underline ? (underline[1]!.startsWith('=') ? 1 : 2) : undefined;
      };
      for (let line = 0; line <= s.lines.length + 1; line++) {
        const chain: number[] = [];
        let lowest = 7;
        for (let i = Math.min(line, s.lines.length); i >= 1 && lowest > 1; i--) {
          const l = level(i);
          if (l !== undefined && l < lowest) {
            chain.push(i);
            lowest = l;
          }
        }
        expect(headingChain(s, line), JSON.stringify({ content, line })).toEqual(chain);
        expect(nearestHeading(s, line), JSON.stringify({ content, line })).toBe(chain[0]);
      }
    }
  });

  it('HTML comment lines and range lookups', () => {
    const pool = ['<!--', '-->', ' ', '\n', 'x', BT, FENCE + '\n'];
    const next = generator(0x8b1b);
    for (let n = 0; n < RUNS; n++) {
      const content = randomText(pool, 14, next);
      const ranges = htmlCommentRanges(content);
      let start = 0;
      const expected = content.split('\n').map((line) => {
        const end = start + line.length;
        const hit = ranges.some(([a, b]) => a < end + 1 && b > start);
        start = end + 1;
        return hit;
      });
      expect(htmlCommentLines(content), JSON.stringify(content)).toEqual(expected);
      for (let offset = 0; offset <= content.length; offset++) {
        expect(inRanges(ranges, offset)).toBe(ranges.some(([a, b]) => offset >= a && offset < b));
      }
    }
  });

  it('line numbers and line starts', () => {
    const next = generator(0x9c2c);
    for (let n = 0; n < 500; n++) {
      const content = randomText(['\n', 'a', '\r', ' '], 20, next);
      const lineOf = lineNumberIndex(content);
      const startOf = lineStartIndex(content);
      for (let offset = 0; offset <= content.length; offset++) {
        expect(lineOf(offset)).toBe(content.slice(0, offset).split('\n').length);
        // lastIndexOf reads a negative start as 0, so at offset 0 of a file opening with a newline the
        // expression says 1; it only ever runs at a word, never there.
        if (offset > 0 || content[0] !== '\n') expect(startOf(offset)).toBe(content.lastIndexOf('\n', offset - 1) + 1);
      }
    }
  });

  it('section and paragraph normalization', () => {
    // The chains before pcic-1ik0.25, whose list-marker patterns ran across blank lines.
    const oldSection = (text: string) =>
      text
        .toLowerCase()
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/^[\s]*[-*+]\s+/gm, '')
        .replace(/^[\s]*\d+\.\s+/gm, '')
        .replace(/\s+/g, ' ')
        .trim();
    const oldParagraph = (text: string) =>
      text
        .toLowerCase()
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/^[\s]*[-*+]\s+/gm, '')
        .replace(/^[\s]*\d+[.)]\s+/gm, '')
        .replace(/\s+/g, ' ')
        .trim();
    const pool = ['- ', '* ', '+ ', '1. ', '2) ', '-', ' ', '  ', '\t', '\n', '\r\n', '\r', '\u2028', '\u00a0', 'x', 'Word', '## ', '#'];
    const next = generator(0xad3d);
    for (let n = 0; n < RUNS * 2; n++) {
      const text = randomText(pool, 14, next);
      expect(normalizeSection(text), JSON.stringify(text)).toBe(oldSection(text));
      expect(normalizeParagraph(text), JSON.stringify(text)).toBe(oldParagraph(text));
    }
  });

  it('evidence past the quoting window', () => {
    const regex = /read\s+.*\.promptci\s+before/i;
    const matcher = inOrderOnOneLine(/read\s+/i, /\.promptci\s+before/i);
    for (const filler of [1_900, 2_100, 5_000]) {
      const text = '# Rules\n\nRead ' + 'x '.repeat(filler / 2) + ' .promptci before editing source code files.\n';
      expect(matchEvidence(text, regex, 'L', 120, matcher), String(filler)).toBe(matchEvidence(text, regex, 'L'));
    }
    const twice = 'Read .promptci before you start. ' + 'x '.repeat(1_500) + 'and read .promptci before you stop.';
    expect(matchEvidence(twice, regex, 'L', 120, matcher)).toBe(matchEvidence(twice, regex, 'L'));
  });

  it('evidence quotes the same text as the plain regex', () => {
    const text = 'Intro.\nPlease read the latest report before you look at the source code.\n';
    const regex = /read\s+.*report.*\s+before\s+.*(source|docs|code)/i;
    const matcher = inOrderOnOneLine(/read\s+/i, /report/i, { afterSpace: /before\s+/i }, /(source|docs|code)/i);
    expect(matchEvidence(text, regex, 'Reports first', 120, matcher)).toBe(matchEvidence(text, regex, 'Reports first'));
    expect(firstMatch(text, regex)).toBe('read the latest report before you look at the source code');
  });
});

describe('checkMissingScripts on one long line of commands (pcic-1ik0.26)', () => {
  it('a 120 KB line of distinct "pnpm run" mentions reads in linear time', () => {
    const line = distinct((i) => 'pnpm run s' + i + ' ');
    const scoped = scopedInvocationTester(line);
    const start = performance.now();
    let count = 0;
    for (const m of line.matchAll(/\bpnpm run (s\d+)\b/g)) {
      expect(scoped(m.index, m.index + m[0].length)).toBe(false);
      count++;
    }
    expect(count).toBeGreaterThan(5_000);
    expect(performance.now() - start).toBeLessThan(DETECTOR_BUDGET_MS);
  });
});
