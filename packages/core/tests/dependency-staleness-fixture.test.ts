/**
 * pcic-2b6.11 against a committed fixture: examples/fixture-dependency-staleness
 * triggers each rule once and keeps a "must stay quiet" section next to them,
 * and fixture-clean (no staleness) must not produce any dep-staleness finding.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scan } from '../src/scan.js';

const EXAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../examples');

describe('examples/fixture-dependency-staleness', () => {
  it('reports exactly the stale mentions and nothing from the "stay quiet" section', async () => {
    const report = await scan({ repoPath: path.join(EXAMPLES, 'fixture-dependency-staleness') });
    const found = report.issues
      .filter((i) => i.id.startsWith('dep-staleness-'))
      .map((i) => `${i.severity}: ${i.title}`)
      .sort();
    expect(found).toEqual([
      'high: Instructions use ReactDOM.render, which React 19 removed',
      'info: Instructions point at a deprecated package: moment',
      'warning: Instructions use getInitialProps in a Next.js app-router project',
      'warning: Package named in instructions is not in any package.json: zustand',
    ]);
  });

  it('leaves the clean fixture alone', async () => {
    const report = await scan({ repoPath: path.join(EXAMPLES, 'fixture-clean') });
    expect(report.issues.filter((i) => i.id.startsWith('dep-staleness-'))).toEqual([]);
  });
});
