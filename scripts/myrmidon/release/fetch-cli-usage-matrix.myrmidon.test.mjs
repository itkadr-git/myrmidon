import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { labelFromVersion, mainSync, parseArgs, UsageError, validateArgs } from "./fetch-release-verdict.mjs";

const cli = fileURLToPath(new URL("./fetch-release-verdict.mjs", import.meta.url));
const cases = [
  ["long help", ["--help"], 0],
  ["short help", ["-h"], 0],
  ["help with version", ["--version", "1.7.0", "--help"], 0],
  ["missing version", [], 2],
  ["incomplete version", ["--version", "1.7"], 2],
  ["prerelease version", ["--version", "1.7.0-rc.1"], 2],
  ["unknown flag", ["--version", "1.7.0", "--unknown"], 2],
  ["help with unknown flag", ["--help", "--unknown"], 2],
];

for (const [name, args, expected] of cases) {
  test(`mainSync and CLI: ${name}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "fetch-cli-usage-"));
    const originalFetch = globalThis.fetch;
    const originalError = console.error;
    const originalWrite = process.stdout.write;
    const stderr = [];
    let stdout = "";
    let fetchCalls = 0;
    try {
      globalThis.fetch = () => { fetchCalls += 1; throw new Error("offline tripwire"); };
      console.error = (...values) => stderr.push(values.join(" "));
      process.stdout.write = (chunk) => { stdout += chunk; return true; };
      const result = await mainSync([...args, "--out", join(dir, "main.json")]);
      assert.equal(result, expected);
      assert.match(stderr.join("\n"), /usage:/);
      assert.equal(stdout, "");
      assert.equal(fetchCalls, 0);
      assert.deepEqual(readdirSync(dir), []);
      assert.throws(() => globalThis.fetch(), /offline tripwire/);
      assert.equal(fetchCalls, 1);
    } finally {
      globalThis.fetch = originalFetch;
      console.error = originalError;
      process.stdout.write = originalWrite;
      rmSync(dir, { recursive: true, force: true });
    }

    const childDir = mkdtempSync(join(tmpdir(), "fetch-cli-child-"));
    try {
      const tripwire = 'globalThis.fetch=()=>{console.error("OFFLINE_FETCH_TRIPWIRE");throw Error("offline")};';
      const preload = `data:text/javascript,${encodeURIComponent(tripwire)}`;
      const child = spawnSync(process.execPath, ["--import", preload, cli, ...args, "--out", join(childDir, "verdict.json")], {
        encoding: "utf8",
        env: { ...process.env, NODE_OPTIONS: "" },
        timeout: 10000,
      });
      assert.ifError(child.error);
      assert.equal(child.status, expected, child.stderr);
      assert.match(child.stderr, /usage:/);
      assert.doesNotMatch(child.stderr, /OFFLINE_FETCH_TRIPWIRE/);
      assert.equal(child.stdout, "");
      assert.deepEqual(readdirSync(childDir), []);
    } finally {
      rmSync(childDir, { recursive: true, force: true });
    }
  });
}

test("version validation and exact release labels", () => {
  for (const [version, label] of [["1.7.0", "1.7"], ["2.10.3", "2.10"]]) {
    assert.equal(validateArgs(parseArgs(["--version", version])), undefined);
    assert.equal(labelFromVersion(version), label);
  }
  for (const version of ["1.7", "1.7.0-rc.1"]) {
    assert.throws(() => validateArgs(parseArgs(["--version", version])), UsageError);
  }
  assert.throws(() => validateArgs(parseArgs([])), UsageError);
});
