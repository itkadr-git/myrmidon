import assert from "node:assert/strict";
import { test } from "node:test";
import { run } from "./close-orphan-wakeup-requests.mjs";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const claimed = Array.from({ length: 7 }, (_, i) => ({ id: id(i + 1), status: "claimed", idempotency_key: null }));
const admission = Array.from({ length: 5 }, (_, i) => ({ id: id(i + 8), status: "queued", idempotency_key: `issue-review-admission:${i}` }));
const other = Array.from({ length: 3 }, (_, i) => ({ id: id(i + 13), status: "queued", idempotency_key: `other:${i}` }));
const rows = [other[0], claimed[0], admission[0], claimed[1], admission[1], other[1], ...claimed.slice(2), ...admission.slice(2), other[2]];
const expectedPlan = { failed: claimed, coalesced: admission, untouched: other };

function portFor(readRows, results = []) {
  const calls = [];
  return {
    calls,
    query(sql) {
      calls.push(sql);
      if (calls.length === 1) {
        assert.match(sql, /^select /);
        return readRows;
      }
      assert.ok(results.length, "unexpected mutation");
      return results.shift();
    },
  };
}

const options = (port, apply) => ({ port, apply, batch: 3, log() {} });

test("apply preserves the exact plan, batches each target separately, and counts returned rows", () => {
  const port = portFor(rows, [[{ id: id(1) }, { id: id(3) }], [], [{ id: id(7) }], [{ id: id(8) }], []]);
  const result = run(options(port, true));
  assert.deepEqual(result.plan, expectedPlan);
  assert.equal(result.applied, 4);
  assert.equal(port.calls.length, 6);
  const batches = [
    ["failed", [1, 2, 3]], ["failed", [4, 5, 6]], ["failed", [7]],
    ["coalesced", [8, 9, 10]], ["coalesced", [11, 12]],
  ];
  for (const [i, [status, numbers]] of batches.entries()) {
    const sql = port.calls[i + 1];
    assert.match(sql, new RegExp(`set status = '${status}'`));
    const ids = [...sql.matchAll(/'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'/g)].map((m) => m[1]);
    assert.deepEqual(ids, numbers.map(id));
    assert.ok(ids.length <= 3);
    assert.ok(other.every((row) => !ids.includes(row.id)));
  }
});

test("a repeated run with an empty read performs no updates", () => {
  const port = portFor([]);
  assert.deepEqual(run(options(port, true)), { plan: { failed: [], coalesced: [], untouched: [] }, applied: 0 });
  assert.equal(port.calls.length, 1);
});

test("dry-run plans the same mixed rows and only reads", () => {
  const port = portFor(rows);
  assert.deepEqual(run(options(port, false)), { plan: expectedPlan, applied: 0 });
  assert.equal(port.calls.length, 1);
});
