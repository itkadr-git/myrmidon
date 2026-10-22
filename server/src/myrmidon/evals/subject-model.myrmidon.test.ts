// @vitest-environment node
// myrmidon(1.6.5 EVALS-JUDGE-FAMILY): the model behind the sameFamily badge is
// the *agent's* model, never the judge's.
//
// The 05.10 review found the second acceptance defect here: routes built the
// service with `subjectModel: current.model` — the judge model from the contour
// settings — so isSameModelFamily() compared the judge with itself and the flag
// was true for every subject under the default qwen-plus-free judge. These
// tests pin the fix: the value comes from the agent card of the evaluated role,
// and when it cannot be resolved the flag stays false instead of guessing.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  evalReferenceTasks as evalTasksTable,
  evalRuns as evalRunsTable,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import {
  createEvalsService,
  createHeuristicJudge,
  ENGINEER_REFERENCE_TASKS,
  EVALS_PILOT_ROLE,
  seedReferenceTasks,
} from "./index.js";
import { subjectModelFromAgentCard } from "./routes.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

/** The contour default: a DashScope/Qwen judge. */
const JUDGE_MODEL = "qwen-plus-free";
/** The evaluated engineer: also Qwen, but a different model of the family. */
const AGENT_MODEL = "qwen-max";

/** Records the agentModel the service hands the judge, then delegates. */
function recordingJudge(seen: (string | undefined)[]) {
  const inner = createHeuristicJudge(() => 50);
  return {
    judgeTask: (input: Parameters<typeof inner.judgeTask>[0]) => {
      seen.push(input.agentModel);
      return inner.judgeTask(input);
    },
  };
}

describeEmbeddedPostgres("myrmidon(1.6.5 EVALS-JUDGE-FAMILY) the subject model", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-evals-subject-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(evalRunsTable);
    await db.delete(evalTasksTable);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function makeCompany() {
    return db
      .insert(companies)
      .values({ name: `company-subject ${randomUUID()}`, issuePrefix: `ES${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function makeAgent(companyId: string, role: string, model: unknown) {
    return db
      .insert(agents)
      .values({
        companyId,
        name: `${role} agent`,
        role,
        adapterConfig: model === undefined ? {} : { model },
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function answers(tasks: readonly { slug: string }[]) {
    const out: Record<string, string> = {};
    for (const task of tasks) out[task.slug] = "engineer answer";
    return out;
  }

  it("reads the subject model from the agent card of the evaluated role", async () => {
    const company = await makeCompany();
    await makeAgent(company.id, EVALS_PILOT_ROLE, AGENT_MODEL);

    expect(
      await subjectModelFromAgentCard(db, company.id, { role: EVALS_PILOT_ROLE, subject: "engineer" }),
    ).toBe(AGENT_MODEL);
  });

  it("answers undefined for a missing model, an adapter-decides value and an unknown role", async () => {
    const company = await makeCompany();
    await makeAgent(company.id, "manager", undefined);
    await makeAgent(company.id, "designer", "default");

    expect(await subjectModelFromAgentCard(db, company.id, { role: "manager", subject: "lead" })).toBeUndefined();
    expect(await subjectModelFromAgentCard(db, company.id, { role: "designer", subject: "art" })).toBeUndefined();
    expect(await subjectModelFromAgentCard(db, company.id, { role: "nobody", subject: "x" })).toBeUndefined();
    expect(await subjectModelFromAgentCard(db, company.id, { role: "   ", subject: "x" })).toBeUndefined();
  });

  it("hands the judge the subject's model, not the judge's own", async () => {
    const company = await makeCompany();
    await seedReferenceTasks(db, company.id, EVALS_PILOT_ROLE, ENGINEER_REFERENCE_TASKS);
    await makeAgent(company.id, EVALS_PILOT_ROLE, AGENT_MODEL);
    const seen: (string | undefined)[] = [];
    const service = createEvalsService(db, {
      judge: recordingJudge(seen),
      model: JUDGE_MODEL,
      subjectModelFor: (input) => subjectModelFromAgentCard(db, company.id, input),
      now: () => new Date(),
    });
    const tasks = await service.loadTasks(company.id, EVALS_PILOT_ROLE);

    await service.runEval({
      companyId: company.id,
      role: EVALS_PILOT_ROLE,
      subject: "engineer",
      answers: await answers(tasks),
    });

    expect(seen.length).toBe(tasks.length);
    expect(new Set(seen)).toEqual(new Set([AGENT_MODEL]));
    // The regression the review found: the judge was compared with itself.
    expect(seen).not.toContain(JUDGE_MODEL);
  });

  it("keeps the subject model unknown when the role has no agent card", async () => {
    const company = await makeCompany();
    await seedReferenceTasks(db, company.id, EVALS_PILOT_ROLE, ENGINEER_REFERENCE_TASKS);
    const seen: (string | undefined)[] = [];
    const service = createEvalsService(db, {
      judge: recordingJudge(seen),
      model: JUDGE_MODEL,
      subjectModelFor: (input) => subjectModelFromAgentCard(db, company.id, input),
      now: () => new Date(),
    });
    const tasks = await service.loadTasks(company.id, EVALS_PILOT_ROLE);

    await service.runEval({
      companyId: company.id,
      role: EVALS_PILOT_ROLE,
      subject: "engineer",
      answers: await answers(tasks),
    });

    expect(seen.length).toBe(tasks.length);
    expect(new Set(seen)).toEqual(new Set([undefined]));
  });
});