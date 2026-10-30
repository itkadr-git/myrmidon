// scripts/myrmidon/ci/ci-routing.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isReleasePR,
  getExecutionPriority,
  getRunnerPool,
  computeConcurrencyGroup,
  computeCancelInProgress,
  isSupersededHead,
} from './ci-routing.mjs';

test('isReleasePR correctly classifies release PRs', () => {
  // Title contains rc.*
  assert.equal(isReleasePR({ title: '1.6.6 rc.19 release prep' }), true);
  assert.equal(isReleasePR({ title: 'OPE-9999 rc.1 bugfix' }), true);
  assert.equal(isReleasePR({ title: 'fix: RC.20 hotfix' }), true);

  // Title contains release
  assert.equal(isReleasePR({ title: 'release v1.7.0' }), true);
  assert.equal(isReleasePR({ title: 'Release 1.6.6' }), true);

  // Label contains release
  assert.equal(isReleasePR({ labels: ['release', 'backend'] }), true);
  assert.equal(isReleasePR({ labels: [{ name: 'release' }] }), true);

  // Branch starts with rel/
  assert.equal(isReleasePR({ headRef: 'rel/1.6.6' }), true);
  assert.equal(isReleasePR({ baseRef: 'rel/1.6.6' }), true);

  // Ordinary PR
  assert.equal(isReleasePR({ title: 'feat: add knowledge search', labels: ['enhancement'], headRef: 'bot/OPE-1234' }), false);
  assert.equal(isReleasePR({ title: 'fix: search bar styling', headRef: 'main' }), false);
});

test('getExecutionPriority assigns correct priority levels', () => {
  // Main branch push is P0_CRITICAL
  assert.equal(getExecutionPriority({ eventName: 'push', ref: 'refs/heads/main' }), 'P0_CRITICAL');

  // Release tag is P0_CRITICAL
  assert.equal(getExecutionPriority({ eventName: 'push', ref: 'refs/tags/v1.6.6' }), 'P0_CRITICAL');

  // Release PR is P1_HIGH
  assert.equal(getExecutionPriority({ prTitle: '1.6.6 rc.19: patch' }), 'P1_HIGH');
  assert.equal(getExecutionPriority({ headRef: 'rel/1.6.6' }), 'P1_HIGH');
  assert.equal(getExecutionPriority({ prLabels: ['release'] }), 'P1_HIGH');

  // Ordinary PR is P2_NORMAL
  assert.equal(getExecutionPriority({ prTitle: 'feat: add button' }), 'P2_NORMAL');
});

test('getRunnerPool routes to priority pool for P0/P1 when configured', () => {
  // When priority runner is configured, P0 and P1 use priority runner
  assert.equal(
    getRunnerPool({ priority: 'P0_CRITICAL', defaultRunner: 'ubuntu-latest', priorityRunner: 'vps-ci' }),
    'vps-ci'
  );
  assert.equal(
    getRunnerPool({ priority: 'P1_HIGH', defaultRunner: 'ubuntu-latest', priorityRunner: 'vps-ci' }),
    'vps-ci'
  );

  // P2 uses standard runner even if priority runner is defined
  assert.equal(
    getRunnerPool({ priority: 'P2_NORMAL', defaultRunner: 'ubuntu-latest', priorityRunner: 'vps-ci' }),
    'ubuntu-latest'
  );

  // When no priority runner is configured, fallback to default
  assert.equal(
    getRunnerPool({ priority: 'P0_CRITICAL', defaultRunner: 'ubuntu-latest', priorityRunner: null }),
    'ubuntu-latest'
  );
});

test('computeConcurrencyGroup assigns isolated release- prefix to release PRs', () => {
  // Ordinary PR gets normal group
  const standard = computeConcurrencyGroup({
    eventName: 'pull_request',
    prNumber: 2063,
    prTitle: 'ci: fix test',
    prLabels: [],
  });
  assert.equal(standard, 'myrmidon-ci-2063');

  // PR with rc.19 gets release- prefix
  const rcGroup = computeConcurrencyGroup({
    eventName: 'pull_request',
    prNumber: 1830,
    prTitle: '1.6.6 rc.19 release',
  });
  assert.equal(rcGroup, 'myrmidon-ci-release-1830');

  // PR with release label gets release- prefix
  const labelGroup = computeConcurrencyGroup({
    eventName: 'pull_request',
    prNumber: 1830,
    prTitle: 'cherry-pick fix',
    prLabels: ['release'],
  });
  assert.equal(labelGroup, 'myrmidon-ci-release-1830');

  // PR with rel/* branch gets release- prefix
  const branchGroup = computeConcurrencyGroup({
    eventName: 'pull_request',
    prNumber: 1950,
    prTitle: 'cherry-pick fix',
    headRef: 'rel/1.6.6',
  });
  assert.equal(branchGroup, 'myrmidon-ci-release-1950');

  // Push to main uses ref
  const mainPush = computeConcurrencyGroup({
    eventName: 'push',
    ref: 'refs/heads/main',
  });
  assert.equal(mainPush, 'myrmidon-ci-refs/heads/main');

  // Irrelevant label goes to label-noop
  const noopLabel = computeConcurrencyGroup({
    eventName: 'pull_request',
    action: 'labeled',
    labelName: 'documentation',
    prNumber: 2063,
    prTitle: 'update docs',
  });
  assert.equal(noopLabel, 'myrmidon-ci-2063-label-noop');
});

test('computeCancelInProgress protects main and reruns from cancellation', () => {
  // Push to main must NOT be cancelled by another commit
  assert.equal(
    computeCancelInProgress({
      eventName: 'push',
      ref: 'refs/heads/main',
      runAttempt: 1,
    }),
    false,
  );

  // Merge group candidates must NOT be cancelled
  assert.equal(
    computeCancelInProgress({
      eventName: 'merge_group',
      runAttempt: 1,
    }),
    false,
  );

  // Fresh PR push (runAttempt 1) DOES cancel obsolete previous push
  assert.equal(
    computeCancelInProgress({
      eventName: 'pull_request',
      action: 'synchronize',
      runAttempt: 1,
    }),
    true,
  );

  // Manual/scheduled rerun of an old or existing PR run (runAttempt > 1) must NOT cancel in-progress runs
  assert.equal(
    computeCancelInProgress({
      eventName: 'pull_request',
      action: 'synchronize',
      runAttempt: 2,
    }),
    false,
  );
  assert.equal(
    computeCancelInProgress({
      eventName: 'pull_request',
      action: 'synchronize',
      runAttempt: 3,
    }),
    false,
  );

  // Non-triggering labels do not cancel
  assert.equal(
    computeCancelInProgress({
      eventName: 'pull_request',
      action: 'labeled',
      labelName: 'question',
      runAttempt: 1,
    }),
    false,
  );
});

test('isSupersededHead detects when commit is replaced by a newer head on PR', () => {
  const currentHead = 'aaa111';
  const prHead = 'bbb222';

  // Superseded when current head differs from PR head
  assert.equal(
    isSupersededHead({ eventName: 'pull_request', currentHead, prHead }),
    true,
  );

  // Not superseded when current head matches PR head
  assert.equal(
    isSupersededHead({ eventName: 'pull_request', currentHead: 'bbb222', prHead: 'bbb222' }),
    false,
  );

  // Not applicable on push to main or merge_group
  assert.equal(
    isSupersededHead({ eventName: 'push', currentHead, prHead }),
    false,
  );
  assert.equal(
    isSupersededHead({ eventName: 'merge_group', currentHead, prHead }),
    false,
  );
});
