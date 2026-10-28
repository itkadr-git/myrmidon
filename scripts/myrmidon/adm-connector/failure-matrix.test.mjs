import test from 'node:test';
import assert from 'node:assert/strict';
import { executeFailureMatrix } from './failure-matrix.mjs';

test('Integration and Failure Matrix: 5 core operational scenarios', async () => {
  const result = await executeFailureMatrix();
  assert.equal(result.status, 'success');
  const m = result.matrix;

  // 1. Fresh
  assert.equal(m.fresh.status, 'pass');
  assert.equal(m.fresh.mode, 'fresh');
  assert.equal(m.fresh.hazardousAllowed, true);
  assert.ok(m.fresh.sessionStartUnder12K, 'SessionStart must be <= 12 KiB');
  assert.ok(m.fresh.userPromptUnder2K, 'UserPromptSubmit must be <= 2 KiB');
  assert.ok(m.fresh.contextHasDeployRule);

  // 2. Stale
  assert.equal(m.stale.status, 'pass');
  assert.equal(m.stale.mode, 'stale-read');
  assert.equal(m.stale.hazardousAllowed, true);
  assert.ok(m.stale.contextIncludesDegradedWarning);
  assert.ok(m.stale.contextIncludesSshRule);
  assert.ok(m.stale.userPromptUnder2K);

  // 3. Fail-Closed
  assert.equal(m.fail_closed.status, 'pass');
  assert.equal(m.fail_closed.mode, 'fail-closed');
  assert.equal(m.fail_closed.hazardousAllowed, false);
  assert.equal(m.fail_closed.itemsCount, 0);
  assert.ok(m.fail_closed.contextEnforcesFailClosed);
  assert.ok(m.fail_closed.noLeakedPolicyBodies);

  // 4. Concurrent Revision
  assert.equal(m.concurrent_revision.status, 'pass');
  assert.ok(m.concurrent_revision.parallelExecutionHandled);
  assert.ok(m.concurrent_revision.sessionRevisionDeduplicated);
  assert.equal(m.concurrent_revision.deferralMode, 'write-deferred');
  assert.equal(m.concurrent_revision.publishable, false);
  assert.equal(m.concurrent_revision.requiresOwnerReview, true);

  // 5. Recovery
  assert.equal(m.recovery.status, 'pass');
  assert.equal(m.recovery.breakerTripped, true);
  assert.ok(m.recovery.trippedFailuresCount >= 3);
  assert.equal(m.recovery.recoveredMode, 'fresh');
  assert.equal(m.recovery.recoveredHazardousAllowed, true);
  assert.equal(m.recovery.failuresResetToZero, true);
  assert.equal(m.recovery.nextAttemptResetToZero, true);
});
