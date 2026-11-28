import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkCheckList, runCheckCheckList } from "./vendor-release-add.mjs";

describe("vendor release checklist base exceptions and independent gaps", () => {
  it("accepts three empty explicit lists", () => {
    assert.deepEqual(checkCheckList({ registry: [], smoke: [], fixtures: [] }), []);
  });

  it("allows both default base releases in smoke and fixtures without registry entries", () => {
    assert.deepEqual(checkCheckList({ registry: [], smoke: ["v2026.916.0", "v2026.916.1"], fixtures: ["v2026.916.1", "v2026.916.0"] }), []);
  });

  it("disables both default exceptions with an empty base list", () => {
    assert.deepEqual(checkCheckList({ registry: [], smoke: ["v2026.916.0", "v2026.916.1"], fixtures: ["v2026.916.0", "v2026.916.1"], baseReleases: [] }), [
      "v2026.916.0: in the smoke matrix but not in the vendor registry",
      "v2026.916.1: in the smoke matrix but not in the vendor registry",
      "v2026.916.0: fixture release is not in the vendor registry",
      "v2026.916.1: fixture release is not in the vendor registry",
    ]);
  });

  it("replaces the defaults with only the custom base exception", () => {
    assert.deepEqual(checkCheckList({ registry: [], smoke: ["v2026.1201.0", "v2026.916.0", "v2026.916.1"], fixtures: ["v2026.1201.0", "v2026.916.0", "v2026.916.1"], baseReleases: ["v2026.1201.0"] }), [
      "v2026.916.0: in the smoke matrix but not in the vendor registry",
      "v2026.916.1: in the smoke matrix but not in the vendor registry",
      "v2026.916.0: fixture release is not in the vendor registry",
      "v2026.916.1: fixture release is not in the vendor registry",
    ]);
  });

  it("requires both kinds of coverage when the custom base is registered", () => {
    assert.deepEqual(checkCheckList({ registry: ["v2026.1201.0"], smoke: [], fixtures: [], baseReleases: ["v2026.1201.0"] }), [
      "v2026.1201.0: in the vendor registry but missing from the migration smoke matrix (.github/workflows/myrmidon-paperclip-migration.yml)",
      "v2026.1201.0: in the vendor registry but missing from fixture SUPPORTED_RELEASES (paperclip-migration-generate-fixture.mjs)",
    ]);
  });

  it("reports missing smoke and fixture as distinct ordered problems", () => {
    assert.deepEqual(checkCheckList({ registry: ["v2026.1001.0"], smoke: [], fixtures: [] }), [
      "v2026.1001.0: in the vendor registry but missing from the migration smoke matrix (.github/workflows/myrmidon-paperclip-migration.yml)",
      "v2026.1001.0: in the vendor registry but missing from fixture SUPPORTED_RELEASES (paperclip-migration-generate-fixture.mjs)",
    ]);
  });

  it("reports unsupported smoke and fixture independently even for the same tag", () => {
    assert.deepEqual(checkCheckList({ registry: [], smoke: ["v2026.1001.0"], fixtures: ["v2026.1001.0"] }), [
      "v2026.1001.0: in the smoke matrix but not in the vendor registry",
      "v2026.1001.0: fixture release is not in the vendor registry",
    ]);
  });

  it("does not mutate frozen input arrays or the frozen base list", () => {
    const opts = {
      registry: Object.freeze(["v2026.1001.0", "v2026.1002.0"]),
      smoke: Object.freeze(["v2026.1002.0", "v2026.1001.0", "v2026.1201.0"]),
      fixtures: Object.freeze(["v2026.1201.0", "v2026.1001.0", "v2026.1002.0"]),
      baseReleases: Object.freeze(["v2026.1201.0"]),
    };
    assert.deepEqual(checkCheckList(opts), []);
    assert.deepEqual(opts, {
      registry: ["v2026.1001.0", "v2026.1002.0"],
      smoke: ["v2026.1002.0", "v2026.1001.0", "v2026.1201.0"],
      fixtures: ["v2026.1201.0", "v2026.1001.0", "v2026.1002.0"],
      baseReleases: ["v2026.1201.0"],
    });
  });

  it("accepts independent permutations of complete coverage", () => {
    const orders = [["v2026.1001.0", "v2026.1002.0"], ["v2026.1002.0", "v2026.1001.0"]];
    for (const registry of orders) for (const smoke of orders) for (const fixtures of orders) {
      assert.deepEqual(checkCheckList({ registry, smoke, fixtures, baseReleases: [] }), []);
    }
  });

  it("runs successfully with fully covered explicit options", () => {
    assert.doesNotThrow(() => runCheckCheckList({ registry: ["v2026.1001.0"], smoke: ["v2026.1001.0"], fixtures: ["v2026.1001.0"], baseReleases: [] }));
  });

  it("reports two problems when both forms of coverage are missing", () => {
    assert.throws(() => runCheckCheckList({ registry: ["v2026.1001.0"], smoke: [], fixtures: [], baseReleases: [] }), {
      message: "Vendor release check list failed with 2 problem(s)",
    });
  });
});
