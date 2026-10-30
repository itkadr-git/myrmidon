import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BATCH_SIZE, chunk, planIssue, reasonlessPredicate, run, selectSql, updateSql } from "./unblock-reasonless.mjs";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const row = (n, extra = {}) => ({ id: id(n), identifier: `OPE-${n}`, company_id: id(999), assignee_agent_id: id(1), assignee_user_id: null, ...extra });

describe("unblock-reasonless", () => {
  it("selection requires no open blocker, no blockReason and no complete descriptor", () => {
    const sql = selectSql(null);
    assert.match(sql, /b\.status not in \('done','cancelled'\)/);
    assert.match(sql, /blockReason/);
    assert.match(sql, /unblock_descriptor/);
    assert.match(sql, /conversation_agent_id is null/);
  });
  it("a task without an assignee is skipped", () => {
    assert.ok(planIssue(row(1, { assignee_agent_id: null })).skipped);
    assert.ok(!planIssue(row(2)).skipped);
  });
  it("batches of 10", () => {
    const sizes = chunk(Array.from({ length: 23 }, (_, n) => n)).map((b) => b.length);
    assert.deepEqual(sizes, [10, 10, 3]);
    assert.throws(() => updateSql(Array.from({ length: BATCH_SIZE + 1 }, (_, n) => planIssue(row(n + 1)))), /batch size/);
  });
  it("the update re-checks the predicate and does not touch wakeups", () => {
    const sql = updateSql([planIssue(row(1))]);
    assert.ok(sql.includes(reasonlessPredicate("i")));
    assert.match(sql, /status = 'todo'/);
    assert.ok(!/wakeup/i.test(sql));
  });
  it("rejects a malformed --only identifier", async () => {
    await assert.rejects(run({ port: {}, only: ["x'"] }), /bad identifier/);
  });
  it("dry-run writes nothing; apply snapshots first and updates in batches", async () => {
    const rows = Array.from({ length: 12 }, (_, n) => row(n + 1));
    const queries = [];
    const port = { query(sql) { queries.push(sql); return sql.includes("update issues") ? rows.slice(0, sql.split("','").length) : rows; } };
    const logs = [];
    const res0 = await run({ port, apply: false, log: (m) => logs.push(m) });
    assert.equal(res0.applied, 0);
    assert.ok(!queries.some((q) => q.includes("update issues")));
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "unblock-")), "snap.json");
    queries.length = 0;
    const portApply = { query(sql) { queries.push(sql); if (!sql.includes("update issues")) return rows; return (sql.match(/'0000/g) ?? []).map((_, n) => ({ id: n })).slice(0, sql.includes(id(11)) ? 2 : 10); } };
    await run({ port: portApply, apply: true, snapshotPath: file, log: (m) => logs.push(m) });
    assert.equal(queries.filter((q) => q.includes("update issues")).length, 2);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).length, 12);
  });
});
