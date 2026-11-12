/**
 * pcic-csf: a caller-supplied inventory of the paths a repository holds, used
 * instead of (or alongside) the filesystem for every existence check a scan
 * makes.
 *
 * A hosted scan does not have the repository on disk. It fetches the
 * instruction files into a temp directory and leaves everything else
 * unfetched, so every path a detector checks reads as missing and the scan
 * reports references, commands and config targets as broken when they are
 * merely absent from the temp dir. Naming the repository's real file list up
 * front — `ScanInput.knownPaths`, with `knownPathsComplete` saying whether the
 * list is the whole repository — makes those checks answer about the
 * repository rather than about what happened to be downloaded.
 *
 * This module is pure: it holds no filesystem access and no I/O of any kind.
 * {@link RepoTree} consults it first and falls back to the filesystem only for
 * paths the inventory does not cover, and only while `knownPathsComplete` is
 * false.
 */

/**
 * Repo-relative POSIX paths of the files a repository holds. A `Set` is read
 * as-is; an array is accepted for convenience (JSON, a database row).
 *
 * Only FILES need listing: every directory on the way to a listed file is
 * implied, so `[".github/workflows/ci.yml"]` also says `.github` and
 * `.github/workflows` are directories.
 */
export type KnownPaths = ReadonlySet<string> | readonly string[];

/** What an inventory says about one path. */
export type PathKind =
  | 'file'
  | 'dir'
  /** The inventory covers the whole repository and does not list it. */
  | 'absent'
  /** Not listed, and the inventory is partial: ask the filesystem. */
  | 'unknown';

/**
 * `p` as a repo-relative POSIX path (`''` for the root itself), or `null` when
 * it is not one: absolute on any platform, or climbing out of the repository.
 *
 * Backslashes are read as separators so a caller that built its list on
 * Windows is not silently misread as holding one file named `a\b`. `.`
 * segments are dropped and `..` is refused outright rather than resolved: an
 * inventory entry is a statement about a path inside the repository, and a
 * caller that means `a/b` should say so.
 */
export function normalizeKnownPath(p: string): string | null {
  if (p === '') return '';
  // Absolute in any platform's form, or a Windows drive-relative path.
  if (/^[/\\]/.test(p) || /^[A-Za-z]:/.test(p)) return null;
  const segments: string[] = [];
  for (const segment of p.split(/[/\\]+/)) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return null;
    segments.push(segment);
  }
  return segments.join('/');
}

/** `''`, plus every proper ancestor directory of `rel`, nearest last. */
function ancestorsOf(rel: string): string[] {
  const out = [''];
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'));
  return out;
}

/**
 * pcic-csf: the paths a repository holds, as a lookup. Built once per scan and
 * shared through {@link RepoTree}; immutable afterwards.
 *
 * A path is a directory when some listed path has it as a prefix, so no caller
 * has to list directories separately. A listed path that is ALSO a prefix of
 * another (`a/b` next to `a/b/c`) is a directory: the deeper entry can only be
 * true if it is.
 */
export class PathInventory {
  /**
   * True when the list is the whole repository, so a path it does not hold is
   * genuinely absent. False when it is a partial view and unlisted paths must
   * still be looked for on the filesystem.
   */
  readonly complete: boolean;
  /** Listed paths that are not also a directory. */
  private readonly files = new Set<string>();
  /** Directory → its entries, by name. The root is `''`. */
  private readonly tree = new Map<string, Map<string, 'file' | 'dir'>>();

  constructor(knownPaths: KnownPaths, complete = false) {
    this.complete = complete;
    const listed = new Set<string>();
    for (const raw of knownPaths) {
      const rel = normalizeKnownPath(raw);
      if (rel === null || rel === '') continue;
      listed.add(rel);
    }
    const dirs = new Set<string>(['']);
    for (const rel of listed) for (const dir of ancestorsOf(rel)) dirs.add(dir);
    for (const rel of listed) if (!dirs.has(rel)) this.files.add(rel);
    // One pass over files and directories, each filed under its parent.
    const place = (rel: string, kind: 'file' | 'dir'): void => {
      const slash = rel.lastIndexOf('/');
      const parent = slash === -1 ? '' : rel.slice(0, slash);
      const name = slash === -1 ? rel : rel.slice(slash + 1);
      let entries = this.tree.get(parent);
      if (entries === undefined) {
        entries = new Map();
        this.tree.set(parent, entries);
      }
      // A directory wins over a file of the same name: see the class comment.
      if (kind === 'dir' || !entries.has(name)) entries.set(name, kind);
    };
    for (const rel of this.files) place(rel, 'file');
    for (const dir of dirs) {
      if (dir === '') continue;
      place(dir, 'dir');
      if (!this.tree.has(dir)) this.tree.set(dir, new Map());
    }
    if (!this.tree.has('')) this.tree.set('', new Map());
  }

  /** What the inventory says `rel` (a normalized repo-relative path, `''` = root) is. */
  classify(rel: string): PathKind {
    if (rel === '') return 'dir';
    if (this.tree.has(rel)) return 'dir';
    if (this.files.has(rel)) return 'file';
    return this.complete ? 'absent' : 'unknown';
  }

  /** The entries of the directory at `rel`, or `undefined` when it is not a listed directory. */
  children(rel: string): ReadonlyMap<string, 'file' | 'dir'> | undefined {
    return this.tree.get(rel);
  }

  /** Every listed file, sorted — the inventory's own view of the repository. */
  listedFiles(): string[] {
    return [...this.files].sort();
  }
}

/**
 * A {@link PathInventory} for `knownPaths`, or `undefined` when none was given.
 * An EMPTY complete list is a real statement ("the repository holds nothing
 * else"), so it still produces an inventory; `undefined`/absent does not.
 */
export function buildInventory(
  knownPaths: KnownPaths | undefined,
  knownPathsComplete: boolean | undefined,
): PathInventory | undefined {
  if (knownPaths === undefined) return undefined;
  return new PathInventory(knownPaths, knownPathsComplete === true);
}
