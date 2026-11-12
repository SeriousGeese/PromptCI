/**
 * Minimal `.gitignore` matching for "is this referenced file expected to be
 * absent from a checkout?" questions.
 *
 * A reference to `.beads/issues.jsonl` or `/data/app.db` is not broken when the
 * repository's own ignore rules say the file is local, generated state. This
 * reads the `.gitignore` files on the path from the repo root down to the file
 * (nested ignore files apply to their own directory) and evaluates them the way
 * git does: within one file the last matching rule wins, a deeper file overrides
 * a shallower one, and a file under an ignored directory is ignored. It does not
 * read `.git/info/exclude` or the user's global excludes file — only what the
 * repository itself commits.
 *
 * Patterns are translated to regular expressions with gitignore's own glob
 * dialect (`*`, `?`, `[...]`, `**`, backslash escapes). They are deliberately
 * NOT handed to a general-purpose glob library: braces, extglobs (`+(a|b)`),
 * a leading `!` after an escape, and `#` mean something different there than
 * they do to git, which treats them literally.
 */

import type { RepoTree } from './repo-tree.js';

type Rule = {
  negate: boolean;
  dirOnly: boolean;
  /** Contains a slash (other than a trailing one): matched against the path below the ignore file. */
  anchored: boolean;
  regex: RegExp;
};

function escapeRegex(ch: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(ch) ? `\\${ch}` : ch;
}

/** Translate a gitignore glob (no leading `/`, no trailing `/`) to an anchored RegExp source. */
function globToRegexSource(glob: string): string {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i]!;
    if (ch === '\\') {
      // A backslash makes the next character literal.
      if (i + 1 < glob.length) out += escapeRegex(glob[i + 1]!);
      i += 2;
    } else if (ch === '*') {
      if (glob[i + 1] === '*') {
        const atStart = i === 0 || glob[i - 1] === '/';
        let end = i + 2;
        while (glob[end] === '*') end++;
        if (atStart && glob[end] === '/') {
          out += '(?:.*/)?'; // `**/` — zero or more directories
          i = end + 1;
        } else if (atStart && end === glob.length) {
          out += '.*'; // trailing `/**` (the slash is already emitted) — everything below
          i = end;
        } else {
          out += '[^/]*'; // `**` not bounded by slashes behaves like `*`
          i = end;
        }
      } else {
        out += '[^/]*';
        i++;
      }
    } else if (ch === '?') {
      out += '[^/]';
      i++;
    } else if (ch === '[') {
      const close = glob.indexOf(']', i + 2); // `[]x]` / `[!]x]` make the first `]` a member
      if (close === -1) {
        out += '\\[';
        i++;
      } else {
        let body = glob.slice(i + 1, close);
        let negated = false;
        if (body.startsWith('!') || body.startsWith('^')) {
          negated = true;
          body = body.slice(1);
        }
        body = body.replace(/[\\^\]]/g, (c) => `\\${c}`);
        out += `[${negated ? '^' : ''}${body}]`;
        i = close + 1;
      }
    } else {
      out += escapeRegex(ch);
      i++;
    }
  }
  return out;
}

function parseRules(content: string): Rule[] {
  const rules: Rule[] = [];
  for (const raw of content.split(/\r?\n/)) {
    // Unescaped trailing spaces are dropped; `foo\ ` keeps its space.
    let line = raw.replace(/(?<!\\)[ \t]+$/, '');
    if (line === '' || line.startsWith('#')) continue; // `\#file` starts with a backslash, not `#`
    let negate = false;
    if (line.startsWith('!')) {
      negate = true;
      line = line.slice(1);
    }
    // `\!file` and `\#file`: the backslash stays in the glob, where it reads as an escape.
    let dirOnly = false;
    if (line.endsWith('/')) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    const anchored = line.includes('/');
    line = line.replace(/^\//, '');
    if (line === '') continue;
    try {
      rules.push({ negate, dirOnly, anchored, regex: new RegExp(`^${globToRegexSource(line)}$`) });
    } catch {
      // An unparseable pattern is skipped, as git would warn about and ignore it.
    }
  }
  return rules;
}

function ruleMatches(rule: Rule, pathBelowIgnoreFile: string, isDir: boolean): boolean {
  if (rule.dirOnly && !isDir) return false;
  const target = rule.anchored ? pathBelowIgnoreFile : pathBelowIgnoreFile.split('/').pop()!;
  return rule.regex.test(target);
}

/**
 * What the repository's ignore rules say about a path.
 *
 * `true`/`false` are answers. The other two say the answer is not available,
 * because an ignore file that applies to the path exists and its text was not
 * read — callers must not take either for "not ignored". They are kept apart
 * for the same reason {@link RepoTree.readText} keeps them apart:
 *  - `'unreadable'` — the scan tried and failed. It is recorded, so a caller
 *    can raise the "check incomplete" warning that names what it could not read.
 *  - `'unfetched'` — a caller's inventory listed the file without fetching it
 *    (pcic-csf). Nothing failed and there is nothing to name, so callers stay
 *    silent.
 */
export type IgnoreVerdict = boolean | 'unreadable' | 'unfetched';

/** The rules of one `.gitignore`, or why its text was not available. */
type RulesOrUnknown = Rule[] | 'unreadable' | 'unfetched';

/**
 * Build a checker over one repository; ignore files are read lazily and once
 * each.
 *
 * pcic-e6xa: the `.gitignore` files are read through the scan's
 * {@link RepoTree}, so a `.gitignore` committed as a link out of the
 * repository is not read and a caller's file inventory is consulted first
 * (pcic-csf) — the same source every other existence check in the scan uses.
 *
 * pcic-csf: a `.gitignore` the scan knows is there but has not got the bytes
 * of (a hosted scan fetches only the instruction files) yields `'unknown'`, not
 * an empty rule set. Treating it as "no rules" is what made such a scan report
 * every reference to a gitignored generated file — `.beads/issues.jsonl`,
 * `data/app.db` — as a broken reference.
 */
export function createGitIgnoreChecker(tree: RepoTree): (repoRelativePath: string) => IgnoreVerdict {
  const cache = new Map<string, RulesOrUnknown>();
  const rulesFor = (dir: string): RulesOrUnknown => {
    let rules = cache.get(dir);
    if (rules === undefined) {
      const read = tree.readText(dir === '' ? '.gitignore' : `${dir}/.gitignore`);
      rules = read.state === 'found' ? parseRules(read.content)
        : read.state === 'unfetched' ? 'unfetched'
        : read.state === 'unreadable' || read.state === 'too-large' ? 'unreadable'
        : [];
      cache.set(dir, rules);
    }
    return rules;
  };

  return (repoRelativePath: string): IgnoreVerdict => {
    const segments = repoRelativePath.replace(/\\/g, '/').replace(/^\.\//, '').split('/').filter(Boolean);
    let unavailable: 'unreadable' | 'unfetched' | undefined;
    for (let end = 1; end <= segments.length; end++) {
      const isDir = end < segments.length; // every prefix but the last is a directory
      let ignored: boolean | undefined;
      for (let start = 0; start < end; start++) {
        const below = segments.slice(start, end).join('/');
        const rules = rulesFor(segments.slice(0, start).join('/'));
        if (typeof rules === 'string') {
          // A real read failure is the one worth naming, so it wins.
          if (rules === 'unreadable' || unavailable === undefined) unavailable = rules;
          continue;
        }
        for (const rule of rules) {
          if (ruleMatches(rule, below, isDir)) ignored = !rule.negate;
        }
      }
      // An ignored directory cannot be re-included, so everything below it is ignored too.
      if (ignored === true) return true;
    }
    // Nothing matched, but an ignore file that could have matched went unread.
    return unavailable ?? false;
  };
}
