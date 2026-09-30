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
 */

import micromatch from 'micromatch';
import { readTextWithinRoot } from './ai-config.js';

type Rule = {
  negate: boolean;
  dirOnly: boolean;
  /** Contains a slash (other than a trailing one): matched against the path below the ignore file. */
  anchored: boolean;
  glob: string;
};

function parseRules(content: string): Rule[] {
  const rules: Rule[] = [];
  for (const raw of content.split(/\r?\n/)) {
    let line = raw.replace(/(?<!\\)[ \t]+$/, '');
    if (line === '' || line.startsWith('#')) continue;
    let negate = false;
    if (line.startsWith('!')) {
      negate = true;
      line = line.slice(1);
    }
    if (line.startsWith('\\')) line = line.slice(1); // `\#file`, `\!file`
    let dirOnly = false;
    if (line.endsWith('/')) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    const anchored = line.includes('/');
    line = line.replace(/^\//, '');
    if (line === '') continue;
    rules.push({ negate, dirOnly, anchored, glob: line });
  }
  return rules;
}

function ruleMatches(rule: Rule, pathBelowIgnoreFile: string, isDir: boolean): boolean {
  if (rule.dirOnly && !isDir) return false;
  const target = rule.anchored ? pathBelowIgnoreFile : pathBelowIgnoreFile.split('/').pop()!;
  return micromatch.isMatch(target, rule.glob, { dot: true });
}

/** Build a checker over one repository; ignore files are read lazily and once each. */
export function createGitIgnoreChecker(repoRoot: string): (repoRelativePath: string) => boolean {
  const cache = new Map<string, Rule[]>();
  const rulesFor = (dir: string): Rule[] => {
    let rules = cache.get(dir);
    if (!rules) {
      const content = readTextWithinRoot(repoRoot, dir === '' ? '.gitignore' : `${dir}/.gitignore`);
      rules = content === undefined ? [] : parseRules(content);
      cache.set(dir, rules);
    }
    return rules;
  };

  return (repoRelativePath: string): boolean => {
    const segments = repoRelativePath.replace(/\\/g, '/').replace(/^\.\//, '').split('/').filter(Boolean);
    for (let end = 1; end <= segments.length; end++) {
      const isDir = end < segments.length; // every prefix but the last is a directory
      let ignored: boolean | undefined;
      for (let start = 0; start < end; start++) {
        const below = segments.slice(start, end).join('/');
        for (const rule of rulesFor(segments.slice(0, start).join('/'))) {
          if (ruleMatches(rule, below, isDir)) ignored = !rule.negate;
        }
      }
      // An ignored directory cannot be re-included, so everything below it is ignored too.
      if (ignored === true) return true;
    }
    return false;
  };
}
