import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = fileURLToPath(new URL("./release-package-map.mjs", import.meta.url));
const entry = { dir: "cli", name: "myrmidon", publishFromCi: true };
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), ".cache", "myrmidon-test");

function writeJson(root, path, value) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

function packageBytes(root, dir = root) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
    const path = join(dir, item.name);
    if (item.isDirectory()) return packageBytes(root, path);
    return item.name === "package.json" ? [[path.slice(root.length), readFileSync(path).toString("base64")]] : [];
  }).sort(([a], [b]) => a.localeCompare(b));
}

function run(root, command) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ["--permission", "--allow-fs-read=*", join(root, "scripts/release-package-map.mjs"), command], {
      cwd: root,
      env: { PATH: join(root, "bin"), HOME: root, TMPDIR: root },
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolveRun({ code, signal, stdout, stderr }));
  });
}

const cases = [
  ["non-array manifest", {}, /expected .*release-package-manifest\.json to contain an array\./],
  ["null entry", [null], /manifest entry 1 .* must be an object\./],
  ["array entry", [[]], /manifest entry 1 .* must be an object\./],
  ["missing dir", [{ name: "myrmidon", publishFromCi: true }], /manifest entry 1 .* missing a non-empty "dir"\./],
  ["empty dir", [{ ...entry, dir: "" }], /manifest entry 1 .* missing a non-empty "dir"\./],
  ["missing name", [{ dir: "cli", publishFromCi: true }], /manifest entry 1 .* missing a non-empty "name"\./],
  ["empty name", [{ ...entry, name: "" }], /manifest entry 1 .* missing a non-empty "name"\./],
  ["nonboolean publishFromCi", [{ ...entry, publishFromCi: "true" }], /manifest entry 1 \(cli\) .* must set boolean "publishFromCi"\./],
  ["duplicate directory", [entry, entry], /duplicate manifest entry for cli/],
  ["name mismatch", [{ ...entry, name: "wrong" }], /cli is listed as wrong in .* but package\.json declares myrmidon/],
  ["missing public package", [], /cli \(myrmidon\) is public but missing from .*add it with publishFromCi true or false/],
  ["nonexistent package", [entry, { dir: "packages/missing", name: "missing", publishFromCi: false }], /packages\/missing is listed in .* but is not a public package in this repo/],
  ["private package", [entry, { dir: "packages/private", name: "private", publishFromCi: false }], /packages\/private is listed in .* but is not a public package in this repo/],
];

async function exercise(manifest, diagnostic) {
  mkdirSync(scratch, { recursive: true });
  const root = realpathSync(mkdtempSync(join(resolve(scratch), "package-manifest-")));
  try {
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "bin"));
    copyFileSync(source, join(root, "scripts/release-package-map.mjs"));
    writeJson(root, "scripts/release-package-manifest.json", manifest);
    writeJson(root, "package.json", { private: true, name: "fixture" });
    writeJson(root, "cli/package.json", { name: "myrmidon", version: "1.2.3" });
    writeJson(root, "packages/private/package.json", { name: "private", version: "1.2.3", private: true });
    const before = packageBytes(root);
    for (const command of ["check", "list"]) {
      const result = await run(root, command);
      assert.equal(result.signal, null, `${command} timed out or was killed`);
      if (diagnostic) {
        assert.notEqual(result.code, 0, `${command} unexpectedly succeeded`);
        assert.match(result.stderr, diagnostic);
        assert.equal(result.stdout, "");
      } else {
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.stderr, "");
        assert.equal(result.stdout, command === "check" ? "Release package manifest OK: 1 enabled for CI publish, 0 disabled pending bootstrap.\n" : "cli\tmyrmidon\t1.2.3\n");
      }
      assert.deepEqual(packageBytes(root), before, `${command} changed package.json bytes`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("valid minimal CLI manifest passes check and list without package writes", async () => {
  await exercise([entry]);
});

for (const [name, manifest, diagnostic] of cases) {
  test(`invalid manifest: ${name}`, async () => {
    await exercise(manifest, diagnostic);
  });
}
