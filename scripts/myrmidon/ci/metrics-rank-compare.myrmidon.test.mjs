import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatePercentile, compareQueueMetrics, formatComparisonMarkdown, formatMetricsMarkdown } from './queue-metrics.mjs';

const metrics = (p95, p50 = 60, cancellationRatePercent = 10, extra = {}) => ({
  queueWaitSeconds: { p95, p50 }, cancellationRatePercent, ...extra,
});

test('nearest rank sorts numeric unsorted values without mutating them', () => {
  const values = [100, 2, 30, 4, 20];
  assert.equal(calculatePercentile(values, 40), 4);
  assert.equal(calculatePercentile(values, 41), 20);
  assert.deepEqual(values, [100, 2, 30, 4, 20]);
});

test('nearest rank counts duplicate values', () => {
  assert.equal(calculatePercentile([9, 2, 2, 5], 50), 2);
  assert.equal(calculatePercentile([9, 2, 2, 5], 75), 5);
});

test('empty and singleton samples have distinct results', () => {
  assert.equal(calculatePercentile([], 95), 0);
  assert.equal(calculatePercentile([42], 95), 42);
});

test('percentile endpoints and out-of-range inputs clamp to sample bounds', () => {
  const values = [40, 10, 20];
  assert.equal(calculatePercentile(values, 0), 10);
  assert.equal(calculatePercentile(values, -10), 10);
  assert.equal(calculatePercentile(values, 100), 40);
  assert.equal(calculatePercentile(values, 110), 40);
});

test('exact target reduction passes with numeric p95 and p50 deltas', () => {
  const c = compareQueueMetrics(metrics(100, 80), metrics(70, 40));
  assert.equal(c.baselineP95Sec, 100);
  assert.equal(c.postChangeP95Sec, 70);
  assert.equal(c.waitP95DeltaSec, -30);
  assert.equal(c.waitP95ChangePct, -30);
  assert.equal(c.p95ReductionPercent, 30);
  assert.equal(c.targetReductionPercent, 30);
  assert.equal(c.meetsTarget, true);
  assert.equal(c.baselineP50Sec, 80);
  assert.equal(c.postChangeP50Sec, 40);
  assert.equal(c.waitP50DeltaSec, -40);
  assert.equal(c.waitP50ChangePct, -50);
});

test('reduction above target passes', () => {
  const c = compareQueueMetrics(metrics(100), metrics(69));
  assert.equal(c.p95ReductionPercent, 31);
  assert.equal(c.meetsTarget, true);
});

test('reduction below target fails', () => {
  const c = compareQueueMetrics(metrics(100), metrics(71));
  assert.equal(c.p95ReductionPercent, 29);
  assert.equal(c.meetsTarget, false);
});

test('custom target changes the verdict for the same reduction', () => {
  assert.equal(compareQueueMetrics(metrics(100), metrics(70), { targetReductionPercent: 31 }).meetsTarget, false);
  assert.equal(compareQueueMetrics(metrics(100), metrics(70), { targetReductionPercent: 29 }).meetsTarget, true);
});

test('zero baseline does not invent a percentage improvement', () => {
  const c = compareQueueMetrics(metrics(0, 0), metrics(50, 20));
  assert.equal(c.waitP95DeltaSec, 50);
  assert.equal(c.waitP95ChangePct, 0);
  assert.equal(c.waitP50DeltaSec, 20);
  assert.equal(c.waitP50ChangePct, 0);
  assert.equal(c.meetsTarget, false);
});

test('regression reports a signed positive verdict', () => {
  const c = compareQueueMetrics(metrics(100), metrics(120));
  assert.equal(c.waitP95DeltaSec, 20);
  assert.equal(c.waitP95ChangePct, 20);
  assert.equal(c.p95ReductionPercent, -20);
  assert.equal(c.meetsTarget, false);
  assert.ok(formatComparisonMarkdown(c).split('\n').includes('**Acceptance verdict:** PENDING / TARGET NOT MET: +20% (target -30%)'));
});

test('cancellation increase uses a plus sign', () => {
  const c = compareQueueMetrics(metrics(100, 60, 10), metrics(70, 60, 12.5));
  assert.equal(c.cancellationDeltaPct, 2.5);
  assert.ok(formatComparisonMarkdown(c).split('\n').includes('| Cancellation share delta | - | - | +2.5% | - | - |'));
});

test('cancellation decrease keeps a minus sign', () => {
  const c = compareQueueMetrics(metrics(100, 60, 12.5), metrics(70, 60, 10));
  assert.equal(c.cancellationDeltaPct, -2.5);
  assert.ok(formatComparisonMarkdown(c).split('\n').includes('| Cancellation share delta | - | - | -2.5% | - | - |'));
});

test('measured type and both sources appear in report', () => {
  const c = compareQueueMetrics(metrics(120, 60, 10, { source: 'baseline data' }), metrics(60, 30, 8, { type: 'measured_operational', source: 'observed data' }));
  assert.equal(c.postChangeType, 'measured_operational');
  assert.equal(c.baselineSource, 'baseline data');
  assert.equal(c.postChangeSource, 'observed data');
  const lines = formatComparisonMarkdown(c).split('\n');
  assert.ok(lines.includes('| Metric | Baseline | Post-change (Measured) | Change | Target | Status |'));
  assert.ok(lines.includes('- **Baseline:** baseline data'));
  assert.ok(lines.includes('- **Post-change (Measured):** observed data'));
  assert.ok(lines.includes('| **Queue wait p95** | 2.0 min (120s) | 1.0 min (60s) | -50% (-60s) | -30% | **PASS** |'));
});

test('missing type defaults to modeled, distinct from measured', () => {
  const c = compareQueueMetrics(metrics(120), metrics(90, 60, 10, { source: 'projection' }));
  assert.equal(c.postChangeType, 'modeled');
  const lines = formatComparisonMarkdown(c).split('\n');
  assert.ok(lines.includes('| Metric | Baseline | Post-change (Modeled Projection) | Change | Target | Status |'));
  assert.ok(lines.includes('- **Post-change (Modeled Projection):** projection'));
  assert.ok(!lines.includes('| Metric | Baseline | Post-change (Measured) | Change | Target | Status |'));
});

test('metrics report converts queue and duration seconds to minutes', () => {
  const report = formatMetricsMarkdown({ windowDays: 7, queueWaitSeconds: { p50: 30, p95: 120 }, durationSeconds: { p50: 90, p95: 180 }, cancellationRatePercent: 0, cancelledRuns: 0, totalRuns: 3, mainMergesPerDay: 1, mainMergesTotal: 7 }).split('\n');
  assert.ok(report.includes('| Queue wait p50 | 30s (0.5 min) | Median time from creation to runner pickup |'));
  assert.ok(report.includes('| Queue wait p95 | 120s (2.0 min) | 95th percentile queue delay |'));
  assert.ok(report.includes('| Job duration p50 | 90s (1.5 min) | Median execution time |'));
  assert.ok(report.includes('| Job duration p95 | 180s (3.0 min) | 95th percentile execution time |'));
});
