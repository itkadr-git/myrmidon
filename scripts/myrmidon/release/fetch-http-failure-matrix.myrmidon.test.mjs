import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "./fetch-release-verdict.mjs";

const issue = "issue-with spaces";
const verdict = {
  issueId: issue,
  verdict: "confirmed",
  checkedAt: "2026-11-16T00:00:00.000Z",
  deployedVersion: "candidate-sha",
  signature: "synthetic-signature",
};
const env = { PAPERCLIP_API_URL: "http://board.invalid", PAPERCLIP_API_KEY: "synthetic-key", PAPERCLIP_COMPANY_ID: "company" };
const bodyPrefix = "body-start-" + "x".repeat(289);
const uniqueTail = "TAIL-MUST-NOT-APPEAR";
const cases = [
  { name: "fetch rejects", response: () => Promise.reject(new Error("synthetic network failure")), diagnostic: /unreachable: synthetic network failure/ },
  { name: "HTTP 403 with long body", response: () => Promise.resolve(new Response(bodyPrefix + uniqueTail, { status: 403 })), diagnostic: /HTTP 403/ },
  { name: "HTTP 500 with unreadable body", response: () => Promise.resolve({ ok: false, status: 500, text: () => Promise.reject(new Error("body read failed")) }), diagnostic: /HTTP 500/ },
  { name: "HTTP 200 with invalid JSON", response: () => Promise.resolve(new Response("not-json", { status: 200 })), diagnostic: /JSON|Unexpected token/i },
];

for (const scenario of cases) {
  test(`default HTTP wrapper: ${scenario.name} fails closed and recovers`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fetch-http-matrix-"));
    const out = path.join(dir, "verdict.json");
    const original = Buffer.from([0, 255, 10, 65, 0, 13]);
    const previousFetch = globalThis.fetch;
    const calls = [];
    const logs = [];
    const args = { version: "1.8.0", issue, out };
    try {
      fs.writeFileSync(out, original);
      globalThis.fetch = async (...call) => { calls.push(call); return scenario.response(); };
      assert.equal(await run(args, { env, log: (message) => logs.push(message) }), 1);
      assert.equal(calls.length, 1);
      assert.deepEqual(fs.readFileSync(out), original);
      assert.match(logs.join("\n"), scenario.diagnostic);
      assert.match(logs.join("\n"), /FETCH-VERDICT REFUSED/);
      if (scenario.name === "HTTP 403 with long body") {
        assert.ok(logs.join("\n").includes(bodyPrefix));
        assert.ok(!logs.join("\n").includes(uniqueTail));
      }
      assert.equal(calls[0][0], `http://board.invalid/api/issues/${encodeURIComponent(issue)}/release-verify`);
      assert.equal(calls[0][1].method, "POST");
      assert.equal(calls[0][1].headers.Authorization, "Bearer synthetic-key");
      calls.length = 0;
      globalThis.fetch = async (...call) => {
        calls.push(call);
        return new Response(JSON.stringify(verdict), { status: 200, headers: { "Content-Type": "application/json" } });
      };
      assert.equal(await run(args, { env, log: (message) => logs.push(message) }), 0);
      assert.equal(calls.length, 1);
      assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")), verdict);
    } finally {
      globalThis.fetch = previousFetch;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
