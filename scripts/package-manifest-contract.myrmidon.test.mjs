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

const networkGuard = `
import net from "node:net";
import dgram from "node:dgram";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
const deny = () => { process.stderr.write("NETWORK_ACCESS_BLOCKED\\n"); throw new Error("network access blocked"); };
net.connect = net.createConnection = deny;
net.Socket.prototype.connect = deny;
dgram.createSocket = deny;
dns.lookup = dns.resolve = dns.resolve4 = dns.resolve6 = deny;
globalThis.fetch = deny;
syncBuiltinESMExports();
`;

function run(root, command, program = "scripts/release-package-map.mjs") {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ["--permission", "--allow-fs-read=*", "--import", join(root, "scripts/network-guard.mjs"), join(root, program), command], {
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
    writeFileSync(join(root, "scripts/network-guard.mjs"), networkGuard);
    copyFileSync(source, join(root, "scripts/release-package-map.mjs"));
    writeJson(root, "scripts/release-package-manifest.json", manifest);
    writeJson(root, "package.json", { private: true, name: "fixture" });
    writeJson(root, "cli/package.json", { name: "myrmidon", version: "1.2.3" });
    writeJson(root, "packages/private/package.json", { name: "private", version: "1.2.3", private: true });
    const before = packageBytes(root);
    for (const command of ["check", "list"]) {
      const result = await run(root, command);
      assert.equal(result.signal, null, `${command} timed out or was killed`);
      assert.doesNotMatch(result.stderr, /NETWORK_ACCESS_BLOCKED/, `${command} attempted network access`);
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

test("network guard rejects a loopback request", async () => {
  mkdirSync(scratch, { recursive: true });
  const root = realpathSync(mkdtempSync(join(resolve(scratch), "package-manifest-network-")));
  try {
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "scripts/network-guard.mjs"), networkGuard);
    writeFileSync(join(root, "scripts/network-probe.mjs"),
      'import http from "node:http";\nhttp.get("http://127.0.0.1:9");\n');
    const result = await run(root, "probe", "scripts/network-probe.mjs");
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /NETWORK_ACCESS_BLOCKED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [name, manifest, diagnostic] of cases) {
  test(`invalid manifest: ${name}`, async () => {
    await exercise(manifest, diagnostic);
  });
}
