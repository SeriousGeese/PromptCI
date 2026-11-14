/**
 * Provenance for the checks (pcic-kvv3.1, issue #162).
 *
 * Every check encodes a claim: about a repository, about a tool, or about how a
 * model behaves. A provenance record says which, where the claim comes from, which
 * tools it is about and when it was last verified, so that a vendor change can be
 * traced to the checks it touches and a check nobody re-verified can be seen as such.
 *
 * Records are plain data, kept in `packages/core/src/provenance/` next to the
 * detectors they describe, and exported from `@promptci/core` so a consumer can
 * show "applies to" and "last verified" per check. Nothing here runs at scan time
 * and nothing here touches the network: sources are URLs a person or an agent read
 * on the stated date, never fetched by the scanner.
 */

/**
 * - `repo-fact`: a statement about the repository being scanned (a file does not
 *   exist, a script is not defined). Does not go stale, so it is exempt from expiry.
 * - `tool-fact`: how an AI coding tool behaves (which files it reads, a size limit,
 *   a config format). Goes stale when the vendor ships.
 * - `opinion`: advice about how to write instructions. Goes stale as models improve.
 */
export type ProvenanceKind = 'repo-fact' | 'tool-fact' | 'opinion';

/** The tools a claim can be about. A `repo-fact` applies to `all`. */
export const PROVENANCE_TOOLS = ['claude-code', 'codex', 'cursor', 'copilot', 'gemini-cli', 'windsurf'] as const;
export type ProvenanceTool = (typeof PROVENANCE_TOOLS)[number];

/**
 * How a source bears on the claim, as read on `readOn`.
 *
 * - `supports`: the page says what the claim says. Only this makes a `tool-fact` sourced.
 * - `contradicts`: the page says the opposite, or something that makes the claim false.
 * - `context`: related reading. It does not support the claim and never counts as a source.
 */
export type SourceStance = 'supports' | 'contradicts' | 'context';

/**
 * What a record stands on, derived from its fields (see `provenanceStatus`):
 * `repo-fact` (needs nothing), `sourced` (a supporting page, or an eval),
 * `unverified` (nothing supports it; it rests on judgement) or `refuted` (the
 * only on-point source says the opposite: the check is probably wrong).
 */
export type ProvenanceStatus = 'repo-fact' | 'sourced' | 'unverified' | 'refuted';

export type ProvenanceSource = {
  /** A page that was actually read; never reconstructed from memory. */
  url: string;
  /** What the page is, in a few words. */
  title: string;
  /** `YYYY-MM-DD` the page was read. */
  readOn: string;
  stance: SourceStance;
  /** What on the page bears on the claim, in one sentence. */
  note: string;
};

export type ProvenanceThreshold = {
  /** The constant or option, as named in the detector. */
  name: string;
  value: number | string;
  unit?: string;
  /** Where it lives, `file.ts:CONSTANT`. */
  where: string;
  /** What supports the number, or `unverified`. An arbitrary but declared heuristic cut-off is `unverified`. */
  source: ProvenanceSource | 'unverified';
};

export type CheckProvenance = {
  /** Stable id: the detector id, or `<detector-id>/<family>` when one detector rests on several claims. */
  id: string;
  /** The `DETECTORS` id (packages/core/src/detectors.ts) this record belongs to. */
  detector: string;
  /** Plain-words name of the check family. */
  title: string;
  kind: ProvenanceKind;
  /** One sentence the check depends on, written so it can be false. */
  claim: string;
  /**
   * The AI tools the claim is about; `all` when it holds for every AI tool (or the
   * scanned repository), `n/a` when it is not about an AI tool at all (a package
   * manager, a language, a framework, git).
   */
  appliesTo: readonly ProvenanceTool[] | 'all' | 'n/a';
  /**
   * Pages read for this claim. A `tool-fact` is sourced only by a `supports`
   * source; `context` pages are related reading and `contradicts` pages mean the
   * claim is `refuted`. Stances are judged against `appliesTo`.
   */
  sources: readonly ProvenanceSource[];
  /**
   * For an opinion: an eval (a path or URL) that shows the advice changes what an
   * agent does. A documentation page is not an eval: an opinion with none is `unverified`.
   */
  evals?: readonly string[];
  /**
   * True when nothing supports the claim: no `supports` source for a tool-fact, no
   * eval for an opinion. A result, not a failure: the check rests on judgement and
   * stays visible until someone sources it. May list `context` sources (related reading).
   */
  unverified?: true;
  /**
   * True when the only on-point source contradicts the claim. It needs at least one
   * `contradicts` source and no `supports` one; the check is reviewed by a person,
   * never retired automatically.
   */
  refuted?: true;
  /**
   * Something a reader of the record should know that is not a source: a banner on
   * the vendor's page saying the product is being replaced, a caveat on a claim.
   */
  caveat?: string;
  /** Every numeric threshold the check uses, each with its own source. */
  thresholds?: readonly ProvenanceThreshold[];
  lastVerified: {
    /** `YYYY-MM-DD`. */
    date: string;
    /** Who or what verified it: a person, or the agent run that read the sources. */
    by: string;
  };
};
