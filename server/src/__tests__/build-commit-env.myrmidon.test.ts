import { afterEach, describe, expect, it, vi } from "vitest";
import { readBuildCommit } from "../build-commit.js";

const canonical = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";
const legacy = "1234567890abcdef1234567890abcdef12345678";
const marker = "ffffffffffffffffffffffffffffffffffffffff";
const markerPath = "/app/.paperclip-build-commit";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("readBuildCommit environment aliases", () => {
  it("prefers and normalizes the canonical commit without reading the marker", () => {
    vi.stubEnv("MYRMIDON_BUILD_COMMIT", canonical);
    vi.stubEnv("PAPERCLIP_BUILD_COMMIT", legacy);
    const readTextFile = vi.fn(() => marker);

    expect(readBuildCommit({ buildCommitPath: markerPath, readTextFile })).toBe(canonical.toLowerCase());
    expect(readTextFile).not.toHaveBeenCalled();
  });

  it("uses the legacy commit when the canonical variable is absent", () => {
    vi.stubEnv("MYRMIDON_BUILD_COMMIT", undefined);
    vi.stubEnv("PAPERCLIP_BUILD_COMMIT", legacy);
    const readTextFile = vi.fn(() => marker);

    expect(readBuildCommit({ buildCommitPath: markerPath, readTextFile })).toBe(legacy);
    expect(readTextFile).not.toHaveBeenCalled();
  });

  it.each(["", "invalid-commit"])("uses the marker instead of legacy when canonical is %j", (value) => {
    vi.stubEnv("MYRMIDON_BUILD_COMMIT", value);
    vi.stubEnv("PAPERCLIP_BUILD_COMMIT", legacy);
    const readTextFile = vi.fn(() => marker);

    expect(readBuildCommit({ buildCommitPath: markerPath, readTextFile })).toBe(marker);
    expect(readTextFile).toHaveBeenCalledOnce();
    expect(readTextFile).toHaveBeenCalledWith(markerPath);
  });
});
