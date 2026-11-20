#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

function measurement(value, label) {
  if (!value || typeof value !== 'object' || typeof value.cmd !== 'string' || !value.cmd.trim()) {
    throw new Error(`${label}: missing cmd`);
  }
  if (!Array.isArray(value.envKeys) || value.envKeys.some((key) => typeof key !== 'string' || !key.trim()) || new Set(value.envKeys).size !== value.envKeys.length) {
    throw new Error(`${label}: invalid envKeys`);
  }
  if (!Array.isArray(value.runs) || value.runs.length < 4) throw new Error(`${label}: at least three warm samples required`);
  value.runs.forEach((run, i) => {
    if (!run || run.run !== i + 1 || run.cold !== (i === 0)) throw new Error(`${label}: invalid run order or cold marker`);
    if (typeof run.seconds !== 'number' || !Number.isFinite(run.seconds) || run.seconds <= 0) throw new Error(`${label}: seconds must be finite and positive`);
  });
  const times = value.runs.slice(1).map((run) => run.seconds).sort((a, b) => a - b);
  const middle = Math.floor(times.length / 2);
  const median = times.length % 2 ? times[middle] : times[middle - 1] / 2 + times[middle] / 2;
  return { cmd: value.cmd, envKeys: [...value.envKeys].sort(), cold: { seconds: value.runs[0].seconds }, warm: { count: times.length, min: times[0], median, max: times.at(-1) } };
}

export function compare(baselineInput, candidateInput, overrideReason = null) {
  const baseline = measurement(baselineInput, 'baseline');
  const candidate = measurement(candidateInput, 'candidate');
  const differences = [];
  if (baseline.cmd !== candidate.cmd) differences.push('cmd');
  if (JSON.stringify(baseline.envKeys) !== JSON.stringify(candidate.envKeys)) differences.push('envKeys');
  if (overrideReason !== null && (typeof overrideReason !== 'string' || !overrideReason.trim())) throw new Error('override reason must not be blank');
  if (differences.length && !overrideReason) throw new Error(`incompatible conditions: ${differences.join(', ')}; provide --override-reason`);
  const ratio = baseline.warm.median / candidate.warm.median;
  if (!Number.isFinite(ratio) || ratio <= 0) throw new Error('invalid ratio');
  return { baseline, candidate, differences, overrideReason: overrideReason?.trim() ?? null, ratio, verdict: ratio >= 2 ? 'PASS' : 'FAIL' };
}

export function main(args) {
  try {
    if (args.length !== 2 && args.length !== 4) throw new Error('usage: compare-bench.mjs <baseline.json> <candidate.json> [--override-reason <reason>]');
    if (args.length === 4 && args[2] !== '--override-reason') throw new Error('expected --override-reason');
    const report = compare(JSON.parse(readFileSync(args[0], 'utf8')), JSON.parse(readFileSync(args[1], 'utf8')), args.length === 4 ? args[3] : null);
    console.log(JSON.stringify(report, null, 2));
    return report.verdict === 'PASS' ? 0 : 1;
  } catch (error) {
    console.error(`compare-bench: ${error.message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
