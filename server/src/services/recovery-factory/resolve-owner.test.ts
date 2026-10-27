import { describe, expect, it } from "vitest";
import {
  ISSUE_RECOVERY_ACTION_KINDS,
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
    it.each(ISSUE_RECOVERY_ACTION_KINDS)("resolves owner and SLA for kind %s", (kind) => {
      const result = resolveRecoveryOwner({
        kind,
        projectId: "proj-core",
        candidates: BASE_CANDIDATES,
        now: fixedNow,
      });

      expect(result).toBeDefined();
      expect(result.owner).toBeDefined();
      expect(typeof (result.owner as any).agentId).toBe("string");
      expect((result.owner as any).agentId.length).toBeGreaterThan(0);
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
  });

  describe("Criterion 3: User owners are excluded from technical recovery tasks", () => {
    it("skips user candidates when mixed with agent candidates for technical kinds", () => {
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

      expect(result.owner).toHaveProperty("agentId", "agent-devops-1");
    });

    it("throws RecoveryOwnerUnresolvedError when only user owners are present on technical kinds", () => {
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

  describe("Validation: now parameter", () => {
    it("throws RecoveryOwnerUnresolvedError on invalid string timestamp", () => {
      expect(() =>
        resolveRecoveryOwner({
          kind: "ci_restart",
          candidates: BASE_CANDIDATES,
          now: "invalid-iso-date-string",
        }),
      ).toThrow(RecoveryOwnerUnresolvedError);
    });

    it("throws RecoveryOwnerUnresolvedError on invalid Date object", () => {
      expect(() =>
        resolveRecoveryOwner({
          kind: "ci_restart",
          candidates: BASE_CANDIDATES,
          now: new Date("invalid"),
        }),
      ).toThrow(RecoveryOwnerUnresolvedError);
    });

    it("accepts valid ISO date strings and Date instances", () => {
      const resString = resolveRecoveryOwner({
        kind: "ci_restart",
        candidates: BASE_CANDIDATES,
        now: "2026-10-26T10:00:00.000Z",
      });
      expect(resString.nextCheckAt).toBe("2026-10-26T10:30:00.000Z");

      const resDate = resolveRecoveryOwner({
        kind: "ci_restart",
        candidates: BASE_CANDIDATES,
        now: new Date("2026-10-26T10:00:00.000Z"),
      });
      expect(resDate.nextCheckAt).toBe("2026-10-26T10:30:00.000Z");
    });
  });

  describe("Validation: unknown or invalid kind", () => {
    it("throws on unknown kind string", () => {
      expect(() =>
        resolveRecoveryOwner({
          kind: "unknown_bogus_kind",
          candidates: BASE_CANDIDATES,
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

  describe("Candidate identifier validation: кандидат без id", () => {
    it("skips candidate without id and agentId and picks valid candidate", () => {
      const pool: RecoveryOwnerCandidate[] = [
        { name: "Ghost DevOps", role: "devops", status: "active" }, // no id or agentId
        { id: "agent-valid-1", role: "devops", status: "active" },
      ];

      const result = resolveRecoveryOwner({
        kind: "ci_restart",
        candidates: pool,
      });

      expect(result.owner).toHaveProperty("agentId", "agent-valid-1");
    });

    it("throws RecoveryOwnerUnresolvedError when all candidates lack an identifier", () => {
      const pool: RecoveryOwnerCandidate[] = [
        { name: "Ghost 1", role: "devops", status: "active" },
        { id: "   ", role: "lead", status: "active" },
      ];

      expect(() =>
        resolveRecoveryOwner({
          kind: "ci_restart",
          candidates: pool,
        }),
      ).toThrow(RecoveryOwnerUnresolvedError);
    });
  });

  describe("Project matching and projectIds array", () => {
    it("matches candidate with matching project in projectIds array", () => {
      const pool: RecoveryOwnerCandidate[] = [
        {
          id: "agent-multi",
          role: "devops",
          projectIds: ["proj-alpha", "proj-core", "proj-beta"],
          status: "active",
        },
        {
          id: "agent-other",
          role: "devops",
          projectIds: ["proj-other"],
          status: "active",
        },
      ];

      const result = resolveRecoveryOwner({
        kind: "ci_restart",
        projectId: "proj-core",
        candidates: pool,
      });

      expect(result.owner).toHaveProperty("agentId", "agent-multi");
    });

    it("prefers exact project match in projectIds over unconstrained global candidate", () => {
      const pool: RecoveryOwnerCandidate[] = [
        { id: "global-devops", role: "devops", projectIds: [], status: "active" },
        { id: "project-devops", role: "devops", projectIds: ["proj-special"], status: "active" },
      ];

      const result = resolveRecoveryOwner({
        kind: "ci_restart",
        projectId: "proj-special",
        candidates: pool,
      });

      expect(result.owner).toHaveProperty("agentId", "project-devops");
    });

    it("filters out candidate when projectIds does not contain input.projectId", () => {
      const pool: RecoveryOwnerCandidate[] = [
        { id: "agent-wrong-proj", role: "devops", projectIds: ["proj-x", "proj-y"], status: "active" },
      ];

      expect(() =>
        resolveRecoveryOwner({
          kind: "ci_restart",
          projectId: "proj-target",
          candidates: pool,
        }),
      ).toThrow(RecoveryOwnerUnresolvedError);
    });
  });

  describe("Role & casteKey vs fragile title matching", () => {
    it("does not falsely identify 'Research Analyst' as architect via substring", () => {
      const pool: RecoveryOwnerCandidate[] = [
        {
          id: "agent-analyst",
          role: "researcher",
          title: "Research Analyst", // contains 'arch'
          status: "active",
        },
        {
          id: "agent-lead",
          role: "lead",
          title: "Team Lead",
          status: "active",
        },
      ];

      const result = resolveRecoveryOwner({
        kind: "review_participant_restore",
        candidates: pool,
      });

      // Must be agent-lead, agent-analyst is not an architect
      expect(result.owner).toHaveProperty("agentId", "agent-lead");
    });

    it("recognizes role passed via casteKey", () => {
      const pool: RecoveryOwnerCandidate[] = [
        {
          id: "agent-custom",
          casteKey: "architect",
          status: "active",
        },
        {
          id: "agent-eng",
          role: "engineer",
          status: "active",
        },
      ];

      const result = resolveRecoveryOwner({
        kind: "review_participant_restore",
        candidates: pool,
      });

      // Architect from casteKey ranks higher than engineer
      expect(result.owner).toHaveProperty("agentId", "agent-custom");
    });
  });

  describe("Role restriction per kind and status filtering", () => {
    it("disallows non-technical roles (marketer) on ci_restart", () => {
      const marketerPool: RecoveryOwnerCandidate[] = [
        { id: "agent-mkt-1", role: "marketing", casteKey: "marketing", status: "active" },
        { id: "agent-designer-1", role: "designer", status: "active" },
      ];

      expect(() =>
        resolveRecoveryOwner({
          kind: "ci_restart",
          candidates: marketerPool,
        }),
      ).toThrow(RecoveryOwnerUnresolvedError);
    });

    it("filters out paused and error agents in addition to terminated and archived", () => {
      const pool: RecoveryOwnerCandidate[] = [
        { id: "agent-paused", role: "devops", status: "paused" },
        { id: "agent-error", role: "devops", status: "error" },
        { id: "agent-terminated", role: "devops", status: "terminated" },
        { id: "agent-archived", role: "devops", status: "archived" },
        { id: "agent-pending", role: "devops", status: "pending_approval" },
        { id: "agent-healthy", role: "devops", status: "active" },
      ];

      const result = resolveRecoveryOwner({
        kind: "ci_restart",
        candidates: pool,
      });

      expect(result.owner).toHaveProperty("agentId", "agent-healthy");
    });

    it("throws when only paused or error agents are present", () => {
      const pool: RecoveryOwnerCandidate[] = [
        { id: "agent-paused", role: "devops", status: "paused" },
        { id: "agent-error", role: "devops", status: "error" },
      ];

      expect(() =>
        resolveRecoveryOwner({
          kind: "ci_restart",
          candidates: pool,
        }),
      ).toThrow(RecoveryOwnerUnresolvedError);
    });
  });

  describe("operator_action: user owners and serviceQueue support", () => {
    it("allows user owner for operator_action when no agent operator is present", () => {
      const poolWithUserOp: RecoveryOwnerCandidate[] = [
        { id: "usr-admin-1", userId: "usr-admin-1", role: "operator", isUser: true },
      ];

      const result = resolveRecoveryOwner({
        kind: "operator_action",
        candidates: poolWithUserOp,
      });

      expect(result.owner).toHaveProperty("userId", "usr-admin-1");
    });

    it("prefers agent operator over user operator for operator_action", () => {
      const poolMixed: RecoveryOwnerCandidate[] = [
        { id: "usr-op", userId: "usr-op-1", role: "operator", isUser: true },
        { id: "agent-op", role: "operator", status: "active" },
      ];

      const result = resolveRecoveryOwner({
        kind: "operator_action",
        candidates: poolMixed,
      });

      expect(result.owner).toHaveProperty("agentId", "agent-op");
    });

    it("allows serviceQueue candidate for operator_action", () => {
      const poolQueue: RecoveryOwnerCandidate[] = [
        { serviceQueue: "ops-triage-queue" },
      ];

      const result = resolveRecoveryOwner({
        kind: "operator_action",
        candidates: poolQueue,
      });

      expect(result.owner).toHaveProperty("serviceQueue", "ops-triage-queue");
    });

    it("falls back to input.serviceQueue for operator_action when candidate pool is empty", () => {
      const result = resolveRecoveryOwner({
        kind: "operator_action",
        candidates: [],
        serviceQueue: "ops-emergency",
      });

      expect(result.owner).toHaveProperty("serviceQueue", "ops-emergency");
      expect(result.slaMinutes).toBe(120);
    });

    it("falls back to input.serviceQueue for operator_action when candidates are ineligible", () => {
      const poolIneligible: RecoveryOwnerCandidate[] = [
        { id: "agent-paused", role: "operator", status: "paused" },
      ];

      const result = resolveRecoveryOwner({
        kind: "operator_action",
        candidates: poolIneligible,
        serviceQueue: "ops-fallback",
      });

      expect(result.owner).toHaveProperty("serviceQueue", "ops-fallback");
    });

    it("rejects malformed fallback queue identifiers", () => {
      expect(() => resolveRecoveryOwner({
        kind: "operator_action",
        candidates: [],
        serviceQueue: "../other-tenant",
      })).toThrow(RecoveryOwnerUnresolvedError);
    });

    it("rejects candidates that combine multiple owner identities", () => {
      expect(() => resolveRecoveryOwner({
        kind: "operator_action",
        candidates: [{ id: "agent-1", userId: "user-1", serviceQueue: "ops" }],
      })).toThrow(RecoveryOwnerUnresolvedError);
    });

    it("rejects a user candidate without a user identifier", () => {
      expect(() => resolveRecoveryOwner({
        kind: "operator_action",
        candidates: [{ id: "agent-1", isUser: true, role: "operator" }],
      })).toThrow(RecoveryOwnerUnresolvedError);
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

      expect((resultA.owner as any).agentId).toBe((resultB.owner as any).agentId);
      expect((resultA.owner as any).agentId).toBe((resultC.owner as any).agentId);
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

      expect(result.owner).toHaveProperty("agentId", "agent-lead");
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

      expect(result.owner).toHaveProperty("agentId", "agent-arch");
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

      expect(result.owner).toHaveProperty("agentId", "agent-rev");
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

      expect(result.owner).toHaveProperty("agentId", "agent-lead-mgr");
    });
  });
});
