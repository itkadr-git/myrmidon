import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { main } from "./prod-runtime-exports.mjs";

const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(process.env.HOME, ".cache");
const names = ["a", "b", "z"];
const original = (name) => `{ "name": "${name}", "main": "src/index.js" }\r\n`;
const changed = (name) => `{ "name": "${name}", "main": "dist/index.js" }\n`;

function snapshot(dir, base = dir) {
  return Object.fromEntries(readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? Object.entries(snapshot(path, base)) : [[relative(base, path), readFileSync(path)]];
  }));
}

function fixture(t, scenario) {
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, "restore-preflight-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "workspace");
  const backup = join(root, "node_modules/.cache/myrmidon-prod-exports/backup.json");
  mkdirSync(join(root, "node_modules/.cache/myrmidon-prod-exports"), { recursive: true });
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
  writeFileSync(join(dir, "outside.json"), "outside unchanged\n");
  const records = {};
  for (const name of names) {
    mkdirSync(join(root, "packages", name), { recursive: true });
    writeFileSync(join(root, "packages", name, "package.json"), changed(name));
    records[name] = { packageFile: `packages/${name}/package.json`, originalText: original(name), originalFields: {}, appliedFields: ["main"] };
  }
  const validLast = { ...records.z };
  if (scenario === "invalid appliedFields") records.z.appliedFields = ["invalid"];
  if (scenario === "invalid originalText") records.z.originalText = 42;
  if (scenario === "escape path") records.z.packageFile = "../outside.json";
  const doc = { version: 1, packages: records };
  writeFileSync(backup, JSON.stringify(doc, null, 2) + "\n");
  return { dir, root, backup, doc, validLast };
}

function restore(root) {
  const logs = [];
  const errors = [];
  const code = main(["restore", "--root", root], { log: (line) => logs.push(line), error: (line) => errors.push(line) });
  return { code, logs, errors };
}

for (const scenario of ["invalid appliedFields", "invalid originalText", "escape path"]) {
  test(`last record with ${scenario} rejects before any write`, (t) => {
    const f = fixture(t, scenario);
    const before = snapshot(f.dir);
    const error = scenario === "escape path" ? "error: Invalid backup path: ../outside.json" : "error: Invalid backup record: z";
    assert.deepEqual(restore(f.root), { code: 3, logs: [], errors: [error] });
    assert.deepEqual(snapshot(f.dir), before);
  });

  test(`repairing last record with ${scenario} restores all three`, (t) => {
    const f = fixture(t, scenario);
    f.doc.packages.z = f.validLast;
    writeFileSync(f.backup, JSON.stringify(f.doc, null, 2) + "\n");
    const expected = snapshot(f.dir);
    delete expected[relative(f.dir, f.backup)];
    for (const name of names) expected[`workspace/packages/${name}/package.json`] = Buffer.from(original(name));
    assert.deepEqual(restore(f.root), {
      code: 0,
      logs: [...names.map((name) => `restored: ${name} (packages/${name}/package.json)`), "restore: 3 package.json restored from backup; backup removed."],
      errors: [],
    });
    assert.deepEqual(snapshot(f.dir), expected);
  });
}
