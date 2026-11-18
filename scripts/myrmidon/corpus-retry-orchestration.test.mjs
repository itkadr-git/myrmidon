import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWithRetries } from '../../packages/corpus/src/retry.ts';

const policy = { attempts: 3, baseDelayMs: 10, maxDelayMs: 100 };

function harness() {
  const events = [];
  return {
    events,
    context: {
      random: () => 0.5,
      sleep: async () => { events.push('sleep'); },
    },
  };
}

for (const [successAttempt, expected] of [
  [1, ['run:1']],
  [2, ['run:1', 'sleep', 'run:2']],
  [3, ['run:1', 'sleep', 'run:2', 'sleep', 'run:3']],
]) {
  test(`returns the same value on attempt ${successAttempt} and stops`, async () => {
    const { events, context } = harness();
    const result = { successAttempt };
    const actual = await runWithRetries(policy, context, async (attempt) => {
      events.push(`run:${attempt}`);
      if (attempt !== successAttempt) throw new Error('retry');
      return result;
    }, () => true);
    assert.strictEqual(actual, result);
    assert.deepStrictEqual(events, expected);
    assert.strictEqual(events.filter((event) => event === 'sleep').length, successAttempt - 1);
  });
}

test('throws the final retryable error without sleeping after exhaustion', async () => {
  const { events, context } = harness();
  const errors = [new Error('first'), new Error('second'), new Error('last')];
  await assert.rejects(runWithRetries(policy, context, async (attempt) => {
    events.push(`run:${attempt}`);
    throw errors[attempt - 1];
  }, () => true), (error) => { assert.strictEqual(error, errors[2]); return true; });
  assert.deepStrictEqual(events, ['run:1', 'sleep', 'run:2', 'sleep', 'run:3']);
  assert.strictEqual(events.filter((event) => event === 'sleep').length, 2);
});

for (const [failureAttempt, expected] of [
  [1, ['run:1']],
  [2, ['run:1', 'sleep', 'run:2']],
]) {
  test(`throws a nonretryable error on attempt ${failureAttempt} without further work`, async () => {
    const { events, context } = harness();
    const retryable = new Error('retryable');
    const fatal = new Error('fatal');
    await assert.rejects(runWithRetries(policy, context, async (attempt) => {
      events.push(`run:${attempt}`);
      throw attempt === failureAttempt ? fatal : retryable;
    }, (error) => error === retryable), (error) => { assert.strictEqual(error, fatal); return true; });
    assert.deepStrictEqual(events, expected);
    assert.strictEqual(events.filter((event) => event === 'sleep').length, failureAttempt - 1);
  });
}

test('rejects an invalid policy before running or sleeping', async () => {
  const { events, context } = harness();
  await assert.rejects(runWithRetries({ ...policy, attempts: 0 }, context, async () => {
    events.push('run');
    return {};
  }, () => true), RangeError);
  assert.deepStrictEqual(events, []);
});
