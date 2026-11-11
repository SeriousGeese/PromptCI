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

type Listing = Map<string, fs.Dirent> | 'missing' | 'unreadable';

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
  /** What could not be read, as shown in the report (`dir/` or a link's path) → why. */
  readonly unreadable = new Map<string, string>();

  constructor(repoRoot: string) {
    this.root = path.resolve(repoRoot);
    const real = realPath(this.root);
    this.realRoot = real !== null && real !== this.root ? real : undefined;
  }

  /** Forward-slash path relative to the root (`.` for the root itself); never absolute. */
  relative(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join('/') || '.';
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

  /** The entries of an in-root directory, by exact name. */
  private list(dir: string): Listing {
    let listing = this.listings.get(dir);
    if (listing === undefined) {
      try {
        listing = new Map(fs.readdirSync(dir, { withFileTypes: true }).map((d) => [d.name, d]));
      } catch (err) {
        const code = errorCode(err);
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          listing = 'missing';
        } else {
          listing = 'unreadable';
          this.noteUnreadable(dir, code ?? 'error');
        }
      }
      this.listings.set(dir, listing);
    }
    return listing;
  }

  /** In-root equivalent of a link target written against the root's real path. */
  private fromRealRoot(p: string): string {
    if (this.realRoot === undefined || isWithinRoot(this.root, p) || !isWithinRoot(this.realRoot, p)) return p;
    return path.join(this.root, path.relative(this.realRoot, p));
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
          // Resolved lexically against the link's own directory, then re-walked
          // from the root: the containment check above runs before anything
          // under the target is touched.
          next = path.join(this.fromRealRoot(path.resolve(dir, link)), ...parts.slice(i + 1));
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
  entries(candidate: string): ReadonlyMap<string, fs.Dirent> | 'missing' | 'outside' | 'unreadable' {
    const dir = this.lookup(candidate);
    if (dir.state !== 'found') return dir.state;
    if (!dir.isDir) return 'missing';
    return this.list(dir.path);
  }

  /**
   * fast-glob's directory reads, routed through node:fs here so a directory the
   * walk cannot list is recorded instead of silently dropping out of the result.
   * The walk itself (`cwd` = root, links not followed) never leaves the root.
   */
  walkFs(onError: () => void): Partial<fg.FileSystemAdapter> {
    const readdirSync = (dir: string, options?: { withFileTypes: true }): unknown => {
      try {
        return options ? fs.readdirSync(dir, options) : fs.readdirSync(dir);
      } catch (err) {
        const code = errorCode(err);
        // A directory deleted mid-walk has nothing left to miss.
        if (code !== 'ENOENT') {
          this.noteUnreadable(dir, code ?? 'error');
          onError();
        }
        throw err;
      }
    };
    return { readdirSync: readdirSync as fg.FileSystemAdapter['readdirSync'] };
  }
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
