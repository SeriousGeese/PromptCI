/**
 * The product's promise for every unattended fix: merge it and the next scan
 * is no worse. For every fixture under examples/ and every finding the scan
 * marks `autoApplySafe`, apply that one recipe to a copy of the fixture and
 * rescan: the health score must not drop, no finding may appear that was not
 * there before (by baseline fingerprint, any severity), and the finding the
 * recipe fixed must be gone (pcic-1ik0.10: the old duplicate recipe left a
 * markdown link no tool loads, and the rescan scored the trimmed file lower).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../src/scan.js';
import { applyFixRecipe } from '../src/fix-engine.js';
import { computeFingerprint } from '../src/baseline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES = path.resolve(__dirname, '../../../examples');
const FIXTURES = fs
  .readdirSync(EXAMPLES, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

describe('every autoApplySafe recipe, on every fixture, never makes the next scan worse', () => {
  it('has fixtures to check', () => {
    expect(FIXTURES.length).toBeGreaterThan(10);
  });

  it.each(FIXTURES)('%s', async (name) => {
    const fixture = path.join(EXAMPLES, name);
    const report = await scan({ repoPath: fixture });
    const fixable = report.issues.filter((i) => i.autoApplySafe === true);
    for (const finding of fixable) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `promptci-guard-${name}-`));
      try {
        fs.cpSync(fixture, root, { recursive: true });
        const before = await scan({ repoPath: root });
        const target = before.issues.find((i) => i.id === finding.id)!;
        const changes = await applyFixRecipe(target, root);
        expect(changes.length, `${name}: ${finding.id} produced an edit`).toBeGreaterThan(0);
        for (const change of changes) fs.writeFileSync(change.filePath, change.newContent);
        const after = await scan({ repoPath: root });

        const label = `${name}: ${finding.id} (${finding.title})`;
        expect(after.healthScore, `${label}: score`).toBeGreaterThanOrEqual(before.healthScore);
        const beforeKeys = new Set(before.issues.map((i) => computeFingerprint(i, root)));
        const added = after.issues.filter((i) => !beforeKeys.has(computeFingerprint(i, root)));
        expect(added.map((i) => `${i.severity} ${i.title}`), `${label}: new findings`).toEqual([]);
        const fixedKey = computeFingerprint(target, root);
        expect(after.issues.some((i) => computeFingerprint(i, root) === fixedKey), `${label}: still reported`).toBe(false);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
