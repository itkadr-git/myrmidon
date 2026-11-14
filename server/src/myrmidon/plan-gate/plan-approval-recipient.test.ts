import { describe, expect, it } from "vitest";
import type { Db } from "@myrmidon/db";
import { resolvePlanApprovalRecipient } from "./plan-approval-recipient.js";

type MockDbConfig = {
  projectLead?: string | null;
  agents?: Array<{ id: string; name?: string; status: string; pausedAt: Date | null }>;
};

function createMockDb(config: MockDbConfig): Db {
  const selectImpl = () => ({
    from: (table: { _: { name: string } }) => ({
      where: () => ({
        limit: async () => {
          if (table._.name === "projects") {
            return config.projectLead !== undefined ? [{ leadAgentId: config.projectLead }] : [];
          }
          if (table._.name === "agents") {
            const agent = config.agents?.find((a) => a.id === config.projectLead);
            return agent ? [agent] : [];
          }
          return [];
        },
        then: <TResult1 = unknown>(
          onfulfilled?: (value: Array<{ id: string; name: string; status: string; pausedAt: Date | null }>) => TResult1 | PromiseLike<TResult1>,
        ) => {
          const list = (config.agents ?? []).map((a) => ({
            id: a.id,
            name: a.name ?? a.id,
            status: a.status,
            pausedAt: a.pausedAt,
          }));
          return Promise.resolve(list).then(onfulfilled);
        },
      }),
    }),
  });

  return { select: selectImpl } as unknown as Db;
}

describe("resolvePlanApprovalRecipient", () => {
  it("routes to project lead when active and distinct from executor", async () => {
    const mockDb = createMockDb({
      projectLead: "lead-1",
      agents: [{ id: "lead-1", name: "Lead", status: "active", pausedAt: null }],
    });

    const recipient = await resolvePlanApprovalRecipient(
      mockDb,
      "company-1",
      "project-1",
      "engineer-1",
    );
    expect(recipient).toBe("lead-1");
  });

  it("falls back to adm when project lead is paused or same as executor", async () => {
    const mockDb = createMockDb({
      projectLead: "lead-1",
      agents: [
        { id: "lead-1", name: "Lead", status: "paused", pausedAt: new Date() },
        { id: "adm-1", name: "adm", status: "active", pausedAt: null },
      ],
    });

    const recipient = await resolvePlanApprovalRecipient(
      mockDb,
      "company-1",
      "project-1",
      "engineer-1",
    );
    expect(recipient).toBe("adm-1");
  });

  it("falls back to adm when project has no lead", async () => {
    const mockDb = createMockDb({
      projectLead: null,
      agents: [{ id: "adm-1", name: "adm", status: "active", pausedAt: null }],
    });

    const recipient = await resolvePlanApprovalRecipient(
      mockDb,
      "company-1",
      null,
      "engineer-1",
    );
    expect(recipient).toBe("adm-1");
  });
});
