import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { myrmidonFleetOnboardJobs, myrmidonFleetServers } from "@myrmidon/db";
import { onboardRoutes } from "../myrmidon/server-onboard/routes.js";
import { onboardService } from "../myrmidon/server-onboard/service.js";
import { fleetOnboardStore } from "../myrmidon/server-onboard/store.js";
import {
  describeEmbeddedPostgres, routeApp, seedCompanyWithBoardAccess, useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

const token = "test-only-executor-token";
const container = (digit: string) => ({ kind: "role_container" as const, containerId: digit.repeat(64) });

describeEmbeddedPostgres("fleet owned inventory HTTP and persistence contract", () => {
  const ctx = useEmbeddedPostgres("fleet-owned-inventory");

  async function fixture() {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Owned inventory");
    const store = fleetOnboardStore(ctx.db);
    const server = await store.createServer(companyId, {
      slug: `owned-${randomUUID()}`, name: "Owned inventory", hostname: "192.0.2.1",
      port: 22, username: "deploy", role: "generic", passwordSecretKey: null,
      accessKeySecretKey: null, keepPassword: false,
    });
    const job = await store.createJob({ companyId, serverId: server.id, kind: "onboard", createdBy: null });
    const service = onboardService(ctx.db, {
      store, settings: { enabled: true, executorToken: token, stepTimeoutMs: 3600000, tickMs: 60000, allowKeepPassword: false },
      secrets: { putSecret: async () => { throw new Error("Unexpected secret write"); }, readSecret: async () => null, deleteSecret: async () => {} },
      getServer: (company, id) => store.getServerById(company, id),
      logActivity: vi.fn().mockResolvedValue(undefined),
    });
    const app = routeApp(ctx.db, actor, () => onboardRoutes({ service }));
    const report = () => request(app).post(`/api/myrmidon/fleet/onboard-jobs/${job.id}/owned-resources`);
    const read = () => store.getServerById(companyId, server.id);
    return { companyId, server, job, store, app, report, read };
  }

  it("applies the migration without assigning ownership to preexisting rows", async () => {
    const migration = await readFile(new URL("../../../packages/db/src/migrations/0495_fleet_ownership_inventory.sql", import.meta.url), "utf8");
    await ctx.db.transaction(async (tx) => {
      // A temporary table shadows the real registry only on this connection.
      await tx.execute(sql`CREATE TEMP TABLE myrmidon_fleet_servers (id uuid PRIMARY KEY) ON COMMIT DROP`);
      const id = randomUUID();
      await tx.execute(sql`INSERT INTO myrmidon_fleet_servers (id) VALUES (${id}::uuid)`);
      await tx.execute(sql.raw(migration));
      const rows = await tx.execute(sql`SELECT ownership_inventory FROM myrmidon_fleet_servers WHERE id = ${id}::uuid`);
      expect(Array.from(rows)).toEqual([{ ownership_inventory: null }]);
    });
  });

  it("requires the documented executor header and delivers persisted inventory in the next claim", async () => {
    const f = await fixture();
    const claim = () => request(f.app).post("/api/myrmidon/fleet/onboard-jobs/claim")
      .set("x-onboard-token", token).send({ companyId: f.companyId });
    expect((await claim()).body.ownershipInventory).toBeNull();
    const body = { companyId: f.companyId, resource: container("a") };
    expect((await f.report().send(body)).status).toBe(401);
    expect((await f.report().set("Authorization", `Bearer ${token}`).send(body)).status).toBe(401);
    expect((await f.report().set("x-onboard-token", "wrong").send(body)).status).toBe(401);
    expect((await f.read())?.ownershipInventory).toBeNull();
    const response = await f.report().set("x-onboard-token", token).send(body);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ companyId: f.companyId, serverId: f.server.id,
      resources: [{ jobId: f.job.id, resource: body.resource }] });
    expect((await f.read())?.ownershipInventory).toEqual(response.body);
    await f.store.updateJob(f.companyId, f.job.id, { status: "succeeded" });
    await f.store.createJob({ companyId: f.companyId, serverId: f.server.id, kind: "decommission", createdBy: null });
    const next = await claim();
    expect(next.status).toBe(200);
    expect(next.body.job.kind).toBe("decommission");
    expect(next.body.ownershipInventory).toEqual(response.body);
  });

  it("serializes distinct appends and preserves the first owner across duplicate reports and later jobs", async () => {
    const f = await fixture();
    await f.store.updateJob(f.companyId, f.job.id, { status: "claimed" });
    await Promise.all(["a", "b"].map((digit) => f.store.recordOwnedResource(f.companyId, f.server.id, f.job.id, container(digit))));
    const first = (await f.read())?.ownershipInventory;
    expect(first?.resources.map((entry) => entry.resource)).toEqual(expect.arrayContaining([container("a"), container("b")]));
    expect(first?.resources).toHaveLength(2);
    await f.store.updateJob(f.companyId, f.job.id, { status: "succeeded" });
    const later = await f.store.createJob({ companyId: f.companyId, serverId: f.server.id, kind: "onboard", createdBy: null });
    await f.store.updateJob(f.companyId, later.id, { status: "running" });
    await f.store.recordOwnedResource(f.companyId, f.server.id, later.id, container("a"));
    expect((await f.read())?.ownershipInventory).toEqual(first);
  });

  it("commits only scoped firewall ownership with successful hardening", async () => {
    const f = await fixture();
    await f.store.updateJob(f.companyId, f.job.id, { status: "claimed" });
    const report = (body: object) => request(f.app).post(`/api/myrmidon/fleet/onboard-jobs/${f.job.id}/report`)
      .set("x-onboard-token", token).send({ companyId: f.companyId, ...body });
    const resource = { kind: "firewall_rule", backend: "ufw", rule: "allow 22/tcp", marker: `myrmidon:${f.companyId}:${f.server.id}:${randomUUID()}` };
    expect((await report({ status: "failed", ownedFirewallRule: resource })).status).toBe(400);
    expect((await report({ status: "succeeded", ownedFirewallRule: resource })).status).toBe(409);
    expect((await report({ step: "harden", result: "ok" })).status).toBe(200);
    expect((await report({ status: "succeeded", ownedFirewallRule: { ...resource, marker: `myrmidon:${f.companyId}:${randomUUID()}:${randomUUID()}` } })).status).toBe(400);
    expect((await f.read())?.ownershipInventory).toBeNull();
    expect((await f.store.getJob(f.companyId, f.job.id))?.status).toBe("claimed");
    expect((await report({ status: "succeeded", ownedFirewallRule: resource })).status).toBe(200);
    expect(await f.read()).toMatchObject({ onboardState: "ready", ownershipInventory: { resources: [{ jobId: f.job.id, resource }] } });
    expect((await f.store.getJob(f.companyId, f.job.id))?.status).toBe("succeeded");
  });

  it("rejects foreign scopes and rolls back corrupt inventory without replacing it", async () => {
    const f = await fixture();
    const foreign = await fixture();
    await f.store.updateJob(f.companyId, f.job.id, { status: "claimed" });
    await expect(f.store.recordOwnedResource(foreign.companyId, f.server.id, f.job.id, container("a"))).rejects.toThrow();
    await expect(f.store.recordOwnedResource(f.companyId, foreign.server.id, f.job.id, container("a"))).rejects.toThrow();
    await expect(f.store.recordOwnedResource(f.companyId, f.server.id, foreign.job.id, container("a"))).rejects.toThrow();
    expect((await f.read())?.ownershipInventory).toBeNull();
    await ctx.db.execute(sql`UPDATE myrmidon_fleet_servers SET ownership_inventory = '{"version":999}'::jsonb WHERE id = ${f.server.id}::uuid`);
    await expect(f.store.recordOwnedResource(f.companyId, f.server.id, f.job.id, container("a"))).rejects.toThrow();
    const [row] = await ctx.db.select().from(myrmidonFleetServers).where(eq(myrmidonFleetServers.id, f.server.id));
    expect(row?.ownershipInventory).toEqual({ version: 999 });
  });

  it("does not append when a terminal transition wins the job lock", async () => {
    const f = await fixture();
    await f.store.updateJob(f.companyId, f.job.id, { status: "claimed" });
    let pending: Promise<unknown> | undefined;
    await ctx.db.transaction(async (tx) => {
      await tx.update(myrmidonFleetOnboardJobs).set({ status: "succeeded" }).where(eq(myrmidonFleetOnboardJobs.id, f.job.id));
      // The append starts while the terminal transaction still holds the job lock.
      pending = expect(f.store.recordOwnedResource(f.companyId, f.server.id, f.job.id, container("a"))).rejects.toThrow();
    });
    await pending;
    expect((await f.read())?.ownershipInventory).toBeNull();
  });
});
