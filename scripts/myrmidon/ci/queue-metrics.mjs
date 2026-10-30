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
    const rawCreated = r.created_at || r.createdAt;
    const created = new Date(rawCreated);
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

    const branch = r.head_branch || r.headBranch;
    const evt = r.event;
    if (branch === 'main' && (evt === 'push' || !evt)) {
      mainCommitsCount++;
    }

    const rawCreated = r.created_at || r.createdAt;
    const rawStarted = r.run_started_at || r.startedAt;
    const rawUpdated = r.updated_at || r.updatedAt;

    const created = rawCreated ? new Date(rawCreated).getTime() : null;
    const started = rawStarted ? new Date(rawStarted).getTime() : null;
    const updated = rawUpdated ? new Date(rawUpdated).getTime() : null;

    if (started && created && started >= created) {
      queueWaitsSec.push((started - created) / 1000);
    }

    if (started && updated && updated >= started && (r.status === 'completed' || r.conclusion)) {
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
 * Compares baseline metrics with post-change or modeled metrics to verify
 * acceptance criteria (e.g. p95 reduction of at least 30%).
 */
export function compareQueueMetrics(baseline, postChange, { targetReductionPercent = 30 } = {}) {
  const baseP95 = baseline?.queueWaitSeconds?.p95 || 0;
  const postP95 = postChange?.queueWaitSeconds?.p95 || 0;
  const baseP50 = baseline?.queueWaitSeconds?.p50 || 0;
  const postP50 = postChange?.queueWaitSeconds?.p50 || 0;

  const waitP95DeltaSec = Number((postP95 - baseP95).toFixed(1));
  const waitP95ChangePct = baseP95 > 0
    ? Number((((postP95 - baseP95) / baseP95) * 100).toFixed(1))
    : 0;

  const waitP50DeltaSec = Number((postP50 - baseP50).toFixed(1));
  const waitP50ChangePct = baseP50 > 0
    ? Number((((postP50 - baseP50) / baseP50) * 100).toFixed(1))
    : 0;

  // Target reduction is a negative percentage change: e.g. -30% or less
  const p95ReductionPercent = -waitP95ChangePct;
  const meetsTarget = p95ReductionPercent >= targetReductionPercent;

  return {
    baselineP95Sec: baseP95,
    postChangeP95Sec: postP95,
    waitP95DeltaSec,
    waitP95ChangePct,
    p95ReductionPercent,
    targetReductionPercent,
    meetsTarget,
    baselineP50Sec: baseP50,
    postChangeP50Sec: postP50,
    waitP50DeltaSec,
    waitP50ChangePct,
    cancellationDeltaPct: Number((postChange.cancellationRatePercent - baseline.cancellationRatePercent).toFixed(2)),
  };
}

/**
 * Formats metrics comparison as markdown table.
 */
export function formatComparisonMarkdown(comparison) {
  const status = comparison.meetsTarget
    ? `PASSED: -${comparison.p95ReductionPercent.toFixed(1)}% reduction (target >= ${comparison.targetReductionPercent}%)`
    : `PENDING / TARGET NOT MET: ${comparison.waitP95ChangePct > 0 ? '+' : ''}${comparison.waitP95ChangePct}% (target -${comparison.targetReductionPercent}%)`;

  return [
    `### CI Queue Wait Comparison & Acceptance Verification`,
    `| Metric | Baseline | Post-change / Modeled | Change | Target | Status |`,
    `| --- | --- | --- | --- | --- | --- |`,
    `| **Queue wait p95** | ${(comparison.baselineP95Sec / 60).toFixed(1)} min (${comparison.baselineP95Sec}s) | ${(comparison.postChangeP95Sec / 60).toFixed(1)} min (${comparison.postChangeP95Sec}s) | ${comparison.waitP95ChangePct}% (${comparison.waitP95DeltaSec}s) | -${comparison.targetReductionPercent}% | **${comparison.meetsTarget ? 'PASS' : 'PENDING'}** |`,
    `| Queue wait p50 | ${(comparison.baselineP50Sec / 60).toFixed(1)} min (${comparison.baselineP50Sec}s) | ${(comparison.postChangeP50Sec / 60).toFixed(1)} min (${comparison.postChangeP50Sec}s) | ${comparison.waitP50ChangePct}% (${comparison.waitP50DeltaSec}s) | - | - |`,
    `| Cancellation share delta | - | - | ${comparison.cancellationDeltaPct > 0 ? '+' : ''}${comparison.cancellationDeltaPct}% | - | - |`,
    ``,
    `**Acceptance verdict:** ${status}`,
  ].join('\n');
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
  let baseFile = null;
  let postFile = null;
  let benchmarkFile = null;
  let days = 14;
  let targetReduction = 30;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file') file = args[++i];
    else if (args[i] === '--baseline') baseFile = args[++i];
    else if (args[i] === '--post') postFile = args[++i];
    else if (args[i] === '--benchmark') {
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        benchmarkFile = args[++i];
      } else {
        benchmarkFile = 'scripts/myrmidon/ci/fixtures/queue-metrics-benchmark.json';
      }
    }
    else if (args[i] === '--days') days = parseInt(args[++i], 10);
    else if (args[i] === '--target-reduction') targetReduction = parseFloat(args[++i]);
  }

  if (benchmarkFile) {
    const raw = JSON.parse(fs.readFileSync(benchmarkFile, 'utf8'));
    const baseMetrics = raw.baseline?.queueWaitSeconds ? raw.baseline : analyzeQueueMetrics(raw.baseline, { days });
    const postMetrics = raw.postChange?.queueWaitSeconds ? raw.postChange : analyzeQueueMetrics(raw.postChange, { days });
    const comparison = compareQueueMetrics(baseMetrics, postMetrics, { targetReductionPercent: targetReduction });
    console.log(formatComparisonMarkdown(comparison));
    return;
  }

  if (baseFile && postFile) {
    const baseRuns = JSON.parse(fs.readFileSync(baseFile, 'utf8'));
    const postRuns = JSON.parse(fs.readFileSync(postFile, 'utf8'));
    const baseMetrics = analyzeQueueMetrics(baseRuns, { days });
    const postMetrics = analyzeQueueMetrics(postRuns, { days });
    const comparison = compareQueueMetrics(baseMetrics, postMetrics, { targetReductionPercent: targetReduction });
    console.log(formatComparisonMarkdown(comparison));
    return;
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
