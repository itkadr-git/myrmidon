import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs, validatePackageName } from "../../bootstrap-npm-package.mjs";

const name = "@myrmidon/adapter-2";

test("parseArgs returns every field for publish positions and dry run", () => {
  for (const [argv, publish] of [
    [[name], false],
    [[name, "--publish"], true],
    [["--publish", name], true],
    [["--publish", name, "--publish"], true],
    [["--", name, "--", "--publish"], true],
  ]) {
    assert.deepEqual(parseArgs(argv), { help: false, packageName: name, publish });
  }
  assert.deepEqual(parseArgs([]), { help: false, packageName: null, publish: false });
});

test("parseArgs help resets all fields", () => {
  for (const flag of ["--help", "-h"]) {
    assert.deepEqual(parseArgs([name, "--publish", flag]), {
      help: true, packageName: null, publish: false,
    });
  }
});

test("parseArgs distinguishes extra names from unknown options, including after --", () => {
  assert.throws(() => parseArgs([name, "extra"]), {
    name: "Error", message: "expected exactly one package name",
  });
  for (const argv of [[name, "--unknown"], [name, "--", "--unknown"]]) {
    assert.throws(() => parseArgs(argv), { name: "Error", message: "unknown option: --unknown" });
  }
});

test("validatePackageName accepts own lowercase, hyphen and digit names", () => {
  for (const packageName of ["@myrmidon/a", "@myrmidon/adapter-2", "@myrmidon/2fast"]) {
    assert.equal(validatePackageName(packageName), undefined);
  }
});

test("validatePackageName rejects names outside the own-scope grammar", () => {
  for (const packageName of ["@other/name", "@myrmidon/Upper", "@myrmidon/has space", "@myrmidon/name/extra"]) {
    assert.throws(() => validatePackageName(packageName), {
      name: "Error",
      message: `refusing to publish a placeholder for ${JSON.stringify(packageName)}: ` +
        "the name must be a lowercase package inside the @myrmidon scope " +
        "(this guard prevents accidental publishes to names we do not own).",
    });
  }
});
