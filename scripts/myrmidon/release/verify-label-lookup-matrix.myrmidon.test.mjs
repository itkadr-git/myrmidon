import assert from "node:assert/strict";
import { test } from "node:test";
import { formatReport, verifyOnProduction } from "./verify-on-prod.mjs";

const healthUrl = "https://health.example.invalid/api/health";
const apiUrl = "https://board.example.invalid";
const labelsUrl = `${apiUrl}/api/companies/fictional-company/labels`;
const exact = { id: "exact id", name: "1.7" };
const alias = { id: "alias id", name: "release:1.7" };
const other = { id: "other id", name: "1.70" };

function fixture(labels) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const parsed = new URL(url);
    let body;
    if (url === healthUrl) body = { status: "ok", version: "1.7.0" };
    else if (url === labelsUrl) body = labels;
    else if (parsed.origin === apiUrl && parsed.pathname === "/api/companies/fictional-company/issues") {
      body = [{ id: "task-id", identifier: "TEST-1", title: "Release task", status: "done" }];
    } else throw new Error(`unexpected request: ${url}`);
    return { ok: true, status: 200, json: async () => body };
  };
  return {
    calls,
    run: () => verifyOnProduction({ version: "1.7.0", label: "1.7", healthUrl, apiUrl, apiKey: "fictional-api-key", token: "fictional-health-key", companyId: "fictional-company", fetchImpl }),
  };
}

for (const [name, labels, selected] of [
  ["exact name", [exact], exact],
  ["release alias only", [alias], alias],
  ["other version before exact", [other, exact], exact],
  ["exact before alias", [exact, alias], exact],
  ["alias before exact", [alias, exact], alias],
]) {
  test(`label lookup: ${name}`, async () => {
    const { calls, run } = fixture(labels);
    const report = await run();
    assert.deepEqual(calls, [healthUrl, labelsUrl, `${apiUrl}/api/companies/fictional-company/issues?labelId=${encodeURIComponent(selected.id)}&limit=100&offset=0&view=compact`]);
    assert.equal(report.verified, true);
    assert.deepEqual(report.checks, [
      { name: "production-version", verified: true, details: { expected: "1.7.0", actual: "1.7.0", status: "ok" } },
      { name: "release-tasks", verified: true, details: { label: "1.7", count: 1 } },
    ]);
    assert.deepEqual(report.tasks, [{ identifier: "TEST-1", title: "Release task", status: "done", verified: true }]);
    assert.match(formatReport(report), /- Result: PASS/);
  });
}

for (const [name, labels] of [["empty list", []], ["null", null], ["object", { id: "exact id", name: "1.7" }]]) {
  test(`label lookup rejects ${name} without issues IO`, async () => {
    const { calls, run } = fixture(labels);
    await assert.rejects(run(), { message: 'release label "1.7" not found' });
    assert.deepEqual(calls, [healthUrl, labelsUrl]);
  });
}
