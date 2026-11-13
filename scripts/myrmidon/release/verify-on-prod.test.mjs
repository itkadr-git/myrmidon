import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildReport,
  formatReport,
  releaseTaskResults,
  fetchReleaseTasks,
  verifyOnProduction,
  EXIT_OK,
  EXIT_FAILED,
  EXIT_USAGE,
} from "./verify-on-prod.mjs";

function createFakeFetch({
  issues = [],
  health = { status: "ok", version: "1.8.0" },
  labels = [{ id: "l1", name: "1.8" }],
}) {
  const calls = [];
  async function fakeFetch(url, init = {}) {
    calls.push({ url: String(url), init });
    const parsed = new URL(url);
    if (parsed.pathname === "/api/health") {
      return {
        ok: true,
        status: 200,
        json: async () => health,
      };
    }
    if (parsed.pathname.endsWith("/labels")) {
      return {
        ok: true,
        status: 200,
        json: async () => labels,
      };
    }
    if (parsed.pathname.endsWith("/issues")) {
      const limit = Number.parseInt(parsed.searchParams.get("limit") || "100", 10);
      const offset = Number.parseInt(parsed.searchParams.get("offset") || "0", 10);
      const page = issues.slice(offset, offset + limit);
      return {
        ok: true,
        status: 200,
        json: async () => page,
      };
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({ error: "not found" }),
    };
  }
  return { fakeFetch, calls };
}

test("release tasks map to per-task verification results", () => {
  const results = releaseTaskResults([
    { identifier: "OPE-1", title: "Ship it", status: "done" },
    { identifier: "OPE-2", title: "Deploy it", status: "in_progress" },
  ]);
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], { identifier: "OPE-1", title: "Ship it", status: "done", verified: true });
  assert.equal(results[1].verified, false);
});

test("release gate refuses while any release task is unverified", () => {
  const report = buildReport({
    version: "1.8.0",
    label: "1.8",
    health: { status: "ok", version: "1.8.0" },
    tasks: [{ identifier: "OPE-1", title: "Ship it", status: "done" }, { identifier: "OPE-2", title: "Deploy it", status: "blocked" }],
  });
  assert.equal(report.verified, false);
  const tasksCheck = report.checks.find((check) => check.name === "release-tasks");
  assert.equal(tasksCheck.verified, false);
});

test("success path requires ok health at the exact version and every task done", () => {
  const report = buildReport({
    version: "1.8.0",
    label: "1.8",
    health: { status: "ok", version: "1.8.0" },
    tasks: [{ identifier: "OPE-1", title: "Ship it", status: "done" }],
  });
  assert.equal(report.verified, true);
});

test("health version mismatch fails even when all tasks are done", () => {
  const report = buildReport({
    version: "1.8.0",
    label: "1.8",
    health: { status: "ok", version: "1.7.0" },
    tasks: [{ identifier: "OPE-1", title: "Ship it", status: "done" }],
  });
  assert.equal(report.verified, false);
  const versionCheck = report.checks.find((check) => check.name === "production-version");
  assert.equal(versionCheck.verified, false);
});

test("empty release task list fails the gate rather than passing vacuously", () => {
  const report = buildReport({ version: "1.8.0", label: "1.8", health: { status: "ok", version: "1.8.0" }, tasks: [] });
  assert.equal(report.verified, false);
});

test("report names the version and per-item outcomes", () => {
  const report = buildReport({
    version: "1.8.0",
    label: "1.8",
    health: { status: "ok", version: "1.8.0" },
    tasks: [{ identifier: "OPE-1", title: "Ship it", status: "done" }],
  });
  const text = formatReport(report);
  assert.match(text, /VERIFY-ON-PROD 1\.8\.0/);
  assert.match(text, /PASS OPE-1 — Ship it \[done\]/);
});

test("exit codes distinguish usage errors from gate failures", () => {
  assert.equal(EXIT_OK, 0);
  assert.equal(EXIT_FAILED, 1);
  assert.equal(EXIT_USAGE, 2);
});

test("fetchReleaseTasks paginates across multiple pages until the last partial page", async () => {
  const issues = Array.from({ length: 250 }, (_, i) => ({
    id: `issue-${i + 1}`,
    identifier: `OPE-${i + 1}`,
    title: `Task ${i + 1}`,
    status: "done",
  }));
  const { fakeFetch, calls } = createFakeFetch({ issues });
  const tasks = await fetchReleaseTasks({
    apiUrl: "http://board.test",
    apiKey: "key",
    companyId: "c1",
    labelId: "l1",
    pageSize: 100,
    fetchImpl: fakeFetch,
  });
  assert.equal(tasks.length, 250);
  const issueCalls = calls.filter((c) => c.url.includes("/issues?"));
  assert.equal(issueCalls.length, 3);
  assert.ok(issueCalls[0].url.includes("offset=0"));
  assert.ok(issueCalls[1].url.includes("offset=100"));
  assert.ok(issueCalls[2].url.includes("offset=200"));
});

test("verifyOnProduction with >100 tasks proves later unfinished tasks prevent success", async () => {
  const issues = Array.from({ length: 105 }, (_, i) => ({
    id: `id-${i + 1}`,
    identifier: `OPE-${i + 1}`,
    title: `Task ${i + 1}`,
    status: i === 104 ? "in_progress" : "done",
  }));
  const { fakeFetch, calls } = createFakeFetch({ issues });
  const report = await verifyOnProduction({
    version: "1.8.0",
    label: "1.8",
    healthUrl: "http://prod.test/api/health",
    apiUrl: "http://board.test",
    apiKey: "key",
    companyId: "c1",
    fetchImpl: fakeFetch,
  });

  assert.equal(report.tasks.length, 105);
  assert.equal(report.verified, false);
  const releaseTasksCheck = report.checks.find((c) => c.name === "release-tasks");
  assert.ok(releaseTasksCheck);
  assert.equal(releaseTasksCheck.verified, false);
  const task105 = report.tasks.find((t) => t.identifier === "OPE-105");
  assert.ok(task105);
  assert.equal(task105.verified, false);
  assert.equal(task105.status, "in_progress");

  const issueUrls = calls.filter((c) => c.url.includes("/issues?")).map((c) => c.url);
  assert.equal(issueUrls.length, 2);
  assert.ok(issueUrls[0].includes("offset=0"));
  assert.ok(issueUrls[1].includes("offset=100"));
});

test("verifyOnProduction with >100 tasks succeeds when every task across all pages is done", async () => {
  const issues = Array.from({ length: 105 }, (_, i) => ({
    id: `id-${i + 1}`,
    identifier: `OPE-${i + 1}`,
    title: `Task ${i + 1}`,
    status: "done",
  }));
  const { fakeFetch, calls } = createFakeFetch({ issues });
  const report = await verifyOnProduction({
    version: "1.8.0",
    label: "1.8",
    healthUrl: "http://prod.test/api/health",
    apiUrl: "http://board.test",
    apiKey: "key",
    companyId: "c1",
    fetchImpl: fakeFetch,
  });

  assert.equal(report.tasks.length, 105);
  assert.equal(report.verified, true);
  const releaseTasksCheck = report.checks.find((c) => c.name === "release-tasks");
  assert.ok(releaseTasksCheck);
  assert.equal(releaseTasksCheck.verified, true);
  assert.ok(report.tasks.every((t) => t.verified));
});
