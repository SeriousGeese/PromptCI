/**
 * A containment-safe view of the scanned repository, for detectors that check
 * whether a path an instruction file names exists (pcic-xhzb, pcic-x1vl).
 *
 * Instruction files are untrusted input. In the hosted product the scan root
 * is a server temp directory, so an existence check on a path the text names
 * (`../../etc/x`, `/etc/x`, `C:\x`, or a committed link out of the tree) would
 * tell whoever wrote the scanned repository whether a server path exists.
 * Every such check goes through {@link RepoTree}, which never touches a path
 * outside the root.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type fg from 'fast-glob';
import type { IssueCategory, PromptCiIssue } from './types.js';
import { isWithinRoot, realPath } from './path-containment.js';
import { PathInventory, buildInventory, normalizeKnownPath } from './known-paths.js';
import type { KnownPaths } from './known-paths.js';

/**
 * True for a path that is absolute on ANY platform: POSIX (`/x`), Windows drive
 * or UNC (`C:\x`, `\\host\share`), or drive-relative (`C:x`, which Windows
 * resolves against that drive's working directory and Linux reads as a file
 * name). Detectors skip these before any lookup, so a Windows and a Linux scan
 * agree, the verdict never depends on where the repository is checked out, and
 * a Windows scan never opens an SMB connection for `\\host\…`.
 */
export function isAbsoluteAnywhere(p: string): boolean {
  return path.posix.isAbsolute(p) || path.win32.isAbsolute(p) || /^[A-Za-z]:/.test(p);
}

/** What the repository holds at a path. */
export type Lookup =
  | { state: 'found'; path: string; isDir: boolean }
  | { state: 'missing' }
  /** The path, or a link on the way to it, leads outside the scan root. */
  | { state: 'outside' }
  /** A directory on the way could not be listed: neither present nor absent. */
  | { state: 'unreadable' };

/**
 * One directory entry, as much of `fs.Dirent` as a detector needs. A real
 * `fs.Dirent` satisfies it; so does an entry synthesized from a
 * {@link PathInventory} (pcic-csf), which never stands for a symlink.
 */
export type TreeEntry = {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

type Listing = Map<string, TreeEntry> | 'missing' | 'unreadable';

/** A {@link TreeEntry} for an inventory entry: a plain file or directory, never a link. */
function inventoryEntry(name: string, kind: 'file' | 'dir'): TreeEntry {
  return {
    name,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir',
    isSymbolicLink: () => false,
  };
}

/** How a {@link RepoTree} answers existence questions. */
export type RepoTreeOptions = {
  /**
   * pcic-csf: the repo-relative POSIX paths the repository holds. Consulted
   * before the filesystem by every existence check a scan makes.
   */
  knownPaths?: KnownPaths;
  /**
   * True when `knownPaths` is the WHOLE repository, so a path it does not list
   * is genuinely absent and the filesystem is never consulted. False (the
   * default) treats it as a partial view: an unlisted path is still looked for
   * on disk.
   */
  knownPathsComplete?: boolean;
};

/** The `code` of a filesystem error (`EACCES`, `ENOENT`, …), when it has one. */
export function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** Links followed for one lookup before it gives up (a cycle, or a chain no real tree has). */
const MAX_LINK_HOPS = 40;

/**
 * pcic-xhzb: the only way a detector asks the filesystem about a path an
 * instruction file names (dead references; command validity since pcic-x1vl).
 *
 * - Contained. A path is looked up by listing the directories from the scan
 *   root down to it, so nothing outside the root is ever listed, stat'ed or
 *   opened. A committed link is read (`readlink`, a property of the link,
 *   which lives in the tree) and followed only while its target stays inside
 *   the root; a link out of the tree makes the lookup `outside` without
 *   touching what it points at. A hosted scan runs against a server temp
 *   directory, and an existence check outside it would tell whoever wrote the
 *   scanned repository whether a server path exists.
 * - Exact case. A segment matches a directory entry of exactly that name, so
 *   `Deploy_PR.yml` does not resolve to `deploy_pr.yml` on a case-insensitive
 *   filesystem (Windows, macOS). The result is the same on every platform, and
 *   the same as on Linux and GitHub, where the reference is broken.
 * - Honest about failure. A directory that cannot be listed makes the lookup
 *   `unreadable`, never `missing`, and is recorded so the scan can say so.
 *
 * Listings are cached for the scan, so each directory is read at most once.
 */
export class RepoTree {
  readonly root: string;
  /** The root's real path, when it differs (a root under a symlink, like macOS `/var`). */
  private readonly realRoot: string | undefined;
  private readonly listings = new Map<string, Listing>();
  /**
   * pcic-csf: the caller's inventory of the repository, when one was given.
   * Consulted before the filesystem; see {@link PathInventory}.
   */
  readonly inventory: PathInventory | undefined;
  /** What could not be read, as shown in the report (`dir/` or a link's path) → why. */
  readonly unreadable = new Map<string, string>();

  constructor(repoRoot: string, options: RepoTreeOptions = {}) {
    this.root = path.resolve(repoRoot);
    const real = realPath(this.root);
    this.realRoot = real !== null && real !== this.root ? real : undefined;
    this.inventory = buildInventory(options.knownPaths, options.knownPathsComplete);
  }

  /** Forward-slash path relative to the root (`.` for the root itself); never absolute. */
  relative(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join('/') || '.';
  }

  /** {@link relative} in the inventory's own spelling: `''` for the root, never `.`. */
  private relativePosix(abs: string): string {
    const rel = this.relative(abs);
    return rel === '.' ? '' : rel;
  }

  /** Record what could not be read: a directory (shown as `dir/`) or a link (shown as its path). */
  noteUnreadable(p: string, reason: string, kind: 'dir' | 'link' = 'dir'): void {
    const abs = path.resolve(this.root, p);
    // Only in-root names are ever recorded: the report must not carry a server path.
    if (!isWithinRoot(this.root, abs)) return;
    const rel = this.relative(abs);
    const shown = kind === 'link' ? rel : rel === '.' ? './' : `${rel}/`;
    if (!this.unreadable.has(shown)) this.unreadable.set(shown, reason);
  }

  /** The entries of an in-root directory on the filesystem, by exact name. */
  private listFs(dir: string, note: boolean): Listing {
    try {
      return new Map<string, TreeEntry>(fs.readdirSync(dir, { withFileTypes: true }).map((d) => [d.name, d]));
    } catch (err) {
      const code = errorCode(err);
      if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
      if (note) this.noteUnreadable(dir, code ?? 'error');
      return 'unreadable';
    }
  }

  /**
   * The entries of an in-root directory, by exact name.
   *
   * pcic-csf: with an inventory, its listing is authoritative when it is
   * complete; otherwise the two are merged (the inventory wins on a name they
   * both carry) so a path the caller named is found even though the scan root
   * holds only the instruction files. A directory the inventory describes is
   * never reported as unreadable, since nothing had to be read to answer.
   */
  private list(dir: string): Listing {
    let listing = this.listings.get(dir);
    if (listing !== undefined) return listing;
    const inventoryChildren = this.inventory?.children(this.relativePosix(dir));
    const fromInventory = inventoryChildren === undefined
      ? undefined
      : new Map<string, TreeEntry>([...inventoryChildren].map(([name, kind]) => [name, inventoryEntry(name, kind)]));
    if (this.inventory !== undefined && this.inventory.complete) {
      listing = fromInventory ?? 'missing';
    } else {
      const onDisk = this.listFs(dir, fromInventory === undefined);
      if (fromInventory === undefined) listing = onDisk;
      else if (typeof onDisk === 'string') listing = fromInventory;
      else listing = new Map<string, TreeEntry>([...onDisk, ...fromInventory]);
    }
    this.listings.set(dir, listing);
    return listing;
  }

  /** In-root equivalent of a link target written against the root's real path. */
  private fromRealRoot(p: string): string {
    if (this.realRoot === undefined || isWithinRoot(this.root, p) || !isWithinRoot(this.realRoot, p)) return p;
    return path.join(this.root, path.relative(this.realRoot, p));
  }

  /**
   * Where a link's target lands inside the root, or `null` when following it
   * would leave the root.
   *
   * pcic-e6xa: a RELATIVE target is resolved segment by segment against the
   * link's own directory and refused the moment it climbs above the root —
   * even when a later segment names the root's own directory again
   * (`x -> ../<root dir name>/y`). Resolving such a link lexically lands back
   * inside the root, so the old containment check passed it and the verdict
   * came to depend on the name of the directory the scan runs in: whoever
   * wrote the scanned repository could learn it, and a hosted scan's temp
   * directory name is not theirs to learn. An ABSOLUTE target cannot climb, so
   * it keeps the plain containment check (plus the root's real path, for a root
   * that itself sits under a link, like macOS `/var`).
   */
  private linkTargetWithinRoot(linkDir: string, link: string): string | null {
    if (path.isAbsolute(link) || /^[A-Za-z]:/.test(link)) {
      const absolute = this.fromRealRoot(path.resolve(link));
      return isWithinRoot(this.root, absolute) ? absolute : null;
    }
    const parts = path.relative(this.root, linkDir).split(path.sep).filter(Boolean);
    if (parts.includes('..') || path.isAbsolute(parts.join(path.sep))) return null;
    for (const segment of link.split(/[\\/]/)) {
      if (segment === '' || segment === '.') continue;
      if (segment !== '..') parts.push(segment);
      else if (parts.pop() === undefined) return null; // climbed above the root
    }
    return path.join(this.root, ...parts);
  }

  lookup(candidate: string): Lookup {
    let target = path.resolve(this.root, candidate);
    let lastLink = '';
    for (let hop = 0; hop <= MAX_LINK_HOPS; hop++) {
      // Lexical containment first: `..`, absolute, other-drive and UNC paths stop here.
      if (!isWithinRoot(this.root, target)) return { state: 'outside' };
      const parts = path.relative(this.root, target).split(path.sep).filter(Boolean);
      let dir = this.root;
      let isDir = true;
      let next: string | undefined;
      for (let i = 0; i < parts.length; i++) {
        if (!isDir) return { state: 'missing' }; // a file in the middle of a path
        const listing = this.list(dir);
        if (listing === 'missing') return { state: 'missing' };
        if (listing === 'unreadable') return { state: 'unreadable' };
        const name = parts[i]!;
        const entry = listing.get(name);
        if (!entry) return { state: 'missing' };
        const entryPath = path.join(dir, name);
        if (entry.isSymbolicLink()) {
          let link: string;
          try {
            link = fs.readlinkSync(entryPath);
          } catch (err) {
            this.noteUnreadable(entryPath, errorCode(err) ?? 'unreadable link', 'link');
            return { state: 'unreadable' };
          }
          lastLink = entryPath;
          // Resolved against the link's own directory and refused if it leaves
          // the root (pcic-e6xa), then re-walked from the root: the containment
          // check above runs again before anything under the target is touched.
          const landing = this.linkTargetWithinRoot(dir, link);
          if (landing === null) return { state: 'outside' };
          next = path.join(landing, ...parts.slice(i + 1));
          break;
        }
        isDir = entry.isDirectory();
        dir = entryPath;
      }
      if (next === undefined) return { state: 'found', path: dir, isDir };
      target = next;
    }
    // More links than the kernel itself follows (Linux MAXSYMLINKS): a cycle.
    this.noteUnreadable(lastLink, 'symlink loop', 'link');
    return { state: 'unreadable' };
  }

  isDir(candidate: string): boolean {
    const found = this.lookup(candidate);
    return found.state === 'found' && found.isDir;
  }

  /**
   * pcic-e6xa: the one way a detector asks whether a FIXED name exists
   * (`.env`, `supabase/migrations`, `Cargo.toml`, `requirements.txt`,
   * `.clinerules`). The name is not user input, but the tree around it is: a
   * committed link out of the repository made the answer depend on a path
   * outside the scan root, and a hosted scan's root is a server temp
   * directory. Going through {@link lookup} keeps every such check inside the
   * root — and lets a caller's inventory answer it (pcic-csf).
   *
   * `candidate` may be repo-relative or absolute inside the root. Anything
   * outside, or under a directory that could not be listed, reads as absent:
   * these checks are signals ("does this repo use Supabase?"), and the honest
   * answer when the scan cannot look is the one that adds no finding.
   */
  exists(candidate: string): boolean {
    return this.lookup(candidate).state === 'found';
  }

  /** {@link exists}, restricted to a regular file (or a link to one inside the root). */
  isFile(candidate: string): boolean {
    const found = this.lookup(candidate);
    return found.state === 'found' && !found.isDir;
  }

  /**
   * The text of an in-root file, or why there is none to read.
   *
   * `missing` and `outside` come from {@link lookup}, so nothing outside the
   * root is opened. `unreadable` covers both a directory on the way that could
   * not be listed and a file the scan knows is there but cannot open — which
   * is what a caller's inventory (pcic-csf) produces for a path it listed
   * without fetching. Callers must not read `unreadable` as "absent": the
   * difference is exactly what keeps a hosted scan from reporting a file it
   * never downloaded as missing.
   */
  readText(candidate: string): { state: 'found'; content: string } | { state: 'missing' | 'outside' | 'unreadable' } {
    const found = this.lookup(candidate);
    if (found.state !== 'found') return { state: found.state };
    if (found.isDir) return { state: 'missing' };
    try {
      return { state: 'found', content: fs.readFileSync(found.path, 'utf8') };
    } catch (err) {
      const code = errorCode(err);
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        // Listed by the inventory but not on disk: known to exist, not readable here.
        if (this.inventory !== undefined) return { state: 'unreadable' };
        return { state: 'missing' };
      }
      this.noteUnreadable(found.path, code ?? 'error', 'link');
      return { state: 'unreadable' };
    }
  }

  /**
   * Every file at or below `candidate`, as repo-relative POSIX paths in sorted
   * order, or `undefined` when the scan's view of that subtree is not complete
   * enough to enumerate it (no inventory, or a partial one). Lets a detector
   * that would otherwise walk the repository itself use the caller's inventory
   * instead (pcic-csf).
   */
  listKnownFiles(candidate = ''): string[] | undefined {
    const inventory = this.inventory;
    if (inventory === undefined || !inventory.complete) return undefined;
    const rel = normalizeKnownPath(candidate);
    if (rel === null) return [];
    const prefix = rel === '' ? '' : `${rel}/`;
    return inventory.listedFiles().filter((p) => p === rel || p.startsWith(prefix));
  }

  /**
   * An extension-less module path names the file that carries the extension:
   * `src/lib/db` is `src/lib/db.ts`. True when the directory holds `<name>.*`.
   */
  hasStemSibling(candidate: string): boolean {
    const dir = this.lookup(path.dirname(candidate));
    if (dir.state !== 'found' || !dir.isDir) return false;
    const listing = this.list(dir.path);
    if (typeof listing === 'string') return false;
    const prefix = `${path.basename(candidate)}.`;
    for (const name of listing.keys()) if (name.startsWith(prefix)) return true;
    return false;
  }

  /**
   * pcic-x1vl: the entries of the in-root directory at `candidate`, by exact
   * name, or why there are none to give (a file counts as `missing`).
   */
  entries(candidate: string): ReadonlyMap<string, TreeEntry> | 'missing' | 'outside' | 'unreadable' {
    const dir = this.lookup(candidate);
    if (dir.state !== 'found') return dir.state;
    if (!dir.isDir) return 'missing';
    return this.list(dir.path);
  }

  /**
   * fast-glob's directory reads, routed through this tree so a directory the
   * walk cannot list is recorded instead of silently dropping out of the
   * result — and so a caller's inventory is what the walk sees (pcic-csf),
   * which is the whole repository rather than the handful of files a hosted
   * scan fetched. The walk itself (`cwd` = root, links not followed) never
   * leaves the root.
   */
  walkFs(onError: () => void): Partial<fg.FileSystemAdapter> {
    const readdirSync = (dir: string, options?: { withFileTypes: true }): unknown => {
      const listing = this.list(dir);
      if (listing === 'missing') {
        throw Object.assign(new Error(`ENOENT: no such file or directory, scandir '${dir}'`), { code: 'ENOENT' });
      }
      if (listing === 'unreadable') {
        onError();
        throw Object.assign(new Error(`EACCES: permission denied, scandir '${dir}'`), { code: 'EACCES' });
      }
      const entries = [...listing.values()];
      return options ? entries : entries.map((entry) => entry.name);
    };
    return { readdirSync: readdirSync as fg.FileSystemAdapter['readdirSync'] };
  }
}

/**
 * The scan's {@link RepoTree}: the one built while the context was assembled,
 * so every detector shares its directory cache and its inventory (pcic-csf).
 *
 * Hand-built contexts (tests, older callers) carry no tree, and get a plain
 * filesystem-backed one over the same root — the behavior before pcic-e6xa
 * routed these checks through the tree, minus the out-of-root access.
 */
export function treeFor(context: { repoRoot: string; tree?: RepoTree }): RepoTree {
  return context.tree ?? new RepoTree(context.repoRoot);
}

/** A reference left unchecked because part of the tree could not be read, aggregated per evidence line. */
export type UncheckedRef = { filePaths: Set<string>; fileLines: Map<string, number>; evidence: string };

/** Evidence lines listed per kind before the rest is summarised. */
const MAX_INCOMPLETE_EVIDENCE = 10;

/**
 * pcic-xhzb: a directory the scan could not list is named, never turned into
 * findings. Without this, an unreadable directory emptied the name index (or
 * part of it) and every bare name filed there was reported as broken, with no
 * sign the scan had failed. The gap is a `warning`, the severity of the
 * findings it stands in for, so a `--fail-on warning` gate that a broken
 * reference would have tripped is not passed silently by a scan that could
 * not look (the supply-chain scan's `unscanned-files` likewise warns about
 * content it could not read). Paths are repo-relative, so a hosted scan never
 * shows its temp dir. Shared by the detectors that use {@link RepoTree}
 * (pcic-x1vl), each with its own wording.
 */
export function incompleteCheckIssue(
  tree: RepoTree,
  refs: UncheckedRef[],
  text: {
    id: string;
    category: IssueCategory;
    title: string;
    /** What was left unchecked, singular (`reference`, `command`). */
    unit: string;
    /** Sentence saying the outcome is unknown, without the final period. */
    unknown: string;
    /** The finding kind that was not reported (`broken-reference`). */
    finding: string;
  },
): PromptCiIssue {
  const capped = (lines: string[], noun: string): string[] =>
    lines.length > MAX_INCOMPLETE_EVIDENCE
      ? [...lines.slice(0, MAX_INCOMPLETE_EVIDENCE), `…and ${lines.length - MAX_INCOMPLETE_EVIDENCE} more ${noun}`]
      : lines;
  const dirs = [...tree.unreadable].sort(([a], [b]) => a.localeCompare(b));
  const dirLines = dirs.map(([shown, reason]) => `Could not read: ${shown} (${reason})`);
  const filePaths = [...new Set(refs.flatMap((r) => [...r.filePaths]))];
  const firstLine = new Map<string, number>();
  for (const r of refs) {
    for (const [fp, line] of r.fileLines) {
      const seen = firstLine.get(fp);
      if (seen === undefined || line < seen) firstLine.set(fp, line);
    }
  }
  return {
    id: text.id,
    severity: 'warning',
    category: text.category,
    title: text.title,
    summary:
      `${refs.length} ${text.unit}(s) were not checked because part of the repository could not be read ` +
      `(${dirs.length} location${dirs.length === 1 ? '' : 's'}). ${text.unknown}; ` +
      `no ${text.finding} finding was reported for them.`,
    filePaths,
    locations: filePaths.map((fp) => {
      const startLine = firstLine.get(fp);
      return startLine !== undefined ? { filePath: fp, startLine } : { filePath: fp };
    }),
    evidence: [...capped(dirLines, 'locations'), ...capped(refs.map((r) => r.evidence), `${text.unit}s`)],
    recommendation:
      'Make the listed locations readable by the user running the scan (or fix the symlink), then scan again to ' +
      `check these ${text.unit}s.`,
    confidence: 0.8,
  };
}
