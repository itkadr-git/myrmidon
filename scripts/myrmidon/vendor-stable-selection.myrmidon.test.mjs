import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isStableReleaseTag, selectLatestStableRelease } from "./vendor-release-add.mjs";

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe("stable upstream release selection", () => {
  it("classifies stable tags and rejects prerelease variants", () => {
    const cases = [
      ["v2026.1012.0", true],
      ["v2025.1.42", true],
      ["v2026.1012.0-canary", false],
      ["v2026.1012.0-beta", false],
      ["v2026.1012.0-nightly", false],
      ["nightly/2026-10-12", false],
      ["v2026.1012.0-rc.1", false],
      ["2026.1012.0", false],
      ["v2026.1012", false],
    ];
    for (const [tag, expected] of cases) {
      assert.equal(isStableReleaseTag(tag), expected, tag);
    }
  });

  it("selects the newest published stable from shuffled frozen records without changing input", () => {
    const releases = deepFreeze([
      { tag_name: "v2026.1005.0", published_at: "2026-10-05T00:00:00Z", draft: false, prerelease: false, metadata: { id: 1 } },
      { tag_name: "v2026.1015.0", published_at: "2026-10-15T00:00:00Z", draft: true, prerelease: false, metadata: { id: 2 } },
      { tag_name: "v2026.1012.0", published_at: "2026-10-12T00:00:00Z", draft: false, prerelease: false, metadata: { id: 3 } },
      { tag_name: "v2026.1016.0", published_at: "2026-10-16T00:00:00Z", draft: false, prerelease: true, metadata: { id: 4 } },
      { tag_name: "v2026.1017.0-canary", published_at: "2026-10-17T00:00:00Z", draft: false, prerelease: false, metadata: { id: 5 } },
      { tag_name: "v2026.1009.0", published_at: "2026-10-09T00:00:00Z", draft: false, prerelease: false, metadata: { id: 6 } },
      { tag_name: "v2026.1018.0-beta", published_at: "2026-10-18T00:00:00Z", draft: false, prerelease: false, metadata: { id: 7 } },
      { tag_name: "nightly/2026-10-19", published_at: "2026-10-19T00:00:00Z", draft: false, prerelease: false, metadata: { id: 8 } },
    ]);
    const before = structuredClone(releases);
    assert.equal(selectLatestStableRelease(releases), releases[2]);
    assert.deepEqual(releases, before);
  });

  it("returns undefined for an empty list or when every release is filtered out", () => {
    assert.equal(selectLatestStableRelease(deepFreeze([])), undefined);
    const excluded = deepFreeze([
      { tag_name: "v2026.1012.0", published_at: "2026-10-12T00:00:00Z", draft: true, prerelease: false },
      { tag_name: "v2026.1013.0", published_at: "2026-10-13T00:00:00Z", draft: false, prerelease: true },
      { tag_name: "v2026.1014.0-beta", published_at: "2026-10-14T00:00:00Z", draft: false, prerelease: false },
    ]);
    const before = structuredClone(excluded);
    assert.equal(selectLatestStableRelease(excluded), undefined);
    assert.deepEqual(excluded, before);
  });
});
