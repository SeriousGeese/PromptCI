/**
 * pcic-oonz: the one deterministic "is this a typo for that?" test the
 * mechanical fix recipes share.
 *
 * A fix recipe may only rewrite a name when the repository offers exactly one
 * plausible replacement — otherwise the finding stays advisory and a human
 * picks. "Plausible" has to be a rule, not a judgement call: detectors are
 * rule-based, make no LLM call, and must produce identical output for
 * identical input, so the matcher below is a pure function of the name and the
 * candidate set, with no scoring heuristics, no locale and no ordering
 * dependence (a tie is resolved by reporting no match at all, never by taking
 * whichever candidate the manifest happened to list first).
 *
 * Two rules, applied in order:
 *
 *  1. **Separator / case equality.** The name and the candidate are equal once
 *     lowercased with `- _ : . /` and spaces removed, so `type-check` matches
 *     `typecheck` and `Build` matches `build`. Applied first because it is an
 *     exact correspondence, not a guess.
 *  2. **Damerau-Levenshtein distance ≤ {@link CLOSE_MATCH_MAX_DISTANCE}** —
 *     the optimal-string-alignment variant, so a single transposition
 *     (`tets` → `test`, `bulid` → `build`) costs 1 rather than 2. Only for
 *     names of at least {@link CLOSE_MATCH_MIN_LENGTH} characters: two edits
 *     on a three-character name is a different word, not a typo (`dev` would
 *     "match" `test`).
 *
 * Either rule must produce exactly ONE winner — one normalised-equal
 * candidate, or one candidate alone at the minimum distance. Zero candidates
 * and ties both yield `undefined`.
 *
 * {@link closestUniqueMatch} answers "is there one plausible candidate worth
 * NAMING?" and is deliberately permissive. Whether that candidate may be
 * applied without a human looking is a separate, much stricter question —
 * see {@link isMechanicalRename}.
 */

/** Maximum edit distance between a name and the candidate that may replace it. */
export const CLOSE_MATCH_MAX_DISTANCE = 2;

/** Shortest name the distance rule will judge; shorter names use rule 1 only. */
export const CLOSE_MATCH_MIN_LENGTH = 4;

/** Lowercased with the separators naming conventions disagree about removed. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_:./\s]/g, '');
}

/** Shortest name a two-edit difference may be judged a typo rather than a different script. */
export const MECHANICAL_TWO_EDIT_MIN_LENGTH = 8;

/** Shortest differing segment that may be corrected by an arbitrary single edit. */
export const MECHANICAL_SEGMENT_MIN_LENGTH = 5;

/** True when `a` and `b` are the same characters with one adjacent pair swapped. */
function isAdjacentTransposition(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const diff: number[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff.push(i);
  return diff.length === 2 && diff[1] === diff[0]! + 1 && a[diff[0]!] === b[diff[1]!] && a[diff[1]!] === b[diff[0]!];
}

/** True when `a` and `b` differ only by substituting digits for digits, position for position. */
function isDigitForDigitSubstitution(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let changed = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if (!/^\d$/.test(a[i]!) || !/^\d$/.test(b[i]!)) return false;
    changed = true;
  }
  return changed;
}

/**
 * pcic-oonz: whether replacing `missing` with `candidate` is a MECHANICAL
 * rename — a misspelling of one name — rather than a plausible reference to a
 * genuinely different script. Only a mechanical rename may be auto-applied;
 * {@link closestUniqueMatch} alone is far too loose for that.
 *
 * The problem the extra rules solve: a one-edit neighbour is very often a real
 * sibling script, and rewriting to it silently runs the wrong command.
 * `test:api` → `test:app`, `test:unit` → `test:init`, `db:up` → `db:rm`,
 * `test` → `best`, `build:v1` → `build:v2` are each a unique nearest
 * neighbour, and each rewrite is wrong. So:
 *
 *  1. A pure case / separator difference (`type-check` → `typecheck`) is always
 *     mechanical: the two names denote the same thing in different styles.
 *  2. Otherwise both names must have the SAME number of `:`-separated segments,
 *     with the difference confined to exactly one of them. A command that
 *     gains, loses or re-scopes a segment is a different command.
 *  3. That segment pair must be within one edit, or two only when the whole
 *     name is at least {@link MECHANICAL_TWO_EDIT_MIN_LENGTH} characters —
 *     two edits on a short name reaches too far (`test` → `dist`).
 *  4. A trailing-digit variant suffix is never corrected: `v1` → `v2`,
 *     `py2` → `py3`, `1` → `2` select a version or a target, and the digit is
 *     the whole point of the name.
 *  5. In a differing segment shorter than
 *     {@link MECHANICAL_SEGMENT_MIN_LENGTH} characters, only a transposition
 *     or a mid-name digit swap counts. A single substituted LETTER in a short
 *     name usually spells another real token (`api`/`app`, `test`/`best`,
 *     `unit`/`init`), and no deterministic rule can tell which was meant — but
 *     `e3e`/`e2e` is not two words, and `bulid`/`build` is a slip of the
 *     fingers. (A dictionary would separate these more sharply; the repository
 *     has no dictionary and detectors make no network call, so the test is
 *     structural.)
 *
 * Anything this rejects is still reported — with the candidate named
 * cautiously in the recommendation — just never rewritten automatically.
 */
export function isMechanicalRename(missing: string, candidate: string): boolean {
  if (!missing || !candidate || missing === candidate) return false;
  // 1. Same name, different convention.
  if (normalizeName(missing) === normalizeName(candidate)) return true;

  // 2. One differing `:` segment.
  const from = missing.split(':');
  const to = candidate.split(':');
  if (from.length !== to.length) return false;
  const differing = from.map((seg, i) => (seg === to[i] ? -1 : i)).filter((i) => i !== -1);
  if (differing.length !== 1) return false;
  const a = from[differing[0]!]!;
  const b = to[differing[0]!]!;

  // 3. Within the edit budget for this name's length.
  const distance = damerauLevenshtein(a, b);
  if (distance < 1 || distance > CLOSE_MATCH_MAX_DISTANCE) return false;
  if (distance === 2 && missing.length < MECHANICAL_TWO_EDIT_MIN_LENGTH) return false;

  // 4. A trailing-digit variant is a choice, not a typo.
  const stem = (seg: string): string => seg.replace(/\d+$/, '');
  if (stem(a) === stem(b)) return false;

  // 5. A short segment may only be transposed, or have a mid-name digit swapped.
  if (Math.max(a.length, b.length) < MECHANICAL_SEGMENT_MIN_LENGTH) {
    return isAdjacentTransposition(a, b) || isDigitForDigitSubstitution(a, b);
  }
  return true;
}

/**
 * Damerau-Levenshtein distance, optimal-string-alignment variant: insertions,
 * deletions, substitutions and transpositions of ADJACENT characters each cost
 * 1. OSA (rather than unrestricted Damerau-Levenshtein) is deliberate — it is
 * the simpler recurrence, and no substring is edited twice in a typo short
 * enough for this matcher to accept.
 */
export function damerauLevenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Three rolling rows: the previous two plus the one being filled.
  let twoBack: number[] = [];
  let oneBack: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  let current: number[] = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(
        oneBack[j]! + 1, // deletion
        current[j - 1]! + 1, // insertion
        oneBack[j - 1]! + cost, // substitution
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, twoBack[j - 2]! + 1); // transposition
      }
      current[j] = best;
    }
    twoBack = oneBack;
    oneBack = current;
    current = new Array<number>(b.length + 1);
  }

  return oneBack[b.length]!;
}

/**
 * The single candidate close enough to `name` to replace it mechanically, or
 * `undefined` when there is none or more than one. See the module comment for
 * the two rules; a candidate equal to `name` is ignored (the caller already
 * established that `name` is absent, so an equal entry is a different thing
 * with the same spelling, never the fix).
 */
export function closestUniqueMatch(name: string, candidates: Iterable<string>): string | undefined {
  const pool = [...new Set(candidates)].filter((c) => c !== name && c.length > 0);
  if (pool.length === 0 || name.length === 0) return undefined;

  // Rule 1: separator / case equality.
  const normalized = normalizeName(name);
  const equal = pool.filter((c) => normalizeName(c) === normalized);
  if (equal.length === 1) return equal[0];
  if (equal.length > 1) return undefined; // ambiguous: two spellings of one name

  // Rule 2: a unique nearest neighbour within the distance budget.
  if (name.length < CLOSE_MATCH_MIN_LENGTH) return undefined;
  let best = CLOSE_MATCH_MAX_DISTANCE + 1;
  let winner: string | undefined;
  let tied = false;
  for (const candidate of pool) {
    const distance = damerauLevenshtein(name, candidate);
    if (distance > CLOSE_MATCH_MAX_DISTANCE) continue;
    if (distance < best) {
      best = distance;
      winner = candidate;
      tied = false;
    } else if (distance === best) {
      tied = true;
    }
  }
  return tied ? undefined : winner;
}
