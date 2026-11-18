import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { test } from "node:test";
import { main } from "./check-prod-runtime-resolution.mjs";

function createDist(root, body) {
  const dist = path.join(root, "server сборка", "dist файлы");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, "index.js"), body);
  return dist;
}

function run(cwd, dist) {
  const messages = [];
  const log = {
    log: (line) => messages.push(["log", line]),
    error: (line) => messages.push(["error", line]),
  };
  const code = main(["--dist", dist], log, cwd);
  return { code, messages };
}

test("dist resolution and reported paths use the injected cwd", () => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(homedir(), ".cache", "myrmidon-test-scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(scratch, "cwd fixture "));
  const originalCwd = process.cwd();
  try {
    const rootA = path.join(fixture, "root A тест");
    const rootB = path.join(fixture, "root B тест");
    const distA = createDist(rootA, "export {};\n");
    const distB = createDist(rootB, 'import "./bad.ts";\n');
    const relative = path.join("server сборка", "dist файлы");

    const clean = { code: 0, messages: [["log", "0 сбоев в 0 пакетах"]] };
    const failure = {
      code: 1,
      messages: [
        ["error", `${relative}/index.js:1 ./bad.ts → относительный импорт .ts`],
        ["error", "1 сбой в 0 пакетах"],
      ],
    };
    assert.deepEqual(run(rootA, relative), clean);
    assert.deepEqual(run(rootA, distA), clean);
    assert.deepEqual(run(rootB, relative), failure);
    assert.deepEqual(run(rootB, distB), failure);
    assert.deepEqual(run(rootA, distB), {
      code: 1,
      messages: [
        ["error", `${distB}/index.js:1 ./bad.ts → относительный импорт .ts`],
        ["error", "1 сбой в 0 пакетах"],
      ],
    });
    assert.equal(process.cwd(), originalCwd);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
