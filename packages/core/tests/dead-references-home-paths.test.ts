/**
 * pcic-2b6.12: home-directory references (`~/…`, `$HOME/…`, `%USERPROFILE%\…`)
 * live outside the repository and must never be reported as broken references.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectDeadReferences } from '../src/dead-references.js';
import type { InstructionFile } from '../src/types.js';

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptci-home-ref-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeFile(content: string): InstructionFile {
  return {
    path: path.join(tmpDir, 'CLAUDE.md'),
    fileType: 'claude',
    content,
    sections: [],
    lineCount: content.split('\n').length,
    charCount: content.length,
    estimatedTokens: Math.round(content.length / 4),
  };
}

describe('detectDeadReferences: home-directory paths', () => {
  it.each([
    ['tilde', 'Settings live in `~/.config/x/settings.json`.'],
    ['tilde with a script', 'Run `~/bin/setup-machine.sh` once per machine.'],
    ['$HOME', 'Merge into `$HOME/.config/x/settings.json`.'],
    ['${HOME}', 'Merge into `${HOME}/.config/x/settings.json`.'],
    ['$USERPROFILE', 'Edit `$USERPROFILE/.claude/settings.json`.'],
    ['%USERPROFILE%', 'Edit `%USERPROFILE%\\.claude\\settings.json`.'],
    ['$env:USERPROFILE', 'Edit `$env:USERPROFILE/.claude.json`.'],
    ['$env:APPDATA', 'Config is in `$env:APPDATA/Code/User/settings.json`.'],
    ['markdown link', 'See [my global rules](~/.claude/rules.md) for context.'],
  ])('does not flag a %s reference', (_label, content) => {
    expect(detectDeadReferences([makeFile(content)], tmpDir)).toEqual([]);
  });

  it('still flags a broken repo-relative path on the same line as a home path', () => {
    const issues = detectDeadReferences(
      [makeFile('Copy `docs/missing-guide.md` over `~/.config/x/settings.json`.')],
      tmpDir,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.title).toMatch(/missing-guide\.md/);
  });

  it('does not treat a repo path that merely contains "home" as home-rooted', () => {
    const issues = detectDeadReferences([makeFile('See `home/docs/missing.md`.')], tmpDir);
    expect(issues).toHaveLength(1);
  });
});
