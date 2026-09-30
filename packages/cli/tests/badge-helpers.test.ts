import { describe, it, expect } from 'vitest';
import { buildBadge, badgeColor, BADGE_LABEL, badgeMarkdown, gitignoreException } from '../src/badge.js';

describe('badge helpers', () => {
  it('produces a Shields.io endpoint document (schemaVersion 1)', () => {
    expect(buildBadge(93)).toEqual({
      schemaVersion: 1,
      label: BADGE_LABEL,
      message: '93/100',
      color: 'brightgreen',
    });
  });

  it('colours by the report score bands', () => {
    expect(badgeColor(100)).toBe('brightgreen');
    expect(badgeColor(90)).toBe('brightgreen');
    expect(badgeColor(89)).toBe('yellowgreen');
    expect(badgeColor(70)).toBe('yellowgreen');
    expect(badgeColor(69)).toBe('orange');
    expect(badgeColor(50)).toBe('orange');
    expect(badgeColor(49)).toBe('red');
    expect(badgeColor(0)).toBe('red');
  });

  it('accepts a custom label', () => {
    expect(buildBadge(75, 'agent docs').label).toBe('agent docs');
  });

  it('clamps and rounds out-of-range scores, and rejects non-numbers', () => {
    expect(buildBadge(104).message).toBe('100/100');
    expect(buildBadge(-3).message).toBe('0/100');
    expect(buildBadge(89.6)).toMatchObject({ message: '90/100', color: 'brightgreen' });
    expect(() => buildBadge(Number.NaN)).toThrow(/finite/);
  });

  it('escapes brackets and backslashes in the label used as Markdown alt text', () => {
    const md = badgeMarkdown('a]b[c\\d', '.promptci/health-badge.json');
    expect(md.startsWith('[![a\\]b\\[c\\\\d](https://img.shields.io/endpoint?url=')).toBe(true);
    expect(md).toContain('%2F.promptci%2Fhealth-badge.json)');
  });

  it('builds the right .gitignore exception, including for nested badge paths', () => {
    expect(gitignoreException('.promptci/health-badge.json')).toBe('!**/.promptci/health-badge.json');
    expect(gitignoreException('packages/app/.promptci/health-badge.json')).toBe('!**/.promptci/health-badge.json');
    // A file inside an ignored subdirectory cannot be re-included on its own.
    expect(gitignoreException('.promptci/badges/score.json')).toBe('!**/.promptci/badges/');
    expect(gitignoreException('badges/score.json')).toBeUndefined();
  });

  it('carries only the score — no finding or file detail', () => {
    expect(Object.keys(buildBadge(50)).sort()).toEqual(['color', 'label', 'message', 'schemaVersion']);
  });
});
