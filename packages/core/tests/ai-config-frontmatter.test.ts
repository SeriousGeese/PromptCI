import { describe, it, expect } from 'vitest';
import { parseFrontmatter, asStringList, frontmatterStructureIssues } from '../src/ai-config.js';
import type { FrontmatterSurface } from '../src/ai-config.js';

describe('parseFrontmatter', () => {
  it('returns present=false when there is no frontmatter', () => {
    const fm = parseFrontmatter('# Just a heading\nbody');
    expect(fm.present).toBe(false);
    expect(fm.closed).toBe(false);
    expect(fm.bodyStartLine).toBe(1);
  });

  it('parses scalars, quoted strings, booleans, and numbers', () => {
    const fm = parseFrontmatter(
      ['---', 'name: my-skill', 'description: "Does a thing"', 'alwaysApply: true', 'count: 3', '---', 'body'].join('\n'),
    );
    expect(fm.present).toBe(true);
    expect(fm.closed).toBe(true);
    expect(fm.data.name).toBe('my-skill');
    expect(fm.data.description).toBe('Does a thing');
    expect(fm.data.alwaysApply).toBe(true);
    expect(fm.data.count).toBe(3);
    expect(Object.keys(fm.data)).toEqual(['name', 'description', 'alwaysApply', 'count']);
    expect(fm.bodyStartLine).toBe(7);
  });

  it('parses block lists and inline sequences', () => {
    const fm = parseFrontmatter(
      ['---', 'tools:', '  - Read', '  - Write', 'globs: [a.ts, b.ts]', '---'].join('\n'),
    );
    expect(fm.data.tools).toEqual(['Read', 'Write']);
    expect(fm.data.globs).toEqual(['a.ts', 'b.ts']);
  });

  it('keeps commas inside quotes and braces within an inline sequence', () => {
    const fm = parseFrontmatter(['---', 'globs: ["**/*.{ts,tsx}", src/a.ts]', '---'].join('\n'));
    expect(fm.data.globs).toEqual(['**/*.{ts,tsx}', 'src/a.ts']);
  });

  it('strips an unquoted trailing comment but keeps quoted # verbatim', () => {
    const fm = parseFrontmatter(
      ['---', 'name: my-skill # the slug', 'description: "Fixes issue #23 reliably"', '---'].join('\n'),
    );
    expect(fm.data.name).toBe('my-skill');
    expect(fm.data.description).toBe('Fixes issue #23 reliably');
  });

  it('records the first occurrence line for a duplicate key', () => {
    const fm = parseFrontmatter(['---', 'name: a', 'name: b', '---'].join('\n'));
    expect(fm.keyLines.name).toBe(2);
  });

  it('treats an indented --- inside a block scalar as content, not the closing fence', () => {
    const fm = parseFrontmatter(
      ['---', 'description: |', '  intro', '  ---', '  more', 'name: x', '---', 'body'].join('\n'),
    );
    expect(fm.closed).toBe(true);
    expect(fm.fenceEndLine).toBe(7);
    expect(fm.data.description).toBe('intro\n---\nmore');
    expect(fm.data.name).toBe('x');
  });

  it('strips a trailing comment from a sequence value and re-dispatches it as a sequence', () => {
    const fm = parseFrontmatter(['---', 'globs: ["*.ts"] # auto-attach', '---'].join('\n'));
    expect(fm.data.globs).toEqual(['*.ts']);
  });

  it('strips trailing comments from block list items', () => {
    const fm = parseFrontmatter(['---', 'tools:', '  - Read # file access', '  - Write', '---'].join('\n'));
    expect(fm.data.tools).toEqual(['Read', 'Write']);
  });

  it('does not let an apostrophe inside an item swallow later commas', () => {
    const fm = parseFrontmatter(["---", "globs: [docs/o'brien/*.md, src/*.ts]", '---'].join('\n'));
    expect(fm.data.globs).toEqual(["docs/o'brien/*.md", 'src/*.ts']);
  });

  it('parses block scalars', () => {
    const fm = parseFrontmatter(
      ['---', 'description: |', '  line one', '  line two', '---'].join('\n'),
    );
    expect(fm.data.description).toBe('line one\nline two');
  });

  it('flags an unterminated frontmatter block', () => {
    const fm = parseFrontmatter(['---', 'name: x', 'body without close'].join('\n'));
    expect(fm.present).toBe(true);
    expect(fm.closed).toBe(false);
    expect(fm.fenceEndLine).toBe(-1);
  });

  it('records duplicate keys as errors, last write wins', () => {
    const fm = parseFrontmatter(['---', 'name: a', 'name: b', '---'].join('\n'));
    expect(fm.data.name).toBe('b');
    expect(fm.errors.some((e) => e.includes('Duplicate'))).toBe(true);
  });

  it('records nested mappings as unsupported errors', () => {
    const fm = parseFrontmatter(['---', 'permissions:', '  allow: x', '---'].join('\n'));
    expect(fm.errors.some((e) => e.includes('Nested'))).toBe(true);
  });

  it('tolerates a BOM before the opening fence', () => {
    const fm = parseFrontmatter('﻿---\nname: x\n---\n');
    expect(fm.present).toBe(true);
    expect(fm.data.name).toBe('x');
  });
});

describe('frontmatterStructureIssues — nested-map finding (BUG-007)', () => {
  const surface: FrontmatterSurface = {
    idPrefix: 'skill',
    noun: 'Skill',
    why: 'A valid block provides name/description.',
    recommendation: 'Add a `---` block.',
  };

  it('names the offending nested key in the title and anchors to its line', () => {
    const content = ['---', 'name: demo', 'tools:', '  read: true', '  write: false', '---', 'body'].join('\n');
    const fm = parseFrontmatter(content);
    const issues = frontmatterStructureIssues('SKILL.md', content, fm, surface);

    // One finding per unsupported nested key, each naming the key (not generic).
    const readIssue = issues.find((i) => i.title.includes('"read"'));
    expect(readIssue).toBeDefined();
    expect(readIssue!.title).not.toContain('structural problem');
    expect(readIssue!.summary).toContain('read');
    // Anchored to the offending line (`  read: true` is line 4), not line 1.
    expect(readIssue!.locations[0]?.startLine).toBe(4);

    const writeIssue = issues.find((i) => i.title.includes('"write"'));
    expect(writeIssue).toBeDefined();
    expect(writeIssue!.locations[0]?.startLine).toBe(5);
  });
});

describe('asStringList', () => {
  it('splits comma- and newline-separated strings', () => {
    expect(asStringList('Read, Write')).toEqual(['Read', 'Write']);
  });
  it('keeps a brace-expansion glob as one item', () => {
    expect(asStringList('*.{ts,tsx}')).toEqual(['*.{ts,tsx}']);
    expect(asStringList('*.{ts,tsx}, src/**')).toEqual(['*.{ts,tsx}', 'src/**']);
  });
  it('passes arrays through', () => {
    expect(asStringList(['a', 'b'])).toEqual(['a', 'b']);
  });
  it('returns [] for null', () => {
    expect(asStringList(null)).toEqual([]);
  });
});
