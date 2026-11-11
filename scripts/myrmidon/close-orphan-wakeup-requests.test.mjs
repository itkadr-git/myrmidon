import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { run, selectSql, targetStatus, updateSql } from "./close-orphan-wakeup-requests.mjs";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const rows = [
  { id: id(1), status: "claimed", idempotency_key: null },
  { id: id(2), status: "queued", idempotency_key: "issue-review-admission:x:y" },
  { id: id(3), status: "queued", idempotency_key: "other:1" },
];
const fakePort = (log) => ({
  query(sql) {
    log.push(sql);
    if (sql.includes("json_agg(t)")) return rows;
    return sql.includes("'failed'") ? [{ id: id(1) }] : [{ id: id(2) }];
  },
});

describe("close-orphan-wakeup-requests", () => {
  it("maps claimed to failed, queued admission seeds to coalesced, leaves other queued", () => {
    assert.equal(targetStatus(rows[0]), "failed");
    assert.equal(targetStatus(rows[1]), "coalesced");
    assert.equal(targetStatus(rows[2]), null);
  });
  it("select skips young rows, native status intents and rows with a live run", () => {
    const sql = selectSql(60);
    assert.match(sql, /interval '60 minutes'/);
    assert.match(sql, /native-status-committer/);
    assert.match(sql, /native-status-wake-dispatch/);
    assert.match(sql, /'queued', 'running', 'scheduled_retry'/);
    assert.throws(() => selectSql("1; drop table x"));
  });
  it("update is guarded by the status read and by absence of a live run", () => {
    const sql = updateSql([id(1)], "failed");
    assert.match(sql, /status = 'claimed'/);
    assert.match(sql, /not exists/);
    assert.throws(() => updateSql(["x'; --"], "failed"));
  });
  it("dry-run writes nothing", () => {
    const log = [];
    const out = run({ port: fakePort(log), apply: false, log() {} });
    assert.equal(out.applied, 0);
    assert.equal(log.length, 1);
  });
  it("apply updates each group and counts the rows", () => {
    const log = [];
    const out = run({ port: fakePort(log), apply: true, log() {} });
    assert.equal(out.applied, 2);
    assert.equal(log.filter((s) => s.startsWith("with u")).length, 2);
  });
});
