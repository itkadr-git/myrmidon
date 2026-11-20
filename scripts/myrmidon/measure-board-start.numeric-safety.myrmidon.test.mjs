import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { describe, it } from "node:test";

const originalSpawn = childProcess.spawn;
const originalFetch = globalThis.fetch;
let spawnCalls = 0;
let fetchCalls = 0;
childProcess.spawn = () => { spawnCalls += 1; throw new Error("unexpected spawn"); };
globalThis.fetch = () => { fetchCalls += 1; throw new Error("unexpected fetch"); };
syncBuiltinESMExports();
const { main, parseArgs } = await import("./measure-board-start.mjs");

const base = ["--cwd", ".", "--cmd", "unexpected-command"];
const forms = (flag, value) => [[flag, value], [`${flag}=${value}`]];
const commonInvalid = ["0", "-1", "1.5", "NaN", "1e309", "9007199254740992"];
const invalid = {
  "--runs": commonInvalid,
  "--timeout-sec": [...commonInvalid, "2147484"],
  "--port": [...commonInvalid, "65536"],
};

describe("numeric argument safety", () => {
  for (const [flag, values] of Object.entries(invalid)) {
    for (const value of values) {
      for (const args of forms(flag, value)) {
        it(`rejects ${args.join(" ")} before spawning or fetching`, async () => {
          assert.throws(() => parseArgs([...base, ...args]), new RegExp(flag));
          const beforeSpawn = spawnCalls;
          const beforeFetch = fetchCalls;
          const messages = [];
          const code = await main([...base, ...args], { log() {}, error: (message) => messages.push(message) });
          assert.equal(code, 2);
          assert.match(messages.join("\n"), new RegExp(flag));
          assert.equal(spawnCalls, beforeSpawn);
          assert.equal(fetchCalls, beforeFetch);
        });
      }
    }
  }

  for (const [flag, property, values] of [
    ["--runs", "runs", ["1", "9007199254740991"]],
    ["--timeout-sec", "timeoutSec", ["1", "2147483"]],
    ["--port", "port", ["1", "65535"]],
  ]) {
    for (const value of values) {
      for (const args of forms(flag, value)) {
        it(`accepts ${args.join(" ")}`, () => {
          assert.equal(parseArgs([...base, ...args])[property], Number(value));
        });
      }
    }
  }
});

process.on("exit", () => {
  childProcess.spawn = originalSpawn;
  globalThis.fetch = originalFetch;
  syncBuiltinESMExports();
});
