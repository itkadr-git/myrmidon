import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { main } from "./prod-runtime-exports.mjs";

const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || join(process.env.HOME, ".cache");
const log = { log() {}, error() {} };
const record = (packageFile, originalText = "original\n") => ({ packageFile, originalText, originalFields: {}, appliedFields: ["main"] });

function fixture(t) {
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, "restore-safety-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "workspace");
  mkdirSync(join(root, "node_modules/.cache/myrmidon-prod-exports"), { recursive: true });
  mkdirSync(join(root, "packages/a"), { recursive: true });
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
  const inside = join(root, "packages/a/package.json");
  const outside = join(dir, "outside.json");
  const backup = join(root, "node_modules/.cache/myrmidon-prod-exports/backup.json");
  writeFileSync(inside, "changed\n");
  writeFileSync(outside, "outside\n");
  return { root, inside, outside, backup, dir };
}

for (const scenario of ["traversal", "absolute", "symlink", "version", "record", "mixed"]) {
  test(`restore rejects ${scenario} before writing anything`, (t) => {
    const f = fixture(t);
    let doc = { version: 1, packages: { bad: record("../outside.json") } };
    if (scenario === "absolute") doc.packages.bad = record(f.outside);
    if (scenario === "symlink") {
      symlinkSync(f.outside, join(f.root, "escape.json"));
      doc.packages.bad = record("escape.json");
    }
    if (scenario === "version") doc = { version: 2, packages: { bad: record("packages/a/package.json") } };
    if (scenario === "record") doc.packages.bad = { packageFile: "packages/a/package.json", originalText: 42 };
    if (scenario === "mixed") doc.packages = { a: record("packages/a/package.json"), z: record("../outside.json") };
    const text = JSON.stringify(doc);
    writeFileSync(f.backup, text);
    assert.notEqual(main(["restore", "--root", f.root], log), 0);
    assert.equal(readFileSync(f.backup, "utf8"), text);
    assert.equal(readFileSync(f.inside, "utf8"), "changed\n");
    assert.equal(readFileSync(f.outside, "utf8"), "outside\n");
  });
}

test("valid backup restores exact bytes and a repeated restore is a no-op", (t) => {
  const f = fixture(t);
  const original = '{  "name": "a" }\r\n';
  writeFileSync(f.backup, JSON.stringify({ version: 1, packages: { a: record("packages/a/package.json", original) } }));
  assert.equal(main(["restore", "--root", f.root], log), 0);
  assert.equal(readFileSync(f.inside, "utf8"), original);
  assert.equal(existsSync(f.backup), false);
  assert.equal(main(["restore", "--root", f.root], log), 0);
  assert.equal(readFileSync(f.inside, "utf8"), original);
});
