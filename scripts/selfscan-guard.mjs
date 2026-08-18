#!/usr/bin/env node
// Guard for the selfscan npm scripts: refuse to scan when the repo checkout
// itself lives under a `.claude/` directory (e.g. a Claude Code worktree at
// .claude/worktrees/<branch>/).
//
// Why: deriveFileType in packages/core/src/scanner.ts classifies files by
// substring-matching the ABSOLUTE path, so `/.claude/` anywhere above the repo
// root makes every scanned file (README.md included) look like a Claude
// instruction file. A selfscan from such a checkout produces bogus findings,
// and `pnpm selfscan:update` would commit a silently corrupted baseline and
// badge that the CI ratchet then enforces. Fail loudly instead.
//
// This guard is defense-in-depth: the root cause (classifying by absolute
// rather than repo-relative path) belongs in scanner.ts, but the baseline
// artifacts this repo commits must stay trustworthy meanwhile.
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const normalized = repoRoot.replace(/\\/g, '/');

if (/\/\.claude\//.test(normalized + '/')) {
  console.error(
    'selfscan: this checkout lives under a .claude/ directory\n' +
      `  (${repoRoot})\n` +
      'The scanner classifies files by absolute path, so scanning from here\n' +
      'misclassifies every file as a Claude instruction file and produces a\n' +
      'corrupted baseline/badge. Run the selfscan from a checkout whose path\n' +
      'does not contain "/.claude/" (a normal clone, or CI).',
  );
  process.exit(1);
}
