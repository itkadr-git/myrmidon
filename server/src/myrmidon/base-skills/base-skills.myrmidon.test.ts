// myrmidon(1.6.5 BASE-SKILLS): the company base-skills registry.
//
// The suite pins the three promises of the registry: a new agent already
// carries the company base skills, declaring a skill as base gives it to every
// existing agent at once, and a per-agent skill edit cannot take a base skill
// away. The gaps of the screen are asserted separately, because that is what
// makes a silent miss visible instead of silent.
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentConfigRevisions,
  agents,
  companies,
  companyBaseSkills,
  companySkills,
  createDb,
} from "@paperclipai/db";
import { readPaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { errorHandler } from "../../middleware/index.js";
import { agentRoutes } from "../../routes/agents.js";
import { companyBaseSkillRoutes } from "../../routes/company-base-skills.js";
import { agentService } from "../../services/agents.js";
import { companyBaseSkillService } from "../../services/company-base-skills.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

const PARALLEL_HELPERS_KEY = "parallel-helpers";
const REVIEW_KEY = "review-checklist";
/** The only built-in adapter that implements skill sync (see the registry). */
const SKILLS_ADAPTER_TYPE = "hermes_local";

function boardActor(companyId: string): Express.Request["actor"] {
  return {
    type: "board",
    userId: "local-board",
    companyIds: [companyId],
    source: "local_implicit",
    isInstanceAdmin: false,
  } as Express.Request["actor"];
}

function foreignAgentActor(companyId: string): Express.Request["actor"] {
  return {
    type: "agent",
    agentId: randomUUID(),
    companyId,
    source: "agent_key",
  } as Express.Request["actor"];
}

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", companyBaseSkillRoutes(db));
  app.use(errorHandler);
  return app;
}

function createAgentSkillsApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", agentRoutes(db));
  app.use(errorHandler);
  return app;
}

function desiredSkillsOf(config: Record<string, unknown> | null | undefined) {
  return readPaperclipSkillSyncPreference((config ?? {}) as Record<string, unknown>).desiredSkills;
}

describeEmbeddedPostgres("myrmidon(1.6.5 BASE-SKILLS) company base skills", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-base-skills-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentConfigRevisions);
    await db.delete(companyBaseSkills);
    await db.delete(companySkills);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany() {
    return db
      .insert(companies)
      .values({
        name: `company-${randomUUID()}`,
        issuePrefix: `B${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  /**
   * A library skill the runtime listing keeps: the source folder must exist,
   * otherwise the skill inventory reconciliation drops the row — and the base
   * list (a cascade) with it. The folder is real, exactly like an installed
   * skill.
   */
  async function createLibrarySkill(companyId: string, key: string) {
    const skillDir = await mkdtemp(join(tmpdir(), `base-skill-${key}-`));
    await writeFile(join(skillDir, "SKILL.md"), `# ${key}\n`);
    return db
      .insert(companySkills)
      .values({
        companyId,
        key,
        slug: key,
        name: key,
        markdown: `# ${key}`,
        sourceType: "local_path",
        sourceLocator: skillDir,
        sourceRef: skillDir,
        trustLevel: "markdown_only",
        compatibility: "compatible",
        fileInventory: [{ path: "SKILL.md", kind: "skill" }],
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function declareBaseSkill(companyId: string, key: string) {
    const skill = await createLibrarySkill(companyId, key);
    await db.insert(companyBaseSkills).values({ companyId, skillId: skill.id, key });
    return skill;
  }

  /** Declare base skills through the service, with their library entries. */
  async function addBaseSkills(companyId: string, keys: string[]) {
    for (const key of keys) await createLibrarySkill(companyId, key);
    return companyBaseSkillService(db).add(companyId, keys, {
      actorType: "user",
      actorId: "user-a",
    });
  }

  /** An agent row written directly, i.e. one that existed before the registry. */
  async function insertExistingAgent(
    companyId: string,
    name: string,
    options: { status?: string; adapterType?: string; desiredSkills?: string[] } = {},
  ) {
    return db
      .insert(agents)
      .values({
        companyId,
        name,
        role: "engineer",
        status: options.status ?? "idle",
        adapterType: options.adapterType ?? "process",
        adapterConfig: options.desiredSkills
          ? { paperclipSkillSync: { desiredSkills: options.desiredSkills } }
          : {},
        permissions: {},
        runtimeConfig: {},
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  it("gives a new agent the company base skills at creation", async () => {
    const company = await createCompany();
    await declareBaseSkill(company.id, PARALLEL_HELPERS_KEY);
    await declareBaseSkill(company.id, REVIEW_KEY);

    const created = await agentService(db).create(company.id, {
      name: "smm-bot",
      role: "engineer",
      adapterType: "process",
      adapterConfig: { model: "m", paperclipSkillSync: { desiredSkills: ["own-skill"] } },
      runtimeConfig: {},
    });

    expect(desiredSkillsOf(created.adapterConfig as Record<string, unknown>)).toEqual([
      "own-skill",
      PARALLEL_HELPERS_KEY,
      REVIEW_KEY,
    ]);
    // The stored row carries them too — the creation path writes once.
    const stored = await db
      .select({ adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(eq(agents.id, created.id))
      .then((rows) => rows[0]!);
    expect(desiredSkillsOf(stored.adapterConfig as Record<string, unknown>)).toContain(PARALLEL_HELPERS_KEY);
  });

  it("leaves a new agent alone in a company without base skills", async () => {
    const company = await createCompany();
    const created = await agentService(db).create(company.id, {
      name: "plain-bot",
      role: "engineer",
      adapterType: "process",
      adapterConfig: { model: "m" },
      runtimeConfig: {},
    });
    expect(desiredSkillsOf(created.adapterConfig as Record<string, unknown>)).toEqual([]);
  });

  it("gives a declared base skill to the agents that already exist", async () => {
    const company = await createCompany();
    const idle = await insertExistingAgent(company.id, "idle-bot");
    const paused = await insertExistingAgent(company.id, "paused-bot", { status: "paused" });
    const terminated = await insertExistingAgent(company.id, "gone-bot", { status: "terminated" });
    const pending = await insertExistingAgent(company.id, "pending-bot", { status: "pending_approval" });

    const outcome = await addBaseSkills(company.id, [PARALLEL_HELPERS_KEY]);

    expect(outcome.apply.changed).toBe(2);
    expect(outcome.apply.failed).toEqual([]);
    const rows = await db.select({ id: agents.id, adapterConfig: agents.adapterConfig }).from(agents);
    const byId = new Map(rows.map((row) => [row.id, desiredSkillsOf(row.adapterConfig as Record<string, unknown>)]));
    expect(byId.get(idle.id)).toEqual([PARALLEL_HELPERS_KEY]);
    expect(byId.get(paused.id)).toEqual([PARALLEL_HELPERS_KEY]);
    expect(byId.get(terminated.id)).toEqual([]);
    expect(byId.get(pending.id)).toEqual([]);
  });

  it("applying the base list again changes nothing", async () => {
    const company = await createCompany();
    await insertExistingAgent(company.id, "idle-bot");
    await addBaseSkills(company.id, [PARALLEL_HELPERS_KEY]);

    const again = await companyBaseSkillService(db).applyToCompanyAgents(
      company.id,
      { actorType: "user", actorId: "user-a" },
    );

    expect(again.keys).toEqual([PARALLEL_HELPERS_KEY]);
    expect(again.changed).toBe(0);
    expect(again.unchanged).toBe(1);
    // One revision from the first application, none from the second.
    const revisions = await db.select({ id: agentConfigRevisions.id }).from(agentConfigRevisions);
    expect(revisions.length).toBe(1);
  });

  it("keeps the base skills when the board edits one agent's own skills", async () => {
    const company = await createCompany();
    await declareBaseSkill(company.id, PARALLEL_HELPERS_KEY);
    const agent = await insertExistingAgent(company.id, "editor-bot");

    const res = await request(createAgentSkillsApp(db, boardActor(company.id)))
      .post(`/api/agents/${agent.id}/skills/sync`)
      .send({ mode: "replace", desiredSkills: [] });

    expect(res.status).toBe(200);
    // The answer of the route shows what the sync computed; the stored row shows
    // that the base skill also reached the database.
    expect(res.body.desiredSkills).toEqual([PARALLEL_HELPERS_KEY]);
    const stored = await db
      .select({ adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(eq(agents.id, agent.id))
      .then((rows) => rows[0]!);
    expect(desiredSkillsOf(stored.adapterConfig as Record<string, unknown>)).toEqual([PARALLEL_HELPERS_KEY]);
  });

  it("shows who is missing a base skill and why", async () => {
    const company = await createCompany();
    await addBaseSkills(company.id, [PARALLEL_HELPERS_KEY]);
    // Written directly after the declaration: the shape of an agent that
    // existed before the registry, or one whose config was frozen.
    const missed = await insertExistingAgent(company.id, "missed-bot", {
      adapterType: SKILLS_ADAPTER_TYPE,
    });
    const unsupported = await insertExistingAgent(company.id, "no-skill-adapter-bot", {
      adapterType: "no-such-adapter",
    });
    const covered = await insertExistingAgent(company.id, "covered-bot", {
      adapterType: SKILLS_ADAPTER_TYPE,
      desiredSkills: [PARALLEL_HELPERS_KEY],
    });

    const overview = await companyBaseSkillService(db).overview(company.id);

    expect(overview.entries).toHaveLength(1);
    expect(overview.entries[0]!.key).toBe(PARALLEL_HELPERS_KEY);
    expect(overview.entries[0]!.missing).toBe(false);
    expect(overview.entries[0]!.assignedAgentCount).toBe(1);
    expect(overview.entries[0]!.agentCount).toBe(3);
    const gapsByAgent = new Map(overview.gaps.map((gap) => [gap.agentId, gap]));
    expect(gapsByAgent.get(covered.id)).toBeUndefined();
    expect(gapsByAgent.get(missed.id)?.reason).toBe("not_assigned");
    expect(gapsByAgent.get(unsupported.id)?.reason).toBe("adapter_unsupported");
    expect(overview.agents.find((agent) => agent.id === unsupported.id)?.skillsSupported).toBe(false);
  });

  it("keeps a second company out of the registry", async () => {
    const first = await createCompany();
    const second = await createCompany();
    const otherAgent = await insertExistingAgent(second.id, "other-bot");

    await addBaseSkills(first.id, [PARALLEL_HELPERS_KEY]);

    const otherConfig = await db
      .select({ adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(eq(agents.id, otherAgent.id))
      .then((rows) => rows[0]!);
    expect(desiredSkillsOf(otherConfig.adapterConfig as Record<string, unknown>)).toEqual([]);
    expect(await companyBaseSkillService(db).overview(second.id).then((o) => o.entries)).toEqual([]);
  });

  it("refuses a key the library does not have", async () => {
    const company = await createCompany();
    await expect(
      companyBaseSkillService(db).add(company.id, ["unknown-skill"], {
        actorType: "user",
        actorId: "user-a",
      }),
    ).rejects.toThrow(/Unknown company skill/);
  });

  it("stops assigning a removed base skill but leaves owned skills in place", async () => {
    const company = await createCompany();
    await declareBaseSkill(company.id, PARALLEL_HELPERS_KEY);
    const agent = await agentService(db).create(company.id, {
      name: "kept-bot",
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    });

    const removed = await companyBaseSkillService(db).remove(
      company.id,
      PARALLEL_HELPERS_KEY,
      { actorType: "user", actorId: "user-a" },
    );
    expect(removed?.key).toBe(PARALLEL_HELPERS_KEY);
    expect(await companyBaseSkillService(db).overview(company.id).then((o) => o.entries)).toEqual([]);

    const stored = await db
      .select({ adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(eq(agents.id, agent.id))
      .then((rows) => rows[0]!);
    expect(desiredSkillsOf(stored.adapterConfig as Record<string, unknown>)).toEqual([PARALLEL_HELPERS_KEY]);
  });

  it("serves and mutates the list over HTTP for the board only", async () => {
    const company = await createCompany();
    await createLibrarySkill(company.id, PARALLEL_HELPERS_KEY);
    const agent = await insertExistingAgent(company.id, "http-bot");

    const forbiddenAdd = await request(createApp(db, foreignAgentActor(company.id)))
      .post(`/api/companies/${company.id}/base-skills`)
      .send({ keys: [PARALLEL_HELPERS_KEY] });
    expect(forbiddenAdd.status).toBe(403);

    const added = await request(createApp(db, boardActor(company.id)))
      .post(`/api/companies/${company.id}/base-skills`)
      .send({ keys: [PARALLEL_HELPERS_KEY] });
    expect(added.status).toBe(201);
    expect(added.body.apply.changed).toBe(1);
    expect(added.body.overview.entries[0].key).toBe(PARALLEL_HELPERS_KEY);

    const overview = await request(createApp(db, boardActor(company.id)))
      .get(`/api/companies/${company.id}/base-skills`);
    expect(overview.status).toBe(200);
    expect(overview.body.entries[0].assignedAgentCount).toBe(1);
    expect(overview.body.gaps).toEqual([]);

    const applied = await request(createApp(db, boardActor(company.id)))
      .post(`/api/companies/${company.id}/base-skills/apply`);
    expect(applied.status).toBe(200);
    expect(applied.body.apply.unchanged).toBe(1);

    const missing = await request(createApp(db, boardActor(company.id)))
      .delete(`/api/companies/${company.id}/base-skills/${REVIEW_KEY}`);
    expect(missing.status).toBe(404);

    const removed = await request(createApp(db, boardActor(company.id)))
      .delete(`/api/companies/${company.id}/base-skills/${PARALLEL_HELPERS_KEY}`);
    expect(removed.status).toBe(200);
    expect(removed.body.removed).toBe(PARALLEL_HELPERS_KEY);

    const stored = await db
      .select({ adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(eq(agents.id, agent.id))
      .then((rows) => rows[0]!);
    expect(desiredSkillsOf(stored.adapterConfig as Record<string, unknown>)).toEqual([PARALLEL_HELPERS_KEY]);
  });
});