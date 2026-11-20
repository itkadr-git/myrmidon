import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? join(homedir(), ".cache", "myrmidon-tests");
const locale = "const LC_MESSAGES_LOCALE = 'C';";
const processMarker = "globalThis.process.env";
const originalOptional = { existing: "1.0.0", collision: "1.0.0" };

function fixture({ runtime = `${locale}\n${processMarker}\n`, optional = { collision: "2.0.0", native: "3.0.0" }, bundled = true }, callback) {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "bundle-postgres-"));
  try {
    const source = join(root, "source");
    const destination = join(root, "destination");
    const bin = join(root, "bin");
    mkdirSync(source);
    mkdirSync(bin);
    const manifest = { name: "fixture", version: "1.0.0", files: ["payload.txt"], bundleDependencies: [bundled ? "embedded-postgres" : "other"], optionalDependencies: originalOptional };
    const sourceBytes = `${JSON.stringify(manifest)}\n`;
    writeFileSync(join(source, "package.json"), sourceBytes);
    writeFileSync(join(source, "payload.txt"), "source payload\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ pnpm: { patchedDependencies: {} } }));
    const fake = `#!${process.execPath}\nconst fs = require('node:fs');\nconst path = require('node:path');\nfs.writeFileSync(${JSON.stringify(join(root, "npm-args.json"))}, JSON.stringify(process.argv.slice(2)));\nfs.mkdirSync('node_modules/embedded-postgres/dist', { recursive: true });\nfs.mkdirSync('node_modules/@embedded-postgres', { recursive: true });\nfs.writeFileSync('node_modules/@embedded-postgres/native', 'native sentinel\\n');\nfs.writeFileSync('node_modules/embedded-postgres/dist/index.js', ${JSON.stringify(runtime)});\nfs.writeFileSync('node_modules/embedded-postgres/package.json', ${JSON.stringify(JSON.stringify(optional === null ? {} : { optionalDependencies: optional }))});\n`;
    writeFileSync(join(bin, "npm"), fake, { mode: 0o755 });
    const runner = `import { prepareBundledPackage } from ${JSON.stringify(new URL("./prepare-bundled-package.mjs", import.meta.url).href)}; prepareBundledPackage(process.argv[1], process.argv[2], { sourceRoot: process.argv[3] });`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", runner, source, destination, root], { encoding: "utf8", env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` } });
    assert.ifError(result.error);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "npm-args.json"), "utf8")), ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"]);
    assert.equal(readFileSync(join(source, "package.json"), "utf8"), sourceBytes);
    assert.equal(readFileSync(join(source, "payload.txt"), "utf8"), "source payload\n");
    callback({ result, destination });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function stagedOptional(destination) {
  return JSON.parse(readFileSync(join(destination, "package.json"), "utf8")).optionalDependencies;
}

function nativePath(destination) {
  return join(destination, "node_modules", "@embedded-postgres", "native");
}

test("merges embedded optional dependencies after runtime verification and removes native files", () => fixture({}, ({ result, destination }) => {
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(stagedOptional(destination), { existing: "1.0.0", collision: "2.0.0", native: "3.0.0" });
  assert.equal(existsSync(join(destination, "node_modules", "@embedded-postgres")), false);
  assert.equal(readFileSync(join(destination, "payload.txt"), "utf8"), "source payload\n");
}));

for (const [name, runtime] of [["neither marker", "unpatched"], ["locale only", locale], ["process only", processMarker]]) {
  test(`rejects ${name} before merge and native cleanup`, () => fixture({ runtime }, ({ result, destination }) => {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /staged embedded-postgres runtime is missing the repository patch/);
    assert.deepEqual(stagedOptional(destination), originalOptional);
    assert.equal(readFileSync(nativePath(destination), "utf8"), "native sentinel\n");
  }));
}

test("preserves publish optional dependencies when embedded manifest has none", () => fixture({ optional: null }, ({ result, destination }) => {
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(stagedOptional(destination), originalOptional);
  assert.equal(existsSync(join(destination, "node_modules", "@embedded-postgres")), false);
}));

test("does not postcheck or clean native files when embedded-postgres is not bundled", () => fixture({ bundled: false, runtime: "unpatched" }, ({ result, destination }) => {
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(stagedOptional(destination), originalOptional);
  assert.equal(readFileSync(nativePath(destination), "utf8"), "native sentinel\n");
}));
