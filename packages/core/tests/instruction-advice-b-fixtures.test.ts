/**
 * #181, #182, #185 against committed fixtures: the volatile-content and local-path hints
 * are for tools other than Claude Code (a CLAUDE.md gets none), and the Copilot topic-silence
 * check stays quiet when Copilot can read a file that documents the topic.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scan } from '../src/scan.js';

const EXAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../examples');

describe('examples/fixture-prompt-cache-hints', () => {
  it('hints for the Cursor file only, at info and unscored, never for CLAUDE.md', async () => {
    const report = await scan({ repoPath: path.join(EXAMPLES, 'fixture-prompt-cache-hints') });
    const cache = report.issues.filter((i) => i.id.startsWith('prompt-cache-'));
    expect(cache.map((i) => i.title).sort()).toEqual([
      'Local machine paths in instructions',
      'Volatile branch or task status in instructions',
      'Volatile timestamp in instruction file',
    ]);
    for (const issue of cache) {
      expect(issue.severity).toBe('info');
      expect(issue.tags).toContain('unscored');
      expect(issue.filePaths.map((p) => path.basename(p))).toEqual(['.cursorrules']);
    }
  });
});

describe('Copilot topic silence fixtures', () => {
  const silence = (r: Awaited<ReturnType<typeof scan>>) => r.issues.filter((i) => i.title.includes('silent on'));

  it('fires when only a Cursor file (which Copilot does not read) documents the convention', async () => {
    const report = await scan({ repoPath: path.join(EXAMPLES, 'fixture-copilot-topic-silence') });
    expect(silence(report)).toHaveLength(1);
  });

  it('stays quiet when AGENTS.md exists', async () => {
    const report = await scan({ repoPath: path.join(EXAMPLES, 'fixture-copilot-topic-silence-agents') });
    expect(silence(report)).toEqual([]);
  });
});
