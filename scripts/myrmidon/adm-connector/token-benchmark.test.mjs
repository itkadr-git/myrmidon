import test from 'node:test';
import assert from 'node:assert/strict';
import { runTokenBenchmark, estimateTokens, TOKENIZER_SPEC } from './token-benchmark.mjs';

test('Token Estimator is deterministic, versioned, and handles multilingual text', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(TOKENIZER_SPEC.name, 'cl100k_base_deterministic_v1');
  assert.equal(TOKENIZER_SPEC.version, '1.0.0');

  // Deterministic reference calibration strings
  const count1 = estimateTokens('Проверь состояние сервисов и сетевых коннекторов');
  assert.ok(count1 >= 15 && count1 <= 45);
  const count2 = estimateTokens('deploy release rc.14 with migrations');
  assert.ok(count2 >= 5 && count2 <= 20);
});

test('Offline Token & Byte Benchmark on 50 real ADM messages satisfies Contract A', async () => {
  const result = await runTokenBenchmark();

  assert.equal(result.dataset.totalMessages, 50, 'Must process exactly 50 messages');
  assert.equal(result.dataset.unmatchedMessageCount, 6, 'Must verify 6 unmatched messages');
  assert.equal(result.dataset.matchedMessageCount, 44, 'Must verify 44 matched messages');
  assert.ok(result.dataset.sha256, 'Must include dataset sha256');
  assert.equal(result.tokenizer.name, 'cl100k_base_deterministic_v1');

  // Acceptance criteria
  const c = result.contractACompliance;
  assert.equal(c.newBytesUnderOldBytes, true, 'New scheme total bytes must be <= old scheme');
  assert.equal(c.newTokensUnderOldTokens, true, 'New scheme total tokens must be <= old scheme');
  assert.equal(c.sessionStartUnder12KiB, true, 'SessionStart must be <= 12 KiB');
  assert.equal(c.allUserPromptsUnder2KiB, true, 'UserPromptSubmit must be <= 2 KiB');
  assert.equal(c.zeroInjectionForUnmatched, true, 'Unmatched messages must have 0 bytes injected');
  assert.equal(c.secretScanClean, true, 'Outputs must be scrubbed of secrets');

  // Metrics sanity
  assert.ok(result.totals.byteSavings > 0, 'Must demonstrate byte savings');
  assert.ok(result.totals.tokenSavings > 0, 'Must demonstrate token savings');
  assert.ok(result.sessionStart.newBytes <= 12 * 1024);
  assert.equal(result.messages.length, 50);
});
