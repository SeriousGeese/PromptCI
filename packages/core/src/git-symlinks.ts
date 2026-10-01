/**
 * Does git say a path is a symlink?
 *
 * A checkout without symlink support (Windows without `core.symlinks`) writes a
 * committed link as a small regular file holding the target path. The scanner
 * only treats such a file as a link when the repository itself says it is one,
 * so a hand-written one-line pointer file stays a real file:
 *
 *  1. the index (`.git/index`, versions 2 and 3) records the path with mode
 *     120000 — authoritative when it can be read: the path is a link exactly
 *     when its entry has that mode;
 *  2. otherwise the repository's own config has `core.symlinks = false` (the
 *     setting git writes at clone time on a filesystem that cannot link). The
 *     global and system config are deliberately not consulted: they say what a
 *     clone would do, not what this checkout is.
 *
 * Read-only, no git binary, no network. Anything unreadable or unrecognised
 * answers "no".
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_INDEX_BYTES = 128 * 1024 * 1024;
const MAX_INDEX_ENTRIES = 2_000_000;
const MAX_PARENT_LEVELS = 24;

type GitLocation = { workTree: string; gitDir: string; commonDir: string };

/** The repository (work tree, git dir, common dir) containing `start`, or undefined. */
function findGit(start: string): GitLocation | undefined {
  let dir = path.resolve(start);
  for (let level = 0; level < MAX_PARENT_LEVELS; level++) {
    const dotGit = path.join(dir, '.git');
    try {
      const stat = fs.statSync(dotGit);
      if (stat.isDirectory()) return { workTree: dir, gitDir: dotGit, commonDir: dotGit };
      if (stat.isFile() && stat.size < 4096) {
        // A linked worktree or submodule: `.git` is a file `gitdir: <path>`.
        const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'))?.[1];
        if (pointer) {
          const gitDir = path.resolve(dir, pointer);
          let commonDir = gitDir;
          try {
            const common = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
            if (common) commonDir = path.resolve(gitDir, common);
          } catch {
            // not a linked worktree
          }
          return { workTree: dir, gitDir, commonDir };
        }
      }
    } catch {
      // no `.git` here: keep climbing
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** `core.symlinks` from a git config file's text: false only when the last value says so. */
export function configDisablesSymlinks(config: string): boolean {
  let inCore = false;
  let value: string | undefined;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    const section = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"[^"]*")?\s*\]/.exec(line);
    if (section) {
      inCore = section[1]!.toLowerCase() === 'core' && !line.includes('"');
      continue;
    }
    if (!inCore) continue;
    const key = /^symlinks\s*(?:=\s*(.*?))?\s*(?:[;#].*)?$/i.exec(line);
    if (key) value = key[1] === undefined ? 'true' : key[1].replace(/^"|"$/g, '').trim();
  }
  return value !== undefined && /^(?:false|no|off|0)$/i.test(value);
}

/** The paths of a git index (versions 2 and 3) whose entry mode is a symlink; undefined when unreadable or another version. */
export function symlinkPathsInIndex(index: Buffer): Set<string> | undefined {
  if (index.length < 12 || index.toString('latin1', 0, 4) !== 'DIRC') return undefined;
  const version = index.readUInt32BE(4);
  if (version !== 2 && version !== 3) return undefined;
  const count = index.readUInt32BE(8);
  if (count > MAX_INDEX_ENTRIES) return undefined;
  const links = new Set<string>();
  let offset = 12;
  for (let n = 0; n < count; n++) {
    if (offset + 62 > index.length) return undefined;
    const mode = index.readUInt32BE(offset + 24);
    const flags = index.readUInt16BE(offset + 60);
    const extended = version === 3 && (flags & 0x4000) !== 0;
    const fixed = extended ? 64 : 62;
    let nameLength = flags & 0x0fff;
    if (nameLength === 0x0fff) {
      const nul = index.indexOf(0, offset + fixed);
      if (nul < 0) return undefined;
      nameLength = nul - (offset + fixed);
    }
    if (offset + fixed + nameLength > index.length) return undefined;
    if ((mode & 0o170000) === 0o120000) links.add(index.toString('utf8', offset + fixed, offset + fixed + nameLength));
    offset += Math.ceil((fixed + nameLength + 1) / 8) * 8;
  }
  return links;
}

export type GitSymlinkOracle = {
  /** Whether git says the file at `scanRelativePath` (relative to the scan root, POSIX) is a symlink. */
  isSymlink(scanRelativePath: string): boolean;
};

/** Built lazily by the caller: nothing is read until the first question. */
export function createGitSymlinkOracle(scanRoot: string): GitSymlinkOracle {
  let loaded: { git: GitLocation; links: Set<string> | undefined; configFalse: boolean } | null | undefined;

  const load = () => {
    if (loaded !== undefined) return loaded;
    loaded = null;
    const git = findGit(scanRoot);
    if (!git) return loaded;
    let configFalse = false;
    try {
      const configPath = path.join(git.commonDir, 'config');
      if (fs.statSync(configPath).size <= MAX_CONFIG_BYTES) configFalse = configDisablesSymlinks(fs.readFileSync(configPath, 'utf8'));
    } catch {
      // no readable config
    }
    let links: Set<string> | undefined;
    try {
      const indexPath = path.join(git.gitDir, 'index');
      if (fs.statSync(indexPath).size <= MAX_INDEX_BYTES) links = symlinkPathsInIndex(fs.readFileSync(indexPath));
    } catch {
      // no readable index
    }
    loaded = { git, links, configFalse };
    return loaded;
  };

  return {
    isSymlink(scanRelativePath) {
      const state = load();
      if (!state) return false;
      // The index is authoritative when it parsed: the path is a link exactly when its entry says so.
      if (state.links) {
        const gitRelative = path.relative(state.git.workTree, path.resolve(scanRoot, scanRelativePath)).split(path.sep).join('/');
        return state.links.has(gitRelative);
      }
      return state.configFalse;
    },
  };
}
