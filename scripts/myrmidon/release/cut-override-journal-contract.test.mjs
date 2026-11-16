import test from "node:test";
import assert from "node:assert/strict";
import { buildOverrideComment, postOverrideComment } from "./cut-rc.mjs";

test("resolves encoded journal before posting the exact JSON payload to its UUID", async () => {
  const api = { marker: "injected" };
  const payload = 'reason "quoted"\nsecond line';
  const calls = [];
  const receipt = { id: "comment-1" };
  const fetchBoard = async (...args) => {
    calls.push(args);
    if (calls.length === 1) return { id: "01234567-89ab-cdef-0123-456789abcdef" };
    if (calls.length === 2) return receipt;
    assert.fail("unexpected board call");
  };
  assert.equal(await postOverrideComment(api, "OPE/42 ?#", payload, fetchBoard), receipt);
  assert.deepEqual(calls, [
    [api, "/api/issues/OPE%2F42%20%3F%23"],
    [api, "/api/issues/01234567-89ab-cdef-0123-456789abcdef/comments", {
      method: "POST",
      body: '{"body":"reason \\"quoted\\"\\nsecond line"}',
    }],
  ]);
});

test("resolve failure propagates without posting", async () => {
  const failure = new Error("resolve failed");
  const calls = [];
  const api = {};
  await assert.rejects(postOverrideComment(api, "OPE-7", "body", async (...args) => {
    calls.push(args);
    throw failure;
  }), (error) => error === failure);
  assert.deepEqual(calls, [[api, "/api/issues/OPE-7"]]);
});

test("post failure propagates after resolving the journal", async () => {
  const failure = new Error("post failed");
  const calls = [];
  const api = {};
  await assert.rejects(postOverrideComment(api, "OPE-8", "body", async (...args) => {
    calls.push(args);
    if (calls.length === 1) return { id: "journal-id" };
    throw failure;
  }), (error) => error === failure);
  assert.deepEqual(calls, [
    [api, "/api/issues/OPE-8"],
    [api, "/api/issues/journal-id/comments", { method: "POST", body: '{"body":"body"}' }],
  ]);
});

test("override comment preserves release metadata, reason, violation order and exact open issues", () => {
  const result = buildOverrideComment({
    tagName: "myr-v1.7.0-rc.25", version: "1.7.0", rc: "25",
    reason: 'approved "exception"\nwith detail',
    violations: ["second gate", "first gate"],
    openIssues: [
      { identifier: "OPE-22", title: "First issue", status: "in_progress" },
      { identifier: "OPE-11", title: 'Quoted "title"', status: "todo" },
    ],
  });
  assert.equal(result, [
    "**RELEASE-CUT OVERRIDE — myr-v1.7.0-rc.25**",
    "",
    "Кандидат myr-v1.7.0-rc.25 (версия 1.7.0, rc.25) поставлен с обходом ворот cut-rc.mjs.",
    "",
    'Обоснование: approved "exception"\nwith detail',
    "",
    "Нарушения, через которые прошёл обход:",
    "- second gate",
    "- first gate",
    "",
    "Открытые задачи выпуска на момент обхода:",
    '- OPE-22 "First issue" [in_progress]',
    '- OPE-11 "Quoted "title"" [todo]',
  ].join("\n"));
});

test("empty violation and open issue lists each render none", () => {
  assert.equal(buildOverrideComment({
    tagName: "myr-v1.7.0-rc.1", version: "1.7.0", rc: "1", reason: "reason",
    violations: [], openIssues: [],
  }), [
    "**RELEASE-CUT OVERRIDE — myr-v1.7.0-rc.1**",
    "",
    "Кандидат myr-v1.7.0-rc.1 (версия 1.7.0, rc.1) поставлен с обходом ворот cut-rc.mjs.",
    "",
    "Обоснование: reason",
    "",
    "Нарушения, через которые прошёл обход:",
    "- (none)",
    "",
    "Открытые задачи выпуска на момент обхода:",
    "- (none)",
  ].join("\n"));
});
