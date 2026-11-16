import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./release-registry-versions.mjs", import.meta.url));
const version = "2026.707.2";

async function run(packages, responses) {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), ".cache", "registry-absent-tests");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "registry-absent-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const log = join(dir, "calls");
    writeFileSync(log, "");
    writeFileSync(join(bin, "npm"), `#!${process.execPath}\n` + `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.LOG, JSON.stringify(args) + '\\n');
const entry = JSON.parse(process.env.RESPONSES)[args[1]];
if (!entry) process.exit(99);
(async () => {
  if (entry.waitFor) {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(path.join(process.env.FIXTURE, entry.waitFor))) {
      if (Date.now() > deadline) process.exit(98);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  if (entry.signal) fs.writeFileSync(path.join(process.env.FIXTURE, entry.signal), '');
  fs.appendFileSync(process.env.FINISHED, args[1] + '\\n');
  process.stdout.write(entry.output);
  process.exitCode = entry.status || 0;
})();
`, { mode: 0o755 });
    const finished = join(dir, "finished");
    writeFileSync(finished, "");
    const child = spawn(process.execPath, [script, "assert-absent", version, ...packages], {
      env: { ...process.env, PATH: bin, TMPDIR: dir, LOG: log, FINISHED: finished, FIXTURE: dir, RESPONSES: JSON.stringify(responses), RELEASE_REGISTRY_CONCURRENCY: "10" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("CLI timed out")); }, 10000);
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    const expected = packages.map(name => ["view", `${name}@${version}`, "version"]);
    assert.deepEqual(calls.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), expected.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
    assert.equal(result.signal, null);
    return { ...result, stdout, stderr, finished: readFileSync(finished, "utf8").trim().split("\n").filter(Boolean) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const key = name => `${name}@${version}`;

test("exact and trimmed matches are reported in input order despite reversed completions", async () => {
  const packages = ["@myrmidon/slow", "@myrmidon/suffix-lookalike", "@myrmidon/prefix-lookalike", "@myrmidon/fast", "@myrmidon/slow"];
  const result = await run(packages, {
    [key(packages[0])]: { output: version, waitFor: "fast-done" },
    [key(packages[1])]: { output: `${version}-canary.1` },
    [key(packages[2])]: { output: `1${version}` },
    [key(packages[3])]: { output: ` \n${version}\t\n`, signal: "fast-done" },
  });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, [packages[0], packages[3], packages[4]].map(name => `npm version ${name}@${version} already exists.\n`).join(""));
  assert.ok(result.finished.indexOf(key(packages[3])) < result.finished.indexOf(key(packages[0])));
});

test("different, prefix, suffix, empty and failed npm responses are absent", async () => {
  const packages = ["@myrmidon/different", "@myrmidon/prefix", "@myrmidon/suffix", "@myrmidon/empty", "@myrmidon/error"];
  const result = await run(packages, {
    [key(packages[0])]: { output: "2026.707.3" },
    [key(packages[1])]: { output: `x${version}` },
    [key(packages[2])]: { output: `${version}x` },
    [key(packages[3])]: { output: "" },
    [key(packages[4])]: { output: version, status: 1 },
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});
