/**
 * End-to-end regression test for suppression of ai_config findings.
 *
 * The detectors discover files themselves (repo-relative), while suppression
 * annotations are parsed from scanner-produced InstructionFiles (absolute
 * paths). withScannerPaths bridges the two — without it, a correctly-formed
 * `promptci-ignore: ai_config` annotation never matches anything.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { scanFiles } from '../src/scanner.js';
import { parseSuppressions, applySuppressions } from '../src/suppression.js';
import { detectSkills } from '../src/skills-detector.js';
import { makeTempRepo, writeFile, ctx } from './ai-config-helpers.js';

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function repo(): string {
  const dir = makeTempRepo();
  cleanups.push(dir);
  return dir;
}

describe('ai_config suppression end-to-end', () => {
  it('an inline promptci-ignore: ai_config annotation suppresses a skill finding', async () => {
    const dir = repo();
    writeFile(dir, '.claude/skills/pdf/SKILL.md', [
      '---',
      'name: pdf',
      'description: Fill and read PDF forms when asked',
      '---',
      '<!-- promptci-ignore: ai_config',
      '     reason: The helper ships from a separate package at install time. -->',
      'Run `scripts/missing.py` first.',
    ].join('\n'));

    const issues = detectSkills(ctx(dir));
    expect(issues.some((i) => i.title.includes('bundled file'))).toBe(true);

    // The scanner picks SKILL.md up via .claude/**/*.md, so its annotations
    // are parsed with the scanner's own (absolute) path form.
    const files = await scanFiles({ repoPath: dir });
    const annotations = parseSuppressions(files);
    expect(annotations.length).toBeGreaterThan(0);

    const { active, suppressed } = applySuppressions(issues, annotations);
    expect(suppressed.some((i) => i.title.includes('bundled file'))).toBe(true);
    expect(active.some((i) => i.title.includes('bundled file'))).toBe(false);
  });
});
