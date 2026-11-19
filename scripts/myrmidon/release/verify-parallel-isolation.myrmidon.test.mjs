import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyOnProduction } from "./verify-on-prod.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function harness(name, { failIssues = false, unfinished = false } = {}) {
  const gates = Object.fromEntries(["health", "labels", "0", "2"].map((key) => [key, { arrived: deferred(), release: deferred() }]));
  const calls = [];
  const companyId = `company-${name}`;
  const label = `release-${name}`;
  const version = name === "A" ? "1.2.3" : "4.5.6";
  const apiKey = `board-key-${name}`;
  const token = `health-key-${name}`;
  const pages = {
    0: [{ id: "shared-id", identifier: `${name}-1`, title: `${name} one`, status: "done" }, { id: `${name}-2`, identifier: `${name}-2`, title: `${name} two`, status: "done" }],
    2: [{ id: `${name}-3`, identifier: `${name}-3`, title: `${name} three`, status: unfinished ? "todo" : "done" }],
  };
  async function fetchImpl(url, init) {
    const parsed = new URL(url);
    const key = parsed.pathname === "/health" ? "health" : parsed.pathname.endsWith("/labels") ? "labels" : parsed.searchParams.get("offset");
    assert.ok(gates[key], `unexpected request ${url}`);
    calls.push({ url: String(url), headers: init.headers });
    gates[key].arrived.resolve();
    await gates[key].release.promise;
    if (key === "0" && failIssues) throw new Error(`issues failed ${name}`);
    const data = key === "health" ? { status: "ok", version } : key === "labels" ? [{ id: `label-${name}`, name: label }] : pages[key];
    return { ok: true, status: 200, json: async () => data };
  }
  return {
    gates, calls, pages, companyId, label, version, apiKey, token,
    start: () => verifyOnProduction({ version, label, companyId, apiKey, token, pageSize: 2, healthUrl: `https://${name.toLowerCase()}.test/health`, apiUrl: `https://${name.toLowerCase()}.test`, fetchImpl }),
    releaseAll: () => Object.values(gates).forEach((gate) => gate.release.resolve()),
  };
}

async function release(h, key) {
  await h.gates[key].arrived.promise;
  h.gates[key].release.resolve();
}

function assertCalls(h, issueOffsets) {
  const base = `https://${h.companyId.endsWith("A") ? "a" : "b"}.test`;
  assert.deepEqual(h.calls.map((call) => call.url), [
    `${base}/health`,
    `${base}/api/companies/${h.companyId}/labels`,
    ...issueOffsets.map((offset) => `${base}/api/companies/${h.companyId}/issues?labelId=label-${h.companyId.endsWith("A") ? "A" : "B"}&limit=2&offset=${offset}&view=compact`),
  ]);
  assert.deepEqual(h.calls.map((call) => call.headers), [
    { Authorization: `Bearer ${h.token}` },
    ...Array.from({ length: issueOffsets.length + 1 }, () => ({ Authorization: `Bearer ${h.apiKey}`, Accept: "application/json" })),
  ]);
}

function assertReport(h, report, verified) {
  assert.equal(report.version, h.version);
  assert.equal(report.label, h.label);
  assert.equal(report.verified, verified);
  assert.deepEqual(report.tasks, [...h.pages[0], ...h.pages[2]].map(({ identifier, title, status }) => ({ identifier, title, status, verified: status === "done" })));
  assert.deepEqual(report.checks, [
    { name: "production-version", verified: true, details: { expected: h.version, actual: h.version, status: "ok" } },
    { name: "release-tasks", verified, details: { label: h.label, count: 3 } },
  ]);
}

test("concurrent companies isolate interleaved pages and reports", async () => {
  const a = harness("A");
  const b = harness("B", { unfinished: true });
  const result = Promise.all([a.start(), b.start()]);
  const stopped = result.then(() => { throw new Error("verification ended before all barriers"); });
  stopped.catch(() => {});
  const step = (h, key) => Promise.race([release(h, key), stopped]);
  try {
    await step(a, "health");
    await step(b, "health");
    await step(b, "labels");
    await step(a, "labels");
    await step(a, "0");
    await step(b, "0");
    await step(b, "2");
    await step(a, "2");
    const [ar, br] = await result;
    assertReport(a, ar, true);
    assertReport(b, br, false);
    assertCalls(a, [0, 2]);
    assertCalls(b, [0, 2]);
  } finally {
    a.releaseAll();
    b.releaseAll();
    await Promise.allSettled([result]);
  }
});

test("a rejected issues request does not affect another concurrent verification", async () => {
  const a = harness("A", { failIssues: true });
  const b = harness("B");
  const aResult = a.start();
  const bResult = b.start();
  const result = Promise.allSettled([aResult, bResult]);
  const stopped = bResult.then(() => { throw new Error("verification B ended before all barriers"); });
  stopped.catch(() => {});
  const step = (h, key) => Promise.race([release(h, key), stopped]);
  try {
    await step(a, "health");
    await step(b, "health");
    await step(b, "labels");
    await step(a, "labels");
    await step(a, "0");
    await step(b, "0");
    await step(b, "2");
    const [ar, br] = await result;
    assert.equal(ar.status, "rejected");
    assert.match(ar.reason.message, /issues failed A/);
    assert.equal(br.status, "fulfilled");
    assertReport(b, br.value, true);
    assertCalls(a, [0]);
    assertCalls(b, [0, 2]);
  } finally {
    a.releaseAll();
    b.releaseAll();
    await result;
  }
});
