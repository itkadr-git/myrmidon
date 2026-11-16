import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseArgs } from "./measure-board-start.mjs";

const baseline = {
  cwd: "/work tree",
  cmd: "node server --mode=test",
  runs: 7,
  port: 65535,
  timeoutSec: 19,
  envPairs: [],
  json: false,
  help: false,
};

const options = [
  ["--cwd", "/work tree"],
  ["--cmd", "node server --mode=test"],
  ["--runs", "7"],
  ["--port", "65535"],
  ["--timeout-sec", "19"],
];

describe("measure argv equivalence", () => {
  for (const [flag] of options) {
    it(`${flag} accepts equivalent split and equals forms without mutating argv`, () => {
      const makeArgs = (equals) => options.flatMap(([name, value]) =>
        name === flag && equals ? [`${name}=${value}`] : [name, value]);
      for (const equals of [false, true]) {
        const argv = Object.freeze(makeArgs(equals));
        const before = [...argv];
        assert.deepStrictEqual(parseArgs(argv), baseline);
        assert.deepStrictEqual(argv, before);
      }
    });
  }

  it("preserves repeated env pairs, empty values and embedded equals in order", () => {
    const argv = Object.freeze([
      "--cwd=/work tree", "--cmd=node server --mode=test", "--runs=7",
      "--port=65535", "--timeout-sec=19", "--env", "EMPTY=",
      "--env=TOKEN=a=b=c", "--env", "EMPTY=again", "--json",
    ]);
    const before = [...argv];
    assert.deepStrictEqual(parseArgs(argv), {
      ...baseline, envPairs: ["EMPTY=", "TOKEN=a=b=c", "EMPTY=again"], json: true,
    });
    assert.deepStrictEqual(argv, before);
  });

  const invalid = [
    ["--port", "0", "--port must be an integer in 1..65535"],
    ["--port", "65536", "--port must be an integer in 1..65535"],
    ["--runs", "1.5", "--runs must be a positive integer"],
    ["--timeout-sec", "2.5", "--timeout-sec must be a positive integer"],
  ];
  for (const [flag, value, message] of invalid) {
    for (const equals of [false, true]) {
      it(`rejects ${flag} ${value} in ${equals ? "equals" : "split"} form`, () => {
        const argv = Object.freeze(["--cwd", "/r", "--cmd", "run", ...(equals ? [`${flag}=${value}`] : [flag, value])]);
        const before = [...argv];
        assert.throws(() => parseArgs(argv), { name: "Error", message });
        assert.deepStrictEqual(argv, before);
      });
    }
  }

  for (const unknown of ["--unexpected", "--unexpected=value"]) {
    it(`rejects ${unknown}`, () => {
      const argv = Object.freeze(["--cwd", "/r", "--cmd", "run", unknown]);
      const before = [...argv];
      assert.throws(() => parseArgs(argv), { name: "Error", message: `unknown option: ${unknown}` });
      assert.deepStrictEqual(argv, before);
    });
  }
});
