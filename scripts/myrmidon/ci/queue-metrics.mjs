// scripts/myrmidon/ci/queue-metrics.mjs
// Reproducible CI queue and throughput metrics calculator for Myrmidon Actions.

import fs from 'node:fs';

/**
 * Calculates nearest-rank percentile for a sorted or unsorted numerical array.
 */
export function calculatePercentile(values, percentile) {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((percentile / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

/**
 * Analyzes GitHub Actions workflow runs data.
 * @param {Array} runs Array of workflow run objects (from gh api /actions/runs)
 * @param {Object} options Options including window days and cutoff date
 */
export function analyzeQueueMetrics(runs, { days = 14, now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  const windowRuns = (runs || []).filter((r) => {
    const created = new Date(r.created_at);
    return !isNaN(created.getTime()) && created >= cutoff;
  });

  const queueWaitsSec = [];
  const durationsSec = [];
  let cancelledCount = 0;
  let mainCommitsCount = 0;

  for (const r of windowRuns) {
    if (r.conclusion === 'cancelled') {
      cancelledCount++;
    }

    if (r.head_branch === 'main' && r.event === 'push') {
      mainCommitsCount++;
    }

    const created = new Date(r.created_at).getTime();
    const started = r.run_started_at ? new Date(r.run_started_at).getTime() : null;
    const updated = r.updated_at ? new Date(r.updated_at).getTime() : null;

    if (started && created && started >= created) {
      queueWaitsSec.push((started - created) / 1000);
    }

    if (started && updated && updated >= started && r.status === 'completed') {
      durationsSec.push((updated - started) / 1000);
    }
  }

  const totalRuns = windowRuns.length;
  const cancelRatePct = totalRuns > 0 ? (cancelledCount / totalRuns) * 100 : 0;
  const mergesPerDay = days > 0 ? mainCommitsCount / days : 0;

  return {
    windowDays: days,
    totalRuns,
    cancelledRuns: cancelledCount,
    cancellationRatePercent: Number(cancelRatePct.toFixed(2)),
    mainMergesTotal: mainCommitsCount,
    mainMergesPerDay: Number(mergesPerDay.toFixed(1)),
    queueWaitSeconds: {
      count: queueWaitsSec.length,
      p50: Number(calculatePercentile(queueWaitsSec, 50).toFixed(1)),
      p90: Number(calculatePercentile(queueWaitsSec, 90).toFixed(1)),
      p95: Number(calculatePercentile(queueWaitsSec, 95).toFixed(1)),
      max: Number((queueWaitsSec.length > 0 ? Math.max(...queueWaitsSec) : 0).toFixed(1)),
    },
    durationSeconds: {
      count: durationsSec.length,
      p50: Number(calculatePercentile(durationsSec, 50).toFixed(1)),
      p90: Number(calculatePercentile(durationsSec, 90).toFixed(1)),
      p95: Number(calculatePercentile(durationsSec, 95).toFixed(1)),
      max: Number((durationsSec.length > 0 ? Math.max(...durationsSec) : 0).toFixed(1)),
    },
  };
}

/**
 * Formats metrics as markdown table.
 */
export function formatMetricsMarkdown(metrics) {
  const p50Min = (metrics.queueWaitSeconds.p50 / 60).toFixed(1);
  const p95Min = (metrics.queueWaitSeconds.p95 / 60).toFixed(1);
  const durP50Min = (metrics.durationSeconds.p50 / 60).toFixed(1);
  const durP95Min = (metrics.durationSeconds.p95 / 60).toFixed(1);

  return [
    `### GitHub Actions Queue & Throughput Metrics (${metrics.windowDays} days)`,
    `| Metric | Value | Units / Notes |`,
    `| --- | --- | --- |`,
    `| Queue wait p50 | ${metrics.queueWaitSeconds.p50}s (${p50Min} min) | Median time from creation to runner pickup |`,
    `| Queue wait p95 | ${metrics.queueWaitSeconds.p95}s (${p95Min} min) | 95th percentile queue delay |`,
    `| Job duration p50 | ${metrics.durationSeconds.p50}s (${durP50Min} min) | Median execution time |`,
    `| Job duration p95 | ${metrics.durationSeconds.p95}s (${durP95Min} min) | 95th percentile execution time |`,
    `| Cancelled runs share | ${metrics.cancellationRatePercent}% (${metrics.cancelledRuns} / ${metrics.totalRuns}) | Concurrency and duplicate cancellation rate |`,
    `| Main merges frequency | ${metrics.mainMergesPerDay}/day (${metrics.mainMergesTotal} total) | Average daily rate of landing into main |`,
  ].join('\n');
}

export function main(args = process.argv.slice(2)) {
  let file = null;
  let days = 14;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file') file = args[++i];
    else if (args[i] === '--days') days = parseInt(args[++i], 10);
  }

  let runs = [];
  if (file) {
    runs = JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  const metrics = analyzeQueueMetrics(runs, { days });
  console.log(formatMetricsMarkdown(metrics));
}

if (process.argv[1] && process.argv[1].endsWith('queue-metrics.mjs')) {
  main();
}
