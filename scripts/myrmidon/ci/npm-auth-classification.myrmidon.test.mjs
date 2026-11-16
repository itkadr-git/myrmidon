import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(new URL("../../bootstrap-npm-package.mjs", import.meta.url));
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? join(homedir(), ".cache", "myrmidon-tests");
const cases = [
  { name: "success", status: 0, stdout: "account\n", stderr: "notice\n", kind: "success" },
  { name: "E401 on stdout", status: 1, stdout: "npm ERR! E401\n", stderr: "auth detail\n", kind: "auth" },
  { name: "401 Unauthorized on stderr", status: 1, stdout: "auth output\n", stderr: "401 Unauthorized\n", kind: "auth" },
  { name: "other failure", status: 7, stdout: "other output\n", stderr: "network failure\n", kind: "generic" },
  { name: "missing npm", kind: "transport", stdout: "", stderr: "" },
];

for (const scenario of cases) {
  test(`ensureNpmAuth: ${scenario.name}`, (t) => {
    mkdirSync(scratch, { recursive: true });
    const root = mkdtempSync(join(scratch, "npm-auth-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const bin = join(root, "bin");
    const marker = join(root, "calls.jsonl");
    const resultFile = join(root, "result.json");
    mkdirSync(bin);
    if (scenario.kind !== "transport") {
      writeFileSync(join(bin, "npm"), `#!${process.execPath}\n` +
        `const fs = require("node:fs");\n` +
        `fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n` +
        `process.stdout.write(${JSON.stringify(scenario.stdout)});\n` +
        `process.stderr.write(${JSON.stringify(scenario.stderr)});\n` +
        `process.exitCode = ${scenario.status};\n`, { mode: 0o755 });
    }
    const child = `import { ensureNpmAuth } from ${JSON.stringify(pathToFileURL(script).href)};\n` +
      `import { writeFileSync } from "node:fs";\n` +
      `let result; try { result = { kind: "success", value: ensureNpmAuth() ?? null }; } ` +
      `catch (e) { result = { kind: "error", name: e.name, message: e.message, code: e.code ?? null, syscall: e.syscall ?? null, path: e.path ?? null }; }\n` +
      `writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(result));\n`;
    const proc = spawnSync(process.execPath, ["--input-type=module", "-e", child], {
      cwd: root, timeout: 10000, encoding: "utf8",
      env: { PATH: bin, HOME: root, TMPDIR: root, TMP: root, TEMP: root },
    });
    assert.equal(proc.error, undefined, "child must not time out or fail to spawn");
    assert.equal(proc.status, 0);
    assert.equal(proc.signal, null);
    assert.equal(proc.stdout, scenario.stdout);
    assert.equal(proc.stderr, scenario.stderr);
    assert.deepEqual(existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n").map(JSON.parse) : [],
      scenario.kind === "transport" ? [] : [["whoami"]]);
    const result = JSON.parse(readFileSync(resultFile, "utf8"));
    if (scenario.kind === "success") {
      assert.deepEqual(result, { kind: "success", value: null });
    } else if (scenario.kind === "transport") {
      assert.deepEqual(result, { kind: "error", name: "Error", message: "spawnSync npm ENOENT", code: "ENOENT", syscall: "spawnSync npm", path: "npm" });
    } else if (scenario.kind === "generic") {
      assert.deepEqual(result, { kind: "error", name: "Error", message: "npm whoami failed", code: null, syscall: null, path: null });
    } else {
      assert.equal(result.kind, "error");
      assert.equal(result.name, "Error");
      assert.equal(result.code, null);
      assert.equal(result.syscall, null);
      assert.equal(result.path, null);
      assert.match(result.message, /^npm auth check failed\./);
      assert.match(result.message, /npm login/);
      assert.match(result.message, /stale token/);
      assert.doesNotMatch(result.message, /npm whoami failed/);
    }
  });
}
