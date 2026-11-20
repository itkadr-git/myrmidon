import { describe, expect, it, vi } from "vitest";
import { loadRegulationWorkspaceFiles } from "./delivery.js";
import type { ApprovedRegulation } from "./types.js";

const COMPANY = "company-matrix";
const regulation: ApprovedRegulation = {
  pageId: "rules/deploy",
  slug: "rules/deploy",
  title: "Deploy",
  content: "Run the checks",
  version: 1,
  roles: ["*"],
  sources: [],
};
const warning = "regulations: the instructions bundle already contains REGULATIONS.md; the wiki text was not delivered to this agent";

describe("regulation delivery path matrix", () => {
  it.each([
    { path: "REGULATIONS.md", collision: true },
    { path: "regulations.md", collision: true },
    { path: "ReGuLaTiOnS.Md", collision: true },
    { path: "HEARTBEAT.md", collision: false },
    { path: "unrelated.md", collision: false },
  ])("handles bundle path $path", async ({ path, collision }) => {
    const resolved = vi.fn().mockResolvedValue([regulation]);
    const takenPaths = [path];
    const original = [...takenPaths];
    const result = await loadRegulationWorkspaceFiles(
      { resolved },
      { companyId: COMPANY, role: "engineer" },
      { takenPaths },
    );

    expect(resolved).toHaveBeenCalledTimes(1);
    expect(resolved).toHaveBeenCalledWith(COMPANY, "engineer");
    expect(takenPaths).toEqual(original);
    if (collision) {
      expect(result.files).toEqual([]);
      expect(result.warnings).toEqual([warning]);
    } else {
      expect(result.warnings).toEqual([]);
      expect(result.files).toHaveLength(1);
      expect(result.files[0]?.path).toBe("REGULATIONS.md");
      expect(result.files[0]?.content).toContain("Run the checks");
    }
  });

  it.each([
    { role: null, expected: "general" },
    { role: undefined, expected: "general" },
    { role: "  \t ", expected: "general" },
    { role: "  engineer  ", expected: "engineer" },
  ])("normalizes role $role to $expected", async ({ role, expected }) => {
    const resolved = vi.fn().mockResolvedValue([regulation]);
    const result = await loadRegulationWorkspaceFiles({ resolved }, { companyId: COMPANY, role });
    expect(resolved).toHaveBeenCalledTimes(1);
    expect(resolved).toHaveBeenCalledWith(COMPANY, expected);
    expect(result.warnings).toEqual([]);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.path).toBe("REGULATIONS.md");
    expect(result.files[0]?.content).toContain("Run the checks");
  });

  it("returns no warning or file for an empty resolver even when the path is taken", async () => {
    const resolved = vi.fn().mockResolvedValue([]);
    const takenPaths = ["REGULATIONS.md"];
    const result = await loadRegulationWorkspaceFiles(
      { resolved },
      { companyId: COMPANY, role: "engineer" },
      { takenPaths },
    );
    expect(resolved).toHaveBeenCalledTimes(1);
    expect(resolved).toHaveBeenCalledWith(COMPANY, "engineer");
    expect(result).toEqual({ files: [], warnings: [] });
    expect(takenPaths).toEqual(["REGULATIONS.md"]);
  });
});
