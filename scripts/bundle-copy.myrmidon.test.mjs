import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const scratchRoot = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? join(homedir(), ".cache", "myrmidon-tests");
const productionModule = new URL("./prepare-bundled-package.mjs", import.meta.url).href;
mkdirSync(scratchRoot, { recursive: true });

function fixture(callback) {
  const root = mkdtempSync(join(scratchRoot, "bundle-copy-"));
  const source = join(root, "source");
  const destination = join(root, "destination");
  const bin = join(root, "bin");
  const npmCalls = join(root, "npm-calls");
  try {
    mkdirSync(join(source, "lib"), { recursive: true });
    mkdirSync(join(source, "assets"), { recursive: true });
    mkdirSync(destination);
    mkdirSync(bin);
    writeFileSync(join(root, "package.json"), "{}\n");
    writeFileSync(join(bin, "npm"), `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(npmCalls)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + "\\n");
`, { mode: 0o755 });
    callback({ root, source, destination, bin, npmCalls });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function manifest(source, files) {
  writeFileSync(join(source, "package.json"), JSON.stringify({
    name: "fixture-package", version: "1.0.0", bundleDependencies: ["fixture-dependency"], files,
  }, null, 2) + "\n");
}

function snapshot(dir, prefix = "") {
  return Object.fromEntries(readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = join(prefix, entry.name);
    return entry.isDirectory() ? Object.entries(snapshot(dir, path)) : [[path, readFileSync(join(dir, path)).toString("hex")]];
  }));
}

function stage(f) {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { prepareBundledPackage } from ${JSON.stringify(productionModule)};
    prepareBundledPackage(process.argv[1], process.argv[2], { sourceRoot: process.argv[3] });
  `, f.source, f.destination, f.root], {
    env: { ...process.env, PATH: f.bin }, encoding: "utf8",
  });
  assert.equal(child.status, 0, `staging failed: ${child.stderr} ${child.error ?? ""}`);
}

function assertCalls(f, count) {
  const calls = readFileSync(f.npmCalls, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls, Array.from({ length: count }, () => ({
    cwd: f.destination, args: ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
  })));
}

test("stages allowlisted bytes and replaces stale output on a second run", () => fixture((f) => {
  const js = Buffer.from("export const revision = 1;\n");
  const asset = Buffer.from([0, 17, 34, 255, 128, 64]);
  writeFileSync(join(f.source, "lib", "entry.js"), js);
  writeFileSync(join(f.source, "assets", "icon.bin"), asset);
  writeFileSync(join(f.source, "secret-like.txt"), "synthetic-not-a-credential\n");
  for (const name of ["README.md", "LICENSE", "LICENSE.md"]) writeFileSync(join(f.source, name), `fixture ${name}\n`);
  manifest(f.source, ["lib/entry.js", "assets/icon.bin"]);
  const before = snapshot(f.source);
  writeFileSync(join(f.destination, "sentinel"), "old destination marker\n");
  writeFileSync(join(f.destination, "stale-payload.txt"), "stale payload\n");

  stage(f);
  assert.deepEqual(readFileSync(join(f.destination, "lib", "entry.js")), js);
  assert.deepEqual(readFileSync(join(f.destination, "assets", "icon.bin")), asset);
  for (const name of ["README.md", "LICENSE", "LICENSE.md"]) assert.equal(readFileSync(join(f.destination, name), "utf8"), `fixture ${name}\n`);
  assert.deepEqual(Object.keys(snapshot(f.destination)).sort(), ["LICENSE", "LICENSE.md", "README.md", "assets/icon.bin", "lib/entry.js", "package.json"].sort());
  assert.deepEqual(snapshot(f.source), before);
  assertCalls(f, 1);

  const changedJs = Buffer.from("export const revision = 2;\n");
  writeFileSync(join(f.source, "lib", "entry.js"), changedJs);
  manifest(f.source, ["lib/entry.js"]);
  writeFileSync(join(f.destination, "second-run-sentinel"), "must be removed\n");
  const beforeSecond = snapshot(f.source);
  stage(f);
  assert.deepEqual(readFileSync(join(f.destination, "lib", "entry.js")), changedJs);
  assert.deepEqual(Object.keys(snapshot(f.destination)).sort(), ["LICENSE", "LICENSE.md", "README.md", "lib/entry.js", "package.json"].sort());
  assert.deepEqual(snapshot(f.source), beforeSecond);
  assertCalls(f, 2);
}));

test("stages successfully when all optional notices are absent", () => fixture((f) => {
  writeFileSync(join(f.source, "lib", "entry.js"), "export {};\n");
  manifest(f.source, ["lib/entry.js"]);
  const before = snapshot(f.source);
  stage(f);
  assert.deepEqual(Object.keys(snapshot(f.destination)).sort(), ["lib/entry.js", "package.json"]);
  assert.equal(readFileSync(join(f.destination, "lib", "entry.js"), "utf8"), "export {};\n");
  assert.deepEqual(snapshot(f.source), before);
  assertCalls(f, 1);
}));
