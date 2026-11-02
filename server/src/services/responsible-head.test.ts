import { describe, expect, it } from "vitest";
import {
  resolveAgentHeadId,
  resolveCompanyDomainHeadId,
  resolveResponsibleHeadAgentId,
} from "./responsible-head.js";

type AgentRecord = {
  id: string;
  companyId: string;
  name: string;
  status: string;
  reportsTo: string | null;
  createdAt: Date;
};

type ProjectRecord = {
  id: string;
  companyId: string;
  leadAgentId: string | null;
};

function createMockReader(options: {
  agents?: AgentRecord[];
  projects?: ProjectRecord[];
}) {
  const agentsList = options.agents ?? [];
  const projectsList = options.projects ?? [];

  return {
    select: (_fields?: unknown) => ({
      from: (table: unknown) => ({
        where: (_cond: unknown) => ({
          orderBy: () => Promise.resolve(agentsList),
          then: (fn: (rows: unknown[]) => unknown) => {
            return Promise.resolve(fn(agentsList));
          },
        }),
        orderBy: () => Promise.resolve(agentsList),
      }),
    }),
  };
}

describe("resolveAgentHeadId", () => {
  it("returns the agent itself if reportsTo is null", async () => {
    const agents: AgentRecord[] = [
      {
        id: "agent-adm",
        companyId: "comp-1",
        name: "adm",
        status: "active",
        reportsTo: null,
        createdAt: new Date("2026-01-01"),
      },
    ];

    const mockDb = {
      select: () => ({
        from: () => ({
          where: () => [agents[0]],
        }),
      }),
    };

    const headId = await resolveAgentHeadId(mockDb as any, "comp-1", "agent-adm");
    expect(headId).toBe("agent-adm");
  });

  it("traverses up the reportsTo hierarchy to the root agent", async () => {
    const agentMap: Record<string, AgentRecord> = {
      "agent-eng": {
        id: "agent-eng",
        companyId: "comp-1",
        name: "adm-dev-eng-23",
        status: "active",
        reportsTo: "agent-lead",
        createdAt: new Date("2026-02-01"),
      },
      "agent-lead": {
        id: "agent-lead",
        companyId: "comp-1",
        name: "adm-dev-lead",
        status: "active",
        reportsTo: "agent-adm",
        createdAt: new Date("2026-01-15"),
      },
      "agent-adm": {
        id: "agent-adm",
        companyId: "comp-1",
        name: "adm",
        status: "active",
        reportsTo: null,
        createdAt: new Date("2026-01-01"),
      },
    };

    const mockDb = {
      select: () => ({
        from: () => ({
          where: (_cond: any) => {
            // Find which agent is queried by id in where condition
            return Object.values(agentMap);
          },
        }),
      }),
    };

    // More precise mock that returns the specific agent:
    const preciseDb = {
      select: () => ({
        from: () => ({
          where: (cond: any) => {
            const id = cond?.right?.value ?? cond?.queryChunks?.[3]?.value;
            // Lookup from map if passed
            return id && agentMap[id] ? [agentMap[id]] : [];
          },
        }),
      }),
    };

    // Test with functional mock:
    let currentLookup: string | null = null;
    const testDb = {
      select: () => ({
        from: () => ({
          where: () => {
            const agent = currentLookup ? agentMap[currentLookup] : null;
            return agent ? [agent] : [];
          },
        }),
      }),
    };

    // Step-by-step resolution simulation:
    const stepDb = {
      select: () => ({
        from: () => ({
          where: () => {
            const res = agentMap[callIndex === 0 ? "agent-eng" : callIndex === 1 ? "agent-lead" : "agent-adm"];
            callIndex++;
            return res ? [res] : [];
          },
        }),
      }),
    };
    let callIndex = 0;

    const headId = await resolveAgentHeadId(stepDb as any, "comp-1", "agent-eng");
    expect(headId).toBe("agent-adm");
  });
});

describe("resolveCompanyDomainHeadId", () => {
  it("prioritizes known direction heads (adm, bbq, work, life, dispatch)", async () => {
    const rootAgents: AgentRecord[] = [
      {
        id: "agent-other",
        companyId: "comp-1",
        name: "general-bot",
        status: "active",
        reportsTo: null,
        createdAt: new Date("2026-01-01"),
      },
      {
        id: "agent-adm",
        companyId: "comp-1",
        name: "adm",
        status: "active",
        reportsTo: null,
        createdAt: new Date("2026-01-02"),
      },
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

    const headId = await resolveCompanyDomainHeadId(mockDb as any, "comp-1");
    expect(headId).toBe("agent-adm");
  });

  it("prioritizes prefix matches when exact name is not present", async () => {
    const rootAgents: AgentRecord[] = [
      {
        id: "agent-other",
        companyId: "comp-1",
        name: "bot-alpha",
        status: "active",
        reportsTo: null,
        createdAt: new Date("2026-01-01"),
      },
      {
        id: "agent-bbq",
        companyId: "comp-1",
        name: "bbq-coordinator",
        status: "active",
        reportsTo: null,
        createdAt: new Date("2026-01-02"),
      },
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

    const headId = await resolveCompanyDomainHeadId(mockDb as any, "comp-1");
    expect(headId).toBe("agent-bbq");
  });
});

describe("resolveResponsibleHeadAgentId", () => {
  it("resolves via assignee hierarchy if assignee is provided", async () => {
    const mockDb = {
      select: () => ({
        from: () => ({
          where: () => [{ id: "agent-adm", reportsTo: null, status: "active" }],
        }),
      }),
    };

    const headId = await resolveResponsibleHeadAgentId(mockDb as any, "comp-1", {
      assigneeAgentId: "agent-adm",
    });
    expect(headId).toBe("agent-adm");
  });

  it("resolves via company domain head for unassigned issues", async () => {
    const rootAgents = [
      { id: "agent-adm", name: "adm", status: "active", reportsTo: null, createdAt: new Date() },
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

    const headId = await resolveResponsibleHeadAgentId(mockDb as any, "comp-1", {});
    expect(headId).toBe("agent-adm");
  });
});
