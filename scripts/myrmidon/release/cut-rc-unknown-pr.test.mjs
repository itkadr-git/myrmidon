import { test } from "node:test";
import assert from "node:assert/strict";
import { blockingPrsOfIssue, collectBoardViolations } from "./cut-rc.mjs";

const pr = (status) => ({ type: "pull_request", status, title: "example PR" });

test("only merged PRs pass the release gate", () => {
  const cases = [
    ["merged", null], ["MERGED", null], ["open", "open"],
    ["draft", "draft"], ["ready", "open"], ["closed", "closed-unmerged"],
    ["unknown", "unknown"], [null, "unknown"], [undefined, "unknown"],
    ["", "unknown"], ["new-state", "new-state"], [42, "unknown"],
    [["merged"], "unknown"],
  ];
  for (const [status, expected] of cases) {
    const blockers = blockingPrsOfIssue({}, [pr(status)]);
    if (expected === null) assert.deepEqual(blockers, [], String(status));
    else assert.deepEqual(blockers, [`example PR (example PR) - PR ${expected}`], String(status));
  }
  assert.deepEqual(blockingPrsOfIssue({}, [{ type: "artifact", status: null }]), []);
});

test("unknown PR status on a done issue produces a release violation", async () => {
  const issues = [{ id: "i1", identifier: "OPE-1", title: "done", status: "done" }];
  const result = await collectBoardViolations({}, issues, {}, async () => [pr(null)]);
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0], /OPE-1.*unmerged attached PR.*PR unknown/);
});
