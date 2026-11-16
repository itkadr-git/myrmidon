import assert from "node:assert/strict";
import { test } from "node:test";
import { ProbeError, runProbe } from "./review-check-run-probe.mjs";

const repo = "example/project";
const failures = [
  { status: 401, kind: "unauthorized" },
  { status: 403, kind: "forbidden" },
  { status: 404, kind: "not-found" },
  { status: 500, kind: "http" },
  { status: null, kind: "network" },
];
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

for (const failure of failures) {
  test(`ref ${failure.status ?? "network error"} stops before POST and a later probe is independent`, async () => {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      const method = init.method ?? "GET";
      calls.push({ url, method, authorization: init.headers.Authorization, body: init.body });
      if (url.endsWith("/commits/bad")) {
        if (failure.status === null) throw new Error("connection synthetic-fail-token then synthetic-fail-token");
        return response(failure.status, { message: "synthetic-fail-token" });
      }
      if (url.endsWith("/commits/before")) return response(200, { sha: "head-before" });
      if (url.endsWith("/commits/after")) return response(200, { sha: "head-after" });
      if (url.endsWith("/check-runs") && method === "POST") {
        const body = JSON.parse(init.body);
        return response(201, { id: body.head_sha === "head-before" ? 101 : 202 });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    };
    const beforeEnv = { GH_TOKEN: "synthetic-before-token", marker: "unchanged" };
    const failEnv = { GH_TOKEN: "synthetic-fail-token", marker: "unchanged" };
    const afterEnv = { GITHUB_TOKEN: "synthetic-after-token", marker: "unchanged" };
    const snapshots = [beforeEnv, failEnv, afterEnv].map((env) => ({ ...env }));

    const before = await runProbe({ repo, ref: "before", fetchImpl, env: beforeEnv });
    assert.deepEqual(before, { ok: true, checkRunId: 101, headSha: "head-before", checkName: "Board review probe" });
    assert.deepEqual(calls.map((call) => call.method), ["GET", "POST"]);
    assert.equal(JSON.parse(calls[1].body).head_sha, "head-before");
    assert.ok(calls.every((call) => call.authorization === "Bearer synthetic-before-token"));

    calls.length = 0;
    await assert.rejects(runProbe({ repo, ref: "bad", fetchImpl, env: failEnv }), (err) => {
      assert.ok(err instanceof ProbeError);
      assert.equal(err.kind, failure.kind);
      assert.ok(!err.message.includes("synthetic-fail-token"));
      if (failure.status === null) assert.equal(err.message, "GitHub недоступен: connection <redacted> then <redacted>");
      if (failure.status === 500) assert.match(err.message, /HTTP 500/);
      return true;
    });
    assert.deepEqual(calls.map((call) => call.method), ["GET"]);
    assert.equal(calls[0].authorization, "Bearer synthetic-fail-token");

    calls.length = 0;
    const after = await runProbe({ repo, ref: "after", fetchImpl, env: afterEnv });
    assert.deepEqual(after, { ok: true, checkRunId: 202, headSha: "head-after", checkName: "Board review probe" });
    assert.deepEqual(calls.map((call) => call.method), ["GET", "POST"]);
    assert.equal(JSON.parse(calls[1].body).head_sha, "head-after");
    assert.ok(calls.every((call) => call.authorization === "Bearer synthetic-after-token"));
    assert.deepEqual([beforeEnv, failEnv, afterEnv], snapshots);
  });
}
