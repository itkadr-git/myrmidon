import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { updateSnapshots } from "./db-renumber-migration.mjs";

function makeFixture(snapshots) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "db-renumber-snapshots-test-"));
  const metaDir = path.join(root, "meta");
  fs.mkdirSync(metaDir, { recursive: true });
  const ordered = [...snapshots].sort(([a], [b]) => a.localeCompare(b));
  for (const [index, [, payload]] of ordered.entries()) {
    payload.prevId = index ? ordered[index - 1][1].id : "00000000-0000-0000-0000-000000000000";
  }
  for (const [num, payload] of snapshots) {
    fs.writeFileSync(path.join(metaDir, `${num}_snapshot.json`), `${JSON.stringify(payload, null, 2)}\n`);
  }
  return { root, metaDir };
}

function snapshot(metaDir, num) {
  return JSON.parse(fs.readFileSync(path.join(metaDir, `${num}_snapshot.json`), "utf8"));
}

function removeFixture(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

describe("db-renumber-snapshots", () => {
  it("selects the nearest smaller snapshot regardless of directory order", () => {
    const fixture = makeFixture([
      ["0004", { id: "00000000-0000-4000-8000-000000000003" }],
      ["0001", { id: "00000000-0000-4000-8000-000000000001" }],
      ["0003", { id: "00000000-0000-4000-8000-000000000002" }],
    ]);
    try {
      const result = updateSnapshots(fixture.metaDir, "0006", "0005");
      assert.equal(result.precedingSnapshotFile, "0004_snapshot.json");
      assert.equal(result.prevId, "00000000-0000-4000-8000-000000000003");
    } finally {
      removeFixture(fixture.root);
    }
  });

  it("skips the old snapshot number when finding the predecessor", () => {
    const fixture = makeFixture([
      ["0003", { id: "00000000-0000-4000-8000-000000000004", payload: "old" }],
      ["0002", { id: "00000000-0000-4000-8000-000000000005" }],
    ]);
    try {
      const result = updateSnapshots(fixture.metaDir, "0003", "0004");
      assert.equal(result.precedingSnapshotFile, "0002_snapshot.json");
      assert.equal(result.prevId, "00000000-0000-4000-8000-000000000005");
    } finally {
      removeFixture(fixture.root);
    }
  });

  it("moves an existing snapshot while preserving its payload", () => {
    const payload = { id: "00000000-0000-4000-8000-000000000004", prevId: "00000000-0000-4000-8000-00000000000b", tables: { tasks: 3 }, custom: ["value"] };
    const fixture = makeFixture([
      ["0003", payload],
      ["0002", { id: "00000000-0000-4000-8000-000000000005" }],
    ]);
    try {
      updateSnapshots(fixture.metaDir, "0003", "0004");
      assert.deepEqual(snapshot(fixture.metaDir, "0004"), {
        ...payload,
        prevId: "00000000-0000-4000-8000-000000000005",
      });
    } finally {
      removeFixture(fixture.root);
    }
  });

  it("deletes only the old snapshot file after moving it", () => {
    const fixture = makeFixture([
      ["0003", { id: "00000000-0000-4000-8000-000000000004" }],
      ["0002", { id: "00000000-0000-4000-8000-000000000005" }],
      ["0009", { id: "00000000-0000-4000-8000-000000000007" }],
    ]);
    try {
      updateSnapshots(fixture.metaDir, "0003", "0004");
      assert.equal(fs.existsSync(path.join(fixture.metaDir, "0003_snapshot.json")), false);
      assert.equal(fs.existsSync(path.join(fixture.metaDir, "0002_snapshot.json")), true);
      assert.equal(fs.existsSync(path.join(fixture.metaDir, "0009_snapshot.json")), true);
    } finally {
      removeFixture(fixture.root);
    }
  });

  it("derives a data-only snapshot from its predecessor payload", () => {
    const fixture = makeFixture([
      ["0002", { id: "00000000-0000-4000-8000-000000000005", prevId: "00000000-0000-4000-8000-000000000006", tables: { tasks: 3 } }],
    ]);
    try {
      const result = updateSnapshots(fixture.metaDir, "0003", "0004");
      assert.deepEqual(snapshot(fixture.metaDir, "0004"), {
        id: result.id,
        prevId: "00000000-0000-4000-8000-000000000005",
        tables: { tasks: 3 },
      });
    } finally {
      removeFixture(fixture.root);
    }
  });

  it("gives a data-only snapshot a new id", () => {
    const fixture = makeFixture([["0002", { id: "00000000-0000-4000-8000-000000000005", tables: {} }]]);
    try {
      const result = updateSnapshots(fixture.metaDir, "0003", "0004");
      assert.notEqual(result.id, "00000000-0000-4000-8000-000000000005");
      assert.notEqual(result.id, result.prevId);
      assert.match(result.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally {
      removeFixture(fixture.root);
    }
  });

  it("returns paths and ids that match the created snapshot file", () => {
    const fixture = makeFixture([
      ["0002", { id: "00000000-0000-4000-8000-000000000005" }],
      ["0003", { id: "00000000-0000-4000-8000-000000000004" }],
    ]);
    try {
      const result = updateSnapshots(fixture.metaDir, "0003", "0004");
      assert.equal(result.snapshotPath, path.join(fixture.metaDir, "0004_snapshot.json"));
      assert.equal(result.precedingSnapshotFile, "0002_snapshot.json");
      const created = JSON.parse(fs.readFileSync(result.snapshotPath, "utf8"));
      assert.equal(result.id, created.id);
      assert.equal(result.prevId, created.prevId);
    } finally {
      removeFixture(fixture.root);
    }
  });

  it("uses the closest predecessor across gaps", () => {
    const fixture = makeFixture([
      ["0001", { id: "00000000-0000-4000-8000-000000000001" }],
      ["0007", { id: "00000000-0000-4000-8000-000000000008" }],
      ["0012", { id: "00000000-0000-4000-8000-000000000009" }],
    ]);
    try {
      const result = updateSnapshots(fixture.metaDir, "0008", "0015");
      assert.equal(result.precedingSnapshotFile, "0012_snapshot.json");
      assert.equal(result.prevId, "00000000-0000-4000-8000-000000000009");
    } finally {
      removeFixture(fixture.root);
    }
  });

  it("preserves an existing snapshot when there is no predecessor", () => {
    const payload = { id: "00000000-0000-4000-8000-00000000000a", prevId: "00000000-0000-4000-8000-000000000006", tables: { tasks: 1 } };
    const fixture = makeFixture([["0001", payload]]);
    try {
      updateSnapshots(fixture.metaDir, "0001", "0002");
      assert.deepEqual(snapshot(fixture.metaDir, "0002"), payload);
    } finally {
      removeFixture(fixture.root);
    }
  });

  it("fails clearly without a source snapshot or predecessor", () => {
    const fixture = makeFixture([["0007", { id: "00000000-0000-4000-8000-000000000007" }]]);
    try {
      assert.throws(
        () => updateSnapshots(fixture.metaDir, "0003", "0004"),
        /old snapshot .*0003_snapshot\.json does not exist and no preceding snapshot found/
      );
      assert.equal(fs.existsSync(path.join(fixture.metaDir, "0004_snapshot.json")), false);
    } finally {
      removeFixture(fixture.root);
    }
  });
});
