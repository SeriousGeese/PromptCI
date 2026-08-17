import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { PROJECT_TYPES } from '@promptci/core';
import type { IssueSeverity, ProjectType } from '@promptci/core';

export type CliConfig = {
  include?: string[];
  exclude?: string[];
  severityThreshold?: IssueSeverity;
  projectType?: ProjectType;
  apiUrl?: string;
  contextBudget?: number;
  fileContextBudget?: number;
};

const CONFIG_FILE = path.join('.promptci', 'config.json');

const VALID_SEVERITIES: IssueSeverity[] = ['info', 'warning', 'high', 'critical'];
// Derived from core so `promptci init` can never write a projectType that
// `loadConfig` then rejects.
const VALID_PROJECT_TYPES: readonly ProjectType[] = PROJECT_TYPES;

function isIssueSeverity(v: unknown): v is IssueSeverity {
  return typeof v === 'string' && (VALID_SEVERITIES as string[]).includes(v);
}

function isProjectType(v: unknown): v is ProjectType {
  return typeof v === 'string' && (VALID_PROJECT_TYPES as readonly string[]).includes(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

export async function loadConfig(scanPath: string): Promise<CliConfig> {
  const configPath = path.join(path.resolve(scanPath), CONFIG_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf-8');
  } catch {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse .promptci/config.json: invalid JSON`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`.promptci/config.json must be a JSON object`);
  }

  const obj = parsed as Record<string, unknown>;
  const config: CliConfig = {};

  if ('include' in obj) {
    if (!isStringArray(obj.include)) throw new Error(`config.include must be an array of strings`);
    config.include = obj.include;
  }
  if ('exclude' in obj) {
    if (!isStringArray(obj.exclude)) throw new Error(`config.exclude must be an array of strings`);
    config.exclude = obj.exclude;
  }
  if ('severityThreshold' in obj) {
    if (!isIssueSeverity(obj.severityThreshold))
      throw new Error(`config.severityThreshold must be one of: ${VALID_SEVERITIES.join(', ')}`);
    config.severityThreshold = obj.severityThreshold;
  }
  if ('projectType' in obj) {
    if (!isProjectType(obj.projectType))
      throw new Error(`config.projectType must be one of: ${VALID_PROJECT_TYPES.join(', ')}`);
    config.projectType = obj.projectType;
  }
  if ('apiUrl' in obj) {
    if (typeof obj.apiUrl !== 'string')
      throw new Error(`config.apiUrl must be a string`);
    config.apiUrl = obj.apiUrl;
  }
  if ('contextBudget' in obj) {
    if (typeof obj.contextBudget !== 'number' || obj.contextBudget <= 0)
      throw new Error(`config.contextBudget must be a positive number`);
    config.contextBudget = obj.contextBudget;
  }
  if ('fileContextBudget' in obj) {
    if (typeof obj.fileContextBudget !== 'number' || obj.fileContextBudget <= 0)
      throw new Error(`config.fileContextBudget must be a positive number`);
    config.fileContextBudget = obj.fileContextBudget;
  }

  return config;
}
