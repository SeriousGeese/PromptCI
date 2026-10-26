/**
 * The one path-containment check for the whole toolchain.
 *
 * Every place that resolves an externally-influenced path (a config value, an
 * LLM-proposed edit target, a fix's file path) must confirm the result stays
 * inside the repo/target root before touching the filesystem. This module is
 * the single, tested implementation those checks share.
 *
 * The naive guard this replaces — `resolved.startsWith(root)` — is wrong two
 * ways:
 *   - **Sibling prefix.** `/repo-evil` starts with `/repo`, so a sibling
 *     directory whose name merely shares a prefix reads as "contained".
 *   - **Separator / drive blind spots.** On Windows a raw string prefix ignores
 *     the path separator boundary and cross-drive absolutes.
 *
 * Comparing the *relative* path from the root sidesteps both: a contained path
 * yields `''` (the root itself) or a forward walk with no leading `..`; any
 * escape yields a leading `..` segment or an absolute path (a different drive).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * True when `candidatePath` resolves to `root` itself or a descendant of it.
 * Both arguments are resolved to absolute form first, so either may be relative.
 */
export function isWithinRoot(root: string, candidatePath: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidatePath);
  const rel = path.relative(resolvedRoot, resolved);
  // '' is the root itself. A genuine escape is exactly '..' or begins with
  // '..<sep>' (a child literally named e.g. '..foo' is NOT an escape), or is
  // absolute — which path.relative only returns when the target is on a
  // different Windows drive and cannot be reached by walking up.
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  );
}

/**
 * Resolve `candidatePath` — treated as relative to `root` unless it is itself
 * absolute — and return the absolute path when it stays within `root`, or
 * `null` when it escapes (via `..`, an absolute path, or a different drive).
 */
export function resolveWithinRoot(root: string, candidatePath: string): string | null {
  try {
    const resolvedRoot = path.resolve(root);
    const resolved = path.isAbsolute(candidatePath)
      ? path.resolve(candidatePath)
      : path.resolve(resolvedRoot, candidatePath);
    return isWithinRoot(resolvedRoot, resolved) ? resolved : null;
  } catch {
    return null;
  }
}

/** The canonical real path (symlinks resolved), or null when it does not exist. */
export function realPath(p: string): string | null {
  try {
    const real: unknown = fs.realpathSync.native(p);
    return typeof real === 'string' ? real : null;
  } catch {
    return null;
  }
}

/**
 * True unless `absPath` exists and resolves — through a symlinked file or any
 * symlinked directory on its path — to a location outside `root`. The lexical
 * checks above cannot see a symlink: a committed `CLAUDE.md -> /etc/passwd`
 * or `package.json -> ~/.npmrc` passes them and is then read through. In-repo
 * symlinks stay readable. A path that does not exist (or a dangling link) has
 * nothing to read through, so it is left to the caller's own read to fail.
 */
export function realPathWithinRoot(root: string, absPath: string): boolean {
  const real = realPath(absPath);
  if (real === null) return true;
  const realRoot = realPath(root) ?? path.resolve(root);
  return isWithinRoot(realRoot, real);
}

/**
 * {@link resolveWithinRoot} for paths about to be READ: additionally `null`
 * when the target is a symlink (or sits under a symlinked directory) whose
 * real path escapes `root`.
 */
export function resolveReadableWithinRoot(root: string, candidatePath: string): string | null {
  const resolved = resolveWithinRoot(root, candidatePath);
  if (resolved === null) return null;
  return realPathWithinRoot(root, resolved) ? resolved : null;
}

/**
 * True when WRITING `target` stays inside `root`. The mirror of the read
 * policy: a path inside the root must not reach outside through a symlink on
 * any component that already exists (a `.promptci` committed as a link to
 * `/etc`, a `latest.md` linked to `~/.bashrc`), including a dangling link whose
 * target a write would create outside. The nearest existing ancestor is
 * checked, so a not-yet-created file is judged by the directory it would land in.
 *
 * A target that is lexically OUTSIDE the root is the caller's explicit choice
 * (`--output /tmp/report.md`) and is allowed.
 */
export function writeTargetWithinRoot(root: string, target: string): boolean {
  const resolved = path.resolve(target);
  if (!isWithinRoot(root, resolved)) return true;
  let probe = resolved;
  for (;;) {
    if (realPath(probe) !== null) return realPathWithinRoot(root, probe);
    try {
      // lstat succeeding while realpath failed: a dangling symlink, whose target a write would create.
      if (fs.lstatSync(probe).isSymbolicLink()) return false;
    } catch {
      // does not exist: look at its parent
    }
    const parent = path.dirname(probe);
    if (parent === probe) return true;
    probe = parent;
  }
}
