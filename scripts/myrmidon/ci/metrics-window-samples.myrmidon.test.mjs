import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeQueueMetrics } from './queue-metrics.mjs';

const now = new Date('2026-11-18T12:00:00.000Z');
const options = { days: 3, now };
const created = '2026-11-18T10:00:00.000Z';
const started = '2026-11-18T10:00:10.000Z';
const updated = '2026-11-18T10:00:30.000Z';
const run = (extra = {}) => ({ created_at: created, run_started_at: started, updated_at: updated, status: 'completed', ...extra });
const metrics = (runs) => analyzeQueueMetrics(runs, options);

test('cutoff is inclusive, one millisecond earlier is excluded, and future runs remain in the window', () => {
  const result = metrics([
    run({ created_at: '2026-11-15T12:00:00.000Z' }),
    run({ created_at: '2026-11-15T11:59:59.999Z', conclusion: 'cancelled' }),
    run({ created_at: '2026-11-19T12:00:00.000Z' }),
  ]);
  assert.equal(result.totalRuns, 2);
  assert.equal(result.cancelledRuns, 0);
});

test('invalid creation timestamps are excluded', () => {
  const result = metrics([run(), run({ created_at: 'not-a-date', conclusion: 'cancelled' })]);
  assert.equal(result.totalRuns, 1);
  assert.equal(result.cancelledRuns, 0);
});

test('snake and camel case inputs produce identical metrics', () => {
  const snake = run({ head_branch: 'main', event: 'push', conclusion: 'success' });
  const camel = { createdAt: created, startedAt: started, updatedAt: updated, status: 'completed', headBranch: 'main', event: 'push', conclusion: 'success' };
  assert.deepEqual(metrics([snake]), metrics([camel]));
  assert.equal(metrics([camel]).mainMergesTotal, 1);
  assert.equal(metrics([camel]).queueWaitSeconds.p50, 10);
  assert.equal(metrics([camel]).durationSeconds.p50, 20);
});

test('queued runs count in total but do not produce timing samples', () => {
  const result = metrics([run(), run({ run_started_at: null, status: 'queued' })]);
  assert.equal(result.totalRuns, 2);
  assert.equal(result.queueWaitSeconds.count, 1);
  assert.equal(result.durationSeconds.count, 1);
});

test('a start before creation does not produce a queue sample', () => {
  const result = metrics([run(), run({ run_started_at: '2026-11-18T09:59:59.000Z' })]);
  assert.equal(result.queueWaitSeconds.count, 1);
  assert.equal(result.durationSeconds.count, 2);
});

test('an update before start does not produce a duration sample', () => {
  const result = metrics([run(), run({ updated_at: '2026-11-18T10:00:09.000Z' })]);
  assert.equal(result.queueWaitSeconds.count, 2);
  assert.equal(result.durationSeconds.count, 1);
});

test('completed status permits duration without a conclusion', () => {
  const result = metrics([run({ conclusion: null }), run({ status: 'in_progress', conclusion: null })]);
  assert.equal(result.queueWaitSeconds.count, 2);
  assert.equal(result.durationSeconds.count, 1);
  assert.equal(result.durationSeconds.p50, 20);
});

test('a conclusion permits duration even without completed status', () => {
  const result = metrics([run({ status: 'in_progress', conclusion: 'failure' }), run({ status: 'in_progress', conclusion: null })]);
  assert.equal(result.durationSeconds.count, 1);
  assert.equal(result.durationSeconds.p50, 20);
});

test('cancelled share uses all window runs as denominator', () => {
  const result = metrics([run({ conclusion: 'cancelled' }), run({ run_started_at: null, status: 'queued' }), run()]);
  assert.equal(result.totalRuns, 3);
  assert.equal(result.cancelledRuns, 1);
  assert.equal(result.cancellationRatePercent, 33.33);
  assert.equal(result.queueWaitSeconds.count, 2);
});

test('throughput includes main push and missing event, not main PR or feature push', () => {
  const result = metrics([
    run({ head_branch: 'main', event: 'push' }), run({ head_branch: 'main' }),
    run({ head_branch: 'main', event: 'pull_request' }), run({ head_branch: 'feature', event: 'push' }),
  ]);
  assert.equal(result.totalRuns, 4);
  assert.equal(result.mainMergesTotal, 2);
  assert.equal(result.mainMergesPerDay, 0.7);
});

test('empty and null runs return zero metrics', () => {
  const empty = { windowDays: 3, totalRuns: 0, cancelledRuns: 0, cancellationRatePercent: 0, mainMergesTotal: 0, mainMergesPerDay: 0, queueWaitSeconds: { count: 0, p50: 0, p90: 0, p95: 0, max: 0 }, durationSeconds: { count: 0, p50: 0, p90: 0, p95: 0, max: 0 } };
  assert.deepEqual(metrics([]), empty);
  assert.deepEqual(metrics(null), empty);
  assert.equal(metrics([run()]).totalRuns, 1);
});

test('analysis does not mutate input objects or their order', () => {
  const runs = [run({ conclusion: 'success', nested: { value: 1 } }), run({ status: 'queued', run_started_at: null })];
  const before = structuredClone(runs);
  assert.equal(metrics(runs).totalRuns, 2);
  assert.deepEqual(runs, before);
});

test('heterogeneous samples have independent counts, nearest-rank percentiles and rounding', () => {
  const runs = [
    run({ run_started_at: '2026-11-18T10:00:01.234Z', updated_at: '2026-11-18T10:00:05.800Z' }),
    run({ run_started_at: '2026-11-18T10:00:03.678Z', updated_at: '2026-11-18T10:00:11.901Z' }),
    run({ run_started_at: '2026-11-18T10:00:02.345Z', updated_at: '2026-11-18T10:00:08.789Z' }),
    run({ run_started_at: null, status: 'queued' }),
    run({ run_started_at: '2026-11-18T10:00:09.876Z', status: 'in_progress', conclusion: null }),
  ];
  const result = metrics(runs);
  assert.equal(result.totalRuns, 5);
  assert.deepEqual(result.queueWaitSeconds, { count: 4, p50: 2.3, p90: 9.9, p95: 9.9, max: 9.9 });
  assert.deepEqual(result.durationSeconds, { count: 3, p50: 6.4, p90: 8.2, p95: 8.2, max: 8.2 });
});
