import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function fixture(t) {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || os.homedir();
  const root = fs.mkdtempSync(path.join(scratch, "myrmidon-lock-recovery-"));
  const processes = new Set();
  t.after(async () => {
    for (const proc of processes) proc.kill("SIGKILL");
    await Promise.all([...processes].map((proc) => once(proc, "close").catch(() => {})));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(new URL("../../ensure-plugin-build-deps.mjs", import.meta.url), path.join(root, "scripts/ensure-plugin-build-deps.mjs"));
  const compiler = path.join(root, "node_modules/typescript/bin/tsc");
  fs.mkdirSync(path.dirname(compiler), { recursive: true });
  fs.writeFileSync(compiler, `const fs = require('node:fs');
const path = require('node:path');
const target = path.dirname(process.argv[3]);
fs.appendFileSync('builds', path.relative(process.cwd(), target) + '\\n');
fs.mkdirSync(path.join(target, 'dist'), { recursive: true });
fs.writeFileSync(path.join(target, 'dist/index.js'), 'export {};\\n');
`);
  for (const target of ["packages/shared", "packages/plugins/sdk"]) {
    fs.mkdirSync(path.join(root, target, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, target, "src/index.ts"), "export {};\n");
    fs.writeFileSync(path.join(root, target, "tsconfig.json"), "{}");
  }
  const lock = path.join(root, "node_modules/.cache/paperclip-plugin-build-deps.lock");
  function launch() {
    const proc = spawn(process.execPath, ["scripts/ensure-plugin-build-deps.mjs"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    processes.add(proc);
    let output = "";
    let notify;
    const waiting = new Promise((resolve) => { notify = resolve; });
    for (const stream of [proc.stdout, proc.stderr]) stream.on("data", (chunk) => {
      output += chunk;
      if (output.includes("Waiting for another workspace build")) notify();
    });
    const done = once(proc, "close").then(([code, signal]) => {
      processes.delete(proc);
      return { code, signal, output };
    });
    return { proc, waiting, done };
  }
  return { root, lock, launch };
}

async function bounded(promise, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 5000); })]);
  } finally {
    clearTimeout(timer);
  }
}

for (const [name, entries] of [
  ["malformed JSON", { "owner-corrupt.json": "{" }],
  ["missing pid", { "owner-corrupt.json": "{}" }],
  ["unknown additional file", null],
]) {
  test(`preserves lock with ${name} until manual removal`, async (t) => {
    const f = fixture(t);
    let lockEntries = entries;
    if (!lockEntries) {
      const owner = spawnSync(process.execPath, ["-e", ""]);
      assert.equal(owner.status, 0);
      assert.throws(() => process.kill(owner.pid, 0), { code: "ESRCH" });
      lockEntries = { "owner-dead.json": JSON.stringify({ pid: owner.pid }), unknown: "keep" };
    }
    fs.mkdirSync(f.lock, { recursive: true });
    for (const [file, content] of Object.entries(lockEntries)) fs.writeFileSync(path.join(f.lock, file), content);
    const run = f.launch();
    await bounded(Promise.race([run.waiting, run.done.then((result) => { throw new Error(`exited before waiting: ${JSON.stringify(result)}`); })]), "waiting message timed out");
    assert.equal(fs.existsSync(path.join(f.root, "builds")), false);
    assert.deepEqual(fs.readdirSync(f.lock).sort(), Object.keys(lockEntries).sort());
    for (const [file, content] of Object.entries(lockEntries)) assert.equal(fs.readFileSync(path.join(f.lock, file), "utf8"), content);
    assert.equal(run.proc.kill("SIGTERM"), true);
    const stopped = await bounded(run.done, "helper did not terminate");
    assert.equal(stopped.code, 143, stopped.output);
    assert.equal(stopped.signal, null);
    assert.equal(fs.existsSync(path.join(f.root, "builds")), false);
    assert.deepEqual(fs.readdirSync(f.lock).sort(), Object.keys(lockEntries).sort());
    fs.rmSync(f.lock, { recursive: true });
    const retry = await bounded(f.launch().done, "retry timed out");
    assert.equal(retry.code, 0, retry.output);
    assert.deepEqual(fs.readFileSync(path.join(f.root, "builds"), "utf8").trim().split("\n"), ["packages/shared", "packages/plugins/sdk"]);
    assert.equal(fs.existsSync(f.lock), false);
  });
}
