import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runTokenBenchmark,
  estimateTokens,
  countTokens,
  TOKENIZER_SPEC,
  BASELINE,
  generateBaselineSessionStart,
  generateBaselineMemoryRead,
} from './token-benchmark.mjs';

test('deterministic_bpe_v1 tokenizer: pinned specification and exact calibration', () => {
  assert.equal(TOKENIZER_SPEC.name, 'deterministic_bpe_v1');
  assert.equal(TOKENIZER_SPEC.version, '1.0.0');

  // Exact boundary calibrations
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(undefined), 0);
  assert.equal(estimateTokens(' '), 1);
  assert.equal(countTokens('deploy'), 1);
  assert.equal(estimateTokens('check status'), 4);
  assert.equal(estimateTokens('deploy release rc.14 with migrations'), 13);
  assert.equal(estimateTokens('Проверь состояние сервисов'), 7);
  assert.equal(estimateTokens('const status = "ok";'), 12);
});

test('Baseline generator produces exact byte budgets for Contract A', () => {
  const startText = generateBaselineSessionStart();
  assert.equal(Buffer.byteLength(startText, 'utf8'), BASELINE.initialSessionBytes);
  assert.equal(BASELINE.initialSessionBytes, 24200);

  const memoryText = generateBaselineMemoryRead('deploy');
  assert.equal(Buffer.byteLength(memoryText, 'utf8'), BASELINE.memoryReadPerMessageBytes);
  assert.equal(BASELINE.memoryReadPerMessageBytes, 800);
});

test('Offline Token & Byte Benchmark on 50 real ADM messages satisfies Contract A', async () => {
  const result = await runTokenBenchmark();

  assert.equal(result.dataset.totalMessages, 50, 'Must process exactly 50 messages');
  assert.equal(result.dataset.unmatchedMessageCount, 6, 'Must verify 6 unmatched messages');
  assert.equal(result.dataset.matchedMessageCount, 44, 'Must verify 44 matched messages');
  assert.ok(result.dataset.sha256, 'Must include dataset sha256');
  assert.equal(result.tokenizer.name, 'deterministic_bpe_v1');

  // Acceptance criteria (Contract A)
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
