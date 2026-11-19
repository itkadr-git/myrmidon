import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mainSync, parseArgs, UsageError, validateArgs } from "./cut-rc.mjs";

const cases = [
  ["version prefix", "--version", "v1.7.0"],
  ["version prerelease", "--version", "1.7.0-rc.1"],
  ["version trailing space", "--version", "1.7.0 "],
  ["version extra component", "--version", "1.7.0.1"],
  ["negative rc", "--rc", "-1"],
  ["fractional rc", "--rc", "1.2"],
  ["rc whitespace", "--rc", " 12 "],
  ["override spaces", "--override", "   "],
  ["override tab", "--override", "\t"],
  ["override newline", "--override", "\n"],
  ["journal without prefix", "--journal", "1234"],
  ["journal suffix", "--journal", "OPE-1234-extra"],
  ["journal whitespace", "--journal", " OPE-1234 "],
];

function argumentsFor(option, value) {
  const values = { "--version": "1.7.0", "--rc": "12", "--override": "reason", "--journal": "OPE-1234" };
  values[option] = value;
  return Object.entries(values).flat();
}

for (const [name, option, value] of cases) {
  test(`validation rejects ${name} without side effects`, (t) => {
    const argv = argumentsFor(option, value);
    assert.throws(() => validateArgs(parseArgs(argv)), (error) => {
      assert.ok(error instanceof UsageError);
      assert.ok(error.message.includes(option), error.message);
      return true;
    });

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cut-args-matrix-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
    git("tag", "existing");
    const before = git("show-ref");
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    const originalError = console.error;
    const originalLog = console.log;
    let diagnostics = "";
    try {
      globalThis.fetch = () => { fetchCalls += 1; throw new Error("unexpected fetch"); };
      console.error = (...args) => { diagnostics += args.join(" "); };
      console.log = () => {};
      assert.equal(mainSync([...argv, "--root", root]), 2);
    } finally {
      globalThis.fetch = originalFetch;
      console.error = originalError;
      console.log = originalLog;
    }
    assert.ok(diagnostics.includes(option), diagnostics);
    assert.equal(fetchCalls, 0);
    assert.equal(git("show-ref"), before);
  });
}

test("valid version and rc retain their exact values", () => {
  const args = parseArgs(argumentsFor("--version", "1.7.0"));
  assert.equal(validateArgs(args), undefined);
  assert.equal(args.version, "1.7.0");
  assert.equal(args.rc, "12");
});
