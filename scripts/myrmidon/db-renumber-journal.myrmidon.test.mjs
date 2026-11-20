import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { updateJournal } from "./db-renumber-migration.mjs";

function withJournal(journal, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "journal-contract-"));
  try {
    const file = path.join(dir, "_journal.json");
    if (journal !== null) fs.writeFileSync(file, JSON.stringify(journal));
    run(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const entry = (idx, tag, extra = {}) => ({
  idx, tag, version: "7", when: 1700000000123, breakpoints: true, ...extra,
});
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const change = (file, oldTag = "0002_target") =>
  updateJournal(file, "0002", "0010", oldTag, "0010_target");

describe("updateJournal contract", () => {
  it("selects an entry by numeric idx", () => {
    withJournal({ entries: [entry(2, "different")] }, (file) => {
      assert.deepEqual(change(file), entry(10, "0010_target"));
      assert.deepEqual(read(file).entries, [entry(10, "0010_target")]);
    });
  });

  it("selects an entry by exact tag when idx differs", () => {
    withJournal({ entries: [entry(3, "0002_target")] }, (file) => {
      change(file);
      assert.deepEqual(read(file).entries, [entry(10, "0010_target")]);
    });
  });

  it("selects an entry by number prefix when idx and exact tag differ", () => {
    withJournal({ entries: [entry(3, "0002_other")] }, (file) => {
      change(file);
      assert.deepEqual(read(file).entries, [entry(10, "0010_target")]);
    });
  });

  it("sorts idx numerically rather than lexically", () => {
    withJournal({ entries: [entry(20, "0020_last"), entry(2, "0002_target"), entry(3, "0003_first")] }, (file) => {
      change(file);
      assert.deepEqual(read(file).entries.map((item) => item.idx), [3, 10, 20]);
    });
  });

  it("preserves journal version and dialect", () => {
    withJournal({ version: "7", dialect: "postgresql", entries: [entry(2, "0002_target")] }, (file) => {
      change(file);
      assert.equal(read(file).version, "7");
      assert.equal(read(file).dialect, "postgresql");
    });
  });

  it("preserves entry version, when and breakpoints", () => {
    withJournal({ entries: [entry(2, "0002_target", { version: "6", when: 123, breakpoints: false })] }, (file) => {
      change(file);
      assert.deepEqual(read(file).entries[0], entry(10, "0010_target", { version: "6", when: 123, breakpoints: false }));
    });
  });

  it("preserves unrelated root and target entry fields", () => {
    withJournal({ custom: { nested: [1, "x"] }, entries: [entry(2, "0002_target", { custom: { keep: true } })] }, (file) => {
      change(file);
      assert.deepEqual(read(file).custom, { nested: [1, "x"] });
      assert.deepEqual(read(file).entries[0].custom, { keep: true });
    });
  });

  it("changes only the selected entry", () => {
    const before = [entry(1, "0001_first", { note: "keep" }), entry(2, "0002_target"), entry(12, "0012_last", { when: 5 })];
    withJournal({ entries: before }, (file) => {
      change(file);
      assert.deepEqual(read(file).entries, [before[0], entry(10, "0010_target"), before[2]]);
    });
  });

  it("writes a trailing newline", () => {
    withJournal({ entries: [entry(2, "0002_target")] }, (file) => {
      change(file);
      assert.ok(fs.readFileSync(file, "utf8").endsWith("\n"));
    });
  });

  it("throws when the journal file is missing", () => {
    withJournal(null, (file) => {
      assert.throws(() => change(file), /_journal\.json not found/);
      assert.equal(fs.existsSync(file), false);
    });
  });

  it("throws for a missing entry without changing any bytes", () => {
    withJournal({ version: "7", entries: [entry(3, "0003_other")] }, (file) => {
      const before = fs.readFileSync(file);
      assert.throws(() => change(file), /Journal entry for migration 0002 .* not found/);
      assert.deepEqual(fs.readFileSync(file), before);
    });
  });
});
