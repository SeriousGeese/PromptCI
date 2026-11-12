import * as path from 'node:path';
import { RepoTree } from './repo-tree.js';
import type { InstructionFile, ProjectType } from './types.js';

/**
 * pcic-e6xa: the project-type probe reads fixed root names, so it goes through
 * the tree like every other existence check — nothing outside the scan root is
 * touched (a `Cargo.toml` or `Assets` committed as a link out of the
 * repository used to decide the project type, and so the framework pack that
 * runs), names match with exact case on every platform, and a caller's file
 * inventory answers it when the repository is not on disk (pcic-csf).
 */
function rootFileNames(tree: RepoTree): ReadonlySet<string> {
  const entries = tree.entries(tree.root);
  if (typeof entries === 'string') return new Set();
  const names = new Set<string>();
  for (const entry of entries.values()) if (!entry.isDirectory()) names.add(entry.name);
  return names;
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
export async function detectProjectType(
  repoRoot: string,
  tree: RepoTree = new RepoTree(repoRoot),
): Promise<ProjectType> {
  const root = path.resolve(repoRoot);
  const exists = (...parts: string[]): boolean => tree.exists(path.join(root, ...parts));
  const dirExists = (...parts: string[]): boolean => tree.isDir(path.join(root, ...parts));
  const rootNames = rootFileNames(tree);

  // ── Next.js ──────────────────────────────────────────────────────────────
  // next.config.* exists OR (app/ or pages/ alongside package.json)
  if ([...rootNames].some((name) => name.startsWith('next.config.'))) return 'nextjs';

  const hasPkgJson = exists('package.json');
  if (hasPkgJson) {
    if (dirExists('app') || dirExists('pages')) return 'nextjs';
  }

  // ── Unity ────────────────────────────────────────────────────────────────
  // Assets/ directory AND ProjectSettings/ProjectVersion.txt both exist.
  // Checked before the package.json→typescript branch so a Unity repo with a
  // root package.json is not misclassified as typescript.
  const hasAssets = dirExists('Assets');
  const hasProjectVersion = exists('ProjectSettings', 'ProjectVersion.txt');
  if (hasAssets && hasProjectVersion) return 'unity';

  // ── .NET ─────────────────────────────────────────────────────────────────
  // any .sln or .csproj file at repo root level. Also checked before the
  // typescript branch for the same reason (JS tooling drops a package.json).
  if ([...rootNames].some((name) => name.endsWith('.sln') || name.endsWith('.csproj'))) return 'dotnet';

  // ── TypeScript ───────────────────────────────────────────────────────────
  // package.json or tsconfig.json present
  const hasTsConfig = exists('tsconfig.json');
  if (hasPkgJson || hasTsConfig) return 'typescript';

  // ── Python ───────────────────────────────────────────────────────────────
  const hasPyProject = exists('pyproject.toml');
  const hasRequirements = exists('requirements.txt');
  const hasPipfile = exists('Pipfile');
  const hasConda = exists('environment.yml');
  const hasSetupPy = exists('setup.py');
  if (hasPyProject || hasRequirements || hasPipfile || hasConda || hasSetupPy) return 'python';

  // ── Go ───────────────────────────────────────────────────────────────────
  const hasGoMod = exists('go.mod');
  if (hasGoMod) return 'go';

  // ── Rust ─────────────────────────────────────────────────────────────────
  const hasCargoToml = exists('Cargo.toml');
  if (hasCargoToml) return 'rust';

  return 'unknown';
}

/**
 * Content-based project type detection — used as a fallback when the file-system
 * scan returns 'unknown' (e.g. repos that only contain instruction files, no source).
 * Checks the combined content of all scanned instruction files for strong signals.
 *
 * Detection order: nextjs → unity → dotnet → typescript → python → go → rust → unknown
 *
 * .NET is checked before typescript for the same reason as in the file-system
 * probe above: .NET repos commonly mention JS tooling (pnpm, npm run, jest) in
 * their instructions, so the broader typescript signals must not shadow the
 * more specific .NET ones.
 */
export function detectProjectTypeFromContent(files: InstructionFile[]): ProjectType {
  const combined = files.map((f) => f.content).join('\n');

  if (/\bnext\.?js\b|\bapp\s+router\b|\bpages?\s+router\b|\bnext\s+build\b|\bnext\s+dev\b/i.test(combined)) {
    return 'nextjs';
  }
  if ((/\bunity\b/i.test(combined) && /\b(lts|editor|hub|engine)\b/i.test(combined)) || /\bmonobehaviour\b|\bunityengine\b|\bgameobject\b|\bprefab\b|\bscriptableobject\b/i.test(combined)) {
    return 'unity';
  }
  if (/\bdotnet\b|\.sln\b|\.csproj\b|\bxunit\b|\bnunit\b|\bmstest\b/i.test(combined)) {
    return 'dotnet';
  }
  if (/\btypescript\b|\btsconfig\b|\btsc\s|\bpnpm\b|\bnpm\s+run\b|\bvitest\b|\bjest\b/i.test(combined)) {
    return 'typescript';
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
