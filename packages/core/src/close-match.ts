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
 */

/** Maximum edit distance between a name and the candidate that may replace it. */
export const CLOSE_MATCH_MAX_DISTANCE = 2;

/** Shortest name the distance rule will judge; shorter names use rule 1 only. */
export const CLOSE_MATCH_MIN_LENGTH = 4;

/** Lowercased with the separators naming conventions disagree about removed. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_:./\s]/g, '');
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
