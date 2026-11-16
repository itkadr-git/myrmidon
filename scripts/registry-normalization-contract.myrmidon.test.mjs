import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("./release-registry-versions.mjs", import.meta.url));
const fixtures = {
  "@myrmidon/array": { stdout: '["1.0.0","2.0.0"]', expected: ["1.0.0", "2.0.0"] },
  "@myrmidon/scalar": { stdout: '"3.1.0"', expected: ["3.1.0"] },
  "@myrmidon/empty": { stdout: "[]", expected: [] },
  "@myrmidon/whitespace": { stdout: " \n\t ", expected: [] },
  "@myrmidon/malformed": { stdout: "[broken", expected: [] },
  "@myrmidon/error": { stdout: '["9.9.9"]', exit: 17, expected: [] },
};

test("fetch normalizes each response and passes exact npm argv without a shell", async () => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), ".myrmidon-test-scratch");
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, "registry-contract-"));
  try {
    const bin = join(dir, "bin");
    const log = join(dir, "calls.jsonl");
    const responses = join(dir, "responses.json");
    mkdirSync(bin);
    writeFileSync(log, "");
    writeFileSync(responses, JSON.stringify(fixtures));
    const npm = join(bin, "npm");
    writeFileSync(npm, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(args) + "\\n");
const fixtures = JSON.parse(fs.readFileSync(process.env.FIXTURE_RESPONSES, "utf8"));
const fixture = fixtures[args[1]];
if (!fixture) process.exit(91);
process.stdout.write(fixture.stdout);
process.exitCode = fixture.exit || 0;
`);
    chmodSync(npm, 0o755);
    const packages = Object.keys(fixtures);
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, "fetch", ...packages], {
        env: { PATH: bin, FIXTURE_LOG: log, FIXTURE_RESPONSES: responses, RELEASE_REGISTRY_CONCURRENCY: "1", TMPDIR: dir },
        timeout: 10000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), Object.fromEntries(packages.map((name) => [name, fixtures[name].expected])));
    const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(calls, packages.map((name) => ["view", name, "versions", "--json"]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
