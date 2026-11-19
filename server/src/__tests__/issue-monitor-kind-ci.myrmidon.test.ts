import { describe, expect, it } from "vitest";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.ts";

describe("monitor kind ci (EMPTY-WAKES-CI-UNREADY)", () => {
  const base = { nextCheckAt: "2026-11-16T12:00:00.000Z" };

  it("stores kind ci as external_service with the service name github-ci", () => {
    const policy = normalizeIssueExecutionPolicy({ monitor: { ...base, kind: "ci" } });
    expect(policy?.monitor?.kind).toBe("external_service");
    expect(policy?.monitor?.serviceName).toBe("github-ci");
  });

  it("keeps a service name the caller gave", () => {
    const policy = normalizeIssueExecutionPolicy({ monitor: { ...base, kind: "ci", serviceName: "review-ci" } });
    expect(policy?.monitor?.kind).toBe("external_service");
    expect(policy?.monitor?.serviceName).toBe("review-ci");
  });

  it("leaves external_service and an absent kind as they were", () => {
    const external = normalizeIssueExecutionPolicy({ monitor: { ...base, kind: "external_service", serviceName: "x" } });
    expect(external?.monitor?.kind).toBe("external_service");
    expect(external?.monitor?.serviceName).toBe("x");
    const none = normalizeIssueExecutionPolicy({ monitor: base });
    expect(none?.monitor?.kind).toBeNull();
    expect(none?.monitor?.serviceName).toBeNull();
  });
});
