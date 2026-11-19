import { describe, expect, it } from "vitest";
import type { Db } from "@myrmidon/db";
import { resolvePlanApprovalRecipient } from "./plan-approval-recipient.js";

type MockAgent = {
  id: string;
  name?: string;
  role?: string;
  status?: string;
  pausedAt?: Date | null;
  reportsTo?: string | null;
};

function createMockDb(agents: MockAgent[]): Db {
  const rows = agents.map((a) => ({
    id: a.id,
    name: a.name ?? a.id,
    role: a.role ?? "general",
    status: a.status ?? "active",
    pausedAt: a.pausedAt ?? null,
    reportsTo: a.reportsTo ?? null,
  }));
  return {
    select: () => ({ from: () => ({ where: async () => rows }) }),
  } as unknown as Db;
}

describe("resolvePlanApprovalRecipient", () => {
  it("routes to the lead in the executor's manager chain", async () => {
    const db = createMockDb([
      { id: "eng-1", role: "engineer", reportsTo: "lead-1" },
      { id: "lead-1", role: "lead" },
      { id: "arch-1", role: "architect" },
    ]);
    expect(await resolvePlanApprovalRecipient(db, "c", null, "eng-1")).toBe("lead-1");
  });

  it("falls back to any invokable architect when the chain has none", async () => {
    const db = createMockDb([
      { id: "eng-1", role: "engineer" },
      { id: "lead-1", role: "lead", status: "paused", pausedAt: new Date() },
      { id: "arch-1", role: "architect" },
    ]);
    expect(await resolvePlanApprovalRecipient(db, "c", null, "eng-1")).toBe("arch-1");
  });

  it("never returns the executor, even when it is a lead", async () => {
    const db = createMockDb([{ id: "lead-1", role: "lead" }]);
    expect(await resolvePlanApprovalRecipient(db, "c", null, "lead-1")).toBeNull();
  });

  it("uses the agent named adm only as the last fallback", async () => {
    const db = createMockDb([
      { id: "eng-1", role: "engineer" },
      { id: "adm-1", name: "adm", role: "general" },
    ]);
    expect(await resolvePlanApprovalRecipient(db, "c", null, "eng-1")).toBe("adm-1");
  });

  it("returns null instead of picking an arbitrary domain head", async () => {
    const db = createMockDb([
      { id: "eng-1", role: "engineer" },
      { id: "bbq-head", name: "bbq-head", role: "general" },
    ]);
    expect(await resolvePlanApprovalRecipient(db, "c", null, "eng-1")).toBeNull();
  });
});
