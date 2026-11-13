// server/src/__tests__/agents-service-name-uniqueness.myrmidon.test.ts
//
// myrmidon(OPE-13035): agent names are unique per company without regard to
// letter case. Creating an agent with a name that differs from an existing
// one only by case is a 409 conflict that writes nothing; renaming an agent
// to such a name is refused and leaves the old name in place; a rename that
// keeps the agent's own name (even with different casing) is allowed.
//
// Neutral data only: agent-a / AGENT-A in company-a.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("agent name uniqueness (case-insensitive, per company)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-name-uniqueness-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db
      .insert(companies)
      .values({
        id: companyId,
        name: "Name Co",
        issuePrefix: `NC${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      });
    return companyId;
  }

  const baseAgent = {
    name: "agent-a",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
  };

  it("create with a name differing only by case is a 409 and writes nothing", async () => {
    const companyId = await seedCompany();
    const svc = agentService(db);
    const created = await svc.create(companyId, { ...baseAgent, name: "alpha" });
    expect(created?.name).toBe("alpha");

    await expect(svc.create(companyId, { ...baseAgent, name: "ALPHA" })).rejects.toMatchObject({
      status: 409,
      details: { code: "agent_name_conflict" },
    });

    const rows = await db.select().from(agents);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("alpha");
  });

  it("create with a unique name is accepted", async () => {
    const companyId = await seedCompany();
    const svc = agentService(db);
    await svc.create(companyId, { ...baseAgent, name: "alpha" });
    const second = await svc.create(companyId, { ...baseAgent, name: "beta" });
    expect(second?.name).toBe("beta");

    // Same shortname, different full name: not a name collision.
    const third = await svc.create(companyId, { ...baseAgent, name: "Alpha Two" });
    expect(third?.name).toBe("Alpha Two");
  });

  it("rename to a name differing only by case is a 409 and keeps the old name", async () => {
    const companyId = await seedCompany();
    const svc = agentService(db);
    const first = await svc.create(companyId, { ...baseAgent, name: "alpha" });
    const second = await svc.create(companyId, { ...baseAgent, name: "beta" });

    await expect(svc.update(second!.id, { name: "ALPHA" })).rejects.toMatchObject({
      status: 409,
      details: { code: "agent_name_conflict" },
    });

    const after = await svc.getById(second!.id);
    expect(after?.name).toBe("beta");
    expect(first).not.toBeNull();
  });

  it("rename that keeps the agent's own name is allowed even with different casing", async () => {
    const companyId = await seedCompany();
    const svc = agentService(db);
    const created = await svc.create(companyId, { ...baseAgent, name: "Alpha" });

    const sameCase = await svc.update(created!.id, { name: "Alpha" });
    expect(sameCase?.name).toBe("Alpha");

    const otherCase = await svc.update(created!.id, { name: "ALPHA" });
    expect(otherCase?.name).toBe("ALPHA");
  });

  it("names are scoped per company: the same name in another company is fine", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const svc = agentService(db);
    await svc.create(companyId, { ...baseAgent, name: "shared-name" });
    const other = await svc.create(otherCompanyId, { ...baseAgent, name: "SHARED-NAME" });
    expect(other?.name).toBe("SHARED-NAME");
  });
});
