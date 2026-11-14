// Probe task OPE-13173: minimal test per acceptance criteria.
import { describe, expect, it } from 'vitest';
import { fn } from './file';

describe('x', () => {
  it('y', () => {
    expect(fn()).toBe('ok');
  });
});
