import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyOnProduction } from "./verify-on-prod.mjs";

function fixture() {
  const state = {
    health: { status: "ok", version: "1.7.0" },
    issues: Array.from({ length: 101 }, (_, i) => ({
      id: `id-${i + 1}`,
      identifier: `OPE-${i + 1}`,
      title: `Task ${i + 1}`,
      status: "done",
    })),
    failOffset: null,
  };
  const calls = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    calls.push(`${parsed.pathname}${parsed.search}`);
    let body;
    if (parsed.pathname === "/api/health") body = state.health;
    else if (parsed.pathname === "/api/companies/c1/labels") body = [{ id: "l1", name: "1.7" }];
    else if (parsed.pathname === "/api/companies/c1/issues") {
      const offset = Number(parsed.searchParams.get("offset"));
      if (offset === state.failOffset) return { ok: false, status: 503 };
      const limit = Number(parsed.searchParams.get("limit"));
      body = state.issues.slice(offset, offset + limit);
    } else throw new Error(`unexpected request ${url}`);
    return { ok: true, status: 200, json: async () => structuredClone(body) };
  };
  const options = { version: "1.7.0", label: "1.7", healthUrl: "http://prod.test/api/health", apiUrl: "http://board.test", companyId: "c1", fetchImpl };
  return { state, calls, options };
}

function assertRequests(calls, offsets) {
  assert.equal(calls.length, 2 + offsets.length);
  assert.equal(calls[0], "/api/health");
  assert.equal(calls[1], "/api/companies/c1/labels");
  for (const [index, offset] of offsets.entries()) {
    const url = new URL(calls[index + 2], "http://board.test");
    assert.equal(url.pathname, "/api/companies/c1/issues");
    assert.equal(url.searchParams.get("labelId"), "l1");
    assert.equal(url.searchParams.get("offset"), String(offset));
  }
}

function checks(report) {
  return Object.fromEntries(report.checks.map(({ name, verified }) => [name, verified]));
}

test("successive verification reads current pages and health without changing previous reports", async () => {
  const { state, calls, options } = fixture();
  const first = await verifyOnProduction(options);
  const firstBytes = JSON.stringify(first);
  assert.equal(first.verified, true);
  assert.deepEqual(checks(first), { "production-version": true, "release-tasks": true });
  assert.equal(first.tasks.length, 101);
  assert.ok(first.tasks.every((task) => task.verified));
  assertRequests(calls.splice(0), [0, 100]);

  state.issues.push({ id: "new", identifier: "OPE-NEW", title: "New task", status: "todo" });
  const second = await verifyOnProduction(options);
  const secondBytes = JSON.stringify(second);
  assert.equal(second.verified, false);
  assert.deepEqual(checks(second), { "production-version": true, "release-tasks": false });
  assert.equal(second.tasks.length, 102);
  assert.deepEqual(second.tasks.filter((task) => !task.verified), [{ identifier: "OPE-NEW", title: "New task", status: "todo", verified: false }]);
  assertRequests(calls.splice(0), [0, 100]);
  assert.equal(JSON.stringify(first), firstBytes);

  state.issues[101].status = "done";
  state.health.version = "1.7.1";
  const third = await verifyOnProduction(options);
  assert.equal(third.verified, false);
  assert.deepEqual(checks(third), { "production-version": false, "release-tasks": true });
  assert.deepEqual(third.checks.find((check) => check.name === "production-version").details, { expected: "1.7.0", actual: "1.7.1", status: "ok" });
  assert.equal(third.tasks.length, 102);
  assert.ok(third.tasks.every((task) => task.verified));
  assertRequests(calls.splice(0), [0, 100]);
  assert.equal(JSON.stringify(first), firstBytes);
  assert.equal(JSON.stringify(second), secondBytes);
});

test("an HTTP failure after a page does not contaminate the next verification", async () => {
  const { state, calls, options } = fixture();
  state.failOffset = 100;
  await assert.rejects(verifyOnProduction(options), /HTTP 503/);
  assertRequests(calls.splice(0), [0, 100]);
  state.failOffset = null;
  const report = await verifyOnProduction(options);
  assert.equal(report.verified, true);
  assert.deepEqual(checks(report), { "production-version": true, "release-tasks": true });
  assert.equal(report.tasks.length, 101);
  assertRequests(calls.splice(0), [0, 100]);
});
