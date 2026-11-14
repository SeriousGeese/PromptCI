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
import { applyFixRecipe, isOptInRecipe } from '../src/fix-engine.js';
import { parseSections } from '../src/scanner.js';
import { sameSectionText } from '../src/same-text.js';
import { MIRROR_CANONICAL_BASENAME, isImportOnlySection, resolvedImports } from '../src/mirror-import.js';
import { computeFingerprint } from '../src/baseline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES = path.resolve(__dirname, '../../../examples');
const FIXTURES = fs
  .readdirSync(EXAMPLES, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

/** The non-empty sections of a file, as the shared same-text rule sees them, minus pure import lines. */
function contentSections(text: string): string[] {
  return parseSections(text, 'x')
    .filter((s) => !isImportOnlySection(s))
    .map((s) => sameSectionText(s))
    .filter((t) => t !== '');
}

describe('every opt-in mirror recipe, on every fixture, loses, moves and adds no text and never makes the scan worse', () => {
  it.each(FIXTURES)('%s', async (name) => {
    const fixture = path.join(EXAMPLES, name);
    const mirrors = (await scan({ repoPath: fixture })).issues.filter(isOptInRecipe);
    for (const finding of mirrors) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `promptci-guard-optin-${name}-`));
      try {
        fs.cpSync(fixture, root, { recursive: true });
        const before = await scan({ repoPath: root });
        const target = before.issues.find((i) => i.id === finding.id)!;
        const canonical = fs.readFileSync(path.join(root, MIRROR_CANONICAL_BASENAME), 'utf8');
        const canonicalTexts = new Set(contentSections(canonical));
        const changes = await applyFixRecipe(target, root, { optIn: true });
        for (const change of changes) {
          const label = `${name}: ${path.relative(root, change.filePath)}`;
          const was = contentSections(change.originalContent);
          const now = contentSections(change.newContent);
          // Copy-only text stays, in its original order, and nothing else is left.
          expect(now, `${label}: kept text`).toEqual(was.filter((t) => !canonicalTexts.has(t)));
          // Every section the import brings in was already in the copy (nothing gained).
          for (const t of canonicalTexts) expect(was, `${label}: canonical text the copy lacked`).toContain(t);
          // The result holds a LIVE import of AGENTS.md: in the import-only block at the top.
          const [first] = parseSections(change.newContent, 'x').filter((s) => sameSectionText(s) !== '');
          expect(first?.heading, `${label}: import block on top`).toBeUndefined();
          expect(isImportOnlySection(first!), `${label}: import-only top block`).toBe(true);
          const copyRel = path.relative(root, change.filePath).split(path.sep).join('/');
          expect(resolvedImports(copyRel, first!.text), `${label}: live import of AGENTS.md`).toContain(MIRROR_CANONICAL_BASENAME);
          fs.writeFileSync(change.filePath, change.newContent);
        }
        if (changes.length === 0) continue;
        const after = await scan({ repoPath: root });
        expect(after.healthScore, `${name}: score`).toBeGreaterThanOrEqual(before.healthScore);
        const beforeKeys = new Set(before.issues.map((i) => computeFingerprint(i, root)));
        const added = after.issues.filter((i) => !beforeKeys.has(computeFingerprint(i, root)));
        expect(added.map((i) => `${i.severity} ${i.title}`), `${name}: new findings`).toEqual([]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });
});

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
