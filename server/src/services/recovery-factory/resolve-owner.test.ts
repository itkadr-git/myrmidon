import { describe, expect, it } from "vitest";
import {
  RECOVERY_SLA_MINUTES_BY_KIND,
  type RecoveryFactoryKind,
} from "@myrmidon/shared";
import {
  resolveRecoveryOwner,
  RecoveryOwnerUnresolvedError,
  type RecoveryOwnerCandidate,
} from "./resolve-owner.js";

const BASE_CANDIDATES: readonly RecoveryOwnerCandidate[] = [
  {
    id: "agent-devops-1",
    name: "DevOps Engineer",
    role: "devops",
    title: "SRE / DevOps",
    status: "active",
    projectId: "proj-core",
  },
  {
    id: "agent-lead-1",
    name: "Tech Lead",
    role: "lead",
    title: "Team Lead",
    status: "active",
    projectId: "proj-core",
  },
  {
    id: "agent-architect-1",
    name: "Architect",
    role: "architect",
    title: "System Architect",
    status: "active",
    projectId: "proj-core",
  },
  {
    id: "agent-reviewer-1",
    name: "Secondary Reviewer",
    role: "secondary_reviewer",
    title: "Code Reviewer",
    status: "active",
    projectId: "proj-core",
  },
  {
    id: "agent-eng-1",
    name: "Software Engineer",
    role: "engineer",
    title: "Backend Engineer",
    status: "active",
    projectId: "proj-core",
  },
  {
    id: "agent-operator-1",
    name: "Operations Admin",
    role: "operator",
    title: "Platform Operator",
    status: "active",
    projectId: "proj-core",
  },
];

describe("resolveRecoveryOwner", () => {
  const fixedNow = new Date("2026-10-26T12:00:00.000Z");

  describe("Criterion 1: Every recovery-factory kind receives an addressed owner and SLA", () => {
    const kinds: readonly RecoveryFactoryKind[] = [
      "ci_restart",
      "github_access",
      "branch_relay",
      "review_participant_restore",
      "workspace_myr_ws",
      "devbuild",
      "disk_space",
      "operator_action",
    ];

    it.each(kinds)("resolves owner and SLA for kind %s", (kind) => {
      const result = resolveRecoveryOwner({
        kind,
        projectId: "proj-core",
        candidates: BASE_CANDIDATES,
        now: fixedNow,
      });

      expect(result).toBeDefined();
      expect(result.owner).toHaveProperty("agentId");
      expect(typeof result.owner.agentId).toBe("string");
      expect(result.owner.agentId.length).toBeGreaterThan(0);
      expect(result.slaMinutes).toBe(RECOVERY_SLA_MINUTES_BY_KIND[kind]);

      const expectedNextCheckAt = new Date(
        fixedNow.getTime() + result.slaMinutes * 60 * 1000,
      ).toISOString();
      expect(result.nextCheckAt).toBe(expectedNextCheckAt);
    });
  });

  describe("Criterion 2: Empty candidate pool throws RecoveryOwnerUnresolvedError", () => {
    it("throws when candidate array is empty", () => {
      expect(() =>
        resolveRecoveryOwner({
          kind: "ci_restart",
          projectId: "proj-core",
          candidates: [],
        }),
      ).toThrow(RecoveryOwnerUnresolvedError);
    });

    it("throws when candidate array has only terminated agents", () => {
      const terminatedPool: RecoveryOwnerCandidate[] = [
        { id: "agent-dead-1", role: "devops", status: "terminated" },
        { id: "agent-dead-2", role: "lead", status: "archived" },
      ];
      expect(() =>
        resolveRecoveryOwner({
          kind: "devbuild",
          projectId: "proj-core",
          candidates: terminatedPool,
        }),
      ).toThrow(RecoveryOwnerUnresolvedError);
    });

    it("throws when all candidates belong to a conflicting project", () => {
      const otherProjectPool: RecoveryOwnerCandidate[] = [
        { id: "agent-other-1", role: "devops", status: "active", projectId: "proj-other" },
      ];
      expect(() =>
        resolveRecoveryOwner({
          kind: "ci_restart",
          projectId: "proj-core",
          candidates: otherProjectPool,
        }),
      ).toThrow(RecoveryOwnerUnresolvedError);
    });

    it("throws on empty or whitespace kind", () => {
      expect(() =>
        resolveRecoveryOwner({
          kind: "   ",
          candidates: BASE_CANDIDATES,
        }),
      ).toThrow(RecoveryOwnerUnresolvedError);
    });
  });

  describe("Criterion 3: User owners (assigneeUserId / userId / isUser) are NEVER selected as recovery executor", () => {
    it("skips user candidates when mixed with agent candidates", () => {
      const poolWithUser: RecoveryOwnerCandidate[] = [
        {
          id: "human-owner",
          userId: "user-admin-123",
          assigneeUserId: "user-admin-123",
          name: "Project Owner",
          role: "lead",
          isUser: true,
        },
        {
          id: "agent-devops-1",
          role: "devops",
          name: "DevOps Bot",
          status: "active",
        },
      ];

      const result = resolveRecoveryOwner({
        kind: "ci_restart",
        candidates: poolWithUser,
      });

      expect(result.owner.agentId).toBe("agent-devops-1");
      expect(result.owner.agentId).not.toBe("human-owner");
    });

    it("throws RecoveryOwnerUnresolvedError when only user owners are present", () => {
      const usersOnlyPool: RecoveryOwnerCandidate[] = [
        { id: "user-1", userId: "usr-1", role: "lead" },
        { id: "user-2", assigneeUserId: "usr-2", role: "architect" },
        { id: "user-3", isUser: true, role: "devops" },
      ];

      expect(() =>
        resolveRecoveryOwner({
          kind: "review_participant_restore",
          candidates: usersOnlyPool,
        }),
      ).toThrow(RecoveryOwnerUnresolvedError);
    });
  });

  describe("Criterion 4: Deterministic outcome regardless of input candidate order", () => {
    it("returns the exact same owner across repeated runs and permutations", () => {
      const inputA = [...BASE_CANDIDATES];
      const inputB = [...BASE_CANDIDATES].reverse();
      const inputC = [
        BASE_CANDIDATES[3]!,
        BASE_CANDIDATES[0]!,
        BASE_CANDIDATES[4]!,
        BASE_CANDIDATES[1]!,
        BASE_CANDIDATES[5]!,
        BASE_CANDIDATES[2]!,
      ];

      const resultA = resolveRecoveryOwner({
        kind: "review_participant_restore",
        projectId: "proj-core",
        candidates: inputA,
        now: fixedNow,
      });
      const resultB = resolveRecoveryOwner({
        kind: "review_participant_restore",
        projectId: "proj-core",
        candidates: inputB,
        now: fixedNow,
      });
      const resultC = resolveRecoveryOwner({
        kind: "review_participant_restore",
        projectId: "proj-core",
        candidates: inputC,
        now: fixedNow,
      });

      expect(resultA.owner.agentId).toBe(resultB.owner.agentId);
      expect(resultA.owner.agentId).toBe(resultC.owner.agentId);
      expect(resultA.nextCheckAt).toBe(resultB.nextCheckAt);
    });
  });

  describe("OPE-8312 §4.B.1 Review Escalation Rule: lead -> architect -> secondary reviewer", () => {
    it("chooses project lead when lead, architect, and reviewer are present", () => {
      const pool: RecoveryOwnerCandidate[] = [
        { id: "agent-arch", role: "architect", status: "active" },
        { id: "agent-lead", role: "lead", status: "active" },
        { id: "agent-rev", role: "secondary_reviewer", status: "active" },
      ];

      const result = resolveRecoveryOwner({
        kind: "review_participant_restore",
        candidates: pool,
      });

      expect(result.owner.agentId).toBe("agent-lead");
    });

    it("chooses architect when lead is absent", () => {
      const pool: RecoveryOwnerCandidate[] = [
        { id: "agent-arch", role: "architect", status: "active" },
        { id: "agent-rev", role: "secondary_reviewer", status: "active" },
        { id: "agent-eng", role: "engineer", status: "active" },
      ];

      const result = resolveRecoveryOwner({
        kind: "review_participant_restore",
        candidates: pool,
      });

      expect(result.owner.agentId).toBe("agent-arch");
    });

    it("chooses secondary reviewer when lead and architect are absent", () => {
      const pool: RecoveryOwnerCandidate[] = [
        { id: "agent-rev", role: "secondary_reviewer", status: "active" },
        { id: "agent-eng", role: "engineer", status: "active" },
      ];

      const result = resolveRecoveryOwner({
        kind: "review_participant_restore",
        candidates: pool,
      });

      expect(result.owner.agentId).toBe("agent-rev");
    });
  });

  describe("Project Affinity", () => {
    it("prefers candidate matching input.projectId over unconstrained candidate", () => {
      const pool: RecoveryOwnerCandidate[] = [
        { id: "global-devops", role: "devops", projectId: null, status: "active" },
        { id: "project-devops", role: "devops", projectId: "proj-special", status: "active" },
      ];

      const result = resolveRecoveryOwner({
        kind: "ci_restart",
        projectId: "proj-special",
        candidates: pool,
      });

      expect(result.owner.agentId).toBe("project-devops");
    });
  });

  describe("SLA Overrides and Hierarchy", () => {
    it("honors custom SLA overrides", () => {
      const result = resolveRecoveryOwner({
        kind: "operator_action",
        candidates: BASE_CANDIDATES,
        slaOverrides: { operator_action: 45 },
        now: fixedNow,
      });

      expect(result.slaMinutes).toBe(45);
      const expectedTime = new Date(fixedNow.getTime() + 45 * 60 * 1000).toISOString();
      expect(result.nextCheckAt).toBe(expectedTime);
    });

    it("prefers manager (referenced by reportsTo) among candidates with the same role", () => {
      const pool: RecoveryOwnerCandidate[] = [
        { id: "agent-lead-sub", role: "lead", reportsTo: "agent-lead-mgr", status: "active" },
        { id: "agent-lead-mgr", role: "lead", status: "active" },
      ];

      const result = resolveRecoveryOwner({
        kind: "review_participant_restore",
        candidates: pool,
      });

      expect(result.owner.agentId).toBe("agent-lead-mgr");
    });
  });
});
