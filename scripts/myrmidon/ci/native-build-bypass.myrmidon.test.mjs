import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { paperclipRunnerBinaryNeedsBuild } from "../../dev-runner-native-binary.mjs";

const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(homedir(), "cache", "scratch");
const timestamp = new Date("2030-01-01T00:00:00Z");

function withCheckout(run) {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(path.join(scratch, "native-build-bypass-"));
  try {
    const bin = path.join(root, "packages", "paperclip-runner", "dist", "bin");
    mkdirSync(bin, { recursive: true });
    const stage = (name, directory = false) => {
      const target = path.join(bin, name);
      if (directory) mkdirSync(target);
      else writeFileSync(target, "synthetic runner");
      utimesSync(target, timestamp, timestamp);
    };
    run(root, stage);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function needsBuild(repoRoot, platform, options = {}) {
  return paperclipRunnerBinaryNeedsBuild({ repoRoot, platform, nativeRunnerRequired: true, ...options });
}

test("non-required runner bypasses even a nonexistent checkout", () => {
  withCheckout((root) => {
    const missing = path.join(root, "nonexistent");
    assert.equal(needsBuild(missing, "linux", { nativeRunnerRequired: false }), false);
    assert.equal(needsBuild(missing, "linux"), true);
  });
});

test("configured binary with surrounding whitespace bypasses a missing binary", () => {
  withCheckout((root) => {
    assert.equal(needsBuild(root, "linux", { configuredBinary: "  /opt/runner  " }), false);
    assert.equal(needsBuild(root, "linux", { configuredBinary: "" }), true);
  });
});

test("whitespace-only configuration does not bypass the build decision", () => {
  withCheckout((root, stage) => {
    assert.equal(needsBuild(root, "linux", { configuredBinary: " \t\n " }), true);
    stage("paperclip-runnerd");
    assert.equal(needsBuild(root, "linux", { configuredBinary: " \t\n " }), false);
  });
});

for (const platform of ["linux", "darwin"]) {
  test(`${platform} requires the extensionless binary, not the Windows binary`, () => {
    withCheckout((root, stage) => {
      stage("paperclip-runnerd.exe");
      assert.equal(needsBuild(root, platform), true);
      stage("paperclip-runnerd");
      assert.equal(needsBuild(root, platform), false);
    });
  });
  test(`${platform} accepts a fresh extensionless binary without an exe`, () => {
    withCheckout((root, stage) => {
      assert.equal(needsBuild(root, platform), true);
      stage("paperclip-runnerd");
      assert.equal(needsBuild(root, platform), false);
    });
  });
}

test("win32 requires the exe binary, not the extensionless binary", () => {
  withCheckout((root, stage) => {
    stage("paperclip-runnerd");
    assert.equal(needsBuild(root, "win32"), true);
    stage("paperclip-runnerd.exe");
    assert.equal(needsBuild(root, "win32"), false);
  });
});

test("win32 accepts a fresh exe without an extensionless binary", () => {
  withCheckout((root, stage) => {
    assert.equal(needsBuild(root, "win32"), true);
    stage("paperclip-runnerd.exe");
    assert.equal(needsBuild(root, "win32"), false);
  });
});

for (const [platform, executable] of [["linux", "paperclip-runnerd"], ["win32", "paperclip-runnerd.exe"]]) {
  test(`${platform} treats a directory at the staged binary path as missing`, () => {
    withCheckout((root, stage) => {
      stage(executable, true);
      assert.equal(needsBuild(root, platform), true);
      assert.equal(needsBuild(root, platform, { configuredBinary: "/opt/runner" }), false);
    });
  });
}
