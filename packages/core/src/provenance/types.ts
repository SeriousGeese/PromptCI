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

/** How a source bears on the claim, as read on `readOn`. */
export type SourceStance = 'supports' | 'contradicts' | 'context';

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
  /** Tools the claim is about, or `all`. */
  appliesTo: readonly ProvenanceTool[] | 'all';
  /** Pages read for this claim. A `tool-fact` or `opinion` needs one, or `unverified: true`. */
  sources: readonly ProvenanceSource[];
  /** For an opinion: an eval (a path or URL) that shows the advice changes what an agent does. */
  evals?: readonly string[];
  /**
   * True when no source or eval was found for the claim. A result, not a failure:
   * it says the check rests on judgement, and it stays visible until someone sources it.
   */
  unverified?: true;
  /** Every numeric threshold the check uses, each with its own source. */
  thresholds?: readonly ProvenanceThreshold[];
  lastVerified: {
    /** `YYYY-MM-DD`. */
    date: string;
    /** Who or what verified it: a person, or the agent run that read the sources. */
    by: string;
  };
};
