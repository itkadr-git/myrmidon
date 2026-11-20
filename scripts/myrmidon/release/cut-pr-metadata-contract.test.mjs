import test from "node:test";
import assert from "node:assert/strict";
import { prKeyOf, describePr, blockingPrsOfIssue, collectBoardViolations } from "./cut-rc.mjs";

test("PR identity prefers repository then repo then fullName, and number then pullRequestNumber", () => {
  const cases = [
    [{ repository: "org/primary", repo: "org/secondary", fullName: "org/third", number: 11, pullRequestNumber: 22 }, "org/primary#11"],
    [{ repo: "org/secondary", fullName: "org/third", pullRequestNumber: 22 }, "org/secondary#22"],
    [{ fullName: "org/third", number: 33 }, "org/third#33"],
    [{ repository: "", repo: "org/fallback", number: null, pullRequestNumber: 44 }, "org/fallback#44"],
  ];
  for (const [metadata, expected] of cases) {
    const wp = Object.freeze({ title: "Change", metadata: Object.freeze(metadata) });
    assert.equal(prKeyOf(wp), expected);
    assert.equal(describePr(wp), `${expected} (Change)`);
  }
});

test("missing identity falls back to title or PR and missing title is untitled", () => {
  assert.equal(prKeyOf(Object.freeze({ title: "Named", metadata: Object.freeze({ repository: "org/repo" }) })), "Named");
  assert.equal(prKeyOf(Object.freeze({ title: "Named", metadata: Object.freeze({ number: 7 }) })), "Named");
  assert.equal(prKeyOf(Object.freeze({})), "PR");
  assert.equal(describePr(Object.freeze({})), "PR (untitled)");
  assert.equal(describePr(Object.freeze({ metadata: Object.freeze({ repository: "org/repo", number: 7 }) })), "org/repo#7 (untitled)");
  assert.equal(describePr(Object.freeze({ title: "Named" })), "Named (Named)");
});

test("blockers retain input order, exact identity and known state; frozen products stay unchanged", () => {
  const issue = Object.freeze({ identifier: "OPE-1" });
  const products = Object.freeze([
    Object.freeze({ type: "pull_request", status: "merged", title: "Merged", metadata: Object.freeze({ repository: "org/a", number: 1 }) }),
    Object.freeze({ type: "artifact", status: "open", title: "Artifact", metadata: Object.freeze({ repository: "org/a", number: 2 }) }),
    Object.freeze({ type: "pull_request", status: "open", title: "Open", metadata: Object.freeze({ repository: "org/a", number: 3 }) }),
    Object.freeze({ type: "pull_request", status: "draft", title: "Draft", metadata: Object.freeze({ repo: "org/b", pullRequestNumber: 4 }) }),
    Object.freeze({ type: "branch", status: "closed", title: "Branch" }),
    Object.freeze({ type: "pull_request", status: "ready", metadata: Object.freeze({ fullName: "org/c", number: 5 }) }),
    Object.freeze({ type: "pull_request", status: "closed", title: "Abandoned" }),
    Object.freeze({ type: "pull_request", status: "open" }),
  ]);
  const before = structuredClone(products);
  assert.deepEqual(blockingPrsOfIssue(issue, products), [
    "org/a#3 (Open) - PR open",
    "org/b#4 (Draft) - PR draft",
    "org/c#5 (untitled) - PR open",
    "Abandoned (Abandoned) - PR closed-unmerged",
    "PR (untitled) - PR open",
  ]);
  assert.deepEqual(products, before);
  assert.deepEqual(issue, { identifier: "OPE-1" });
  assert.deepEqual(blockingPrsOfIssue(issue, Object.freeze([products[0], products[1], products[4]])), []);
});

test("release diagnostics include exact PR descriptions from the injected board", async () => {
  const issue = { id: "i1", identifier: "OPE-1", title: "Release item", status: "done" };
  const products = Object.freeze([
    Object.freeze({ type: "pull_request", status: "ready", title: "Ready", metadata: Object.freeze({ repo: "org/repo", pullRequestNumber: 42 }) }),
    Object.freeze({ type: "pull_request", status: "merged", title: "Merged" }),
    Object.freeze({ type: "artifact", status: "open", title: "Ignore" }),
  ]);
  const paths = [];
  const result = await collectBoardViolations({}, [issue], {}, async (_api, path) => {
    paths.push(path);
    return products;
  });
  assert.deepEqual(paths, ["/api/issues/i1/work-products"]);
  assert.deepEqual(result.violations, ["OPE-1 (done) has unmerged attached PR: org/repo#42 (Ready) - PR open"]);
});
