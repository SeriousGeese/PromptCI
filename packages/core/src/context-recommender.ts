import type { ScanReport, InstructionSection, InstructionFile } from './types.js';
import * as path from 'node:path';
import { existsSync } from 'node:fs';

type SectionClassification = 'always-load' | 'on-demand' | 'archive' | 'unknown';

interface ClassifiedSection {
  file: InstructionFile;
  section: InstructionSection;
  classification: SectionClassification;
  suggestedFile?: string;
  reason: string;
}

export function generateContextRecommendations(report: ScanReport): string {
  const { filesScanned, repoPath } = report;
  const rel = (absPath: string) => {
    const r = path.relative(repoPath, absPath);
    return r && !r.startsWith('..') ? r : absPath;
  };

  // If the repository is small and clean, skip recommendations to avoid noise
  const totalTokens = filesScanned.reduce((sum, f) => sum + f.estimatedTokens, 0);
  if (totalTokens < 500 && report.issues.length === 0) {
    return '';
  }

  // 1. Classify all sections
  const classified: ClassifiedSection[] = [];
  for (const file of filesScanned) {
    for (const sec of file.sections) {
      const heading = (sec.heading || '').toLowerCase();
      const text = sec.normalizedText;

      let classification: SectionClassification = 'unknown';
      let suggestedFile = '';
      let reason = '';

      // Check Archive/Remove markers first
      if (
        heading.includes('changelog') ||
        heading.includes('history') ||
        heading.includes('roadmap') ||
        heading.includes('screenshot') ||
        heading.includes('mockup') ||
        heading.includes('past plan') ||
        heading.includes('yesterday') ||
        heading.includes('todo') ||
        heading.includes('status') ||
        heading.includes('task') ||
        heading.includes('notes') ||
        text.includes('todo') && (heading.includes('todo') || heading.includes('done'))
      ) {
        classification = 'archive';
        reason = 'Contains historical, stale, or roadmap content that is not relevant to ongoing AI tasks.';
      }
      // Check On-demand markers
      else if (
        heading.includes('deploy') ||
        heading.includes('vercel') ||
        heading.includes('ci/cd') ||
        heading.includes('release')
      ) {
        classification = 'on-demand';
        suggestedFile = 'docs/ai/deployment.md';
        reason = 'Contains deployment steps, environments, or release workflows which are only needed during releases.';
      } else if (
        heading.includes('nextjs') ||
        heading.includes('next.js') ||
        heading.includes('react') ||
        heading.includes('remix') ||
        heading.includes('frontend') ||
        heading.includes('dashboard')
      ) {
        classification = 'on-demand';
        suggestedFile = 'docs/ai/nextjs.md';
        reason = 'Contains framework-specific UI/Next.js conventions that are only needed when editing web dashboard code.';
      } else if (
        heading.includes('supabase') ||
        heading.includes('database') ||
        heading.includes('prisma') ||
        heading.includes('migration') ||
        heading.includes('sql') ||
        heading.includes('schema')
      ) {
        classification = 'on-demand';
        suggestedFile = 'docs/ai/supabase.md';
        reason = 'Contains database setup or migration steps which are only needed when schema or API boundary changes occur.';
      } else if (
        heading.includes('architecture') ||
        heading.includes('design') ||
        heading.includes('structure') ||
        heading.includes('components')
      ) {
        classification = 'on-demand';
        suggestedFile = 'docs/ai/architecture.md';
        reason = 'Contains repository structure or module descriptions that are only needed when creating new components.';
      } else if (
        heading.includes('troubleshoot') ||
        heading.includes('debug') ||
        heading.includes('error') ||
        heading.includes('issue')
      ) {
        classification = 'on-demand';
        suggestedFile = 'docs/ai/troubleshooting.md';
        reason = 'Contains error codes or troubleshooting procedures only needed when debugging failures.';
      } else if (sec.text.includes('```') && sec.text.length > 1500) {
        classification = 'on-demand';
        suggestedFile = 'docs/ai/examples.md';
        reason = 'Contains long code snippets or examples that bloat always-loaded context.';
      }
      // Check Always-load markers
      else if (
        heading.includes('identity') ||
        heading.includes('about') ||
        heading.includes('purpose') ||
        heading.includes('boundary') ||
        heading.includes('non-goal') ||
        heading.includes('verification') ||
        heading.includes('build') ||
        heading.includes('test') ||
        heading.includes('lint') ||
        heading.includes('typecheck') ||
        heading.includes('safety') ||
        heading.includes('security') ||
        heading.includes('secret') ||
        heading.includes('credential') ||
        heading.includes('auth') ||
        heading.includes('read-before-edit') ||
        heading.includes('scope-control') ||
        heading.includes('honesty') ||
        heading.includes('plan-first')
      ) {
        classification = 'always-load';
        reason = 'Contains core setup, boundary constraints, verification commands, or critical developer practices.';
      }

      if (classification !== 'unknown') {
        classified.push({
          file,
          section: sec,
          classification,
          suggestedFile,
          reason,
        });
      }
    }
  }

  const lines: string[] = [];

  // ── Cost 2: Context Split & Retrieval Map ────────────────────────────────────
  lines.push('## Context Architecture & Retrieval Map');
  lines.push('');
  lines.push('> [!NOTE]');
  lines.push('> Split large instruction files to keep canonical instructions under the token budget. Move detailed instructions to on-demand documents and link them.');
  lines.push('');

  const onDemand = classified.filter((c) => c.classification === 'on-demand');
  const archive = classified.filter((c) => c.classification === 'archive');

  if (onDemand.length > 0 || archive.length > 0) {
    lines.push('### Suggested Context Splits');
    lines.push('');
    lines.push('| Section / File | Current Size | Classification | Recommendation |');
    lines.push('|---|---|---|---|');

    for (const c of [...onDemand, ...archive]) {
      const loc = `\`${rel(c.file.path)}\` (Heading: *${c.section.heading || 'None'}*)`;
      const size = `~${Math.round(c.section.text.length / 4)} tokens`;
      const target = c.classification === 'archive' ? 'Archive/Remove' : `On-Demand (\`${c.suggestedFile}\`)`;
      lines.push(`| ${loc} | ${size} | **${target}** | ${c.reason} |`);
    }
    lines.push('');
  }

  lines.push('### Suggested Canonical AGENTS.md Layout');
  lines.push('To minimize token consumption, structure your canonical rules as follows:');
  lines.push('```markdown');
  lines.push('# PromptCI - Agent Instructions');
  lines.push('');
  lines.push('## Identity & Boundaries');
  lines.push('- Describe core project limits, tech stack, and non-goals here.');
  lines.push('');
  lines.push('## Verification Loop');
  lines.push('- List exact commands: e.g. `pnpm lint`, `pnpm typecheck`, `pnpm test`.');
  lines.push('');
  lines.push('## References (On-Demand)');
  lines.push('- For deployment details, read [deployment.md](file:///docs/ai/deployment.md).');
  lines.push('- For DB schema, read [supabase.md](file:///docs/ai/supabase.md).');
  lines.push('```');
  lines.push('');

  // ── Cost 5: Skills Readiness & Skill Extraction Recommendations ──────────────
  const proceduralSections = classified.filter((c) => {
    // Check if section is long and contains numbered lists or action bullet points
    const text = c.section.text;
    const linesOfText = text.split('\n');
    const hasNumberedList = linesOfText.some((l) => /^\s*\d+\.\s+[A-Z]/i.test(l));
    const hasImperativeVerbs = linesOfText.some((l) => /^\s*[-*]\s+(Run|Do|Verify|Build|Compile|Deploy|Release|Upgrade|Test|Check|Commit|Push)\b/i.test(l));
    return text.length > 1000 && (hasNumberedList || hasImperativeVerbs);
  });

  if (proceduralSections.length > 0) {
    lines.push('## Skills Readiness & Extraction Recommendations');
    lines.push('');
    lines.push('The following sections describe multi-step procedural workflows. These are excellent candidates to move out of instruction files into reusable local playbooks or skills to save persistent context tokens:');
    lines.push('');

    for (const c of proceduralSections) {
      const heading = c.section.heading || 'Workflow';
      let skillName = `custom-playbook-${c.section.id}`;
      let trigger = `When executing specialized tasks related to ${heading}`;

      const lowerHeading = heading.toLowerCase();
      if (lowerHeading.includes('deploy') || lowerHeading.includes('release')) {
        skillName = 'deployment-runbook';
        trigger = 'Before running a deployment, release, or publishing builds';
      } else if (lowerHeading.includes('supabase') || lowerHeading.includes('migration') || lowerHeading.includes('database')) {
        skillName = 'supabase-migration-workflow';
        trigger = 'When writing or executing database migrations, DDL, or database client code';
      } else if (lowerHeading.includes('test') || lowerHeading.includes('ci')) {
        skillName = 'test-and-ci-checklist';
        trigger = 'When verifying build health or running the automated test matrix';
      }

      lines.push(`### Skill Candidate: \`${skillName}\``);
      lines.push(`- **Trigger Condition:** ${trigger}`);
      lines.push(`- **Source Section:** \`${rel(c.file.path)}\` (Section: *${heading}*)`);
      lines.push(`- **Savings Potential:** ~${Math.round(c.section.text.length / 4)} tokens per session`);
      lines.push(`- **Action:** Extract the procedural checklist into a file like \`docs/skills/${skillName}.md\` and add a single trigger rule in AGENTS.md.`);
      lines.push('');
    }
  }

  // ── Cost 10: Context ROI Ranking (Cleanup Opportunities) ─────────────────────
  interface RoiItem {
    name: string;
    tokens: number;
    savingsPotential: number;
    reason: string;
    action: string;
  }

  const roiList: RoiItem[] = [];
  for (const c of classified) {
    const tokens = Math.round(c.section.text.length / 4);
    if (tokens < 100) continue; // skip small ones

    let multiplier = 1.0;
    let action = 'Archive or remove';

    if (c.classification === 'archive') {
      multiplier = 2.0;
      action = 'Remove completely or move to archive/';
    } else if (c.classification === 'on-demand') {
      multiplier = 1.5;
      action = `Extract to on-demand doc (\`${c.suggestedFile}\`)`;
    } else if (c.classification === 'always-load') {
      multiplier = 0.5;
      action = 'Trim details or move examples out';
    }

    // Reduce multiplier if it contains highly critical rules (value signals)
    const textLower = c.section.text.toLowerCase();
    const hasCriticalGuidance =
      textLower.includes('verification') ||
      textLower.includes('honesty') ||
      textLower.includes('read-before-edit') ||
      textLower.includes('scope-control') ||
      textLower.includes('security') ||
      textLower.includes('safety') ||
      textLower.includes('plan-first');

    if (hasCriticalGuidance) {
      if (c.classification === 'always-load') {
        // Skip highly critical always-loaded rules from cleanup list entirely
        continue;
      } else {
        multiplier *= 0.5; // Lower cleanup priority for other sections containing critical text
      }
    }

    // Increase multiplier for cost signals (volatile content, long code blocks, duplicates)
    // Volatile content check (timestamps, dates, active task/branch notes)
    const hasVolatile =
      /\b(?:last\s+updated|generated\s+at|timestamp|current\s+branch|active\s+task|health\s+score)\b/i.test(c.section.text) ||
      /\b(?:202\d-\d{2}-\d{2}|[0-2]?\d:[0-5]\d:[0-5]\d)\b/.test(c.section.text);
    if (hasVolatile) {
      multiplier += 0.5;
    }

    // Long code blocks / examples check:
    if (c.section.text.includes('```') && c.section.text.length > 2000) {
      multiplier += 0.5;
    }

    // Duplicated section check:
    const isDuplicate = report.issues.some(
      (i) => i.category === 'duplicate' && i.filePaths.includes(c.file.path)
    );
    if (isDuplicate) {
      multiplier += 0.5;
    }

    roiList.push({
      name: `\`${rel(c.file.path)}\` (Section: *${c.section.heading || 'None'}*)`,
      tokens,
      savingsPotential: tokens * multiplier,
      reason: c.reason,
      action,
    });
  }

  const sortedRoi = roiList.sort((a, b) => b.savingsPotential - a.savingsPotential).slice(0, 3);

  if (sortedRoi.length > 0) {
    lines.push('## Context ROI Ranking (Cleanup Opportunities)');
    lines.push('');
    lines.push('Prioritized list of instruction sections to clean up, refactor, or extract to maximize token savings:');
    lines.push('');
    lines.push('| Rank | Section / File | Token Size | Savings Potential | Suggested Action | Why? |');
    lines.push('|---|---|---|---|---|---|');

    sortedRoi.forEach((item, idx) => {
      const rank = idx + 1;
      lines.push(`| ${rank} | ${item.name} | ~${item.tokens} | High | ${item.action} | ${item.reason} |`);
    });
    lines.push('');
  }

  // ── Cost 11: Task-Specific Context Pack Suggestions ──────────────────────────
  // Check repo signals
  const hasSupabase = report.repoPath && (
    existsSync(path.join(report.repoPath, 'supabase')) ||
    filesScanned.some((f) => f.path.endsWith('package.json') && f.content.includes('@supabase/supabase-js'))
  );
  const hasCli = filesScanned.some((f) => f.path.includes('packages/cli') || f.path.includes('apps/cli'));
  const hasWeb = filesScanned.some((f) => f.path.includes('packages/web') || f.path.includes('apps/web'));
  const hasNextJs = filesScanned.some((f) => /next/i.test(f.content));

  interface ContextPack {
    name: string;
    source: string;
    whenToLoad: string;
    savings: string;
  }

  const packs: ContextPack[] = [];

  if (hasSupabase) {
    packs.push({
      name: '`supabase-auth-and-upload`',
      source: 'Supabase schema and client config rules',
      whenToLoad: 'When altering database schemas, migrations, security triggers, or upload APIs.',
      savings: 'Avoids loading database structures for standard frontend/backend edits.',
    });
  }
  if (hasCli) {
    packs.push({
      name: '`cli-command-workflow`',
      source: 'CLI entrypoints and argument parsers instructions',
      whenToLoad: 'When changing CLI flags, command syntax, or command handlers.',
      savings: 'Keeps command parsing logic out of web dashboard and core development runs.',
    });
  }
  if (hasWeb || hasNextJs) {
    packs.push({
      name: '`web-dashboard-development`',
      source: 'Next.js components, page routes, and middleware rules',
      whenToLoad: 'When building UI dashboard layouts, state management, or styling components.',
      savings: 'Keeps CSS and layout instructions out of core engines and CLI builds.',
    });
  }
  if (classified.some((c) => c.classification === 'on-demand' && c.suggestedFile === 'docs/ai/deployment.md')) {
    packs.push({
      name: '`deployment-and-ci`',
      source: 'Vercel, CI/CD, and release commands checklists',
      whenToLoad: 'When debugging GitHub Actions workflows or preparing production releases.',
      savings: 'Keeps long validation check scripts out of the standard iteration loop.',
    });
  }

  if (packs.length > 0) {
    lines.push('## Suggested Context Packs');
    lines.push('');
    lines.push('Consider defining task-specific context bundles so agents only load rules relevant to their active focus area:');
    lines.push('');
    lines.push('| Pack Name | Source Sections | When to Load | Token Benefit |');
    lines.push('|---|---|---|---|');

    for (const p of packs) {
      lines.push(`| ${p.name} | ${p.source} | ${p.whenToLoad} | ${p.savings} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
