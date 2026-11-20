import { describe, expect, it } from "vitest";
import { readKnowledgeExportSettings } from "./git-export.js";

describe("knowledge export branch validation", () => {
  it.each([
    ["feature//export", "knowledge-export"],
    ["feature/export.", "knowledge-export"],
    ["feature/topic.lock", "knowledge-export"],
    ["feature/.hidden", "knowledge-export"],
    ["/feature", "knowledge-export"],
    ["feature/", "knowledge-export"],
    ["feature/-topic", "feature/-topic"],
    ["-feature", "knowledge-export"],
    ["feature/export-1", "feature/export-1"],
    ["knowledge-export", "knowledge-export"],
    ["  feature/export-1  ", "feature/export-1"],
    ["feature/../export", "knowledge-export"],
    ["feature:export", "knowledge-export"],
  ])("handles branch %s without changing env", (branch, expectedBranch) => {
    const env = {
      MYRMIDON_KNOWLEDGE_EXPORT_REPO: "https://example.test/export.git",
      MYRMIDON_KNOWLEDGE_EXPORT_BRANCH: branch,
      SENTINEL: "unchanged",
    };
    const original = { ...env };
    expect(readKnowledgeExportSettings(env)).toEqual({
      enabled: true,
      repoUrl: "https://example.test/export.git",
      branch: expectedBranch,
      intervalHours: 24,
    });
    expect(env).toEqual(original);
  });
});
