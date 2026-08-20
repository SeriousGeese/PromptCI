/**
 * Custom-rules engine (Decision D10) — a deterministic interpreter for
 * `.promptci/custom-rules.json`. It lets a repo add its own instruction checks
 * without shipping code, and those findings behave exactly like built-in ones:
 * they carry `custom:*` ids, participate in suppression and the baseline/ratchet,
 * and run identically in a local scan and the GitHub Action (both go through
 * `buildRepoContext`).
 *
 * Four rule types:
 *  - `forbiddenPattern`  — flag each file whose text matches a regex.
 *  - `absentPattern`     — flag the repo when a required regex is absent from all targeted files.
 *  - `requiredSection`   — flag the repo when a required heading appears in no targeted file.
 *  - `crossFileConflict` — flag when a regex's captured value differs across files.
 *
 * Everything here is deterministic: no clock, network, or randomness. Malformed
 * config is rejected with a clear, actionable error naming the offending key —
 * never a crash or a silent skip.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import micromatch from 'micromatch';
import type { InstructionFile, IssueSeverity, PromptCiIssue } from './types.js';
import { snippet } from './evidence.js';

export const CUSTOM_RULES_FILE = path.join('.promptci', 'custom-rules.json');

export const CUSTOM_RULE_TYPES = [
  'forbiddenPattern',
  'absentPattern',
  'requiredSection',
  'crossFileConflict',
] as const;
export type CustomRuleType = (typeof CUSTOM_RULE_TYPES)[number];

const VALID_SEVERITIES: IssueSeverity[] = ['info', 'warning', 'high', 'critical'];
const VALID_REGEX_FLAGS = /^[gimsuy]*$/;

/** A validated custom rule. `severity` is resolved (default `warning`). */
export type CustomRule = {
  id: string;
  type: CustomRuleType;
  message: string;
  severity: IssueSeverity;
  files?: string[];
  pattern?: string;
  flags?: string;
  heading?: string;
};

// ── Validation ──────────────────────────────────────────────────────────────

/** All validation failures throw this so callers can present them cleanly. */
export class CustomRulesError extends Error {
  constructor(message: string) {
    super(`Invalid ${CUSTOM_RULES_FILE}: ${message}`);
    this.name = 'CustomRulesError';
  }
}

function requireString(obj: Record<string, unknown>, key: string, where: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CustomRulesError(`${where} is missing a non-empty string "${key}".`);
  }
  return value;
}

function requireStringArray(value: unknown, key: string, where: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new CustomRulesError(`${where}: "${key}" must be an array of strings.`);
  }
  return value as string[];
}

function validateRegex(pattern: string, flags: string | undefined, where: string): void {
  if (flags !== undefined && !VALID_REGEX_FLAGS.test(flags)) {
    throw new CustomRulesError(`${where}: "flags" may only contain regex flags (gimsuy).`);
  }
  try {
    void new RegExp(pattern, flags);
  } catch (err) {
    throw new CustomRulesError(
      `${where}: "pattern" is not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Validate a parsed `.promptci/custom-rules.json` value into typed rules.
 * Accepts either `{ "rules": [...] }` or a bare `[...]` array. Throws a
 * {@link CustomRulesError} naming the offending key on any problem.
 */
export function parseCustomRules(raw: unknown): CustomRule[] {
  let rawRules: unknown;
  if (Array.isArray(raw)) {
    rawRules = raw;
  } else if (raw && typeof raw === 'object' && 'rules' in raw) {
    rawRules = (raw as Record<string, unknown>).rules;
  } else {
    throw new CustomRulesError('top level must be an object with a "rules" array (or a bare array of rules).');
  }

  if (!Array.isArray(rawRules)) {
    throw new CustomRulesError('"rules" must be an array.');
  }

  const rules: CustomRule[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < rawRules.length; i++) {
    const entry = rawRules[i];
    const where = `rule at index ${i}`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new CustomRulesError(`${where} must be an object.`);
    }
    const obj = entry as Record<string, unknown>;

    const id = requireString(obj, 'id', where);
    const ruleWhere = `rule "${id}"`;
    if (seenIds.has(id)) {
      throw new CustomRulesError(`${ruleWhere}: duplicate rule id (ids must be unique).`);
    }
    seenIds.add(id);

    const type = requireString(obj, 'type', ruleWhere);
    if (!(CUSTOM_RULE_TYPES as readonly string[]).includes(type)) {
      throw new CustomRulesError(
        `${ruleWhere}: "type" must be one of ${CUSTOM_RULE_TYPES.join(', ')} (got "${type}").`,
      );
    }
    const message = requireString(obj, 'message', ruleWhere);

    let severity: IssueSeverity = 'warning';
    if ('severity' in obj) {
      if (typeof obj.severity !== 'string' || !(VALID_SEVERITIES as string[]).includes(obj.severity)) {
        throw new CustomRulesError(
          `${ruleWhere}: "severity" must be one of ${VALID_SEVERITIES.join(', ')}.`,
        );
      }
      severity = obj.severity as IssueSeverity;
    }

    const rule: CustomRule = { id, type: type as CustomRuleType, message, severity };

    if ('files' in obj) rule.files = requireStringArray(obj.files, 'files', ruleWhere);
    if ('flags' in obj) {
      if (typeof obj.flags !== 'string') {
        throw new CustomRulesError(`${ruleWhere}: "flags" must be a string.`);
      }
      rule.flags = obj.flags;
    }

    if (type === 'requiredSection') {
      rule.heading = requireString(obj, 'heading', ruleWhere);
    } else {
      // pattern-based types
      rule.pattern = requireString(obj, 'pattern', ruleWhere);
      validateRegex(rule.pattern, rule.flags, ruleWhere);
    }

    rules.push(rule);
  }

  return rules;
}

/**
 * Load and validate `.promptci/custom-rules.json` from a repo root. A missing
 * file yields no rules; invalid JSON or an invalid schema throws a
 * {@link CustomRulesError} with an actionable message.
 */
export async function loadCustomRules(repoRoot: string): Promise<CustomRule[]> {
  const filePath = path.join(repoRoot, CUSTOM_RULES_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return [];
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CustomRulesError('file is not valid JSON.');
  }

  return parseCustomRules(parsed);
}

// ── Interpreter ─────────────────────────────────────────────────────────────

function shortHash(value: string): string {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 12);
}

/** 1-based line number of a character offset within `content`. */
function lineOfOffset(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

/** Files a rule targets: all instruction files, or those matching its globs. */
function targetedFiles(files: InstructionFile[], rule: CustomRule, repoRoot: string): InstructionFile[] {
  if (!rule.files || rule.files.length === 0) return files;
  return files.filter((f) => {
    const rel = path.relative(repoRoot, f.path).replace(/\\/g, '/');
    return micromatch.isMatch(rel, rule.files!, { dot: true });
  });
}

function freshRegex(rule: CustomRule): RegExp {
  // A fresh instance per use so a shared `g` flag never leaks lastIndex.
  return new RegExp(rule.pattern!, rule.flags);
}

function baseIssue(rule: CustomRule): Pick<PromptCiIssue, 'severity' | 'category' | 'confidence' | 'tags'> {
  return { severity: rule.severity, category: 'custom', confidence: 1.0, tags: ['custom-rule'] };
}

function runForbiddenPattern(files: InstructionFile[], rule: CustomRule): PromptCiIssue[] {
  const issues: PromptCiIssue[] = [];
  for (const file of files) {
    const match = freshRegex(rule).exec(file.content);
    if (!match) continue;
    const line = lineOfOffset(file.content, match.index);
    issues.push({
      id: `custom:${rule.id}:${shortHash(file.path)}`,
      ...baseIssue(rule),
      title: rule.message,
      summary: `Custom rule "${rule.id}": a forbidden pattern was found in this file.`,
      filePaths: [file.path],
      locations: [{ filePath: file.path, startLine: line, endLine: line }],
      evidence: [`Matched text: "${snippet(match[0], 120)}" (line ${line})`],
      recommendation: `Remove or revise the flagged content to satisfy custom rule "${rule.id}".`,
    });
  }
  return issues;
}

function runAbsentPattern(files: InstructionFile[], rule: CustomRule): PromptCiIssue[] {
  const present = files.some((f) => freshRegex(rule).test(f.content));
  if (present) return [];
  return [
    {
      id: `custom:${rule.id}`,
      ...baseIssue(rule),
      title: rule.message,
      summary: `Custom rule "${rule.id}": a required pattern is absent from all checked instruction files.`,
      filePaths: files.map((f) => f.path),
      locations: files.map((f) => ({ filePath: f.path })),
      evidence: [`Required pattern was not found in any of ${files.length} checked file(s).`],
      recommendation: `Add content matching custom rule "${rule.id}" to one of the instruction files.`,
    },
  ];
}

function normalizeHeading(h: string): string {
  return h.toLowerCase().replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim();
}

function runRequiredSection(files: InstructionFile[], rule: CustomRule): PromptCiIssue[] {
  const wanted = normalizeHeading(rule.heading!);
  const found = files.some((f) =>
    f.sections.some((s) => s.heading !== undefined && normalizeHeading(s.heading).includes(wanted)),
  );
  if (found) return [];
  return [
    {
      id: `custom:${rule.id}`,
      ...baseIssue(rule),
      title: rule.message,
      summary: `Custom rule "${rule.id}": a required section heading ("${rule.heading}") is missing from all checked files.`,
      filePaths: files.map((f) => f.path),
      locations: files.map((f) => ({ filePath: f.path })),
      evidence: [`No section heading matching "${rule.heading}" was found in ${files.length} checked file(s).`],
      recommendation: `Add a "${rule.heading}" section to one of the instruction files to satisfy custom rule "${rule.id}".`,
    },
  ];
}

function runCrossFileConflict(files: InstructionFile[], rule: CustomRule): PromptCiIssue[] {
  // value → the files (and the line) where it was captured.
  const byValue = new Map<string, { filePath: string; line: number }[]>();
  for (const file of files) {
    const match = freshRegex(rule).exec(file.content);
    if (!match) continue;
    // Prefer the first capture group when present, else the whole match.
    const value = (match[1] ?? match[0]).trim();
    const line = lineOfOffset(file.content, match.index);
    const list = byValue.get(value) ?? [];
    list.push({ filePath: file.path, line });
    byValue.set(value, list);
  }

  if (byValue.size < 2) return [];

  const filePaths = [...new Set([...byValue.values()].flat().map((v) => v.filePath))];
  const locations = [...byValue.values()].flat().map((v) => ({ filePath: v.filePath, startLine: v.line, endLine: v.line }));
  const evidence = [...byValue.entries()].map(
    ([value, where]) => `"${snippet(value, 60)}" in ${where.map((w) => path.basename(w.filePath)).join(', ')}`,
  );

  return [
    {
      id: `custom:${rule.id}`,
      ...baseIssue(rule),
      title: rule.message,
      summary: `Custom rule "${rule.id}": the tracked value differs across files (${byValue.size} distinct values).`,
      filePaths,
      locations,
      evidence,
      recommendation: `Reconcile the conflicting values so custom rule "${rule.id}" sees a single consistent value.`,
    },
  ];
}

/** Run all validated custom rules over the scanned instruction files. */
export function runCustomRules(
  files: InstructionFile[],
  rules: CustomRule[],
  repoRoot: string,
): PromptCiIssue[] {
  const issues: PromptCiIssue[] = [];
  for (const rule of rules) {
    const scoped = targetedFiles(files, rule, repoRoot);
    switch (rule.type) {
      case 'forbiddenPattern':
        issues.push(...runForbiddenPattern(scoped, rule));
        break;
      case 'absentPattern':
        issues.push(...runAbsentPattern(scoped, rule));
        break;
      case 'requiredSection':
        issues.push(...runRequiredSection(scoped, rule));
        break;
      case 'crossFileConflict':
        issues.push(...runCrossFileConflict(scoped, rule));
        break;
    }
  }
  return issues;
}
