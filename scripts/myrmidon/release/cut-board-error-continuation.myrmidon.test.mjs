import assert from "node:assert/strict";
import test from "node:test";
import { collectBoardViolations } from "./cut-rc.mjs";

test("collectBoardViolations continues after a work-products error and aggregates every issue", async () => {
  const api = { companyId: "company" };
  const issues = [
    { id: "first", identifier: "OPE-101", title: "Active task", status: "in_progress" },
    { id: "second", identifier: "OPE-102", title: "Done with open PR", status: "done" },
    { id: "third", identifier: "OPE-103", title: "Cancelled task", status: "cancelled" },
    { id: "fourth", identifier: "OPE-104", title: "Merged task", status: "done" },
  ];
  const requests = [];
  const fetchBoard = async (receivedApi, url) => {
    assert.equal(receivedApi, api);
    requests.push(url);
    switch (url) {
      case "/api/issues/first/work-products":
        throw new Error("board unavailable");
      case "/api/issues/second/work-products":
        return [{ type: "pull_request", status: "open", title: "Open delivery", metadata: { repository: "example/repo", number: 42 } }];
      case "/api/issues/third/work-products":
        return [];
      case "/api/issues/fourth/work-products":
        return [{ type: "pull_request", status: "merged", title: "Merged delivery", metadata: { repository: "example/repo", number: 43 } }];
      default:
        throw new Error(`unexpected board request: ${url}`);
    }
  };

  const result = await collectBoardViolations(api, issues, {}, fetchBoard);
  assert.deepEqual(requests, [
    "/api/issues/first/work-products",
    "/api/issues/second/work-products",
    "/api/issues/third/work-products",
    "/api/issues/fourth/work-products",
  ]);
  assert.deepEqual(result.openIssues.map(({ id }) => id), ["first"]);
  assert.deepEqual(result.violations, [
    'open task OPE-101 "Active task" [in_progress]',
    "task OPE-103 not done [cancelled]",
    "OPE-101: cannot read work products: board unavailable",
    "OPE-102 (done) has unmerged attached PR: example/repo#42 (Open delivery) - PR open",
  ]);
});
