import { afterEach, describe, expect, it, vi } from "vitest";
import { readBuildVersion } from "../build-version.js";

describe("readBuildVersion environment aliases", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    { name: "prefers canonical over legacy", canonical: "v1-canonical", legacy: "v2-legacy", expected: "v1-canonical", reads: 0 },
    { name: "accepts legacy alone", canonical: undefined, legacy: "v2-legacy", expected: "v2-legacy", reads: 0 },
    { name: "uses the marker for empty canonical instead of legacy", canonical: "", legacy: "v2-legacy", expected: "v3-marker", reads: 1 },
    { name: "uses the marker when both are absent", canonical: undefined, legacy: undefined, expected: "v3-marker", reads: 1 },
  ])("$name", ({ canonical, legacy, expected, reads }) => {
    vi.stubEnv("MYRMIDON_BUILD_VERSION", canonical);
    vi.stubEnv("PAPERCLIP_BUILD_VERSION", legacy);
    const readTextFile = vi.fn(() => "v3-marker\n");

    expect(readBuildVersion({ buildVersionPath: "/marker", readTextFile })).toBe(expected);
    expect(readTextFile).toHaveBeenCalledTimes(reads);
    if (reads) expect(readTextFile).toHaveBeenCalledWith("/marker");
  }, 5_000);
});
