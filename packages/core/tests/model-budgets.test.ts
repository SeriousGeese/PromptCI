import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  TARGET_MODELS,
  MODEL_BUDGETS_REVIEW_BY,
  resolveTargetModel,
  modelBudget,
  budgetForTargetModel,
  buildRepoContext,
} from '../src/index.js';

describe('model-budgets: derivation', () => {
  it('derives a tighter budget for a 200K-token model than a 1M one', () => {
    const haiku = modelBudget('claude-haiku-4-5'); // 200K window
    const opus = modelBudget('claude-opus-5'); // 1M window
    expect(haiku.contextBudget).toBeLessThan(opus.contextBudget);
    expect(haiku.fileContextBudget).toBeLessThan(opus.fileContextBudget);
    // 200K * 0.03 * 4 = 24,000 total; 24,000 * 0.35 ≈ 8,000 file.
    expect(haiku.contextBudget).toBe(24_000);
    expect(haiku.fileContextBudget).toBe(8_000);
    // 1M * 0.03 * 4 = 120,000 total; 120,000 * 0.35 = 42,000 file.
    expect(opus.contextBudget).toBe(120_000);
    expect(opus.fileContextBudget).toBe(42_000);
  });

  it('every listed model resolves to a positive budget', () => {
    for (const model of TARGET_MODELS) {
      const b = modelBudget(model);
      expect(b.contextBudget).toBeGreaterThan(0);
      expect(b.fileContextBudget).toBeGreaterThan(0);
      expect(b.fileContextBudget).toBeLessThan(b.contextBudget);
    }
  });
});

describe('model-budgets: name resolution', () => {
  it('resolves exact ids case-insensitively', () => {
    expect(resolveTargetModel('claude-opus-5')).toBe('claude-opus-5');
    expect(resolveTargetModel('CLAUDE-OPUS-5')).toBe('claude-opus-5');
    expect(resolveTargetModel('  gpt-5  ')).toBe('gpt-5');
  });

  it('resolves family aliases to a representative model', () => {
    expect(resolveTargetModel('claude')).toBe('claude-opus-5');
    expect(resolveTargetModel('gemini')).toBe('gemini-2.5-pro');
    expect(resolveTargetModel('copilot')).toBe('gpt-5');
  });

  it('returns undefined for unknown names', () => {
    expect(resolveTargetModel('gpt-9-turbo')).toBeUndefined();
    expect(budgetForTargetModel('nonsense')).toBeUndefined();
  });
});

describe('model-budgets: staleness guard', () => {
  // FEAT-012 requires a guard that fails when the preset table ages out, so it
  // cannot silently rot. When this fails, refresh MODEL_CONTEXT_WINDOWS and push
  // MODEL_BUDGETS_REVIEW_BY forward in the same change.
  it('the model table has not aged past its review-by date', () => {
    const reviewBy = new Date(`${MODEL_BUDGETS_REVIEW_BY}T00:00:00Z`);
    expect(Number.isNaN(reviewBy.getTime())).toBe(false);
    expect(Date.now()).toBeLessThan(reviewBy.getTime());
  });
});

describe('model-budgets: threshold wiring via buildRepoContext', () => {
  let tmpDir: string;

  async function ctxWith(input: { targetModel?: string; contextBudget?: number }) {
    return buildRepoContext({ repoPath: tmpDir, ...input });
  }

  it('a targetModel preset populates the context budgets, and --context-budget overrides it', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'promptci-budget-test-'));
    try {
      await fs.writeFile(path.join(tmpDir, 'AGENTS.md'), '# Rules\nRun tests before pushing.', 'utf-8');

      // No preset → no budget set (detector falls back to its own defaults).
      const plain = await ctxWith({});
      expect(plain.contextBudget).toBeUndefined();
      expect(plain.fileContextBudget).toBeUndefined();

      // Preset → budgets derived from the model window.
      const preset = await ctxWith({ targetModel: 'claude-opus-5' });
      expect(preset.contextBudget).toBe(120_000);
      expect(preset.fileContextBudget).toBe(42_000);

      // Explicit contextBudget wins over the preset for the total; the preset
      // still supplies the per-file budget that was not explicitly overridden.
      const overridden = await ctxWith({ targetModel: 'claude-opus-5', contextBudget: 5_000 });
      expect(overridden.contextBudget).toBe(5_000);
      expect(overridden.fileContextBudget).toBe(42_000);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
