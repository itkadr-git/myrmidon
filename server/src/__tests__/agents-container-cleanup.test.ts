// server/src/__tests__/agents-container-cleanup.test.ts
//
// myrmidon(OPE-12477): terminating or deleting an agent with an enabled
// bot-container card must clean up the fleetd container and the bot's host data
// BEFORE the row changes or disappears, and a failed cleanup must fail the
// operation loudly (no silent success that would orphan a running container on
// a remote site). The port is injected, so these tests exercise the service
// contract with a mock cleanup callback — the driver itself is covered by
// fleetd-driver.myrmidon.test.ts and the Go daemon test (main_test.go
// TestCleanup).
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb } from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent container-cleanup tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent service bot container cleanup (OPE-12477)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-container-cleanup-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const containerCard = {
    container: {
      enabled: true,
      image: "ghcr.io/example/hermes-bot:stable",
      memoryMb: 1024,
      cpus: 1,
      pidsLimit: 512,
    },
  };

  async function seedContainerAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Cleanup ${companyId.slice(0, 6).toUpperCase()}`,
      issuePrefix: `CC${companyId.slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Container Bot",
      role: "engineer",
      status: "idle",
      adapterType: "hermes_gateway",
      adapterConfig: containerCard,
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("terminate calls cleanup for an enabled container agent before the status changes", async () => {
    const { agentId } = await seedContainerAgent();
    const cleanupBotContainer = vi.fn();
    const svc = agentService(db, { cleanupBotContainer });

    await svc.terminate(agentId);

    expect(cleanupBotContainer).toHaveBeenCalledTimes(1);
    expect(cleanupBotContainer.mock.calls[0]?.[0]).toMatchObject({ id: agentId, adapterType: "hermes_gateway" });
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(row?.status).toBe("terminated");
  });

  it("remove calls cleanup for an enabled container agent before the row is deleted", async () => {
    const { companyId, agentId } = await seedContainerAgent();
    const cleanupBotContainer = vi.fn();
    const svc = agentService(db, { cleanupBotContainer });

    await svc.remove(agentId);

    expect(cleanupBotContainer).toHaveBeenCalledTimes(1);
    expect(cleanupBotContainer.mock.calls[0]?.[0]).toMatchObject({ id: agentId, adapterType: "hermes_gateway" });
    expect(await db.select().from(agents).where(eq(agents.id, agentId))).toEqual([]);
    expect(await db.select().from(companies).where(eq(companies.id, companyId))).toHaveLength(1);
  });

  it("a failed cleanup aborts terminate and leaves the agent running (no silent success)", async () => {
    const { agentId } = await seedContainerAgent();
    const cleanupBotContainer = vi.fn().mockRejectedValue(new Error("fleetd 500 failed to remove container"));
    const svc = agentService(db, { cleanupBotContainer });

    await expect(svc.terminate(agentId)).rejects.toThrow(/fleetd 500/);

    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(row?.status).toBe("idle");
  });

  it("a failed cleanup aborts remove and keeps the agent row (retryable delete)", async () => {
    const { agentId } = await seedContainerAgent();
    const cleanupBotContainer = vi.fn().mockRejectedValue(new Error("fleetd 502 bot_not_enrolled"));
    const svc = agentService(db, { cleanupBotContainer });

    await expect(svc.remove(agentId)).rejects.toThrow(/fleetd 502/);

    expect(await db.select().from(agents).where(eq(agents.id, agentId))).toHaveLength(1);
  });

  it("skips cleanup for a card without container.enabled", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Plain ${companyId.slice(0, 6).toUpperCase()}`,
      issuePrefix: `CP${companyId.slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Plain Agent",
      role: "engineer",
      status: "idle",
      adapterType: "hermes_gateway",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const cleanupBotContainer = vi.fn();
    const svc = agentService(db, { cleanupBotContainer });

    await svc.remove(agentId);

    expect(cleanupBotContainer).not.toHaveBeenCalled();
    expect(await db.select().from(agents).where(eq(agents.id, agentId))).toEqual([]);
  });

  it("skips cleanup when no cleanup port is wired (runtime disabled)", async () => {
    const { agentId } = await seedContainerAgent();
    // No ports: the pre-runtime behavior — delete without a container call.
    const svc = agentService(db);

    await svc.remove(agentId);

    expect(await db.select().from(agents).where(eq(agents.id, agentId))).toEqual([]);
  });
});
