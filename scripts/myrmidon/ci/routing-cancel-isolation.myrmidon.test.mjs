import test from 'node:test';
import assert from 'node:assert/strict';
import { computeConcurrencyGroup, computeCancelInProgress, isSupersededHead } from './ci-routing.mjs';

const pr = { eventName: 'pull_request', prNumber: 42, prTitle: 'fix ci' };

test('synchronize, non-release labeled, and rerun retain the same PR group', () => {
  for (const event of [
    { action: 'synchronize' },
    { action: 'labeled', labelName: 'documentation', prLabels: ['documentation'] },
    { action: 'synchronize', runAttempt: 2 },
  ]) {
    assert.equal(computeConcurrencyGroup({ ...pr, ...event }), 'myrmidon-ci-42');
  }
  assert.equal(computeConcurrencyGroup({ ...pr, prNumber: 43 }), 'myrmidon-ci-43');
});

for (const [name, attributes] of [
  ['release label', { prLabels: ['release'] }],
  ['release head', { headRef: 'rel/1.7' }],
  ['release base', { baseRef: 'rel/1.7' }],
]) {
  test(`${name} isolates the same PR from the ordinary group`, () => {
    assert.equal(computeConcurrencyGroup({ ...pr, ...attributes }), 'myrmidon-ci-release-42');
    assert.equal(computeConcurrencyGroup(pr), 'myrmidon-ci-42');
  });
}

test('different PR numbers remain distinct in both streams', () => {
  assert.equal(computeConcurrencyGroup(pr), 'myrmidon-ci-42');
  assert.equal(computeConcurrencyGroup({ ...pr, prNumber: 43 }), 'myrmidon-ci-43');
  assert.equal(computeConcurrencyGroup({ ...pr, prLabels: ['release'] }), 'myrmidon-ci-release-42');
  assert.equal(computeConcurrencyGroup({ ...pr, prNumber: 43, prLabels: ['release'] }), 'myrmidon-ci-release-43');
});

test('push and merge queue refs remain distinct from each other and PRs', () => {
  assert.equal(computeConcurrencyGroup({ eventName: 'push', ref: 'refs/heads/main' }), 'myrmidon-ci-refs/heads/main');
  assert.equal(computeConcurrencyGroup({ eventName: 'push', ref: 'refs/heads/feature' }), 'myrmidon-ci-refs/heads/feature');
  assert.equal(computeConcurrencyGroup({ eventName: 'merge_group', ref: 'refs/heads/gh-readonly-queue/main/pr-42-abc' }), 'myrmidon-ci-refs/heads/gh-readonly-queue/main/pr-42-abc');
  assert.equal(computeConcurrencyGroup(pr), 'myrmidon-ci-42');
});

for (const [name, input, expected] of [
  ['main push', { eventName: 'push', ref: 'refs/heads/main', runAttempt: 1 }, false],
  ['merge group', { eventName: 'merge_group', runAttempt: 1 }, false],
  ['PR first attempt', { eventName: 'pull_request', action: 'synchronize', runAttempt: 1 }, true],
  ['PR second attempt', { eventName: 'pull_request', action: 'synchronize', runAttempt: 2 }, false],
  ['PR third attempt', { eventName: 'pull_request', action: 'synchronize', runAttempt: 3 }, false],
  ['workflow dispatch', { eventName: 'workflow_dispatch', runAttempt: 1 }, false],
]) {
  test(`${name} cancellation policy`, () => {
    assert.equal(computeCancelInProgress(input), expected);
    assert.equal(computeCancelInProgress({ eventName: 'pull_request', runAttempt: expected ? 2 : 1 }), !expected);
  });
}

for (const [name, input, expected] of [
  ['different PR heads', { eventName: 'pull_request', currentHead: 'aaa111', prHead: 'bbb222' }, true],
  ['equal PR heads', { eventName: 'pull_request', currentHead: 'aaa111', prHead: 'aaa111' }, false],
  ['empty current head', { eventName: 'pull_request', currentHead: '', prHead: 'bbb222' }, false],
  ['empty PR head', { eventName: 'pull_request', currentHead: 'aaa111', prHead: '' }, false],
  ['both heads empty', { eventName: 'pull_request', currentHead: '', prHead: '' }, false],
  ['push with different heads', { eventName: 'push', currentHead: 'aaa111', prHead: 'bbb222' }, false],
  ['merge group with different heads', { eventName: 'merge_group', currentHead: 'aaa111', prHead: 'bbb222' }, false],
  ['dispatch with different heads', { eventName: 'workflow_dispatch', currentHead: 'aaa111', prHead: 'bbb222' }, false],
]) {
  test(`${name} supersession`, () => {
    assert.equal(isSupersededHead(input), expected);
    assert.equal(isSupersededHead({ eventName: 'pull_request', currentHead: 'aaa111', prHead: expected ? 'aaa111' : 'bbb222' }), !expected);
  });
}
