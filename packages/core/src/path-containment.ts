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
