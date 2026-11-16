import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareStableTags, decideSync, pickLatestStable } from "./lib.mjs";

describe("vendor sync decision contract", () => {
  it("returns the complete decision for missing, older, equal and newer tags", () => {
    const cases = [
      [{ latestVendorTag: null, baseTag: null },
        { action: "nothing", tag: null, base: null, reason: "no stable vendor tag found" }],
      [{ latestVendorTag: null, baseTag: "v2026.916.1" },
        { action: "nothing", tag: null, base: "v2026.916.1", reason: "no stable vendor tag found" }],
      [{ latestVendorTag: "v2026.916.1", baseTag: "v2026.927.0" },
        { action: "nothing", tag: "v2026.916.1", base: "v2026.927.0", reason: "base v2026.927.0 is already at or past the latest stable vendor tag v2026.916.1" }],
      [{ latestVendorTag: "v2026.916.1", baseTag: "v2026.916.1" },
        { action: "nothing", tag: "v2026.916.1", base: "v2026.916.1", reason: "base v2026.916.1 is already at or past the latest stable vendor tag v2026.916.1" }],
      [{ latestVendorTag: "v2026.927.0", baseTag: "v2026.916.1" },
        { action: "sync", tag: "v2026.927.0", base: "v2026.916.1", reason: null }],
      [{ latestVendorTag: "v2026.927.0", baseTag: null },
        { action: "sync", tag: "v2026.927.0", base: null, reason: null }],
    ];
    for (const [input, expected] of cases) {
      assert.deepEqual(decideSync(input), expected);
    }
  });

  it("rejects invalid nonempty latest and base tokens with the offending token", () => {
    assert.throws(() => compareStableTags("bad-latest", "v2026.916.1"), /bad-latest/);
    assert.throws(() => compareStableTags("v2026.916.1", "bad-base"), /bad-base/);
    assert.ok(compareStableTags("v2026.927.0", "v2026.916.1") > 0);
  });

  it("selects stable tags without mutating input and is independent of order", () => {
    const tags = ["v2026.916.1", "v2026.927.0-rc.1", "v2026.1007.0", "refs/tags/v2027.101.0", "v2026.930.5"];
    const original = [...tags];
    assert.equal(pickLatestStable(tags), "v2026.1007.0");
    assert.deepEqual(tags, original);
    assert.equal(pickLatestStable([...tags].reverse()), "v2026.1007.0");
    assert.equal(pickLatestStable([]), null);
    assert.equal(pickLatestStable(["v2027.101.0-beta.1", "main"]), null);
  });
});
