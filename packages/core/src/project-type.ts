import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import fg from 'fast-glob';
import type { InstructionFile, ProjectType } from './types.js';

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Detect the primary project type for a repo at repoRoot.
 * Detection order: nextjs → unity → dotnet → typescript → python → go → rust → unknown
 *
 * Unity/.NET probes run before the package.json→typescript branch: Unity and .NET
 * repos commonly carry a root package.json for JS tooling (husky, prettier), so the
 * bare-package.json check must not shadow their more specific markers. This matches
 * the unity-before-typescript ordering in detectProjectTypeFromContent.
 */
export async function detectProjectType(repoRoot: string): Promise<ProjectType> {
  const root = path.resolve(repoRoot);

  // ── Next.js ──────────────────────────────────────────────────────────────
  // next.config.* exists OR (app/ or pages/ alongside package.json)
  const nextConfigGlob = await fg('next.config.*', {
    cwd: root,
    dot: false,
    followSymbolicLinks: false,
    deep: 1,
  });
  if (nextConfigGlob.length > 0) return 'nextjs';

  const hasPkgJson = await exists(path.join(root, 'package.json'));
  if (hasPkgJson) {
    const hasApp = await dirExists(path.join(root, 'app'));
    const hasPages = await dirExists(path.join(root, 'pages'));
    if (hasApp || hasPages) return 'nextjs';
  }

  // ── Unity ────────────────────────────────────────────────────────────────
  // Assets/ directory AND ProjectSettings/ProjectVersion.txt both exist.
  // Checked before the package.json→typescript branch so a Unity repo with a
  // root package.json is not misclassified as typescript.
  const hasAssets = await dirExists(path.join(root, 'Assets'));
  const hasProjectVersion = await exists(
    path.join(root, 'ProjectSettings', 'ProjectVersion.txt'),
  );
  if (hasAssets && hasProjectVersion) return 'unity';

  // ── .NET ─────────────────────────────────────────────────────────────────
  // any .sln or .csproj file at repo root level. Also checked before the
  // typescript branch for the same reason (JS tooling drops a package.json).
  const dotnetFiles = await fg(['*.sln', '*.csproj'], {
    cwd: root,
    dot: false,
    followSymbolicLinks: false,
    deep: 1,
  });
  if (dotnetFiles.length > 0) return 'dotnet';

  // ── TypeScript ───────────────────────────────────────────────────────────
  // package.json or tsconfig.json present
  const hasTsConfig = await exists(path.join(root, 'tsconfig.json'));
  if (hasPkgJson || hasTsConfig) return 'typescript';

  // ── Python ───────────────────────────────────────────────────────────────
  const hasPyProject = await exists(path.join(root, 'pyproject.toml'));
  const hasRequirements = await exists(path.join(root, 'requirements.txt'));
  const hasPipfile = await exists(path.join(root, 'Pipfile'));
  const hasConda = await exists(path.join(root, 'environment.yml'));
  const hasSetupPy = await exists(path.join(root, 'setup.py'));
  if (hasPyProject || hasRequirements || hasPipfile || hasConda || hasSetupPy) return 'python';

  // ── Go ───────────────────────────────────────────────────────────────────
  const hasGoMod = await exists(path.join(root, 'go.mod'));
  if (hasGoMod) return 'go';

  // ── Rust ─────────────────────────────────────────────────────────────────
  const hasCargoToml = await exists(path.join(root, 'Cargo.toml'));
  if (hasCargoToml) return 'rust';

  return 'unknown';
}

/**
 * Content-based project type detection — used as a fallback when the file-system
 * scan returns 'unknown' (e.g. repos that only contain instruction files, no source).
 * Checks the combined content of all scanned instruction files for strong signals.
 *
 * Detection order: nextjs → unity → typescript → dotnet → python → go → rust → unknown
 */
export function detectProjectTypeFromContent(files: InstructionFile[]): ProjectType {
  const combined = files.map((f) => f.content).join('\n');

  if (/\bnext\.?js\b|\bapp\s+router\b|\bpages?\s+router\b|\bnext\s+build\b|\bnext\s+dev\b/i.test(combined)) {
    return 'nextjs';
  }
  if ((/\bunity\b/i.test(combined) && /\b(lts|editor|hub|engine)\b/i.test(combined)) || /\bmonobehaviour\b|\bunityengine\b|\bgameobject\b|\bprefab\b|\bscriptableobject\b/i.test(combined)) {
    return 'unity';
  }
  if (/\btypescript\b|\btsconfig\b|\btsc\s|\bpnpm\b|\bnpm\s+run\b|\bvitest\b|\bjest\b/i.test(combined)) {
    return 'typescript';
  }
  if (/\bdotnet\b|\.sln\b|\.csproj\b|\bxunit\b|\bnunit\b|\bmstest\b/i.test(combined)) {
    return 'dotnet';
  }
  if (/\bpython\b|\bpip\b|\bpoetry\b|\bvenv\b|\bpytest\b|\bpyproject\.toml\b/i.test(combined)) {
    return 'python';
  }
  if (/\bgo\.mod\b|\bgo\s+(build|test|run|get|mod)\b|\bgolang\b/i.test(combined)) {
    return 'go';
  }
  if (/\bcargo\.toml\b|\bcargo\s+(build|test|run|clippy|fmt)\b|\brustc\b/i.test(combined)) {
    return 'rust';
  }

  return 'unknown';
}
