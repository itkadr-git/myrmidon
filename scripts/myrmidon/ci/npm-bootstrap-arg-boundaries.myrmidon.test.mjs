import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "../../bootstrap-npm-package.mjs";

const name = "@myrmidon/example";
const parsed = (packageName, publish = false) => ({ help: false, packageName, publish });
const help = { help: true, packageName: null, publish: false };

test("publish ordering, repetition, and separators preserve the parsed fields", () => {
  for (const argv of [
    ["--publish", name],
    ["--publish", name, "--publish"],
    ["--", "--publish", name],
    [name, "--", "--publish"],
    ["--publish", name, "--"],
  ]) {
    assert.deepEqual(parseArgs(argv), parsed(name, true), JSON.stringify(argv));
  }
  assert.deepEqual(parseArgs(["--", name, "--"]), parsed(name));
});

test("missing name remains null even with flags and separators", () => {
  assert.deepEqual(parseArgs([]), parsed(null));
  assert.deepEqual(parseArgs(["--", "--publish", "--publish", "--"]), parsed(null, true));
});

test("help short-circuits before and after a name and resets earlier flags", () => {
  for (const flag of ["--help", "-h"]) {
    assert.deepEqual(parseArgs([flag, name, "--invalid"]), help);
    assert.deepEqual(parseArgs(["--publish", name, flag, "--invalid"]), help);
  }
});

test("unknown options and a second positional argument fail at the first error", () => {
  assert.throws(() => parseArgs(["--invalid", "--help"]), { message: "unknown option: --invalid" });
  assert.throws(() => parseArgs([name, "--invalid", "--help"]), { message: "unknown option: --invalid" });
  assert.throws(() => parseArgs([name, "--", "other", "--help"]), { message: "expected exactly one package name" });
  assert.throws(() => parseArgs([name, "--publish", "other", "--invalid"]), { message: "expected exactly one package name" });
});
