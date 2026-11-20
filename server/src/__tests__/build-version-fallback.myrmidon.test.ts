import { describe, expect, it, vi } from "vitest";
import { readBuildVersion } from "../build-version.js";

describe("build version marker fallback", () => {
  it.each(["two words", "two\nlines", "two\twords", "", " \n\t "])(
    "rejects an empty or whitespace-bearing marker %j",
    (marker) => {
      const readTextFile = vi.fn(() => marker);
      expect(readBuildVersion({ environmentVersion: null, readTextFile })).toBeNull();
      expect(readTextFile).toHaveBeenCalledOnce();
    },
  );

  it("trims a single arbitrary token and passes the custom path exactly after an invalid environment value", () => {
    const path = "/custom path/../marker";
    const readTextFile = vi.fn(() => "  arbitrary-token\n");
    expect(readBuildVersion({ environmentVersion: "invalid version", buildVersionPath: path, readTextFile })).toBe("arbitrary-token");
    expect(readTextFile).toHaveBeenCalledExactlyOnceWith(path);
  });

  it.each(["ENOENT", "EACCES"])("returns null on %s", (code) => {
    const readTextFile = vi.fn(() => {
      throw Object.assign(new Error(code), { code });
    });
    expect(readBuildVersion({ environmentVersion: null, readTextFile })).toBeNull();
    expect(readTextFile).toHaveBeenCalledOnce();
  });

  it("reads every marker independently across A/B/A calls", () => {
    const readTextFile = vi.fn()
      .mockReturnValueOnce("A\n")
      .mockReturnValueOnce("B\n")
      .mockReturnValueOnce("A\n");
    const options = { environmentVersion: null, buildVersionPath: "/marker", readTextFile };
    expect([readBuildVersion(options), readBuildVersion(options), readBuildVersion(options)]).toEqual(["A", "B", "A"]);
    expect(readTextFile).toHaveBeenCalledTimes(3);
    expect(readTextFile.mock.calls).toEqual([["/marker"], ["/marker"], ["/marker"]]);
  });
});
