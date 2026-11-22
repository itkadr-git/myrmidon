import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import process from "node:process";
import { describe, it } from "node:test";
import { measureRun } from "./measure-board-start.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("measureRun spawn boundary", () => {
  it("passes the command and cwd unchanged and isolates the child environment", async () => {
    const key = "MYRMIDON_MEASURE_TEST_INHERITED";
    const original = process.env[key];
    const originalPort = process.env.PORT;
    process.env[key] = "parent value";
    process.env.PORT = "parent-port";
    const parentBefore = { ...process.env };
    const extraEnv = { MYRMIDON_MEASURE_TEST_EXTRA: "extra value", [key]: "child override" };
    const extraBefore = { ...extraEnv };
    const child = new EventEmitter();
    const command = "  command --arg='a b' && other  ";
    const cwd = "relative dir/../target";
    let captured;
    try {
      const result = measureRun({
        command, cwd, port: 43219, timeoutMs: 1000, extraEnv,
        spawnImpl: (...args) => { captured = args; return child; },
        fetchImpl: async () => { setImmediate(() => child.emit("close", 0, null)); return { status: 200, json: async () => ({ status: "ok" }) }; },
      });
      const measured = await result;
      assert.equal(typeof measured.elapsedMs, "number");
      assert.ok(measured.elapsedMs >= 0);
      assert.equal(captured.length, 2);
      assert.equal(captured[0], command);
      assert.equal(captured[1].cwd, cwd);
      assert.equal(captured[1].shell, true);
      assert.equal(captured[1].detached, true);
      assert.deepEqual(captured[1].stdio, ["ignore", "ignore", "ignore"]);
      assert.equal(captured[1].env.PORT, "43219");
      assert.equal(typeof captured[1].env.PORT, "string");
      assert.equal(captured[1].env[key], "child override");
      assert.equal(captured[1].env.MYRMIDON_MEASURE_TEST_EXTRA, "extra value");
      assert.notStrictEqual(captured[1].env, process.env);
      assert.notStrictEqual(captured[1].env, extraEnv);
      captured[1].env[key] = "child mutation";
      assert.deepEqual(extraEnv, extraBefore);
      assert.deepEqual({ ...process.env }, parentBefore);
    } finally {
      if (original === undefined) delete process.env[key]; else process.env[key] = original;
      if (originalPort === undefined) delete process.env.PORT; else process.env.PORT = originalPort;
    }
  });

  it("gives an explicit extraEnv.PORT priority over the port argument", async () => {
    const child = new EventEmitter();
    const extraEnv = { PORT: "override-port" };
    let options;
    let probeUrl;
    const result = measureRun({
      command: "fake", cwd: ".", port: 43220, timeoutMs: 1000, extraEnv,
      spawnImpl: (_command, opts) => { options = opts; return child; },
      fetchImpl: async (url) => {
        probeUrl = url;
        setImmediate(() => child.emit("close", 0, null));
        return { status: 200, json: async () => ({ status: "ok" }) };
      },
    });
    assert.ok((await result).elapsedMs >= 0);
    assert.equal(probeUrl, "http://127.0.0.1:43220/api/health");
    assert.equal(options.env.PORT, "override-port");
    assert.deepEqual(extraEnv, { PORT: "override-port" });
  });

  it("reports an ENOENT spawn error as a crash", async () => {
    const child = new EventEmitter();
    const error = Object.assign(new Error("missing executable"), { code: "ENOENT" });
    let calls = 0;
    const result = measureRun({
      command: "missing", cwd: ".", port: 43221, timeoutMs: 1000,
      spawnImpl: () => child,
      fetchImpl: async () => { calls += 1; return { status: 200, json: async () => ({ status: "ok" }) }; },
    });
    child.emit("error", error);
    await assert.rejects(result, (failure) => {
      assert.equal(failure.kind, "crashed");
      assert.equal(failure.reason, "ENOENT");
      assert.strictEqual(failure.error, error);
      assert.equal(failure.pid, undefined);
      return true;
    });
    await tick();
    assert.equal(calls, 0);
  });

  it("does not probe or return a measurement when the child closes before the first probe", async () => {
    const child = new EventEmitter();
    let calls = 0;
    const result = measureRun({
      command: "fake", cwd: ".", port: 43222, timeoutMs: 1000, pollIntervalMs: 10,
      spawnImpl: () => child,
      fetchImpl: async () => { calls += 1; return { status: 200, json: async () => ({ status: "ok" }) }; },
    });
    child.emit("close", 7, null);
    await assert.rejects(result, (failure) => {
      assert.equal(failure.kind, "crashed");
      assert.equal(failure.reason, "exit code 7");
      assert.equal(failure.exitCode, 7);
      assert.equal(failure.signalCode, null);
      assert.equal(failure.pid, undefined);
      assert.equal(failure.elapsedMs, undefined);
      return true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls, 0);
  });
});
