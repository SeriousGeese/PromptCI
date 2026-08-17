import { describe, it, expect } from 'vitest';
import * as core from '../src/index.js';

describe('core exports', () => {
  it('exports scan function', () => {
    expect(typeof core.scan).toBe('function');
  });

  it('exports scanFiles function', () => {
    expect(typeof core.scanFiles).toBe('function');
  });

  it('exports detectDuplicates function', () => {
    expect(typeof core.detectDuplicates).toBe('function');
  });

  it('exports computeHealthScore function', () => {
    expect(typeof core.computeHealthScore).toBe('function');
  });
});
