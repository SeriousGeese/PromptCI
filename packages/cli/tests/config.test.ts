import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PROJECT_TYPES } from '@promptci/core';
import { loadConfig } from '../src/config.js';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'promptci-test-'));
}

describe('loadConfig', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    await fs.mkdir(path.join(tmpDir, '.promptci'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns empty config when no file exists', async () => {
    const config = await loadConfig(tmpDir);
    expect(config).toEqual({});
  });

  it('parses a valid config file', async () => {
    const data = {
      include: ['CLAUDE.md'],
      exclude: ['node_modules/**'],
      severityThreshold: 'high',
      projectType: 'typescript',
    };
    await fs.writeFile(
      path.join(tmpDir, '.promptci', 'config.json'),
      JSON.stringify(data),
      'utf-8',
    );
    const config = await loadConfig(tmpDir);
    expect(config.include).toEqual(['CLAUDE.md']);
    expect(config.exclude).toEqual(['node_modules/**']);
    expect(config.severityThreshold).toBe('high');
    expect(config.projectType).toBe('typescript');
  });

  it('returns partial config with only known fields', async () => {
    await fs.writeFile(
      path.join(tmpDir, '.promptci', 'config.json'),
      JSON.stringify({ severityThreshold: 'warning' }),
      'utf-8',
    );
    const config = await loadConfig(tmpDir);
    expect(config.severityThreshold).toBe('warning');
    expect(config.include).toBeUndefined();
  });

  it('throws on invalid JSON', async () => {
    await fs.writeFile(
      path.join(tmpDir, '.promptci', 'config.json'),
      '{ bad json }',
      'utf-8',
    );
    await expect(loadConfig(tmpDir)).rejects.toThrow('invalid JSON');
  });

  it('throws on invalid severityThreshold', async () => {
    await fs.writeFile(
      path.join(tmpDir, '.promptci', 'config.json'),
      JSON.stringify({ severityThreshold: 'extreme' }),
      'utf-8',
    );
    await expect(loadConfig(tmpDir)).rejects.toThrow('severityThreshold');
  });

  it('throws on invalid projectType', async () => {
    await fs.writeFile(
      path.join(tmpDir, '.promptci', 'config.json'),
      JSON.stringify({ projectType: 'rails' }),
      'utf-8',
    );
    await expect(loadConfig(tmpDir)).rejects.toThrow('projectType');
  });

  // BUG-15: config.ts kept a stale copy of the project-type list, so `promptci
  // init` could write python/go/rust and every later `promptci scan` would then
  // hard-error on the config init had just produced.
  it.each(PROJECT_TYPES)('accepts every core projectType (%s)', async (projectType) => {
    await fs.writeFile(
      path.join(tmpDir, '.promptci', 'config.json'),
      JSON.stringify({ projectType }),
      'utf-8',
    );
    const config = await loadConfig(tmpDir);
    expect(config.projectType).toBe(projectType);
  });

  it('throws when include is not a string array', async () => {
    await fs.writeFile(
      path.join(tmpDir, '.promptci', 'config.json'),
      JSON.stringify({ include: 'CLAUDE.md' }),
      'utf-8',
    );
    await expect(loadConfig(tmpDir)).rejects.toThrow('include');
  });

  // FEAT-004: vagueGuidanceSeverity override
  it.each(['info', 'warning'] as const)('accepts vagueGuidanceSeverity = %s', async (value) => {
    await fs.writeFile(
      path.join(tmpDir, '.promptci', 'config.json'),
      JSON.stringify({ vagueGuidanceSeverity: value }),
      'utf-8',
    );
    const config = await loadConfig(tmpDir);
    expect(config.vagueGuidanceSeverity).toBe(value);
  });

  it('throws on an invalid vagueGuidanceSeverity (e.g. "high")', async () => {
    await fs.writeFile(
      path.join(tmpDir, '.promptci', 'config.json'),
      JSON.stringify({ vagueGuidanceSeverity: 'high' }),
      'utf-8',
    );
    await expect(loadConfig(tmpDir)).rejects.toThrow('vagueGuidanceSeverity');
  });

  // FEAT-012: targetModel preset
  it.each(['claude-opus-5', 'gpt-5', 'gemini-2.5-pro', 'claude'])(
    'accepts a valid targetModel (%s)',
    async (targetModel) => {
      await fs.writeFile(
        path.join(tmpDir, '.promptci', 'config.json'),
        JSON.stringify({ targetModel }),
        'utf-8',
      );
      const config = await loadConfig(tmpDir);
      expect(config.targetModel).toBe(targetModel);
    },
  );

  it('throws on an unknown targetModel, naming the offending key', async () => {
    await fs.writeFile(
      path.join(tmpDir, '.promptci', 'config.json'),
      JSON.stringify({ targetModel: 'gpt-9-ultra' }),
      'utf-8',
    );
    await expect(loadConfig(tmpDir)).rejects.toThrow('targetModel');
  });
});
