import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertRetryPolicy, retryDelayMs, isRetryableFlagged } from '../../packages/corpus/src/retry.ts';

const valid = { attempts: 3, baseDelayMs: 100, maxDelayMs: 350 };

describe('corpus retry policy boundaries', () => {
  for (const attempts of [0, -1, 1.5, NaN, Infinity]) {
    it(`rejects attempts ${attempts}`, () => {
      assert.throws(() => assertRetryPolicy({ ...valid, attempts }), RangeError);
    });
  }
  for (const baseDelayMs of [-1, NaN, Infinity]) {
    it(`rejects base delay ${baseDelayMs}`, () => {
      assert.throws(() => assertRetryPolicy({ ...valid, baseDelayMs }), RangeError);
    });
  }
  for (const maxDelayMs of [99, NaN, Infinity]) {
    it(`rejects max delay ${maxDelayMs}`, () => {
      assert.throws(() => assertRetryPolicy({ ...valid, maxDelayMs }), RangeError);
    });
  }
  it('accepts minimum attempts, zero base, and equal delays without replacing the policy', () => {
    for (const policy of [
      { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
      { attempts: 1, baseDelayMs: 100, maxDelayMs: 100 },
    ]) assert.strictEqual(assertRetryPolicy(policy), policy);
  });
});

describe('deterministic retry jitter', () => {
  const cases = [
    [0, 0, 50], [1, 0.5, 75], [1, 1, 100],
    [2, 0, 100], [2, 0.5, 150], [2, 1, 200],
    [3, 0, 175], [3, 0.5, 263], [3, 1, 350],
    [100, 0, 175], [100, 0.5, 263], [100, 1, 350],
    [-1, 1, 100],
  ];
  for (const [attempt, random, expected] of cases) {
    it(`returns ${expected} ms for attempt ${attempt} and random ${random}`, () => {
      assert.strictEqual(retryDelayMs(valid, attempt, () => random), expected);
    });
  }
  it('rounds fractional delays to the nearest millisecond', () => {
    const policy = { attempts: 1, baseDelayMs: 1.5, maxDelayMs: 1.5 };
    assert.strictEqual(retryDelayMs(policy, 1, () => 0), 1);
    assert.strictEqual(retryDelayMs(policy, 1, () => 0.5), 1);
    assert.strictEqual(retryDelayMs(policy, 1, () => 1), 2);
  });
});

describe('retryable flag', () => {
  it('accepts only the boolean true flag on an object', () => {
    assert.strictEqual(isRetryableFlagged({ retryable: true }), true);
    for (const value of [{ retryable: false }, { retryable: 'true' }, {}, null, undefined, true, 'true', 1]) {
      assert.strictEqual(isRetryableFlagged(value), false);
    }
  });
});
