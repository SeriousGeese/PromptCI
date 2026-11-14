import type { CheckProvenance } from './types.js';
import { INSTRUCTION_ADVICE_PROVENANCE } from './instruction-advice.js';
import { REPO_CHECKS_PROVENANCE } from './repo-checks.js';
import { TOOL_CONFIG_PROVENANCE } from './tool-config.js';

export * from './types.js';
export { PROVENANCE_MAX_AGE_DAYS, daysSince, provenanceExpiringSoon, provenanceProblems } from './check.js';

/**
 * The provenance record of every check family (pcic-kvv3.1). Grouped by what the
 * checks rest on, one file per group, each next to the detectors it describes:
 * tool-config.ts (what the AI tools read), instruction-advice.ts (how to write
 * instructions), repo-checks.ts (facts about the scanned repository).
 */
export const CHECK_PROVENANCE: readonly CheckProvenance[] = [
  ...TOOL_CONFIG_PROVENANCE,
  ...INSTRUCTION_ADVICE_PROVENANCE,
  ...REPO_CHECKS_PROVENANCE,
];

/** The records of one detector (`DETECTORS` id), in registry order. */
export function provenanceFor(detectorId: string): readonly CheckProvenance[] {
  return CHECK_PROVENANCE.filter((record) => record.detector === detectorId);
}
