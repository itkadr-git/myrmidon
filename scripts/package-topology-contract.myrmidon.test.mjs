import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = process.env.TOPOLOGY_TEST_MODULE ?? fileURLToPath(new URL("./release-package-map.mjs", import.meta.url));
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? join(homedir(), ".cache", "myrmidon-topology-tests");
const name = (id) => id === "entry" ? "myrmidon" : `@myrmidon/${id}`;
const item = (id, extra = {}) => ({ id, ...extra });

async function runFixture(packages) {
  await mkdir(scratch, { recursive: true });
  const root = await realpath(await mkdtemp(join(scratch, "topology-")));
  try {
    const scripts = join(root, "scripts");
    const bin = join(root, "bin");
    await mkdir(scripts);
    await mkdir(bin);
    await copyFile(source, join(scripts, "release-package-map.mjs"));
    const guard = join(root, "network-guard.cjs");
    const networkMarker = join(root, "network-called");
    await writeFile(guard, `const fs = require('node:fs');\nconst deny = () => { fs.writeFileSync(${JSON.stringify(networkMarker)}, 'called'); throw new Error('network forbidden'); };\nfor (const module of ['node:http', 'node:https', 'node:net', 'node:tls', 'node:dgram']) { const api = require(module); for (const key of ['request', 'get', 'connect', 'createConnection', 'createSocket']) if (api[key]) api[key] = deny; }\nglobalThis.fetch = deny;\n`);
    // Any unexpected npm invocation fails locally and leaves an auditable marker.
    await writeFile(join(bin, "npm"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(join(root, "npm-called"))}, 'called');\nprocess.exit(91);\n`, { mode: 0o755 });
    const manifest = [];
    for (const { id, enabled = true, ...sections } of packages) {
      const dir = `packages/${id}`;
      await mkdir(join(root, dir), { recursive: true });
      await writeFile(join(root, dir, "package.json"), JSON.stringify({ name: name(id), version: "1.2.3", ...sections }));
      manifest.push({ dir, name: name(id), publishFromCi: enabled });
    }
    await writeFile(join(scripts, "release-package-manifest.json"), JSON.stringify(manifest));
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--require", guard, join(scripts, "release-package-map.mjs"), "list"], {
        cwd: root, env: { PATH: bin, HOME: root, TMPDIR: root }, timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    await assert.rejects(readFile(join(root, "npm-called")), { code: "ENOENT" });
    await assert.rejects(readFile(networkMarker), { code: "ENOENT" });
    assert.equal(result.signal, null, "CLI timed out or was killed");
    return result;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function assertRows(result, expected, edges = []) {
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.ok(result.stdout.endsWith("\n"));
  const rows = result.stdout.trimEnd().split("\n").map((line) => line.split("\t"));
  for (const row of rows) assert.equal(row.length, 3, `not a tab-separated row: ${row}`);
  assert.deepEqual([...rows.map((row) => row[1])].sort(), expected.map(name).sort());
  assert.equal(new Set(rows.map((row) => row[1])).size, rows.length);
  for (const [dir, packageName, version] of rows) {
    const id = expected.find((entry) => name(entry) === packageName);
    assert.equal(dir, `packages/${id}`);
    assert.equal(version, "1.2.3");
  }
  assert.equal(rows.at(-1)[1], "myrmidon");
  const index = (id) => rows.findIndex((row) => row[1] === name(id));
  for (const [dependency, consumer] of edges) assert.ok(index(dependency) < index(consumer), `${dependency} before ${consumer}`);
}

const dep = (id) => ({ [name(id)]: "workspace:*" });

test("diamond order survives reversed creation, unrelated and disabled packages", async () => {
  const packages = [
    item("entry"), item("top", { dependencies: { ...dep("left"), ...dep("right") } }),
    item("left", { dependencies: dep("base") }), item("right", { dependencies: dep("base") }),
    item("base"), item("unrelated"), item("disabled", { enabled: false }),
  ];
  const edges = [["base", "left"], ["base", "right"], ["left", "top"], ["right", "top"]];
  for (const fixture of [packages, [...packages].reverse()]) {
    assertRows(await runFixture(fixture), ["entry", "top", "left", "right", "base", "unrelated"], edges);
  }
});

for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
  test(`${section} orders the dependency before its consumer`, async () => {
    const packages = [item("entry"), item("a-consumer", { [section]: dep("z-dependency") }), item("z-dependency")];
    assertRows(await runFixture(packages), ["entry", "a-consumer", "z-dependency"], [["z-dependency", "a-consumer"]]);
  });
}

test("devDependencies cycle does not affect publication order", async () => {
  const packages = [item("entry"), item("a", { devDependencies: dep("b") }), item("b", { devDependencies: dep("a") })];
  assertRows(await runFixture(packages), ["entry", "a", "b"]);
});

test("runtime cycle fails without partial output", async () => {
  const result = await runFixture([item("entry"), item("a", { dependencies: dep("b") }), item("b", { optionalDependencies: dep("a") })]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /cycle detected in release package graph/i);
  assert.equal(result.stdout, "");
});

test("missing channel entrypoint fails without partial output", async () => {
  const result = await runFixture([item("other")]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /missing channel entrypoint myrmidon/i);
  assert.equal(result.stdout, "");
});
