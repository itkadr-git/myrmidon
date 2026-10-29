import test from 'node:test';
import assert from 'node:assert/strict';
import {
  executeFailureMatrix,
  runScenarioFresh,
  runScenarioStale,
  runScenarioFailClosed,
  runScenarioConcurrentRevision,
  runScenarioRecovery,
} from './failure-matrix.mjs';

test('Scenario 1 (fresh): returns valid signed rules, enables hazardous actions, respects byte limits', async () => {
  const res = await runScenarioFresh();

  assert.equal(res.status, 'pass');
  assert.equal(res.mode, 'fresh');
  assert.equal(res.hazardousAllowed, true);

  // Byte budget assertions
  assert.ok(res.sessionStartUnder12K, `SessionStart bytes (${res.sessionStartBytes}) must be <= 12 KiB`);
  assert.ok(res.userPromptUnder2K, `UserPromptSubmit bytes (${res.userPromptBytes}) must be <= 2 KiB`);

  // Context delivery behavior
  assert.ok(res.contextHasDeployRule, 'Context must contain deploy policy rule body');
  assert.ok(res.userPromptContext.includes('adm/trigger/deploy'));
  assert.ok(!res.userPromptContext.includes('knowledge degraded'), 'Fresh context must not contain degraded warning');

  // Production ContextDelivery boundary
  assert.ok(res.productionDelivery.prodStartUnder12K, 'Production ContextDelivery SessionStart <= 12 KiB');
  assert.ok(res.productionDelivery.prodPromptUnder2K, 'Production ContextDelivery UserPromptSubmit <= 2 KiB');
});

test('Scenario 2 (stale): falls back to cached snapshot on upstream network failure, injects degraded warning, respects TTL', async () => {
  const res = await runScenarioStale();

  assert.equal(res.status, 'pass');
  assert.equal(res.mode, 'stale-read');
  assert.equal(res.hazardousAllowed, true, 'Hazardous operations remain allowed within maxAgeMs window');
  assert.ok(res.ageMs >= 60000, `Cache age must reflect elapsed time, got ${res.ageMs}`);

  // Behavioral assertions
  assert.ok(res.contextIncludesDegradedWarning, 'Context must explicitly inform agent that knowledge is degraded');
  assert.ok(res.userPromptContext.includes('knowledge degraded'));
  assert.ok(res.contextIncludesSshRule, 'Cached rule for SSH must be delivered');
  assert.ok(res.userPromptUnder2K, `Stale UserPromptSubmit bytes (${res.userPromptBytes}) must be <= 2 KiB`);
  assert.ok(res.productionDelivery.under2K, 'Production ContextDelivery stale delivery <= 2 KiB');
});

test('Scenario 3 (fail-closed): refuses corrupted cache and untrusted HMAC, forbids hazardous operations, zero leaked rules', async () => {
  const res = await runScenarioFailClosed();

  assert.equal(res.status, 'pass');
  assert.equal(res.mode, 'fail-closed');
  assert.equal(res.hazardousAllowed, false, 'Hazardous operations MUST be forbidden in fail-closed mode');
  assert.equal(res.itemsCount, 0, 'No unverified/corrupted items may be provided');

  // Behavioral enforcement
  assert.ok(res.contextEnforcesFailClosed, 'Context must instruct agent to fail closed');
  assert.ok(res.userPromptContext.includes('fail closed: fresh knowledge or human approval required'));

  // Zero leaked policy bodies
  assert.ok(res.noLeakedPolicyBodies, 'Unverified policy bodies must never leak into context');
  assert.ok(!res.userPromptContext.includes('Выкат доски — только образ из CI'));
  assert.ok(!res.userPromptContext.includes('Правило OPE-1524'));
});

test('Scenario 4 (concurrent revision): serializes parallel session prompts with deduplication and defers stale write proposals', async () => {
  const res = await runScenarioConcurrentRevision();

  assert.equal(res.status, 'pass');
  assert.ok(res.parallelExecutionHandled, 'Both concurrent prompts must stay <= 2 KiB');
  assert.ok(res.sessionRevisionDeduplicated, 'Second identical rule delivery in same session must be deduplicated to 0 bytes');
  assert.ok(res.productionDeduplicated, 'Production ContextDelivery must deduplicate parallel identical rule deliveries');

  // Deferral on base revision conflict
  assert.equal(res.deferralMode, 'write-deferred');
  assert.equal(res.publishable, false, 'Conflicting revision must not be auto-published');
  assert.equal(res.requiresOwnerReview, true, 'Conflicting revision must require owner review');
});

test('Scenario 5 (recovery & circuit breaker): trips breaker on repeated failures, backs off, and resets to fresh when upstream recovers', async () => {
  const res = await runScenarioRecovery();

  assert.equal(res.status, 'pass');
  assert.equal(res.breakerTripped, true, 'Circuit breaker must trip after >= 3 consecutive failures');
  assert.ok(res.trippedFailuresCount >= 3);

  // Recovery behavior
  assert.equal(res.recoveredMode, 'fresh', 'Cache must recover to fresh mode upon upstream restoration');
  assert.equal(res.recoveredHazardousAllowed, true);
  assert.equal(res.failuresResetToZero, true, 'Failures counter must reset to 0 after successful recovery');
  assert.equal(res.nextAttemptResetToZero, true, 'Next attempt backoff must reset to 0');
});

test('Full executeFailureMatrix report: generates machine-readable matrix artifact', async () => {
  const result = await executeFailureMatrix();
  assert.equal(result.status, 'success');
  assert.ok(result.timestamp);

  const m = result.matrix;
  assert.equal(m.fresh.status, 'pass');
  assert.equal(m.stale.status, 'pass');
  assert.equal(m.fail_closed.status, 'pass');
  assert.equal(m.concurrent_revision.status, 'pass');
  assert.equal(m.recovery.status, 'pass');
});
