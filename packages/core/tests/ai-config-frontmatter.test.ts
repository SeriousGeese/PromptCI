import { describe, it, expect } from 'vitest';
import { parseFrontmatter, asStringList } from '../src/ai-config.js';

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
    expect(fm.order).toEqual(['name', 'description', 'alwaysApply', 'count']);
    expect(fm.bodyStartLine).toBe(7);
  });

  it('parses block lists and inline sequences', () => {
    const fm = parseFrontmatter(
      ['---', 'tools:', '  - Read', '  - Write', 'globs: [a.ts, b.ts]', '---'].join('\n'),
    );
    expect(fm.data.tools).toEqual(['Read', 'Write']);
    expect(fm.data.globs).toEqual(['a.ts', 'b.ts']);
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

describe('asStringList', () => {
  it('splits comma- and newline-separated strings', () => {
    expect(asStringList('Read, Write')).toEqual(['Read', 'Write']);
  });
  it('passes arrays through', () => {
    expect(asStringList(['a', 'b'])).toEqual(['a', 'b']);
  });
  it('returns [] for null', () => {
    expect(asStringList(null)).toEqual([]);
  });
});
