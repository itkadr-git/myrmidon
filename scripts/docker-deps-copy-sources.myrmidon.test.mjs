import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("./check-docker-deps-stage.mjs", import.meta.url));
const manifests = ["packages/alpha/package.json", "packages/beta/package.json", "packages/gamma/package.json"];

function snapshot(root, dir = root) {
  return Object.fromEntries(readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const absolute = path.join(dir, entry.name);
    return entry.isDirectory() ? Object.entries(snapshot(root, absolute)) : [[path.relative(root, absolute), readFileSync(absolute, "utf8")]];
  }));
}

function check(dockerfile, missing = [], selected = manifests) {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(os.homedir(), ".myrmidon-test-scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(path.join(scratch, "docker-copy-"));
  try {
    const files = { Dockerfile: dockerfile, "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n" };
    for (const manifest of selected) files[manifest] = '{"name":"fixture"}\n';
    for (const [name, content] of Object.entries(files)) {
      const target = path.join(root, name);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    const before = snapshot(root);
    const child = spawnSync(process.execPath, [cli], { cwd: root, encoding: "utf8" });
    assert.deepEqual(snapshot(root), before, "CLI must not modify fixture files");
    assert.equal(child.error, undefined);
    assert.equal(child.signal, null);
    assert.equal(child.status, missing.length ? 1 : 0, child.stderr);
    assert.equal(child.stdout, missing.length ? "" : "PASS\n");
    const errors = missing.map((name) => `Dockerfile deps stage missing package manifest coverage for: ${name}\n`).join("");
    assert.equal(child.stderr, missing.length ? `${errors}Dockerfile deps stage is out of sync. Update it to cover the missing files.\n` : "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const stage = (lines, after = "") => `FROM node AS deps\n${lines}\nFROM node AS runtime\n${after}\n`;

test("one source covers its manifest", () => {
  check(stage(`COPY ${manifests[0]} /app/`), [], [manifests[0]]);
});

test("each source in a multi-source COPY covers its manifest", () => {
  check(stage(`COPY ${manifests.join(" ")} /app/`));
  for (const missing of manifests) {
    check(stage(`COPY ${manifests.filter((name) => name !== missing).join(" ")} /app/`), [missing]);
  }
});

test("COPY options and mixed whitespace precede all sources", () => {
  check(stage(`COPY --chown=1000:1000 --chmod=644   ${manifests[0]}\t${manifests[1]}  ${manifests[2]}\t/app/`));
});

test("a tab after COPY separates the instruction from its source", () => {
  check(stage(`COPY\t${manifests[0]} /app/`), [], [manifests[0]]);
});

test("destination, COPYX, RUN text, and other stages do not cover a manifest", () => {
  for (const line of [
    `COPY unrelated ${manifests[0]}`,
    `COPYX ${manifests[0]} /app/`,
    `RUN echo COPY ${manifests[0]} /app/`,
  ]) check(stage(line), [manifests[0]], [manifests[0]]);
  check(stage("RUN true", `COPY ${manifests[0]} /app/`), [manifests[0]], [manifests[0]]);
});
