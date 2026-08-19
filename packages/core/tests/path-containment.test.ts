/**
 * Boundary tests for the shared path-containment helper (issue #54).
 *
 * The headline case is the sibling-prefix trap: `/srv/repo-evil` string-starts
 * with `/srv/repo`, so the naive `resolved.startsWith(root)` guard this helper
 * replaces treated a sibling directory as contained. We assert both the trap
 * (the raw prefix still matches) and the fix (isWithinRoot rejects it).
 *
 * Cross-platform: the platform-agnostic cases run on whatever OS hosts the
 * suite (POSIX in CI, Windows in local dev). The drive-letter / backslash cases
 * are guarded to their native platform because path.resolve only interprets
 * them there.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { isWithinRoot, resolveWithinRoot } from '../src/path-containment.js';

const onWindows = process.platform === 'win32';

describe('isWithinRoot', () => {
  const root = path.resolve('/srv/proj/repo');

  it('accepts the root itself', () => {
    expect(isWithinRoot(root, root)).toBe(true);
  });

  it('accepts a nested descendant', () => {
    expect(isWithinRoot(root, path.join(root, 'packages', 'core', 'x.ts'))).toBe(true);
  });

  it('rejects a sibling directory that shares a name prefix', () => {
    const sibling = path.resolve('/srv/proj/repo-evil');
    // The trap the old guard fell into: the raw string prefix still matches.
    expect(sibling.startsWith(root)).toBe(true);
    // The fix: containment is decided by the relative walk, not the prefix.
    expect(isWithinRoot(root, sibling)).toBe(false);
  });

  it('rejects a parent-directory escape', () => {
    expect(isWithinRoot(root, path.join(root, '..'))).toBe(false);
    expect(isWithinRoot(root, path.join(root, '..', '..', 'etc', 'passwd'))).toBe(false);
  });

  it('accepts a child whose name merely begins with ".." (not a real escape)', () => {
    expect(isWithinRoot(root, path.join(root, '..foo'))).toBe(true);
  });

  it.runIf(!onWindows)('POSIX: rejects a sibling-prefix directory', () => {
    expect(isWithinRoot('/srv/repo', '/srv/repo-evil')).toBe(false);
    expect(isWithinRoot('/srv/repo', '/srv/repo/sub')).toBe(true);
    expect(isWithinRoot('/srv/repo', '/etc/passwd')).toBe(false);
  });

  it.runIf(onWindows)('Windows: rejects a sibling-prefix directory and a different drive', () => {
    expect(isWithinRoot('C:\\srv\\repo', 'C:\\srv\\repo-evil')).toBe(false);
    expect(isWithinRoot('C:\\srv\\repo', 'C:\\srv\\repo\\sub')).toBe(true);
    // A path on another drive can never be reached by walking up.
    expect(isWithinRoot('C:\\srv\\repo', 'D:\\srv\\repo\\sub')).toBe(false);
  });
});

describe('resolveWithinRoot', () => {
  const root = path.resolve('/srv/proj/repo');

  it('resolves a contained relative path to an absolute path', () => {
    expect(resolveWithinRoot(root, 'a/b.md')).toBe(path.join(root, 'a', 'b.md'));
  });

  it('returns null for a relative escape', () => {
    expect(resolveWithinRoot(root, '../secret')).toBeNull();
    expect(resolveWithinRoot(root, '../../etc/passwd')).toBeNull();
  });

  it('accepts an absolute path that lands inside the root', () => {
    const inside = path.join(root, 'sub', 'file.md');
    expect(resolveWithinRoot(root, inside)).toBe(inside);
  });

  it('returns null for an absolute path outside the root', () => {
    const outside = path.resolve('/srv/proj/repo-evil/x');
    expect(resolveWithinRoot(root, outside)).toBeNull();
  });
});
