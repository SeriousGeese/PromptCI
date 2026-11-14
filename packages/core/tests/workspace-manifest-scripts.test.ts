import { describe, expect, it } from 'vitest';
import { hasScript, parseWorkspaceManifest } from '../src/workspace-manifests.js';
import { parsePackageJsonFacts } from '../src/repo-context.js';

describe('parsePackageJsonFacts scripts', () => {
  it('keeps a script named __proto__ as an own script', () => {
    const facts = parsePackageJsonFacts('{"scripts":{"__proto__":"echo hi"}}', []);
    expect(hasScript(facts.scripts, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(facts.scripts)).toBe(Object.prototype);
  });
});

describe('parseWorkspaceManifest scripts', () => {
  it('keeps a script named __proto__ as an own script', () => {
    const manifest = parseWorkspaceManifest('.', '{"scripts":{"__proto__":"echo hi","build":"x"}}');
    expect(manifest).toBeDefined();
    expect(hasScript(manifest!.scripts, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(manifest!.scripts)).toBe(Object.prototype);
  });

  it('keeps an empty command and drops a non-string one', () => {
    const manifest = parseWorkspaceManifest('.', '{"scripts":{"noop":"","bad":1}}');
    expect(hasScript(manifest!.scripts, 'noop')).toBe(true);
    expect(hasScript(manifest!.scripts, 'bad')).toBe(false);
  });

  it('does not take an inherited key for a script', () => {
    const manifest = parseWorkspaceManifest('.', '{"scripts":{"build":"x"}}');
    expect(hasScript(manifest!.scripts, 'constructor')).toBe(false);
    expect(hasScript(manifest!.scripts, 'toString')).toBe(false);
  });
});
