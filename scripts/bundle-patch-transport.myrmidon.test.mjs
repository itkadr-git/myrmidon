import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? join(homedir(), ".cache", "myrmidon-tests");
const packages = ["plain", "@scope/nested"];
const patches = [Buffer.from("plain patch\n\u0000end\n"), Buffer.from("scoped patch\r\nend\n")];

function fixture(callback) {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "bundle-patch-"));
  const source = join(root, "source");
  const destination = join(root, "destination");
  const bin = join(root, "bin");
  const trace = join(root, "trace");
  try {
    mkdirSync(join(source, "patches"), { recursive: true });
    mkdirSync(bin);
    const manifests = [join(source, "package.json")];
    writeFileSync(manifests[0], JSON.stringify({ pnpm: { patchedDependencies: {
      "plain@1.0.0": "patches/plain.patch",
      "@scope/nested@2.0.0": "patches/scoped.patch",
    } } }) + "\n");
    for (const [index, name] of packages.entries()) {
      const dir = join(destination, "node_modules", name);
      mkdirSync(dir, { recursive: true });
      const manifest = join(dir, "package.json");
      manifests.push(manifest);
      writeFileSync(manifest, JSON.stringify({ name, version: index ? "2.0.0" : "1.0.0", marker: "unchanged" }) + "\n");
    }
    writeFileSync(join(source, "patches/plain.patch"), patches[0]);
    writeFileSync(join(source, "patches/scoped.patch"), patches[1]);
    writeFileSync(join(bin, "patch"), `#!${process.execPath}\nconst fs = require('node:fs');\nconst input = fs.readFileSync(0);\nfs.appendFileSync(process.env.TRACE, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), stdin: input.toString('base64') }) + '\\n');\nprocess.exit(process.env.FAIL_PATCH === '1' ? 17 : 0);\n`, { mode: 0o755 });
    const before = manifests.map((path) => readFileSync(path));
    const run = (names = packages, fail = false) => spawnSync(process.execPath, ["--input-type=module", "-e", `import { applyBundledDependencyPatches } from ${JSON.stringify(new URL("./prepare-bundled-package.mjs", import.meta.url).href)};\napplyBundledDependencyPatches(process.argv[1], JSON.parse(process.argv[2]), process.argv[3]);`, destination, JSON.stringify(names), source], {
      cwd: root,
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, TRACE: trace, FAIL_PATCH: fail ? "1" : "0" },
      encoding: "utf8",
    });
    const events = () => existsSync(trace) ? readFileSync(trace, "utf8").trimEnd().split("\n").map(JSON.parse) : [];
    const expected = (index) => ({ argv: ["-p1", "--forward", "-d", join(destination, "node_modules", packages[index])], cwd: root, stdin: patches[index].toString("base64") });
    callback({ source, run, events, expected });
    assert.deepEqual(manifests.map((path) => readFileSync(path)), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("transports exact patch bytes and ordered arguments once per package", () => fixture((f) => {
  const result = f.run([packages[0], packages[1], packages[0], packages[1]]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.events(), [f.expected(0), f.expected(1)]);
}));

test("stops after patch exits 17", () => fixture((f) => {
  const result = f.run(packages, true);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Command failed: patch/);
  assert.deepEqual(f.events(), [f.expected(0)]);
}));

test("missing patch file throws before starting patch", () => fixture((f) => {
  rmSync(join(f.source, "patches/plain.patch"));
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ENOENT/);
  assert.deepEqual(f.events(), []);
}));
