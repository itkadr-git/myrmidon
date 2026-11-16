import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agentWakeupRequests, agents, companies, createDb, heartbeatRuns, instanceSettings, issueClaims, issueLabels, issues, labels } from "@myrmidon/db";
import { eq } from "drizzle-orm";
import { resolveSwarmClaimSettings } from "@myrmidon/shared";
import { matchCompany, type SwarmMatcherDeps } from "../myrmidon/swarm-claim/matcher.js";
import { idlePickupCandidateRows } from "../myrmidon/idle-pickup.js";
import { runViolatesReleaseFocus } from "../myrmidon/release-focus.js";
import { runPriorityService } from "../myrmidon/run-priority/service.js";
import { syncRunPriorityFromStore } from "../myrmidon/run-priority/sync.js";
import { applyCompanyReleaseFocus, resetRunPriorityForTests } from "../myrmidon/run-priority/state.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("company boundaries in dispatch and release focus", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("myrmidon-company-boundaries-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterEach(async () => {
    resetRunPriorityForTests();
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueClaims);
    await db.delete(issueLabels);
    await db.delete(labels);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });
  afterAll(async () => { await database?.cleanup(); });

  async function seed(prefix: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const current = randomUUID();
    const other = randomUUID();
    const currentLabel = randomUUID();
    const otherLabel = randomUUID();
    await db.insert(companies).values({ id: companyId, name: prefix, issuePrefix: prefix });
    await db.insert(agents).values({ id: agentId, companyId, name: "engineer", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {} });
    await db.insert(issues).values([
      { id: current, companyId, title: "current", status: "todo" },
      { id: other, companyId, title: "other", status: "todo", assigneeAgentId: agentId },
    ]);
    await db.insert(labels).values([
      { id: currentLabel, companyId, name: "1.7", color: "#123456" },
      { id: otherLabel, companyId, name: "1.8", color: "#123456" },
    ]);
    await db.insert(issueLabels).values([
      { companyId, issueId: current, labelId: currentLabel },
      { companyId, issueId: other, labelId: otherLabel },
    ]);
    return { companyId, agentId, current, other };
  }

  it("matches only the selected company's engineer and task when roles and labels coincide", async () => {
    const adm = await seed("ADM");
    const others = await Promise.all([seed("BBQ"), seed("WRK"), seed("LIF")]);
    applyCompanyReleaseFocus(new Map([[adm.companyId, { currentRelease: "1.7", strictReleaseFocus: true }]]));
    const beforeIssues = await db.select().from(issues);
    const beforeAgents = await db.select().from(agents);
    const wakes: string[] = [];
    const deps = {
      db,
      heartbeat: { wakeup: async (agentId: string) => { wakes.push(agentId); return { id: randomUUID() }; } },
      settings: { ...resolveSwarmClaimSettings({ env: {} }).settings, enabled: true },
      hostGateOpen: true,
      now: new Date(),
    } as unknown as SwarmMatcherDeps;
    const result = await matchCompany(deps, adm.companyId);
    expect(result.pairs.map(({ issueId, agentId }) => ({ issueId, agentId }))).toEqual([{ issueId: adm.current, agentId: adm.agentId }]);
    expect(wakes).toEqual([adm.agentId]);
    expect(await db.select().from(agents)).toEqual(beforeAgents);
    for (const company of others) {
      const actual = await db.select().from(issues).where(eq(issues.companyId, company.companyId));
      expect(actual).toEqual(beforeIssues.filter((row) => row.companyId === company.companyId));
      expect(await db.select().from(issueClaims).where(eq(issueClaims.companyId, company.companyId))).toEqual([]);
      expect(await idlePickupCandidateRows(db, adm.companyId, company.agentId)).toEqual([]);
    }
  });

  it("persists company focus and restores it during cross-process refresh", async () => {
    const adm = await seed("ADM");
    const other = await seed("BBQ");
    const service = runPriorityService(db);
    const actor = { actorType: "user" as const, actorId: "operator", agentId: null, runId: null, agentApiKeyId: null };
    await service.updateCompany(adm.companyId, { currentRelease: "1.7", strictReleaseFocus: true }, actor);
    expect(await service.readCompany(adm.companyId)).toEqual({ currentRelease: "1.7", strictReleaseFocus: true });
    expect(await service.readCompany(other.companyId)).toEqual({ currentRelease: null, strictReleaseFocus: false });
    resetRunPriorityForTests();
    await syncRunPriorityFromStore(db);
    expect(await runViolatesReleaseFocus(db, { companyId: adm.companyId, agentId: adm.agentId, issueId: adm.other })).toBe(true);
    expect(await runViolatesReleaseFocus(db, { companyId: other.companyId, agentId: other.agentId, issueId: other.other })).toBe(false);
    expect((await idlePickupCandidateRows(db, other.companyId, other.agentId)).map((row) => row.id)).toEqual([other.other]);
  });

  it("preserves an existing instance focus for a single-company installation", async () => {
    const company = await seed("ADM");
    const service = runPriorityService(db);
    const actor = { actorType: "user" as const, actorId: "operator", agentId: null, runId: null, agentApiKeyId: null };
    await service.update({ currentRelease: "1.7", strictReleaseFocus: true }, actor);
    resetRunPriorityForTests();
    await syncRunPriorityFromStore(db);
    expect(await runViolatesReleaseFocus(db, {
      companyId: company.companyId, agentId: company.agentId, issueId: company.other,
    })).toBe(true);
    expect(await service.readCompany(company.companyId)).toEqual({ currentRelease: "1.7", strictReleaseFocus: true });
  });

  it("keeps migrated legacy focus with its original company when another company is added", async () => {
    const adm = await seed("ADM");
    const service = runPriorityService(db);
    const actor = { actorType: "user" as const, actorId: "operator", agentId: null, runId: null, agentApiKeyId: null };
    await service.update({ currentRelease: "1.7", strictReleaseFocus: true }, actor);
    await syncRunPriorityFromStore(db);
    const other = await seed("BBQ");
    resetRunPriorityForTests();
    await syncRunPriorityFromStore(db);
    expect(await service.readCompany(adm.companyId)).toEqual({ currentRelease: "1.7", strictReleaseFocus: true });
    expect(await runViolatesReleaseFocus(db, { companyId: adm.companyId, agentId: adm.agentId, issueId: adm.other })).toBe(true);
    expect(await runViolatesReleaseFocus(db, { companyId: other.companyId, agentId: other.agentId, issueId: other.other })).toBe(false);
  });

  it("migrates a pre-existing legacy focus during startup before a new company is created", async () => {
    const adm = await seed("ADM");
    await db.insert(instanceSettings).values({
      singletonKey: "default",
      general: { runPriority: { currentRelease: "1.7", strictReleaseFocus: true } },
      experimental: {},
    });
    await syncRunPriorityFromStore(db);
    const other = await seed("BBQ");
    resetRunPriorityForTests();
    await syncRunPriorityFromStore(db);
    expect(await runPriorityService(db).readCompany(adm.companyId)).toEqual({ currentRelease: "1.7", strictReleaseFocus: true });
    expect(await runViolatesReleaseFocus(db, { companyId: adm.companyId, agentId: adm.agentId, issueId: adm.other })).toBe(true);
    expect(await runViolatesReleaseFocus(db, { companyId: other.companyId, agentId: other.agentId, issueId: other.other })).toBe(false);
  });

  it("does not assign legacy instance focus arbitrarily across multiple companies", async () => {
    const adm = await seed("ADM");
    const other = await seed("BBQ");
    const service = runPriorityService(db);
    const actor = { actorType: "user" as const, actorId: "operator", agentId: null, runId: null, agentApiKeyId: null };
    await service.update({ currentRelease: "1.7", strictReleaseFocus: true }, actor);
    resetRunPriorityForTests();
    await syncRunPriorityFromStore(db);
    for (const company of [adm, other]) {
      expect(await runViolatesReleaseFocus(db, {
        companyId: company.companyId, agentId: company.agentId, issueId: company.other,
      })).toBe(false);
    }
  });

  it("preserves both companies' settings when focus updates race", async () => {
    const adm = await seed("ADM");
    const other = await seed("BBQ");
    const service = runPriorityService(db);
    const actor = { actorType: "user" as const, actorId: "operator", agentId: null, runId: null, agentApiKeyId: null };
    await Promise.all([
      service.updateCompany(adm.companyId, { currentRelease: "1.7", strictReleaseFocus: true }, actor),
      service.updateCompany(other.companyId, { currentRelease: "1.8", strictReleaseFocus: true }, actor),
    ]);
    resetRunPriorityForTests();
    await syncRunPriorityFromStore(db);
    expect(await service.readCompany(adm.companyId)).toEqual({ currentRelease: "1.7", strictReleaseFocus: true });
    expect(await service.readCompany(other.companyId)).toEqual({ currentRelease: "1.8", strictReleaseFocus: true });
    expect(await runViolatesReleaseFocus(db, { companyId: adm.companyId, agentId: adm.agentId, issueId: adm.other })).toBe(true);
    expect(await runViolatesReleaseFocus(db, { companyId: other.companyId, agentId: other.agentId, issueId: other.other })).toBe(false);
  });

  it("does not apply ADM strict focus to another company's assigned work", async () => {
    const adm = await seed("ADM");
    const other = await seed("BBQ");
    applyCompanyReleaseFocus(new Map([[adm.companyId, { currentRelease: "1.7", strictReleaseFocus: true }]]));
    expect(await runViolatesReleaseFocus(db, { companyId: adm.companyId, agentId: adm.agentId, issueId: adm.other })).toBe(true);
    expect(await runViolatesReleaseFocus(db, { companyId: other.companyId, agentId: other.agentId, issueId: other.other })).toBe(false);
    expect((await idlePickupCandidateRows(db, other.companyId, other.agentId)).map((row) => row.id)).toEqual([other.other]);
  });
});
