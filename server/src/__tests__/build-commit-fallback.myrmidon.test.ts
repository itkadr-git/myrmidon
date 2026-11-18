import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readBuildCommit } from "../build-commit.js";

const shaA = "abcdef0123456789abcdef0123456789abcdef01";
const shaB = "1234567890abcdef1234567890abcdef12345678";
let directory: string;

beforeEach(() => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  directory = mkdtempSync(join(scratch, "build-commit-fallback-"));
});

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("deployment marker fallback", () => {
  it.each([
    ["39 hex characters", "a".repeat(39)],
    ["41 hex characters", "a".repeat(41)],
    ["non-hex character", `${"a".repeat(39)}g`],
    ["embedded newline", `${"a".repeat(20)}\n${"a".repeat(20)}`],
    ["empty marker", ""],
  ])("rejects %s", (_name, marker) => {
    const path = join(directory, "marker");
    writeFileSync(path, marker);
    expect(readBuildCommit({ environmentCommit: null, buildCommitPath: path })).toBeNull();
  });

  it.each([null, "invalid"])("normalizes the marker when environment is %s", (environmentCommit) => {
    const path = join(directory, "custom-marker");
    writeFileSync(path, ` \t${shaA.toUpperCase()}\n`);
    const reader = vi.fn((requestedPath: string) => readFileSync(requestedPath, "utf8"));
    expect(readBuildCommit({ environmentCommit, buildCommitPath: path, readTextFile: reader })).toBe(shaA);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader).toHaveBeenCalledWith(path);
  });

  it("returns null when the marker does not exist", () => {
    expect(readBuildCommit({ environmentCommit: null, buildCommitPath: join(directory, "missing") })).toBeNull();
  });

  it("returns null when the marker read is denied", () => {
    const path = join(directory, "denied");
    const reader = vi.fn(() => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); });
    expect(readBuildCommit({ environmentCommit: "invalid", buildCommitPath: path, readTextFile: reader })).toBeNull();
    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader).toHaveBeenCalledWith(path);
  });

  it("reads the current contents on A/B/A calls without caching", () => {
    const path = join(directory, "marker");
    for (const commit of [shaA, shaB, shaA]) {
      writeFileSync(path, commit);
      expect(readBuildCommit({ environmentCommit: null, buildCommitPath: path })).toBe(commit);
    }
  });
});
