import { describe, expect, it } from "vitest";
import { hasLargeSizeLabel, isLargeEngineeringTask } from "./large-task.js";

describe("large task plan gate", () => {
  it("matches only exact case-insensitive M and L size labels", () => {
    expect(hasLargeSizeLabel(["SIZE:M"])).toBe(true);
    expect(hasLargeSizeLabel(["size:l"])).toBe(true);
    expect(hasLargeSizeLabel(["size:medium"])).toBe(false);
    expect(hasLargeSizeLabel(["feature-size:m"])).toBe(false);
  });

  it("requires both a large size and engineering classification", () => {
    expect(isLargeEngineeringTask({ labels: ["size:M"], assigneeAgentRole: "engineer" })).toBe(true);
    expect(isLargeEngineeringTask({ labels: ["size:M"], assigneeAgentRole: "general" })).toBe(false);
    expect(isLargeEngineeringTask({ labels: ["size:L", "needs-engineer"] })).toBe(true);
    expect(isLargeEngineeringTask({ labels: ["size:L"], assigneeAgentRole: null })).toBe(false);
  });
});
