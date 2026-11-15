import assert from "node:assert/strict";
import http from "node:http";
import process from "node:process";
import { describe, it } from "node:test";
import {
  DEFAULT_PORT,
  DEFAULT_RUNS,
  DEFAULT_TIMEOUT_SEC,
  buildResult,
  formatMarkdown,
  killProcessGroup,
  main,
  measureRun,
  parseArgs,
  runMeasurement,
  summarize,
  usage,
} from "./measure-board-start.mjs";

const HERE = new URL(".", import.meta.url).pathname;

/** Collects log lines without printing them. */
function silentLog() {
  const lines = [];
  return { lines, log: (m) => lines.push(m), error: (m) => lines.push(m) };
}

/** Inline stub-server source served by a real `node -e` child: 503 for `delayMs`, then 200. */
function stubServerSource(delayMs) {
  return `const http=require("node:http");const s=Date.now();const srv=http.createServer((q,r)=>{if(Date.now()-s<${delayMs}){r.writeHead(503);r.end()}else{r.writeHead(200);r.end()}});srv.listen(Number(process.env.PORT)||4599,"127.0.0.1");process.on("SIGTERM",()=>process.exit(0));`;
}

async function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("parseArgs", () => {
  it("parses the full option set", () => {
    const opts = parseArgs([
      "--cwd", "/repo", "--cmd", "node server", "--runs", "2",
      "--port", "4000", "--timeout-sec", "10", "--env", "A=1", "--env", "B=2", "--json",
    ]);
    assert.equal(opts.cwd, "/repo");
    assert.equal(opts.cmd, "node server");
    assert.equal(opts.runs, 2);
    assert.equal(opts.port, 4000);
    assert.equal(opts.timeoutSec, 10);
    assert.deepEqual(opts.envPairs, ["A=1", "B=2"]);
    assert.equal(opts.json, true);
  });

  it("applies documented defaults", () => {
    const opts = parseArgs(["--cwd", "/repo", "--cmd", "x"]);
    assert.equal(opts.runs, DEFAULT_RUNS);
    assert.equal(opts.port, DEFAULT_PORT);
    assert.equal(opts.timeoutSec, DEFAULT_TIMEOUT_SEC);
    assert.equal(opts.json, false);
  });

  it("supports --opt=value form", () => {
    const opts = parseArgs(["--cwd=/repo", "--cmd=echo hi", "--runs=5", "--port=5000", "--timeout-sec=7"]);
    assert.equal(opts.cwd, "/repo");
    assert.equal(opts.cmd, "echo hi");
    assert.equal(opts.runs, 5);
    assert.equal(opts.port, 5000);
    assert.equal(opts.timeoutSec, 7);
  });

  it("rejects missing --cwd / --cmd", () => {
    assert.throws(() => parseArgs(["--cmd", "x"]), /--cwd is required/);
    assert.throws(() => parseArgs(["--cwd", "/repo"]), /--cmd is required/);
  });

  it("rejects invalid numeric options", () => {
    assert.throws(() => parseArgs(["--cwd", "/r", "--cmd", "x", "--runs", "0"]), /--runs/);
    assert.throws(() => parseArgs(["--cwd", "/r", "--cmd", "x", "--port", "0"]), /--port/);
    assert.throws(() => parseArgs(["--cwd", "/r", "--cmd", "x", "--port", "70000"]), /--port/);
    assert.throws(() => parseArgs(["--cwd", "/r", "--cmd", "x", "--timeout-sec", "0"]), /--timeout-sec/);
    assert.throws(() => parseArgs(["--cwd", "/r", "--cmd", "x", "--runs", "abc"]), /--runs/);
  });

  it("rejects --env without a value separator", () => {
    assert.throws(() => parseArgs(["--cwd", "/r", "--cmd", "x", "--env", "NOEQUALS"]), /--env/);
    assert.throws(() => parseArgs(["--cwd", "/r", "--cmd", "x", "--env", "=value"]), /--env/);
  });

  it("rejects unknown options", () => {
    assert.throws(() => parseArgs(["--bogus"]), /unknown option/);
  });
});

describe("summarize", () => {
  it("computes min/median/max including the even-count median", () => {
    assert.deepEqual(summarize([{ elapsedMs: 100 }, { elapsedMs: 300 }, { elapsedMs: 200 }]), { min: 100, median: 200, max: 300 });
    assert.deepEqual(summarize([{ elapsedMs: 100 }, { elapsedMs: 400 }]), { min: 100, median: 250, max: 400 });
  });
});

describe("formatMarkdown", () => {
  it("renders per-run rows with a cold marker and min/median/max rows", () => {
    const table = formatMarkdown([
      { index: 1, elapsedMs: 1234, cold: true },
      { index: 2, elapsedMs: 2345, cold: false },
    ]);
    assert.match(table, /\| 1 \| 1\.234 \| cold \|/);
    assert.match(table, /\| 2 \| 2\.345 \|  \|/);
    assert.match(table, /\| min \| 1\.234 \|/);
    assert.match(table, /\| median \| 1\.790 \|/);
    assert.match(table, /\| max \| 2\.345 \|/);
  });
});

describe("buildResult", () => {
  it("includes env key names but never values", () => {
    const opts = parseArgs(["--cwd", "/repo", "--cmd", "run", "--env", "SECRET_TOKEN=super-secret-value"]);
    const result = JSON.stringify(buildResult(opts, [{ index: 1, elapsedMs: 1500, cold: true }], { min: 1500, median: 1500, max: 1500 }));
    assert.ok(result.includes("SECRET_TOKEN"));
    assert.ok(!result.includes("super-secret-value"));
  });
});

describe("measureRun (real child processes)", () => {
  const PORT = 4321;

  it("does not count 503 as readiness: elapsed >= stub delay before the first 200", async () => {
    const delayMs = 450;
    const result = await measureRun({
      command: `node -e ${JSON.stringify(stubServerSource(delayMs))}`,
      cwd: HERE,
      port: PORT,
      timeoutMs: 8000,
    });
    assert.ok(result.elapsedMs >= delayMs, `elapsed ${result.elapsedMs}ms should be >= ${delayMs}ms (503 phase is not readiness)`);
    assert.ok(result.elapsedMs < 8000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(await isAlive(result.pid), false, "child must be stopped after a successful measurement");
  });

  it("rejects with crashed + exit code when the command dies before readiness", async () => {
    await assert.rejects(
      measureRun({
        command: "node -e \"process.exit(7)\"",
        cwd: HERE,
        port: PORT + 1,
        timeoutMs: 10000,
      }),
      (error) => error.kind === "crashed" && /exit code 7/.test(error.reason),
    );
  });

  it("rejects with timeout and stops the process group when the command never serves /api/health", async () => {
    const command = `node -e "setInterval(() => {}, 1000)"`;
    let pid = null;
    await assert.rejects(
      measureRun({
        command,
        cwd: HERE,
        port: PORT + 2,
        timeoutMs: 800,
        killGraceMs: 200,
      }).then((r) => {
        throw new Error(`expected timeout, got ${JSON.stringify(r)}`);
      }),
      (error) => {
        pid = error.pid;
        return error.kind === "timeout";
      },
    );
    // Give the SIGTERM/SIGKILL escalation a moment, then verify the group is dead.
    await new Promise((resolve) => setTimeout(resolve, 500));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, `child pid ${pid} must be dead after timeout`);
  });

  it("stops the child on the success path (no orphaned server after readiness)", async () => {
    const result = await measureRun({
      command: `node -e ${JSON.stringify(stubServerSource(0))}`,
      cwd: HERE,
      port: PORT + 3,
      timeoutMs: 5000,
      killGraceMs: 200,
    });
    assert.ok(result.elapsedMs >= 0);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(await isAlive(result.pid), false, `child pid ${result.pid} must be dead after success`);
  });

  it("killProcessGroup sends signals to a detached group", async () => {
    const { spawn } = await import("node:child_process");
    const child = spawn("node -e \"setInterval(() => {}, 1000)\"", { shell: true, detached: true, stdio: "ignore" });
    const pid = child.pid;
    await new Promise((resolve) => child.once("spawn", resolve));
    assert.equal(killProcessGroup(pid, "SIGTERM"), true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, "group must be dead after SIGTERM");
  });
});

describe("runMeasurement", () => {
  it("runs N runs against a stubbed server and returns summary", async () => {
    const PORT = 4600;
    const result = await runMeasurement(
      {
        cwd: HERE,
        cmd: `node -e ${JSON.stringify(stubServerSource(0))}`,
        runs: 2,
        port: PORT,
        timeoutSec: 5,
        envPairs: [],
        json: true,
      },
      {
        log: silentLog(),
      },
    );
    assert.equal(result.runs.length, 2);
    assert.equal(result.summary.min <= result.summary.median, true);
    assert.equal(result.summary.median <= result.summary.max, true);
  });

  it("propagates an error with exit code when the command dies before readiness", async () => {
    const log = silentLog();
    await assert.rejects(
      runMeasurement(
        { cwd: HERE, cmd: "node -e \"process.exit(3)\"", runs: 2, port: 4400, timeoutSec: 5, envPairs: [], json: true },
        { log },
      ),
      /exited before readiness/,
    );
  });
});

describe("main", () => {
  it("prints usage on --help", async () => {
    const log = silentLog();
    const code = await main(["--help"], log);
    assert.equal(code, 0);
    assert.match(log.lines.join("\n"), /Usage: node scripts\/myrmidon\/measure-board-start\.mjs/);
  });

  it("returns 2 on usage error", async () => {
    const log = silentLog();
    const code = await main(["--bogus"], log);
    assert.equal(code, 2);
  });

  it("end-to-end: runs against a stub server, JSON out, secret value never printed", async () => {
    const PORT = 4501;
    const log = silentLog();
    const code = await main([
      "--cwd", HERE,
      "--cmd", `node -e ${JSON.stringify(stubServerSource(0))}`,
      "--runs", "2",
      "--port", String(PORT),
      "--timeout-sec", "5",
      "--env", "MEASURE_TEST_SECRET=zz-secret-value-zz",
      "--json",
    ], log);
    assert.equal(code, 0);
    const output = JSON.stringify(log.lines);
    assert.ok(output.includes("medianSeconds"), "json summary present");
    assert.ok(output.includes("MEASURE_TEST_SECRET"), "env key name is printed");
    assert.ok(!output.includes("zz-secret-value-zz"), "env value must not appear");
  });
});
