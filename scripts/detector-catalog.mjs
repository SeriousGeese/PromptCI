#!/usr/bin/env node
/**
 * Generates Docs/detector-catalog.md: one row per entry of the DETECTORS array.
 *
 *   node scripts/detector-catalog.mjs            # (re)write Docs/detector-catalog.md
 *   node scripts/detector-catalog.mjs --check    # exit 1 when the committed copy is stale
 *
 * Needs `pnpm build` first (reads packages/core/dist, like scripts/check-provenance.mjs).
 *
 * DETECTORS entries carry only an id and a run function, so the catalog has two inputs:
 *   - the ids themselves, read from the built DETECTORS array;
 *   - the NOTES table below: a one-line description and the examples/ fixtures (or, where
 *     none exists, the unit-test file) per detector.
 * It deliberately reads NO severities and NO finding text, so reweighting or rewording a
 * finding never makes the catalog stale. What it does enforce: a detector added to or
 * removed from DETECTORS without a matching NOTES entry fails the script, as does a
 * fixture or test path that no longer exists.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DETECTORS } from '../packages/core/dist/detectors.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outPath = path.join(root, 'Docs', 'detector-catalog.md');

/** id -> { what, fixtures: examples/ directory names, tests: packages/core/tests files (when no fixture exists) } */
const NOTES = {
  duplicates: { categories: ['duplicate'], what: 'Duplicate or near-duplicate instruction sections, within and across files; mirrored files are grouped once.', fixtures: ['mirrored-instructions', 'mirrored-drift', 'conflicts'] },
  'duplicate-headings': { categories: ['duplicate'], what: 'The same heading repeated within one instruction file.', fixtures: ['conflicts'] },
  'within-section-dedup': { categories: ['duplicate'], what: 'A single long section that restates the same point in several paragraphs.', tests: ['within-section-dedup.test.ts'] },
  conflicts: { categories: ['conflict'], what: 'Contradictory directives (do/don\'t pairs, tool files that disagree with AGENTS.md).', fixtures: ['conflicts', 'mirrored-drift'] },
  'version-conflicts': { categories: ['conflict'], what: 'Different instruction files naming different versions of the same framework or runtime.', tests: ['conflicts.test.ts'] },
  'competing-tech-conflicts': { categories: ['conflict'], what: 'Different instruction files recommending mutually exclusive technologies for the same job.', tests: ['conflicts.test.ts'] },
  'context-bloat': { categories: ['context_bloat'], what: 'Instruction files, and the total, that exceed size or token budgets.', tests: ['context-bloat.test.ts'] },
  'stale-instructions': { categories: ['stale_instruction'], what: 'Old years, dated TODOs, deprecated wording and outdated versions.', fixtures: ['suppression'] },
  'command-validity': { categories: ['command_validity'], what: 'Documented package scripts, `make` targets and commands that do not exist.', fixtures: ['command-scope', 'script-name-closers', 'fix-recipes', 'monorepo-scripts'] },
  'missing-context': { categories: ['missing_context'], what: 'No setup, build, test or project-specific guidance where an agent needs it.', fixtures: ['basic', 'no-instructions'] },
  'manifest-consistency': { categories: ['conflict', 'stale_instruction'], what: 'Instructions that disagree with package.json or pyproject.toml.', fixtures: ['monorepo-scripts', 'manifest-fix-recipes'] },
  'dependency-staleness': { categories: ['stale_instruction'], what: 'Packages an install command or import names that no `package.json` declares; end-of-life packages (moment, request, tslint, node-sass, react-scripts, enzyme); version-gated APIs (`ReactDOM.render` on React 18+, `getInitialProps` in an app-router Next.js project, NgModule guidance where standalone components are the default).', fixtures: ['dependency-staleness'] },
  'vague-guidance': { categories: ['vague_guidance'], what: 'Guidance too generic to act on ("write clean code").', fixtures: ['basic', 'suppression'] },
  'dead-references': { categories: ['structure'], what: 'Local files and directories the instructions mention that no longer exist.', fixtures: ['dead-ref-resolution', 'moved-refs', 'stale-paths', 'path-references'] },
  'agent-practices': { categories: ['agent_practices', 'structure'], what: 'Common practices (a verification loop, "ask when unsure") that no instruction file mentions.', fixtures: ['basic'] },
  'canonical-owner': { categories: ['duplicate', 'structure'], what: 'Instruction files that each claim to be the canonical source, or that forward authority to a file that does not claim it.', tests: ['canonical-owner.test.ts'] },
  'cross-tool-parity': { categories: ['conflict'], what: 'Instruction files for different AI tools that drift apart.', fixtures: ['cross-tool-parity', 'cross-tool-parity-clean', 'cross-tool-parity-no-anchor'] },
  'ci-alignment': { categories: ['conflict', 'missing_context', 'stale_instruction'], what: 'Instructions that disagree with the project\'s GitHub Actions workflows.', fixtures: ['grouped-findings', 'dead-ref-resolution'] },
  'security-pack': { categories: ['security', 'context_bloat'], what: 'Security and privacy gaps in instruction guidance.', fixtures: ['basic'] },
  'action-pinning': { categories: ['security'], what: 'GitHub Actions `uses:` references pinned to a tag or branch instead of a commit SHA. Detect-only.', fixtures: ['agent-formats', 'grouped-findings', 'grouped-findings-clean'] },
  'framework-packs': { categories: ['stale_instruction', 'conflict', 'structure'], what: 'Framework-specific checks; see "Framework packs" below.', fixtures: ['unity', 'dependency-staleness'] },
  'prompt-cache-friendliness': { categories: ['context_bloat'], what: 'Volatile content that defeats prompt caching and inflates the cost of every turn.', tests: ['prompt-cache.test.ts'] },
  'ai-config-skills': { categories: ['ai_config'], what: 'Agent Skills (SKILL.md) checked against filesystem reality.', fixtures: ['path-references'], tests: ['skills-detector.test.ts'] },
  'skill-supply-chain': { categories: ['ai_config', 'security'], what: 'SKILL.md files and bundled scripts under `.claude/`, `.agents/skills/` and plugin `skills/` directories, read as text and never executed, for fetch-and-execute installers, credential exfiltration, hidden text and unpinned remote dependencies.', fixtures: ['skill-supply-chain'] },
  'ai-config-subagents': { categories: ['ai_config'], what: 'Subagent definitions checked against filesystem reality.', tests: ['subagents-detector.test.ts'] },
  'ai-config-hooks-settings': { categories: ['ai_config'], what: 'Hooks and settings files checked against filesystem reality.', tests: ['hooks-settings-detector.test.ts'] },
  'ai-config-mcp': { categories: ['ai_config'], what: '`.mcp.json` server entries checked against filesystem reality.', tests: ['mcp-config-detector.test.ts'] },
  'ai-config-cursor-rules': { categories: ['ai_config'], what: 'Cursor `.mdc` rules checked against filesystem reality.', fixtures: ['cross-tool-parity-clean'], tests: ['cursor-rules-detector.test.ts'] },
  'ai-config-copilot-instructions': { categories: ['ai_config'], what: 'GitHub Copilot instruction files checked against filesystem reality.', tests: ['copilot-instructions-detector.test.ts'] },
  'ai-config-windsurf-rules': { categories: ['ai_config'], what: 'Windsurf rules checked against filesystem reality.', tests: ['windsurf-detector.test.ts'] },
  'negative-instructions': { categories: ['agent_practices'], what: 'Files whose directives are mostly prohibitions rather than positive guidance.', tests: ['negative-instructions.test.ts'] },
  'buried-critical': { categories: ['structure'], what: 'High-stakes instructions (never, must not, security) concentrated in the bottom half of a long file.', tests: ['buried-critical.test.ts'] },
  'custom-rules': { categories: ['custom'], what: 'Repository-defined rules from `.promptci/config.json`; see [custom-rules.md](custom-rules.md).', fixtures: ['custom-rules'] },
};

/** Canonical suppression categories: VALID_ISSUE_CATEGORIES in suppression.ts (not exported, so read from source). */
const suppressionSrc = fs.readFileSync(path.join(root, 'packages', 'core', 'src', 'suppression.ts'), 'utf8');
const CATEGORIES = [...(suppressionSrc.match(/VALID_ISSUE_CATEGORIES = \[([^\]]*)\]/)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
if (CATEGORIES.length === 0) {
  console.error('detector-catalog: could not read VALID_ISSUE_CATEGORIES from packages/core/src/suppression.ts');
  process.exit(1);
}

const PACK_LABELS = { nextjs: 'Next.js', python: 'Python', rust: 'Rust', go: 'Go', dotnet: '.NET', unity: 'Unity' };

const problems = [];
const ids = DETECTORS.map((d) => d.id);
for (const id of ids) if (!NOTES[id]) problems.push(`DETECTORS has "${id}" but scripts/detector-catalog.mjs NOTES has no entry for it`);
for (const id of Object.keys(NOTES)) if (!ids.includes(id)) problems.push(`NOTES has "${id}" but DETECTORS does not`);
for (const [id, n] of Object.entries(NOTES)) {
  for (const f of n.fixtures ?? []) if (!fs.existsSync(path.join(root, 'examples', `fixture-${f}`))) problems.push(`${id}: examples/fixture-${f} does not exist`);
  for (const t of n.tests ?? []) if (!fs.existsSync(path.join(root, 'packages', 'core', 'tests', t))) problems.push(`${id}: packages/core/tests/${t} does not exist`);
  if (!n.categories?.length) problems.push(`${id}: needs at least one suppression category`);
  for (const c of n.categories ?? []) if (!CATEGORIES.includes(c)) problems.push(`${id}: "${c}" is not a suppression category (${CATEGORIES.join(', ')})`);
  if (!(n.fixtures?.length || n.tests?.length)) problems.push(`${id}: needs a fixture or a test file`);
}
if (problems.length > 0) {
  for (const p of problems) console.error(`detector-catalog: ${p}`);
  process.exit(1);
}

const esc = (s) => s.replace(/\|/g, '\\|');

const rows = ids.map((id) => {
  const n = NOTES[id];
  const what = esc(n.what);
  const where = [
    ...(n.fixtures ?? []).map((f) => `[\`fixture-${f}\`](../examples/fixture-${f}/)`),
    ...(n.tests ?? []).map((t) => `[\`${t}\`](../packages/core/tests/${t})`),
  ].join('<br>');
  const cats = n.categories.map((c) => `\`${c}\``).join(', ');
  return `| \`${id}\` | ${what} | ${cats} | ${where} |`;
});

// The packs are the modules framework-packs.ts imports, not every file under frameworks/.
const packsSrc = fs.readFileSync(path.join(root, 'packages', 'core', 'src', 'framework-packs.ts'), 'utf8');
const packFiles = [...packsSrc.matchAll(/from '\.\/frameworks\/([a-z0-9-]+)\.js'/g)].map((m) => m[1]).sort();
for (const p of packFiles) if (!fs.existsSync(path.join(root, 'packages', 'core', 'src', 'frameworks', p + '.ts'))) { console.error('detector-catalog: frameworks/' + p + '.ts does not exist'); process.exit(1); }
const packs = packFiles.map((p) => `- ${PACK_LABELS[p] ?? p}: [\`frameworks/${p}.ts\`](../packages/core/src/frameworks/${p}.ts)`);

const out = `<!-- Generated by scripts/detector-catalog.mjs from the built DETECTORS array. Do not edit by hand: run \`pnpm build && node scripts/detector-catalog.mjs\`. -->
# Detector catalog

One row per entry of \`DETECTORS\` in [\`packages/core/src/detectors.ts\`](../packages/core/src/detectors.ts) (${ids.length} detectors). Detectors are heuristic; every finding carries evidence, a recommendation and a confidence value. Severities and finding wording change as detectors are tuned and are deliberately not listed here: run \`promptci scan\` or see the [CLI reference](cli-reference.md) for what a given finding says.

## Suppressing a finding

\`promptci-ignore\` takes a finding **category**, not a detector id. A category is shared by several detectors (for example \`conflict\` covers \`conflicts\`, \`version-conflicts\` and \`cross-tool-parity\`), and one detector can emit more than one. The "Suppress with" column lists the categories each detector emits; every finding also shows its \`category\` in the report. Place the annotation in the instruction file next to the content, with a required reason, or use \`all\`:

\`\`\`markdown
<!-- promptci-ignore: vague_guidance
     reason: why this is intentional -->
\`\`\`

Use \`promptci-ignore-start\` / \`promptci-ignore-end\` for a range. An annotation with no reason, or an unknown category, suppresses nothing and is itself reported. Suppressed findings stay in the SARIF output marked as suppressed and do not affect the health score. Config-level alternatives are \`exclude\` patterns in \`.promptci/config.json\`; the \`custom-rules\` detector is covered in [custom-rules.md](custom-rules.md). Details: [\`suppression.ts\`](../packages/core/src/suppression.ts) and [\`examples/fixture-suppression\`](../examples/fixture-suppression/).

## Detectors

Provenance for each detector's claims lives in [check-provenance.md](check-provenance.md). The last column is where the detector is exercised: fixtures under \`examples/\`, and the unit-test file where no fixture is dedicated to it.

| Detector | What it checks | Suppress with | Fixtures / tests |
| --- | --- | --- | --- |
${rows.join('\n')}

## Framework packs

The \`framework-packs\` detector runs the packs under [\`packages/core/src/frameworks/\`](../packages/core/src/frameworks/), each of which checks a framework's own conventions against what the instruction files say:

${packs.join('\n')}
`;

if (process.argv.includes('--check')) {
  const current = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
  if (current !== out) {
    console.error('Docs/detector-catalog.md is stale. Run: pnpm build && node scripts/detector-catalog.mjs  (then commit the result)');
    process.exit(1);
  }
  console.log(`Docs/detector-catalog.md is fresh (${ids.length} detectors).`);
} else {
  fs.writeFileSync(outPath, out, 'utf8');
  console.log(`Wrote Docs/detector-catalog.md (${ids.length} detectors).`);
}
