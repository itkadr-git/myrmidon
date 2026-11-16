import { test } from "node:test";
import assert from "node:assert/strict";
import { listReleaseIssues } from "./cut-rc.mjs";

const api = { companyId: "company-from-api" };
const distractors = [
  { id: "wrong-minor", name: "1.70" },
  { id: "wrong-patch", name: "1.7.1" },
  { id: "wrong-alias", name: "release:1.70" },
];

function fakeBoard(labels, expectedIssuePath, issues) {
  const calls = [];
  return {
    calls,
    async fetchBoard(receivedApi, pathname) {
      assert.strictEqual(receivedApi, api);
      calls.push(pathname);
      if (pathname === "/api/companies/company-from-api/labels") return labels;
      assert.equal(pathname, expectedIssuePath);
      return issues;
    },
  };
}

for (const [name, id] of [["1.7", "exact-id"], ["release:1.7", "alias-id"]]) {
  test(`listReleaseIssues resolves ${name} after similarly named labels`, async () => {
    const label = { id, name, companyId: "different-label-company" };
    const issue = { id: `issue-${id}`, identifier: "OPE-17", status: "todo" };
    const issuePath = `/api/companies/company-from-api/issues?labelId=${id}&limit=100&offset=0&view=compact`;
    const board = fakeBoard([...distractors, label], issuePath, [issue]);

    const result = await listReleaseIssues(api, "1.7", () => {}, board.fetchBoard);

    assert.deepEqual(result, [issue]);
    assert.deepEqual(board.calls, ["/api/companies/company-from-api/labels", issuePath]);
  });
}

test("listReleaseIssues rejects similar labels without requesting issues", async () => {
  const board = fakeBoard(distractors, null, []);

  await assert.rejects(
    listReleaseIssues(api, "1.7", () => {}, board.fetchBoard),
    /release label "1\.7" not found on the board/,
  );
  assert.deepEqual(board.calls, ["/api/companies/company-from-api/labels"]);
});
