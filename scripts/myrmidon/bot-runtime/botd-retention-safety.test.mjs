import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { retain } from "../../../docker/bot-runtime/botd/lib/archive.js";

let root;
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "retention-safety-"))); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const now = new Date("2026-10-27T12:00:00Z");
function manifest(file) {
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({ version: 1, archives: [{ key: "ABC-1", patch: file, createdAt: "2026-01-01T00:00:00Z", sizeBytes: 4 }] }));
}

it("refuses traversal, protected data, directories and symlinks even under disk pressure", () => {
  const outside = path.join(root, "outside");
  fs.writeFileSync(outside, "safe");
  fs.mkdirSync(path.join(root, "hermes"));
  for (const name of ["state.db", "sessions.json", "auth.json", "media-young.png"]) fs.writeFileSync(path.join(root, "hermes", name), "safe");
  fs.symlinkSync(outside, path.join(root, "ABC-1-20260101T000000Z.patch"));
  for (const file of [outside, ...["state.db", "sessions.json", "auth.json", "media-young.png"].map((n) => path.join(root, "hermes", n)), path.join(root, "hermes"), path.join(root, "ABC-1-20260101T000000Z.patch"), root + "/../" + path.basename(root) + "/outside"]) {
    manifest(file);
    const r = retain(root, { now, capBytes: 0 });
    assert.equal(r.ok, false, file);
    assert.equal(fs.readFileSync(outside, "utf8"), "safe");
    assert.equal(fs.readFileSync(path.join(root, "hermes", "state.db"), "utf8"), "safe");
  }
});

it("dry-run leaves the source, manifest and journal untouched", () => {
  const file = path.join(root, "ABC-1-20260101T000000Z.patch");
  fs.writeFileSync(file, "safe");
  manifest(file);
  const before = fs.readFileSync(path.join(root, "manifest.json"), "utf8");
  const r = retain(root, { now, dryRun: true });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.removed.length, 1);
  assert.equal(fs.readFileSync(file, "utf8"), "safe");
  assert.equal(fs.readFileSync(path.join(root, "manifest.json"), "utf8"), before);
  assert.equal(fs.existsSync(path.join(root, "retention-journal.jsonl")), false);
});

it("records intent before removal and a completed deletion afterward", () => {
  const file = path.join(root, "ABC-1-20260101T000000Z.patch");
  fs.writeFileSync(file, "safe");
  manifest(file);
  assert.equal(retain(root, { now }).ok, true);
  assert.equal(fs.existsSync(file), false);
  const journal = fs.readFileSync(path.join(root, "retention-journal.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(journal.map((e) => e.action), ["delete-intent", "deleted"]);
});

it("a symlinked journal fails closed", () => {
  const file = path.join(root, "ABC-1-20260101T000000Z.patch");
  const outside = path.join(root, "outside");
  fs.writeFileSync(file, "safe");
  fs.writeFileSync(outside, "safe");
  manifest(file);
  fs.symlinkSync(outside, path.join(root, "retention-journal.jsonl"));
  assert.equal(retain(root, { now }).ok, false);
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.readFileSync(outside, "utf8"), "safe");
});
