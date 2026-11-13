// myrmidon(1.8 CASTE-MODEL-EVAL): the caste model ranking API over the real
// database with a heuristic judge and a stubbed candidate generator —
// ranking order, the free+enabled filter, the tie-break, failures, and the
// owner-gated apply that writes `agent_castes.default_model`.

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agentCastes,
  companies,
  createDb,
  evalReferenceTasks,
  evalRuns,
  modelProviderModels,
  modelProviders,
} from "@myrmidon/db";
import type { Db } from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import type { EmbeddedPostgresTestDatabase } from "@myrmidon/db";
import { errorHandler } from "../../middleware/index.js";
import { myrmidonEvalsRoutes, type EvalsRoutesDeps } from "./routes.js";
import { createEvalsService, createHeuristicJudge } from "./index.js";
import type { GenerateCandidateAnswer } from "./caste-models.js";
import { CASTE_MODEL_EVAL_SUBJECT_PREFIX } from "./caste-models-shared.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;


/** The board actor (admin membership) — can rank, cannot apply. */
function adminActor(companyId: string) {
  return {
    type: "board",
    source: "session",
    userId: "user-a",
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, status: "active", membershipRole: "admin" }],
  };
}

/** The owner-grade board actor — the only one allowed to apply. */
function ownerActor(companyId: string) {
  return {
    type: "board",
    source: "session",
    userId: "user-owner",
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, status: "active", membershipRole: "owner" }],
  };
}

const agent = {
  type: "agent",
  source: "agent_key",
  agentId: "10000000-0000-4000-8000-0000000000c1",
  companyId: "",
  keyId: "key-a",
};

const GOOD = "verified-answer";
const BAD = "no";

/** Which answer a model produces; "model-fail" refuses (gateway error). */
const stubGenerate: GenerateCandidateAnswer = ({ model }) => {
  if (model.modelName === "model-fail") {
    return Promise.reject(new Error("gateway down"));
  }
  return Promise.resolve(model.modelName === "model-a" ? GOOD : BAD);
};

let tempDb: EmbeddedPostgresTestDatabase | null = null;

describeEmbeddedPostgres("myrmidon(1.8 CASTE-MODEL-EVAL): rank/apply routes", () => {
  let db!: Db;
  let companyId = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-evals-caste-models-");
    db = createDb(tempDb.connectionString);
    const company = await db
      .insert(companies)
      .values({ name: `company-a ${randomUUID()}`, issuePrefix: `CM${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
    companyId = company.id;
    agent.companyId = companyId;
  }, 60_000);

  afterEach(async () => {
    await db.delete(evalRuns);
    await db.delete(evalReferenceTasks);
    await db.delete(modelProviderModels);
    await db.delete(modelProviders);
    await db.delete(agentCastes);
  });

  afterAll(async () => {
    await db.delete(activityLog); // the routes journal their mutations
    await db.delete(companies);
    await tempDb?.cleanup();
  });

  /** The router with a real service (heuristic judge) and the stub generator. */
  function app(actor: unknown, generator: Partial<EvalsRoutesDeps> = {}) {
    const service = createEvalsService(db, {
      judge: createHeuristicJudge(({ answer }) => (answer.includes(GOOD) ? 10 : 0)),
      model: "test-judge",
      subjectModelFor: () => "test-subject",
      now: () => new Date(),
    });
    const expressApp = express();
    expressApp.use(express.json());
    expressApp.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    expressApp.use("/api", myrmidonEvalsRoutes(db, { service, generateCandidateAnswer: stubGenerate, ...generator }));
    expressApp.use(errorHandler);
    return expressApp;
  }

  const base = (company: string) => `/api/myrmidon/companies/${company}/evals/caste-models`;

  async function seedTasks(role: string, slugs: string[]) {
    for (const slug of slugs) {
      await db.insert(evalReferenceTasks).values({
        companyId,
        role,
        slug,
        title: slug,
        prompt: `task ${slug}`,
        kind: "general",
        rubric: { criteria: [{ name: "quality", description: "how good", points: 10 }] },
        weight: 1,
      });
    }
  }

  /** One provider with the given models; `free`/`enabled` flags per model. */
  async function seedModels(specs: Array<{ name: string; free: boolean; enabled: boolean; litellm?: string }>) {
    const provider = await db
      .insert(modelProviders)
      .values({ companyId, type: "openai-compatible", name: `provider-${randomUUID().slice(0, 8)}` })
      .returning()
      .then((rows) => rows[0]!);
    for (const spec of specs) {
      await db.insert(modelProviderModels).values({
        providerId: provider.id,
        modelName: spec.name,
        litellmModelName: spec.litellm ?? `${provider.name}/${spec.name}`,
        enabled: spec.enabled,
        free: spec.free,
      });
    }
  }

  async function seedCaste(key: string) {
    await db.insert(agentCastes).values({ companyId, key, nameEn: key });
  }

  async function readDefaultModel(key: string): Promise<string | null> {
    const row = await db.select().from(agentCastes).where(eq(agentCastes.companyId, companyId));
    return row.find((r) => r.key === key)?.defaultModel ?? null;
  }

  it("ranks free enabled models by score desc, excluding paid and disabled models", async () => {
    await seedCaste("engineer");
    await seedTasks("engineer", ["t1", "t2"]);
    await seedModels([
      { name: "model-a", free: true, enabled: true },
      { name: "model-b", free: true, enabled: true },
      { name: "model-paid", free: false, enabled: true },
      { name: "model-off", free: true, enabled: false },
    ]);
    const res = await request(app(adminActor(companyId))).post(`${base(companyId)}/engineer/rank`).expect(200);
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.rows.map((r: { model: string }) => r.model)).toEqual(["model-a", "model-b"]);
    expect(res.body.failed).toEqual([]);
    for (const row of res.body.rows as Array<{ model: string; runId: string; scorePercent: number }>) {
      expect(row.scorePercent).toBe(row.model === "model-a" ? 100 : 0);
      expect(row.runId).toBeTruthy();
    }
    // The subject of every run names the model, so apply can re-verify.
    const runs = await db.select().from(evalRuns);
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.subject).sort()).toEqual([
      `${CASTE_MODEL_EVAL_SUBJECT_PREFIX}model-a`,
      `${CASTE_MODEL_EVAL_SUBJECT_PREFIX}model-b`,
    ]);
  });

  it("breaks score ties by model name ascending", async () => {
    await seedCaste("engineer");
    await seedTasks("engineer", ["t1"]);
    await seedModels([
      { name: "zeta", free: true, enabled: true },
      { name: "alpha", free: true, enabled: true },
    ]);
    const res = await request(app(adminActor(companyId))).post(`${base(companyId)}/engineer/rank`).expect(200);
    expect(res.body.rows.map((r: { model: string }) => r.model)).toEqual(["alpha", "zeta"]);
  });

  it("answers 200 with empty rows when no free enabled model exists", async () => {
    await seedCaste("engineer");
    await seedTasks("engineer", ["t1"]);
    await seedModels([{ name: "model-paid", free: false, enabled: true }]);
    const res = await request(app(adminActor(companyId))).post(`${base(companyId)}/engineer/rank`).expect(200);
    expect(res.body.rows).toEqual([]);
    expect(res.body.failed).toEqual([]);
  });

  it("moves a model whose generation fails to `failed` and still ranks the rest", async () => {
    await seedCaste("engineer");
    await seedTasks("engineer", ["t1"]);
    await seedModels([
      { name: "model-a", free: true, enabled: true },
      { name: "model-fail", free: true, enabled: true },
    ]);
    const res = await request(app(adminActor(companyId))).post(`${base(companyId)}/engineer/rank`).expect(200);
    expect(res.body.failed).toEqual(["model-fail"]);
    expect(res.body.rows.map((r: { model: string }) => r.model)).toEqual(["model-a"]);
  });

  it("answers 404 when the caste has no reference tasks", async () => {
    await seedCaste("engineer");
    await seedModels([{ name: "model-a", free: true, enabled: true }]);
    await request(app(adminActor(companyId))).post(`${base(companyId)}/engineer/rank`).expect(404);
  });

  it("refuses rank from an agent actor (403)", async () => {
    await seedCaste("engineer");
    await seedTasks("engineer", ["t1"]);
    await seedModels([{ name: "model-a", free: true, enabled: true }]);
    await request(app(agent)).post(`${base(companyId)}/engineer/rank`).expect(403);
  });

  it("refuses rank from a board actor of another company (403)", async () => {
    const other = randomUUID();
    await request(app(adminActor(other))).post(`${base(companyId)}/engineer/rank`).expect(403);
  });

  it("refuses apply without the owner grade and leaves defaultModel untouched", async () => {
    await seedCaste("engineer");
    await seedTasks("engineer", ["t1"]);
    await seedModels([{ name: "model-a", free: true, enabled: true }]);
    const rank = await request(app(adminActor(companyId))).post(`${base(companyId)}/engineer/rank`).expect(200);
    const winner = rank.body.rows[0] as { model: string; runId: string };
    const res = await request(app(adminActor(companyId)))
      .post(`${base(companyId)}/engineer/apply`)
      .send({ model: winner.model, runId: winner.runId })
      .expect(403);
    expect(res.body.code).toBe("approver_kind_mismatch");
    expect(await readDefaultModel("engineer")).toBeNull();
  });

  it("applies the winner with the owner grade and writes defaultModel", async () => {
    await seedCaste("engineer");
    await seedTasks("engineer", ["t1"]);
    await seedModels([{ name: "model-a", free: true, enabled: true }]);
    const rank = await request(app(adminActor(companyId))).post(`${base(companyId)}/engineer/rank`).expect(200);
    const winner = rank.body.rows[0] as { model: string; runId: string; scorePercent: number };
    const res = await request(app(ownerActor(companyId)))
      .post(`${base(companyId)}/engineer/apply`)
      .send({ model: winner.model, runId: winner.runId })
      .expect(200);
    expect(res.body.caste.defaultModel).toBe("model-a");
    expect(res.body.scorePercent).toBe(winner.scorePercent);
    expect(await readDefaultModel("engineer")).toBe("model-a");
  });

  it("refuses apply when the run does not match the model or caste (400)", async () => {
    await seedCaste("engineer");
    await seedTasks("engineer", ["t1"]);
    await seedModels([
      { name: "model-a", free: true, enabled: true },
      { name: "model-b", free: true, enabled: true },
    ]);
    const rank = await request(app(adminActor(companyId))).post(`${base(companyId)}/engineer/rank`).expect(200);
    const rows = rank.body.rows as Array<{ model: string; runId: string }>;
    const winner = rows.find((r) => r.model === "model-a")!;
    // model-b's runId with model-a's name: the pairing must not pass.
    const loser = rows.find((r) => r.model === "model-b")!;
    await request(app(ownerActor(companyId)))
      .post(`${base(companyId)}/engineer/apply`)
      .send({ model: winner.model, runId: loser.runId })
      .expect(400);
    // A real run under another caste key: the subject check rejects it
    // before any caste lookup, so the default model stays untouched.
    const mismatch = await request(app(ownerActor(companyId)))
      .post(`${base(companyId)}/reviewer/apply`)
      .send({ model: winner.model, runId: winner.runId })
      .expect(400);
    expect(mismatch.body.code).toBe("eval_run_model_mismatch");
    expect(await readDefaultModel("engineer")).toBeNull();
  });

  it("refuses apply for an unknown run and for a missing body (404/400)", async () => {
    await seedCaste("engineer");
    await request(app(ownerActor(companyId)))
      .post(`${base(companyId)}/engineer/apply`)
      .send({ model: "model-a", runId: randomUUID() })
      .expect(404);
    await request(app(ownerActor(companyId))).post(`${base(companyId)}/engineer/apply`).send({}).expect(400);
    await request(app(ownerActor(companyId)))
      .post(`${base(companyId)}/engineer/apply`)
      .send({ model: "model-a" })
      .expect(400);
  });

  it("refuses apply for a run of another company (404, tenant isolation)", async () => {
    await seedCaste("engineer");
    await seedTasks("engineer", ["t1"]);
    await seedModels([{ name: "model-a", free: true, enabled: true }]);
    const rank = await request(app(adminActor(companyId))).post(`${base(companyId)}/engineer/rank`).expect(200);
    const winner = rank.body.rows[0] as { model: string; runId: string };
    const otherCompany = await db
      .insert(companies)
      .values({ name: `company-b ${randomUUID()}`, issuePrefix: `CN${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
    try {
      await db.insert(agentCastes).values({ companyId: otherCompany.id, key: "engineer", nameEn: "engineer" });
      const res = await request(app(ownerActor(otherCompany.id)))
        .post(`${base(otherCompany.id)}/engineer/apply`)
        .send({ model: winner.model, runId: winner.runId })
        .expect(404);
      expect(res.body.error).toBe("run not found");
      expect(await readDefaultModel("engineer")).toBeNull();
    } finally {
      await db.delete(agentCastes).where(eq(agentCastes.companyId, otherCompany.id));
      await db.delete(companies).where(eq(companies.id, otherCompany.id));
    }
  });

  it("answers 503 with the reason when the evals contour is not configured", async () => {
    await seedCaste("engineer");
    await seedTasks("engineer", ["t1"]);
    await seedModels([{ name: "model-a", free: true, enabled: true }]);
    const expressApp = express();
    expressApp.use(express.json());
    expressApp.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = adminActor(companyId);
      next();
    });
    // No deps.service, no env: the settings path is off.
    expressApp.use("/api", myrmidonEvalsRoutes(db, { env: {}, now: () => new Date() }));
    expressApp.use(errorHandler);
    await request(expressApp).post(`${base(companyId)}/engineer/rank`).expect(503);
    const ownerExpress = express();
    ownerExpress.use(express.json());
    ownerExpress.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = ownerActor(companyId);
      next();
    });
    ownerExpress.use("/api", myrmidonEvalsRoutes(db, { env: {}, now: () => new Date() }));
    ownerExpress.use(errorHandler);
    await request(ownerExpress).post(`${base(companyId)}/engineer/apply`).send({ model: "model-a", runId: randomUUID() }).expect(503);
  });
});
