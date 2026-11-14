import { describe, expect, it } from "vitest";
import {
  canResumeReleaseGate,
  validateFlakyEvidence,
  type ReleaseFlakyJob,
  type ReleaseFlakyWaiver,
} from "./myrmidon-release-flaky-work.js";

describe("myrmidon-release-flaky-work", () => {
  describe("validateFlakyEvidence", () => {
    it("accepts valid evidence with headSha, job, and attempt", () => {
      const res = validateFlakyEvidence({
        headSha: "abc1234",
        job: "test (node:24)",
        attempt: 2,
        runId: "12345678",
        url: "https://github.com/itkadr-git/myrmidon/actions/runs/12345678",
      });
      expect(res.valid).toBe(true);
      expect(res.evidence).toMatchObject({
        headSha: "abc1234",
        job: "test (node:24)",
        attempt: 2,
      });
    });

    it("rejects evidence when headSha is missing or empty", () => {
      const res = validateFlakyEvidence({
        job: "test (node:24)",
        attempt: 1,
      });
      expect(res.valid).toBe(false);
      expect(res.error).toContain("headSha");
    });

    it("rejects evidence when job name is missing", () => {
      const res = validateFlakyEvidence({
        headSha: "abc1234",
        attempt: 1,
      });
      expect(res.valid).toBe(false);
      expect(res.error).toContain("job");
    });

    it("rejects evidence when attempt is not integer >= 1", () => {
      const resZero = validateFlakyEvidence({
        headSha: "abc1234",
        job: "test (node:24)",
        attempt: 0,
      });
      expect(resZero.valid).toBe(false);

      const resNegative = validateFlakyEvidence({
        headSha: "abc1234",
        job: "test (node:24)",
        attempt: -1,
      });
      expect(resNegative.valid).toBe(false);
    });
  });

  describe("canResumeReleaseGate", () => {
    const jobA: ReleaseFlakyJob = {
      id: "job-1",
      jobName: "build-image",
      headSha: "sha-1",
      attempt: 1,
      status: "failed",
    };

    const jobB: ReleaseFlakyJob = {
      id: "job-2",
      jobName: "test-unit",
      headSha: "sha-1",
      attempt: 1,
      status: "failed",
    };

    it("blocks resumption when there are unresolved failed jobs", () => {
      const decision = canResumeReleaseGate([jobA, jobB], []);
      expect(decision.canResume).toBe(false);
      expect(decision.unresolvedJobs).toEqual(["build-image", "test-unit"]);
      expect(decision.blockingReason).toContain("build-image");
    });

    it("resumes when all jobs succeed after retry", () => {
      const greenJobA: ReleaseFlakyJob = { ...jobA, status: "success", attempt: 2 };
      const greenJobB: ReleaseFlakyJob = { ...jobB, status: "success", attempt: 2 };
      const decision = canResumeReleaseGate([greenJobA, greenJobB], []);
      expect(decision.canResume).toBe(true);
      expect(decision.unresolvedJobs).toHaveLength(0);
    });

    it("resumes when failed job is waived with matching evidence (headSha, job, attempt)", () => {
      const waiverA: ReleaseFlakyWaiver = {
        job: "build-image",
        reason: "Network timeout to external registry not related to code",
        evidence: {
          headSha: "sha-1",
          job: "build-image",
          attempt: 1,
        },
        actor: { type: "agent", id: "agent-1" },
        waivedAt: new Date().toISOString(),
      };

      const greenJobB: ReleaseFlakyJob = { ...jobB, status: "success", attempt: 2 };
      const decision = canResumeReleaseGate([jobA, greenJobB], [waiverA]);
      expect(decision.canResume).toBe(true);
      expect(decision.unresolvedJobs).toHaveLength(0);
    });

    it("blocks when waiver evidence has mismatched headSha or attempt", () => {
      const mismatchWaiver: ReleaseFlakyWaiver = {
        job: "build-image",
        reason: "flaky test",
        evidence: {
          headSha: "different-sha", // mismatch!
          job: "build-image",
          attempt: 1,
        },
        actor: { type: "agent", id: "agent-1" },
        waivedAt: new Date().toISOString(),
      };

      const decision = canResumeReleaseGate([jobA], [mismatchWaiver]);
      expect(decision.canResume).toBe(false);
      expect(decision.unresolvedJobs).toEqual(["build-image"]);
    });

    it("resumes automatically when job list is empty", () => {
      const decision = canResumeReleaseGate([], []);
      expect(decision.canResume).toBe(true);
      expect(decision.unresolvedJobs).toHaveLength(0);
    });
  });
});
