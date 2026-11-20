import test from "node:test";
import assert from "node:assert/strict";
import { collectBoardViolations } from "./cut-rc.mjs";

const api = { companyId: "company" };

function board(responses, calls) {
  return async (receivedApi, path) => {
    assert.strictEqual(receivedApi, api);
    calls.push(path);
    assert.ok(Object.hasOwn(responses, path), `unexpected board request: ${path}`);
    const response = responses[path];
    if (response instanceof Error) throw response;
    return response;
  };
}

test("aggregates task states and continues after a work-product read fails", async () => {
  const issues = [
    { id: "1", identifier: "OPE-1", title: "To do", status: "todo" },
    { id: "2", identifier: "OPE-2", title: "Working", status: "in_progress" },
    { id: "3", identifier: "OPE-3", title: "Review", status: "in_review" },
    { id: "4", identifier: "OPE-4", title: "Blocked", status: "blocked" },
    { id: "5", identifier: "OPE-5", title: "Backlog", status: "backlog" },
    { id: "6", identifier: "OPE-6", title: "Finished", status: "done" },
    { id: "7", identifier: "OPE-7", title: "Cancelled", status: "cancelled" },
  ];
  const pr = { type: "pull_request", status: "open", title: "Pending change", metadata: { repository: "org/repo", number: 42 } };
  const products = [pr, { type: "document", title: "Notes" }];
  const responses = {
    "/api/issues/1/work-products": [],
    "/api/issues/2/work-products": [],
    "/api/issues/3/work-products": [],
    "/api/issues/4/work-products": [],
    "/api/issues/5/work-products": new Error("read failed"),
    "/api/issues/6/work-products": products,
    "/api/issues/7/work-products": [],
  };
  const calls = [];
  const result = await collectBoardViolations(api, issues, {}, board(responses, calls));

  assert.deepEqual(result.violations, [
    'open task OPE-1 "To do" [todo]',
    'open task OPE-2 "Working" [in_progress]',
    'open task OPE-3 "Review" [in_review]',
    'open task OPE-4 "Blocked" [blocked]',
    'open task OPE-5 "Backlog" [backlog]',
    "task OPE-7 not done [cancelled]",
    "OPE-5: cannot read work products: read failed",
    "OPE-6 (done) has unmerged attached PR: org/repo#42 (Pending change) - PR open",
  ]);
  assert.deepEqual(result.openIssues, issues.slice(0, 5));
  assert.deepEqual(calls, [
    "/api/issues/1/work-products", "/api/issues/2/work-products",
    "/api/issues/3/work-products", "/api/issues/4/work-products",
    "/api/issues/5/work-products", "/api/issues/6/work-products",
    "/api/issues/7/work-products",
  ]);
  assert.equal(Object.hasOwn(issues[4], "workProducts"), false);
  assert.strictEqual(issues[5].workProducts, products);
  assert.deepEqual(issues[6].workProducts, []);
});

test("accepts done issues with merged or no work products", async () => {
  const issues = [
    { id: "8", identifier: "OPE-8", title: "Merged", status: "done" },
    { id: "9", identifier: "OPE-9", title: "No PR", status: "done" },
  ];
  const merged = [{ type: "pull_request", status: "merged", title: "Merged PR" }];
  const calls = [];
  const result = await collectBoardViolations(api, issues, {}, board({
    "/api/issues/8/work-products": merged,
    "/api/issues/9/work-products": [],
  }, calls));
  assert.deepEqual(result, { violations: [], openIssues: [] });
  assert.deepEqual(calls, ["/api/issues/8/work-products", "/api/issues/9/work-products"]);
  assert.strictEqual(issues[0].workProducts, merged);
  assert.deepEqual(issues[1].workProducts, []);
});
