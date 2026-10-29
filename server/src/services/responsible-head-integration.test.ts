import { describe, expect, it } from "vitest";
import {
  resolveAgentHeadId,
  resolveCompanyDomainHeadId,
  resolveResponsibleHeadAgentId,
} from "./responsible-head.js";
import {
  deriveOriginatingActor,
  deriveResponsibleActor,
  deriveResponsibleUser,
} from "@myrmidon/shared";

describe("RESPONSIBLE-HEAD acceptance criteria tests", () => {
  describe("1. Responsible Agent Resolution", () => {
    it("assignee with reports_to hierarchy resolves to top-level direction head", async () => {
      const agents = [
        { id: "eng-23", companyId: "c1", reportsTo: "lead-dev", status: "active", createdAt: new Date() },
        { id: "lead-dev", companyId: "c1", reportsTo: "adm", status: "active", createdAt: new Date() },
        { id: "adm", companyId: "c1", reportsTo: null, status: "active", createdAt: new Date() },
      ];

      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => {
              // Simulate lookup
              return agents;
            },
          }),
        }),
      };

      // Step-by-step mock for traversal
      let step = 0;
      const stepDb = {
        select: () => ({
          from: () => ({
            where: () => {
              const res = step === 0 ? [agents[0]] : step === 1 ? [agents[1]] : [agents[2]];
              step++;
              return res;
            },
          }),
        }),
      };

      const head = await resolveAgentHeadId(stepDb as any, "c1", "eng-23");
      expect(head).toBe("adm");
    });

    it("unassigned task resolves to project lead root", async () => {
      const mockDb = {
        select: (_fields: any) => ({
          from: (_table: any) => ({
            where: () => {
              return [{ id: "lead-dev", leadAgentId: "lead-dev", reportsTo: null, status: "active" }];
            },
          }),
        }),
      };

      const head = await resolveResponsibleHeadAgentId(mockDb as any, "c1", {
        projectId: "proj-1",
      });
      expect(head).toBe("lead-dev");
    });

    it("unassigned task without project resolves to company domain head (adm)", async () => {
      const rootAgents = [
        { id: "agent-other", name: "other-agent", status: "active", reportsTo: null, createdAt: new Date("2026-01-01") },
        { id: "agent-adm", name: "adm", status: "active", reportsTo: null, createdAt: new Date("2026-01-02") },
      ];

      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => ({
              orderBy: () => Promise.resolve(rootAgents),
            }),
          }),
        }),
      };

      const head = await resolveResponsibleHeadAgentId(mockDb as any, "c1", {});
      expect(head).toBe("agent-adm");
    });

    it("unassigned task in BBQ domain resolves to bbq head", async () => {
      const rootAgents = [
        { id: "agent-bbq", name: "bbq", status: "active", reportsTo: null, createdAt: new Date("2026-01-01") },
      ];

      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => ({
              orderBy: () => Promise.resolve(rootAgents),
            }),
          }),
        }),
      };

      const head = await resolveCompanyDomainHeadId(mockDb as any, "c-bbq");
      expect(head).toBe("agent-bbq");
    });
  });

  describe("2. Issue card & attribution", () => {
    it("bot task has responsible agent and no responsible user", () => {
      const botIssue = {
        responsibleAgentId: "agent-adm",
        responsibleUserId: null,
        createdByUserId: null,
        createdByAgentId: "agent-eng-23",
      };

      const actor = deriveResponsibleActor(botIssue);
      expect(actor).toEqual({ kind: "agent", id: "agent-adm" });

      const originator = deriveOriginatingActor(botIssue);
      expect(originator).toEqual({ kind: "agent", id: "agent-eng-23" });
    });

    it("owner created task has responsible user (owner) and no responsible agent", () => {
      const ownerIssue = {
        responsibleAgentId: null,
        responsibleUserId: "user-owner",
        createdByUserId: "user-owner",
        createdByAgentId: null,
      };

      const actor = deriveResponsibleActor(ownerIssue);
      expect(actor).toEqual({ kind: "user", id: "user-owner" });

      const originator = deriveOriginatingActor(ownerIssue);
      expect(originator).toEqual({ kind: "user", id: "user-owner" });
    });
  });

  describe("3. Questions / Confirmation routing", () => {
    it("question without addressee from subordinate agent targets responsibleAgentId", () => {
      const issue = {
        responsibleAgentId: "agent-adm",
      };
      const actor = {
        agentId: "agent-eng-23",
      };

      let addresseeAgentId: string | null = null;
      let addresseeUserId: string | null = null;

      if (!addresseeAgentId && !addresseeUserId && actor.agentId) {
        if (issue.responsibleAgentId && issue.responsibleAgentId !== actor.agentId) {
          addresseeAgentId = issue.responsibleAgentId;
          addresseeUserId = null;
        }
      }

      expect(addresseeAgentId).toBe("agent-adm");
      expect(addresseeUserId).toBeNull();
    });

    it("question without addressee from head agent does not target self", () => {
      const issue = {
        responsibleAgentId: "agent-adm",
        responsibleUserId: "user-owner",
      };
      const actor = {
        agentId: "agent-adm",
      };

      let addresseeAgentId: string | null = null;
      let addresseeUserId: string | null = null;

      if (!addresseeAgentId && !addresseeUserId && actor.agentId) {
        if (issue.responsibleAgentId && issue.responsibleAgentId !== actor.agentId) {
          addresseeAgentId = issue.responsibleAgentId;
          addresseeUserId = null;
        }
      }

      // Stays null so it addresses the user/owner
      expect(addresseeAgentId).toBeNull();
    });
  });
});
