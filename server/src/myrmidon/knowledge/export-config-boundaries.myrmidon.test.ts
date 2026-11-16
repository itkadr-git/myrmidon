import { describe, expect, it } from "vitest";
import { readKnowledgeExportSettings } from "./git-export.js";

describe("knowledge export configuration boundaries", () => {
  it.each([
    ["1", 1],
    ["168", 168],
    ["0", 24],
    ["169", 24],
    ["-1", 24],
    ["1.5", 24],
    ["NaN", 24],
    ["Infinity", 24],
    ["", 24],
  ])("uses interval %s as %i without changing env", (value, intervalHours) => {
    const env = {
      MYRMIDON_KNOWLEDGE_EXPORT_REPO: "https://example.test/export.git",
      MYRMIDON_KNOWLEDGE_EXPORT_INTERVAL_HOURS: value,
    };
    const original = { ...env };
    expect(readKnowledgeExportSettings(env)).toEqual({
      enabled: true,
      repoUrl: "https://example.test/export.git",
      branch: "knowledge-export",
      intervalHours,
    });
    expect(env).toEqual(original);
  });

  it.each([
    ["absent", undefined, false, null],
    ["whitespace", " \t ", false, null],
    ["trimmed", "  https://example.test/export.git  ", true, "https://example.test/export.git"],
  ])("handles %s repository without changing env", (_name, repo, enabled, repoUrl) => {
    const env: NodeJS.ProcessEnv = repo === undefined ? {} : { MYRMIDON_KNOWLEDGE_EXPORT_REPO: repo };
    const original = { ...env };
    expect(readKnowledgeExportSettings(env)).toEqual({
      enabled,
      repoUrl,
      branch: "knowledge-export",
      intervalHours: 24,
    });
    expect(env).toEqual(original);
  });

  it.each([
    ["  feature/export-1  ", "feature/export-1"],
    ["feature/export-1", "feature/export-1"],
    ["feature export", "knowledge-export"],
    ["feature:export", "knowledge-export"],
    ["feature/../export", "knowledge-export"],
  ])("handles branch %s without changing env", (branch, expectedBranch) => {
    const env = {
      MYRMIDON_KNOWLEDGE_EXPORT_REPO: "https://example.test/export.git",
      MYRMIDON_KNOWLEDGE_EXPORT_BRANCH: branch,
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
