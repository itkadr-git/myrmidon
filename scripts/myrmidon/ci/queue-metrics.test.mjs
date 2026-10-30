// scripts/myrmidon/ci/queue-metrics.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculatePercentile,
  analyzeQueueMetrics,
  compareQueueMetrics,
  formatMetricsMarkdown,
  formatComparisonMarkdown,
} from './queue-metrics.mjs';

test('calculatePercentile calculates correct ranks', () => {
  const vals = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(calculatePercentile(vals, 50), 50);
  assert.equal(calculatePercentile(vals, 90), 90);
  assert.equal(calculatePercentile(vals, 95), 100);
  assert.equal(calculatePercentile([], 50), 0);
  assert.equal(calculatePercentile([42], 50), 42);
});

test('analyzeQueueMetrics computes queue, duration and cancellation statistics', () => {
  const now = new Date('2026-10-30T15:00:00Z');
  const runs = [
    {
      created_at: '2026-10-30T14:00:00Z',
      run_started_at: '2026-10-30T14:10:00Z', // 600s wait
      updated_at: '2026-10-30T14:30:00Z',     // 1200s duration
      conclusion: 'success',
      status: 'completed',
      head_branch: 'main',
      event: 'push',
    },
    {
      created_at: '2026-10-30T13:00:00Z',
      run_started_at: '2026-10-30T13:20:00Z', // 1200s wait
      updated_at: '2026-10-30T13:40:00Z',     // 1200s duration
      conclusion: 'cancelled',
      status: 'completed',
      head_branch: 'feature',
      event: 'pull_request',
    },
    {
      created_at: '2026-10-29T10:00:00Z',
      run_started_at: '2026-10-29T10:05:00Z', // 300s wait
      updated_at: '2026-10-29T10:15:00Z',     // 600s duration
      conclusion: 'success',
      status: 'completed',
      head_branch: 'main',
      event: 'push',
    },
    {
      // Outside 14-day window
      created_at: '2026-10-01T10:00:00Z',
      run_started_at: '2026-10-01T10:05:00Z',
      updated_at: '2026-10-01T10:15:00Z',
      conclusion: 'success',
      status: 'completed',
      head_branch: 'main',
      event: 'push',
    },
  ];

  const metrics = analyzeQueueMetrics(runs, { days: 14, now });
  assert.equal(metrics.totalRuns, 3);
  assert.equal(metrics.cancelledRuns, 1);
  assert.equal(metrics.cancellationRatePercent, 33.33);
  assert.equal(metrics.mainMergesTotal, 2);
  assert.equal(metrics.mainMergesPerDay, 0.1); // 2 / 14 = 0.14 -> 0.1

  // Queue waits: 300s, 600s, 1200s
  assert.equal(metrics.queueWaitSeconds.p50, 600);
  assert.equal(metrics.queueWaitSeconds.p95, 1200);

  // Markdown output
  const md = formatMetricsMarkdown(metrics);
  assert.match(md, /Queue wait p50/);
  assert.match(md, /600s/);
  assert.match(md, /33.33%/);
});

test('compareQueueMetrics verifies p95 reduction acceptance target', () => {
  const baseline = {
    cancellationRatePercent: 28.4,
    queueWaitSeconds: { p50: 3781.0, p95: 4920.0 },
    durationSeconds: { p50: 14.0, p95: 17.8 },
  };

  // Case 1: 35% reduction in p95 (target >= 30%)
  const postPassing = {
    cancellationRatePercent: 12.0,
    queueWaitSeconds: { p50: 2000.0, p95: 3198.0 }, // (4920 - 3198) / 4920 = 35% reduction
    durationSeconds: { p50: 14.0, p95: 17.8 },
  };

  const compPass = compareQueueMetrics(baseline, postPassing, { targetReductionPercent: 30 });
  assert.equal(compPass.meetsTarget, true);
  assert.equal(compPass.waitP95ChangePct, -35);
  assert.equal(compPass.p95ReductionPercent, 35);

  const mdPass = formatComparisonMarkdown(compPass);
  assert.match(mdPass, /PASSED/);
  assert.match(mdPass, /-35.0% reduction/);

  // Case 2: only 20% reduction (target >= 30% not met)
  const postFailing = {
    cancellationRatePercent: 20.0,
    queueWaitSeconds: { p50: 3000.0, p95: 3936.0 }, // 20% reduction
    durationSeconds: { p50: 14.0, p95: 17.8 },
  };

  const compFail = compareQueueMetrics(baseline, postFailing, { targetReductionPercent: 30 });
  assert.equal(compFail.meetsTarget, false);
  assert.equal(compFail.waitP95ChangePct, -20);
  assert.equal(compFail.p95ReductionPercent, 20);

  const mdFail = formatComparisonMarkdown(compFail);
  assert.match(mdFail, /TARGET NOT MET/);
});
