// scripts/myrmidon/ci/queue-metrics.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculatePercentile,
  analyzeQueueMetrics,
  formatMetricsMarkdown,
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
