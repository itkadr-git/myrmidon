#!/usr/bin/env node
// Builds the per-suite duration manifest used to balance the general-server
// vitest shards (scripts/general-server-shard.mjs, scripts/general-server-shard-durations.json)
// from the GitHub Actions job logs of green main runs.
//
// The server project runs with --no-file-parallelism --maxWorkers=1, so suites
// execute strictly one after another and vitest prints one completion line per
// suite. The cost of a suite is the gap between its completion line and the
// previous one (the first suite counts from the vitest `RUN` line). Unlike the
// duration vitest prints next to the suite name, that gap includes import and
// collection time, which is about a third of the lane (`import 396s, tests 775s`
// in the job summary), so the sum over a shard matches the shard's real wall clock.
//
//   gh api --allow-escape-sequences repos/<owner>/<repo>/actions/jobs/<job id>/logs > run1-shard1.log
//   node scripts/myrmidon/ci/shard-durations-from-logs.mjs \
//     --manifest scripts/general-server-shard-durations.json --write \
//     --note "actions runs <ids>, <date>" \
//     --run run1-shard1.log,run1-shard2.log,run1-shard3.log \
//     --run run2-shard1.log,run2-shard2.log,run2-shard3.log
//
// One --run holds every shard log of one green run. With several runs a suite
// gets the mean of its costs, which smooths out runner speed and flaky timing
// (the chat integration suite alone varied 316-555 s across three main runs).
// A suite missing from the logs gets the median weight at partition time.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ANSI = /\x1b\[[0-9;]*m/g;
const TIMESTAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)\.(\d{1,9})Z (.*)$/;
const RUN_LINE = /^\s*RUN\s+v\d/;

function toMs(second, fraction) {
  return Date.parse(`${second}Z`) + Number(`0.${fraction}`) * 1000;
}

// Returns [{ file, status, costMs }] in completion order, or throws when the
// log holds no suite lines (a log of the wrong job or a changed reporter format
// must not silently produce an empty manifest).
export function parseSuiteCosts(logText, { project = "@myrmidon/server", pathPrefix = "server/" } = {}) {
  const escaped = project.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const suiteLine = new RegExp(
    `^\\s+([✓❯↓×])\\s+${escaped}\\s+(\\S+)\\s+\\(\\d+ tests?(?: \\| \\d+ (?:skipped|failed))*\\)(?:\\s+\\d+ms)?\\s*$`,
  );
  const suites = [];
  let previous = null;
  for (const raw of logText.split("\n")) {
    const stamped = TIMESTAMP.exec(raw.replace(ANSI, "").replace(/\r$/, ""));
    if (!stamped) continue;
    const at = toMs(stamped[1], stamped[2]);
    const body = stamped[3];
    if (previous === null) {
      if (RUN_LINE.test(body)) previous = at;
      continue;
    }
    const match = suiteLine.exec(body);
    if (!match) continue;
    suites.push({ file: `${pathPrefix}${match[2]}`, status: match[1], costMs: Math.max(1, Math.round(at - previous)) });
    previous = at;
  }
  if (suites.length === 0) {
    throw new Error("no vitest suite completion lines found (wrong job log, or the reporter format changed)");
  }
  return suites;
}

// Merges the shard logs of one run into { file: ms }. A suite seen twice (the
// same log passed twice, or overlapping shards) is a mistake worth failing on.
export function mergeSuiteCosts(parsedLogs) {
  const durations = {};
  for (const suites of parsedLogs) {
    for (const { file, costMs } of suites) {
      if (file in durations) throw new Error(`suite appears in more than one log: ${file}`);
      durations[file] = costMs;
    }
  }
  return durations;
}

// Mean cost per suite over the runs that contain it.
export function averageRuns(runs) {
  const totals = new Map();
  for (const run of runs) {
    for (const [file, ms] of Object.entries(run)) {
      const entry = totals.get(file) ?? { sum: 0, count: 0 };
      entry.sum += ms;
      entry.count += 1;
      totals.set(file, entry);
    }
  }
  return Object.fromEntries([...totals].map(([file, { sum, count }]) => [file, Math.round(sum / count)]));
}

export function buildManifest(durations, note) {
  const sorted = Object.fromEntries(Object.entries(durations).sort(([a], [b]) => a.localeCompare(b)));
  return {
    $comment:
      "Per-suite wall-clock cost (ms) of the general-server vitest lane, used by scripts/general-server-shard.mjs " +
      "to balance suites across the CI shard matrix (longest-processing-time-first). The cost of a suite is the gap " +
      "between consecutive suite completion lines in the job log (import + collect + tests), because the lane runs " +
      "suites serially; with several runs it is the mean over the runs. Regenerate with " +
      "scripts/myrmidon/ci/shard-durations-from-logs.mjs from the logs of the last green main runs. Suites missing " +
      "here get the median weight, so small drift is harmless; the shard test fails when coverage of the current " +
      "suite set drops too low.",
    $source: note,
    durations: sorted,
  };
}

function main(argv) {
  let manifest = null;
  let write = false;
  let note = "";
  const runs = [];
  const loose = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--manifest") manifest = argv[++index];
    else if (arg === "--note") note = argv[++index];
    else if (arg === "--write") write = true;
    else if (arg === "--run") runs.push(String(argv[++index]).split(","));
    else if (arg.startsWith("--")) throw new Error(`unknown argument ${arg}`);
    else loose.push(arg);
  }
  if (loose.length > 0) runs.push(loose);
  if (runs.length === 0) throw new Error("pass at least one job log file (or --run a.log,b.log,...)");
  const durations = averageRuns(
    runs.map((logs) => mergeSuiteCosts(logs.map((log) => parseSuiteCosts(readFileSync(log, "utf8"))))),
  );
  const totalS = Object.values(durations).reduce((sum, ms) => sum + ms, 0) / 1000;
  const text = `${JSON.stringify(buildManifest(durations, note), null, 2)}\n`;
  if (write) {
    if (!manifest) throw new Error("--write needs --manifest <path>");
    writeFileSync(manifest, text);
  }
  console.log(`${Object.keys(durations).length} suites, ${totalS.toFixed(0)} s of serial suite time${write ? `, wrote ${manifest}` : ""}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`[shard-durations] ${error.message}`);
    process.exit(1);
  }
}
