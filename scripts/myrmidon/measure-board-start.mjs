#!/usr/bin/env node
// Measures how long a board server takes to reach HTTP 200 on GET /api/health.
//
// Usage:
//   node scripts/myrmidon/measure-board-start.mjs --cwd <repo root> \
//     --cmd "<start command>" --runs 3 --port 3199 --timeout-sec 120 \
//     [--env KEY=VAL ...] [--json]
//
// Each run spawns the command (detached in its own process group) with
// PORT=<port> plus the given --env vars, polls GET http://127.0.0.1:<port>/api/health
// every 100 ms, and records the time from spawn to the first 200 response.
// Non-200 answers (e.g. 503 while migrations/DB are starting) keep the poll
// going. The whole process group is always stopped: SIGTERM to the group,
// escalated to SIGKILL after 5 s. A command that exits early (crash) or never
// turns the port healthy before --timeout-sec is an error with the exit code
// or the timeout recorded; it never yields a number.
//
// --env values and the child environment are never printed; only key names.
//
// Exit code: 0 when every run measured, 2 on usage errors, 1 on measure errors.
// No dependencies: Node built-ins only.

import { spawn } from "node:child_process";
import process from "node:process";

export const DEFAULT_PORT = 3199;
export const DEFAULT_RUNS = 3;
export const DEFAULT_TIMEOUT_SEC = 120;
export const POLL_INTERVAL_MS = 100;
export const KILL_GRACE_MS = 5000;

export function usage() {
  return `Usage: node scripts/myrmidon/measure-board-start.mjs [options]

  --cwd <dir>          Repository root the command runs in (required)
  --cmd <command>      Start command, run via the shell (required)
  --runs <n>           Measured runs (default ${DEFAULT_RUNS})
  --port <n>           Port for PORT env and the health probe (default ${DEFAULT_PORT})
  --timeout-sec <n>    Per-run readiness deadline (default ${DEFAULT_TIMEOUT_SEC})
  --env KEY=VAL        Extra child env; repeatable. Values are never printed.
  --json               Print the machine-readable result instead of the table
  --help, -h           Show this help`;
}

/** Minimal argv parser: `--opt value` and `--opt=value`, repeatable flags. */
export function parseArgs(argv) {
  const opts = {
    cwd: null,
    cmd: null,
    runs: DEFAULT_RUNS,
    port: DEFAULT_PORT,
    timeoutSec: DEFAULT_TIMEOUT_SEC,
    envPairs: [],
    json: false,
    help: false,
  };
  let i = 0;
  const readValue = (name) => {
    const token = argv[i - 1];
    const eq = token.indexOf("=");
    if (eq !== -1) return token.slice(eq + 1);
    if (i >= argv.length) throw new Error(`${name} needs a value`);
    const value = argv[i];
    i += 1;
    return value;
  };
  while (i < argv.length) {
    const arg = argv[i];
    i += 1;
    const flag = arg.startsWith("--") && arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (flag === "--cwd") opts.cwd = readValue("--cwd");
    else if (flag === "--cmd") opts.cmd = readValue("--cmd");
    else if (flag === "--runs") {
      const value = Number(readValue("--runs"));
      if (argv[i - 1] === undefined || Number.isNaN(value) || !Number.isInteger(value) || value < 1) {
        throw new Error("--runs must be a positive integer");
      }
      opts.runs = value;
    } else if (flag === "--port") {
      const value = Number(readValue("--port"));
      if (argv[i - 1] === undefined || Number.isNaN(value) || !Number.isInteger(value) || value < 1 || value > 65535) {
        throw new Error("--port must be an integer in 1..65535");
      }
      opts.port = value;
    } else if (flag === "--timeout-sec") {
      const value = Number(readValue("--timeout-sec"));
      if (argv[i - 1] === undefined || Number.isNaN(value) || !Number.isInteger(value) || value < 1) {
        throw new Error("--timeout-sec must be a positive integer");
      }
      opts.timeoutSec = value;
    } else if (flag === "--env") {
      const pair = readValue("--env");
      const eq = pair.indexOf("=");
      if (eq < 1) throw new Error('--env must be KEY=VALUE (got a name without "=" or an empty key)');
      opts.envPairs.push(pair);
    } else if (flag === "--json") opts.json = true;
    else if (flag === "--help" || flag === "-h") opts.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (opts.help) return opts;
  if (!opts.cwd) throw new Error("--cwd is required");
  if (!opts.cmd) throw new Error("--cmd is required");
  return opts;
}

function elapsedMsSince(bigintStart) {
  return Number(process.hrtime.bigint() - bigintStart) / 1e6;
}

export function killProcessGroup(pid, signal) {
  if (typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Spawns `command` with `PORT` plus `extraEnv` and resolves on the first 200
 * from GET /api/health. Non-200 answers keep polling.
 * Resolves { elapsedMs, pid, exitCode, signalCode }
 * or rejects { kind: "crashed" | "timeout", reason, pid, ... }.
 * The child process group is always stopped: SIGTERM to the group, SIGKILL after killGraceMs.
 */
export function measureRun({
  command,
  cwd,
  port,
  timeoutMs,
  extraEnv = {},
  killGraceMs = KILL_GRACE_MS,
  pollIntervalMs = POLL_INTERVAL_MS,
  spawnImpl = spawn,
  fetchImpl = fetch,
}) {
  return new Promise((resolve, reject) => {
    const startedAt = process.hrtime.bigint();
    const child = spawnImpl(command, {
      cwd,
      shell: true,
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, PORT: String(port), ...extraEnv },
    });

    const pid = child.pid;
    let measured = null;
    let timedOut = false;
    let settled = false;
    let killed = false;
    let pollTimer = null;
    let killTimer = null;
    let timeoutTimer = null;

    const clearTimers = () => {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
    };

    /** SIGTERM to the process group, then SIGKILL after killGraceMs. */
    const stopChild = () => {
      if (killed) return;
      killed = true;
      killProcessGroup(pid, "SIGTERM");
      killTimer = setTimeout(() => {
        killProcessGroup(pid, "SIGKILL");
      }, killGraceMs);
      killTimer.unref?.();
    };

    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (killTimer) { clearTimeout(killTimer); killTimer = null; }
      outcome();
    };

    child.on("error", (spawnError) => {
      stopChild();
      settle(() => {
        reject({
          kind: "crashed",
          reason: spawnError.code ?? "spawn_failed",
          error: spawnError,
          pid,
        });
      });
    });

    child.on("close", (code, signal) => {
      if (measured !== null) {
        settle(() => resolve({ elapsedMs: measured, pid, exitCode: code, signalCode: signal }));
        return;
      }
      if (timedOut) {
        settle(() => reject({
          kind: "timeout",
          timeoutMs,
          pid,
          reason: `timeout after ${timeoutMs}ms`,
        }));
        return;
      }
      const exitReason = signal ? `signal ${signal}` : `exit code ${code ?? 1}`;
      settle(() => reject({
        kind: "crashed",
        exitCode: code,
        signalCode: signal,
        reason: exitReason,
        pid,
      }));
    });

    const probe = async () => {
      if (measured !== null || settled) return;
      try {
        const response = await fetchImpl(`http://127.0.0.1:${port}/api/health`, {
          signal: AbortSignal.timeout(Math.min(pollIntervalMs * 5, 2000)),
        });
        // Only HTTP 200 counts as ready; 503 or others keep polling.
        if (response.status === 200 && measured === null && !settled) {
          measured = elapsedMsSince(startedAt);
          // Stop the server and wait for close so port is free for subsequent runs.
          stopChild();
        }
      } catch {
        // Connection refused / reset / aborted before readiness: keep polling.
      }
    };

    pollTimer = setInterval(() => {
      void probe();
    }, pollIntervalMs);
    pollTimer.unref?.();

    // Fire first probe shortly after spawn
    setImmediate(() => {
      void probe();
    });

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      stopChild();
    }, timeoutMs);
    timeoutTimer.unref?.();
  });
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

export function summarize(runs) {
  const times = runs.map((run) => run.elapsedMs);
  if (times.length === 0) {
    return { min: 0, median: 0, max: 0 };
  }
  return {
    min: Math.min(...times),
    median: median(times),
    max: Math.max(...times),
  };
}

/** Markdown table: one row per run (cold = first run) plus min/median/max. */
export function formatMarkdown(runs) {
  const lines = ["| Run | Seconds | Note |", "| --- | --- | --- |"];
  runs.forEach((run, index) => {
    lines.push(`| ${index + 1} | ${(run.elapsedMs / 1000).toFixed(3)} | ${index === 0 ? "cold" : ""} |`);
  });
  const { min, median: med, max } = summarize(runs);
  lines.push(`| min | ${(min / 1000).toFixed(3)} | |`);
  lines.push(`| median | ${(med / 1000).toFixed(3)} | |`);
  lines.push(`| max | ${(max / 1000).toFixed(3)} | |`);
  return lines.join("\n");
}

/**
 * Runs `--runs` measured starts. Resolves { runs, summary }; rejects with
 * Error describing the first failing run (crash exit code or timeout).
 */
export async function runMeasurement(opts, {
  spawnImpl = spawn,
  fetchImpl = fetch,
  killGraceMs = KILL_GRACE_MS,
  pollIntervalMs = POLL_INTERVAL_MS,
  log = console,
} = {}) {
  const extraEnv = Object.fromEntries(
    opts.envPairs.map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]),
  );
  const runs = [];
  try {
    for (let index = 0; index < opts.runs; index += 1) {
      if (!opts.json) log.log(`run ${index + 1}/${opts.runs}: starting...`);
      const { elapsedMs } = await measureRun({
        command: opts.cmd,
        cwd: opts.cwd,
        port: opts.port,
        timeoutMs: opts.timeoutSec * 1000,
        extraEnv,
        killGraceMs,
        pollIntervalMs,
        spawnImpl,
        fetchImpl,
      });
      runs.push({ index: index + 1, elapsedMs, cold: index === 0 });
      if (!opts.json) log.log(`run ${index + 1}/${opts.runs}: ${(elapsedMs / 1000).toFixed(3)} s`);
    }
  } catch (failure) {
    const reason = failure?.kind === "timeout"
      ? `timeout: no 200 on /api/health within ${opts.timeoutSec} s; process group stopped`
      : `command exited before readiness (${failure?.reason ?? "unknown"})`;
    throw new Error(`run ${runs.length + 1} failed: ${reason}`);
  }
  return { runs, summary: summarize(runs) };
}

/** Builds the machine-readable result object (env values never included). */
export function buildResult(opts, runs, summary) {
  return {
    cmd: opts.cmd,
    cwd: opts.cwd,
    port: opts.port,
    timeoutSec: opts.timeoutSec,
    envKeys: opts.envPairs.map((pair) => pair.slice(0, pair.indexOf("="))),
    runs: runs.map((r) => ({
      run: r.index,
      seconds: Number((r.elapsedMs / 1000).toFixed(3)),
      cold: r.cold,
    })),
    summary: {
      minSeconds: Number((summary.min / 1000).toFixed(3)),
      medianSeconds: Number((summary.median / 1000).toFixed(3)),
      maxSeconds: Number((summary.max / 1000).toFixed(3)),
    },
  };
}

export async function main(argv = process.argv.slice(2), log = console) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    log.error(`measure-board-start: ${error.message}\n\n${usage()}`);
    return 2;
  }
  if (opts.help) {
    log.log(usage());
    return 0;
  }
  try {
    const result = await runMeasurement(opts, { log });
    if (opts.json) {
      log.log(JSON.stringify(buildResult(opts, result.runs, result.summary), null, 2));
    } else {
      log.log(formatMarkdown(result.runs));
    }
    return 0;
  } catch (error) {
    log.error(`measure-board-start: ${error.message}`);
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] && process.argv[1].endsWith("measure-board-start.mjs");
if (invokedDirectly) {
  const code = await main();
  process.exitCode = code;
}
