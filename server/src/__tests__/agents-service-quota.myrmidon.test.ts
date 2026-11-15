// server/src/__tests__/agents-service-quota.myrmidon.test.ts
//
// myrmidon(1.7 TIER-QUOTA-CHECK OPE-12092): agent creation quota check per company subscription tier.
// Acceptance criteria:
// - Creating agent within quota -> succeeds
// - Creating agent over tier quota -> 403 with code quota_exceeded
// - Tier absent -> defaults to tier 'free' with quota = 5
// - CI green

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";
import { createAgentsModule } from "../modules/agents/index.js";
import type { CompanyTierReader } from "../modules/agents/application/ports.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("agent creation quota check (1.7 TIER-QUOTA-CHECK)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-quota-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    // company_tiers ships with 1.7 TIER-SCHEMA (OPE-12091) and is not part of
    // this task's schema; these fixtures use the reader's default-tier path.
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
        name: "Quota Co",
        issuePrefix: `QC${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      });
    return companyId;
  }

  const baseAgent = {
    name: "agent-quota-test",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
  };

  it("within quota: agent is created successfully", async () => {
    const companyId = await seedCompany();
    const fakeReader: CompanyTierReader = {
      getCompanyTier: async () => ({ tier: "pro", agentQuota: 3 }),
      countActiveAgents: async () => 1,
    };
    const agentsMod = createAgentsModule(db, { reader: fakeReader });
    const svc = agentService(db, { agentsModule: agentsMod });

    const created = await svc.create(companyId, {
      ...baseAgent,
      name: "agent-1",
    });

    expect(created).not.toBeNull();
    expect(created?.name).toBe("agent-1");
  });

  it("over quota: rejects with 403 and code quota_exceeded", async () => {
    const companyId = await seedCompany();
    const fakeReader: CompanyTierReader = {
      getCompanyTier: async () => ({ tier: "starter", agentQuota: 2 }),
      countActiveAgents: async () => 2,
    };
    const agentsMod = createAgentsModule(db, { reader: fakeReader });
    const svc = agentService(db, { agentsModule: agentsMod });

    await expect(
      svc.create(companyId, {
        ...baseAgent,
        name: "agent-over-quota",
      }),
    ).rejects.toMatchObject({
      status: 403,
      details: { code: "quota_exceeded" },
    });

    // Verify agent was not written
    const rows = await db.select().from(agents);
    expect(rows).toHaveLength(0);
  });

  it("tier absent: defaults to tier 'free' with quota 5 (within quota succeeds)", async () => {
    const companyId = await seedCompany();
    const fakeReader: CompanyTierReader = {
      getCompanyTier: async () => null,
      countActiveAgents: async () => 4,
    };
    const agentsMod = createAgentsModule(db, { reader: fakeReader });
    const svc = agentService(db, { agentsModule: agentsMod });

    const created = await svc.create(companyId, {
      ...baseAgent,
      name: "agent-default-tier-ok",
    });

    expect(created).not.toBeNull();
    expect(created?.name).toBe("agent-default-tier-ok");
  });

  it("tier absent: defaults to tier 'free' with quota 5 (at quota rejects with 403 quota_exceeded)", async () => {
    const companyId = await seedCompany();
    const fakeReader: CompanyTierReader = {
      getCompanyTier: async () => null,
      countActiveAgents: async () => 5,
    };
    const agentsMod = createAgentsModule(db, { reader: fakeReader });
    const svc = agentService(db, { agentsModule: agentsMod });

    await expect(
      svc.create(companyId, {
        ...baseAgent,
        name: "agent-default-tier-rejected",
      }),
    ).rejects.toMatchObject({
      status: 403,
      details: { code: "quota_exceeded" },
    });
  });
});
