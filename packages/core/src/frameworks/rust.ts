import type { RepoContext } from '../repo-context.js';
import type { PromptCiIssue } from '../types.js';
import * as path from 'node:path';
import * as fs from 'node:fs';

export function detectRust(context: RepoContext): PromptCiIssue[] {
  const issues: PromptCiIssue[] = [];
  const { repoRoot, files } = context;

  const hasCargoToml = fs.existsSync(path.join(repoRoot, 'Cargo.toml'));
  const combinedContent = files.map(f => f.content).join('\n');
  const hasRustMentions = /\bcargo\.toml\b|\bcargo\s+(build|test|run|clippy|fmt)\b/i.test(combinedContent);

  if (!hasCargoToml && !hasRustMentions) {
    return [];
  }

  const allFilePaths = files.map(f => f.path);

  // 1. Missing cargo verification commands
  const hasCargoCommands = /cargo\s+(test|clippy|fmt)/i.test(combinedContent);
  if (!hasCargoCommands) {
    issues.push({
      id: 'rust-missing-verification-commands',
      severity: 'warning',
      category: 'structure',
      title: 'Missing Rust Verification Commands',
      summary: 'Rust project detected, but instructions do not mention Cargo verification commands like "cargo test" or "cargo clippy".',
      filePaths: allFilePaths,
      locations: [],
      evidence: ['Rust detected, but no cargo test/clippy/fmt commands found in instructions.'],
      recommendation: 'Add instructions telling the agent to run cargo test, cargo clippy, and cargo fmt to verify changes.',
      fixRecipe: 'Before saying work is complete, verify changes by running cargo fmt, cargo clippy, and cargo test.',
      confidence: 0.85,
    });
  }

  // 2. MSRV check against Cargo.toml
  let rustVersion: string | undefined;
  if (hasCargoToml) {
    try {
      const cargoContent = fs.readFileSync(path.join(repoRoot, 'Cargo.toml'), 'utf-8');
      const match = /^rust-version\s*=\s*["'](.*?)["']/m.exec(cargoContent);
      if (match) {
        rustVersion = match[1]?.trim();
      }
    } catch {
      // ignore
    }
  }

  if (rustVersion) {
    const majorMinor = (version: string): string | undefined => {
      const match = /^(\d+)\.(\d+)/.exec(version);
      return match ? `${match[1]}.${match[2]}` : undefined;
    };
    const rustVersionRe = /\bRust\s+(\d+\.\d+(?:\.\d+)?)\b/i;
    const match = rustVersionRe.exec(combinedContent);
    if (match) {
      const instrVersion = match[1]!;
      if (majorMinor(instrVersion) !== majorMinor(rustVersion)) {
        issues.push({
          id: 'rust-version-mismatch',
          severity: 'warning',
          category: 'stale_instruction',
          title: 'Rust Version Mismatch',
          summary: `Instructions mention Rust version ${instrVersion}, but Cargo.toml specifies rust-version = "${rustVersion}".`,
          filePaths: allFilePaths,
          locations: [],
          evidence: [`Cargo.toml requires rust-version = ${rustVersion}; instructions mention Rust ${instrVersion}`],
          recommendation: `Update instructions to match the Rust version specified in Cargo.toml (${rustVersion}).`,
          fixRecipe: `Target Rust ${rustVersion} as the Minimum Supported Rust Version (MSRV) for this project.`,
          confidence: 0.8,
        });
      }
    }
  }

  return issues;
}
