// server/src/myrmidon/evals/knowledge-gate.db.myrmidon.test.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-9): the end-to-end acceptance of the evals
// gate, on a synthetic rule, against a real embedded database.
//
// What it pins:
//   * a deliberately bad rule rolls back in ≤ 2 judge runs (first + the repeat
//     the threshold asks for), and the knowledge pointer moves back;
//   * a good rule stays delivered, on a single judge run;
//   * a hallucination rolls back at once, without spending the repeat;
//   * the knowledge journal carries `eval_run_id` and `delta` for both
//     outcomes, and the owner card is posted only when something was rolled
//     back.
//
// The judge is the deterministic heuristic one (no gateway): the answer text
// is what the "caste" is judged on, so the *rule content* is the only
// variable — exactly what the gate exists to catch.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  activityLog,
  companies,
  createDb,
  evalReferenceTasks as evalTasksTable,
  evalRuns as evalRunsTable,
  knowledgeItems,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { createMemorySearchIndex } from "../knowledge/domain.js";
import type { KnowledgeActor } from "../knowledge/store.js";
import { createKnowledgeModule } from "../knowledge/service.js";
import {
  createEvalsService,
  createHeuristicJudge,
  EVALS_PILOT_ROLE,
} from "./index.js";
import {
  ENGINEER_REFERENCE_TASKS,
  seedReferenceTasks,
} from "./seed.js";
import {
  KNOWLEDGE_GATE_ACTOR_ID,
  createKnowledgeGate,
  createKnowledgeGateSink,
  decideKnowledgeGateVerdict,
  hallucinationFromScores,
  isKnowledgeGateTrigger,
  subjectKindForTrigger,
  type KnowledgeGateActor,
  type KnowledgeGateOwnerNotice,
  type KnowledgeGateVerdict,
} from "./knowledge-gate.js";

const GOOD = "verified-answer: the checks are ordered by cost and the evidence is named";
const BAD = "garbage-answer: trust me, it is probably the cache";
const GOOD_MARKER = "verified-answer";
const BAD_MARKER = "garbage-answer";

const markerJudge = (marker: string) => createHeuristicJudge(({ answer }) => (answer.includes(marker) ? 99 : 0));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

// ---------------------------------------------------------------------------
// The pure half: trigger mapping and the decision table. No database.
// ---------------------------------------------------------------------------

describe("myrmidon(1.6.6 K-9) the evals gate decision table", () => {
  it("maps the three lifecycle events onto the three subject kinds", () => {
    expect(isKnowledgeGateTrigger("rule.approved")).toBe(true);
    expect(isKnowledgeGateTrigger("skill.promoted")).toBe(true);
    expect(isKnowledgeGateTrigger("page.published")).toBe(true);
    expect(isKnowledgeGateTrigger("rule.created")).toBe(false);
    expect(subjectKindForTrigger("rule.approved")).toBe("rule");
    expect(subjectKindForTrigger("skill.promoted")).toBe("skill");
    expect(subjectKindForTrigger("page.published")).toBe("page");
  });

  it("only a confirmed regression — or a hallucination — rolls back", () => {
    const run = (verdict: "promote" | "confirm" | "regress" | "error" | null) =>
      ({ verdict, verdictReason: `verdict ${verdict}`, error: null }) as never;
    const cases: Array<[{ final: never; repeated: boolean; hallucinationTaskSlug?: string | null }, KnowledgeGateVerdict]> = [
      [{ final: run("regress"), repeated: true }, "rollback"],
      [{ final: run("promote"), repeated: false }, "keep"],
      [{ final: run("promote"), repeated: true }, "keep"],
      [{ final: run("confirm"), repeated: false }, "keep"], // crossing once is not enough
      [{ final: run("error"), repeated: true }, "keep"], // an unavailable baseline never rolls back
      [{ final: run(null), repeated: false }, "keep"], // no baseline: kept, journal shows delta null
      [{ final: run("promote"), repeated: false, hallucinationTaskSlug: "price-of-item" }, "rollback"],
    ];
    for (const [input, expected] of cases) {
      expect(decideKnowledgeGateVerdict({ delta: 40, ...input }).verdict).toBe(expected);
    }
  });

  it("detects a hallucination from a zeroed hallucination criterion only", () => {
    const score = (name: string, points: number, slug = "t-1") =>
      ({ taskSlug: slug, criteria: { [name]: points }, sameFamily: false, rawScore: points, weight: 1, maxScore: 5 }) as never;
    expect(hallucinationFromScores([score("hallucination", 0)])).toEqual({ taskSlug: "t-1" });
    expect(hallucinationFromScores([score("hallucination", 5)])).toBeNull();
    expect(hallucinationFromScores([score("no-invented-prices", 0)])).toEqual({ taskSlug: "t-1" });
    expect(hallucinationFromScores([score("prioritization", 0)])).toBeNull();
    expect(hallucinationFromScores([])).toBeNull();
  });
});
describeEmbeddedPostgres("myrmidon(1.6.6 K-9) the evals gate over the database", () => {

  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let AGENT!: KnowledgeActor;
  const OWNER: KnowledgeActor = { actorType: "user", actorId: "owner-1", kind: "owner" };
  const GATE_ACTOR: KnowledgeGateActor = { actorType: "system", actorId: KNOWLEDGE_GATE_ACTOR_ID };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-knowledge-gate-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(knowledgeItems);
    await db.delete(evalRunsTable);
    await db.delete(evalTasksTable);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function makeCompany(): Promise<string> {
    const company = await db
      .insert(companies)
      .values({ name: `company ${randomUUID()}`, issuePrefix: `KG${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
    const [agent] = await db
      .insert(agents)
      .values({ companyId: company.id, name: `writer-${randomUUID().slice(0, 6)}`, role: "writer" })
      .returning();
    AGENT = { actorType: "agent", actorId: agent!.id, kind: null };
    return company.id;
  }

  function makeModule(companyId: string) {
    return createKnowledgeModule(db, companyId, { searchIndex: createMemorySearchIndex() });
  }

  function makeEvals(judge = markerJudge(GOOD_MARKER)) {
    return createEvalsService(db, {
      judge,
      model: "test-judge",
      subjectModelFor: () => "test-subject",
      now: () => new Date(),
    });
  }

  type Module = ReturnType<typeof makeModule>;

  async function answersOf(companyId: string, role: string, text: string): Promise<Record<string, string>> {
    const tasks = await db.select().from(evalTasksTable).where(eq(evalTasksTable.companyId, companyId));
    const answers: Record<string, string> = {};
    for (const task of tasks) if (task.role === role) answers[task.slug] = text;
    return answers;
  }

  /** Deliver `first`, then `second`, and hand back the pointer of the first. */
  async function deliverRule(module: Module, slug: string, first: string, second?: string) {
    await module.create({ slug, title: slug, content: first, kind: "rule", approverKind: "owner" }, AGENT);
    await module.submit(slug, AGENT);
    const published = await module.approve(slug, OWNER, { publish: true });
    const firstRevisionId = published.deliveredRevisionId!;
    const itemId = published.id;
    if (second !== undefined) {
      await module.draft(slug, { content: second, submit: true }, AGENT);
      // §2.4 has no published→published edge: re-publishing onto a newer
      // revision is a pointer move. Approve the new revision, then publish it.
      await module.approve(slug, OWNER);
      await module.publish(slug, OWNER);
    }
    return { itemId, firstRevisionId };
  }

  function gateFor(module: Module, judge = markerJudge(GOOD_MARKER), cards: KnowledgeGateOwnerNotice[] = []) {
    return createKnowledgeGate({
      evals: makeEvals(judge),
      sink: createKnowledgeGateSink(module, { actor: GATE_ACTOR, notifyOwner: async (notice) => void cards.push(notice) }),
      defaultThresholdDrop: 5,
    });
  }

  it("a deliberately bad rule is rolled back within two judge runs, with eval_run_id and delta in the journal", async () => {
    const companyId = await makeCompany();
    await seedReferenceTasks(db, companyId, EVALS_PILOT_ROLE, ENGINEER_REFERENCE_TASKS);
    const module = makeModule(companyId);
    const { itemId, firstRevisionId } = await deliverRule(module, "bad-rule", GOOD, BAD);

    // The baseline line: the caste as it answered before this rule was published.
    const evals = makeEvals();
    const baseline = await evals.runEval({
      companyId,
      role: EVALS_PILOT_ROLE,
      subject: "caste-baseline",
      answers: await answersOf(companyId, EVALS_PILOT_ROLE, GOOD),
    });
    expect(baseline.run.scores!.scorePercent).toBeGreaterThan(90);

    const cards: KnowledgeGateOwnerNotice[] = [];
    const gate = gateFor(module, markerJudge(GOOD_MARKER), cards);
    const outcome = await gate.onKnowledgePublished({
      trigger: "rule.approved",
      companyId,
      nestId: companyId,
      itemRef: "bad-rule",
      slug: "bad-rule",
      role: EVALS_PILOT_ROLE,
      content: BAD,
      rollbackToRevisionId: firstRevisionId,
      baselineRunId: baseline.run.id,
      thresholdDrop: 5,
      actor: AGENT,
    });

    // The whole point: caught in ≤ 2 judge runs, no human in the loop.
    expect(outcome.judgeRuns).toBeLessThanOrEqual(2);
    expect(outcome.judgeRuns).toBe(2);
    expect(outcome.verdict).toBe("rollback");
    expect(outcome.rolledBack).toBe(true);
    expect(outcome.ownerNotified).toBe(true);
    expect(outcome.delta).toBeGreaterThanOrEqual(95);

    // Both runs name the item they gated.
    const runs = await db.select().from(evalRunsTable).where(eq(evalRunsTable.subjectRef, "bad-rule"));
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.kind).sort()).toEqual(["confirm", "first"]);
    expect(runs.map((r) => r.subjectKind)).toEqual(["rule", "rule"]);
    expect(runs.find((r) => r.kind === "confirm")!.confirmRunId).toBe(outcome.firstRunId);

    // The pointer is back on the last good delivery (as a fresh copy).
    const item = (await module.get("bad-rule"))!;
    expect(item.deliveredContent).toBe(GOOD);
    expect(item.deliveredRevisionId).not.toBe(firstRevisionId);

    // The journal: the judge run and the delta, plus the rollback event.
    const events = await module.listEvents(itemId);
    const gateLine = events.find((event) => event.event === "knowledge.eval_gate");
    expect(gateLine).toBeDefined();
    expect(gateLine!.payload.eval_run_id).toBe(outcome.runId);
    expect(gateLine!.payload.delta).toBe(outcome.delta);
    expect(gateLine!.payload.verdict).toBe("rollback");
    expect(gateLine!.payload.owner_notice).toBe(true);
    expect(events.some((event) => event.event === "knowledge.rollback")).toBe(true);

    // The owner card lands after the fact, and says why.
    expect(cards).toHaveLength(1);
    expect(cards[0]!.reason).toMatch(/confirmed/);
    expect(cards[0]!.evalRunId).toBe(outcome.runId);
    expect(cards[0]!.delta).toBe(outcome.delta);
  });

  it("a good rule stays delivered on a single judge run and gets its journal line too", async () => {
    const companyId = await makeCompany();
    await seedReferenceTasks(db, companyId, EVALS_PILOT_ROLE, ENGINEER_REFERENCE_TASKS);
    const module = makeModule(companyId);
    const { itemId, firstRevisionId } = await deliverRule(module, "good-rule", GOOD, GOOD);

    const evals = makeEvals();
    const baseline = await evals.runEval({
      companyId,
      role: EVALS_PILOT_ROLE,
      subject: "caste-baseline",
      answers: await answersOf(companyId, EVALS_PILOT_ROLE, GOOD),
    });

    const cards: KnowledgeGateOwnerNotice[] = [];
    const gate = gateFor(module, markerJudge(GOOD_MARKER), cards);
    const outcome = await gate.onKnowledgePublished({
      trigger: "rule.approved",
      companyId,
      nestId: companyId,
      itemRef: "good-rule",
      slug: "good-rule",
      role: EVALS_PILOT_ROLE,
      content: GOOD,
      rollbackToRevisionId: firstRevisionId,
      baselineRunId: baseline.run.id,
      thresholdDrop: 5,
      actor: AGENT,
    });

    expect(outcome.verdict).toBe("keep");
    expect(outcome.judgeRuns).toBe(1); // nothing to repeat: no threshold crossing
    expect(outcome.rolledBack).toBe(false);
    expect(outcome.ownerNotified).toBe(false);
    expect(outcome.delta).toBe(0);
    expect(cards).toHaveLength(0);

    const item = (await module.get("good-rule"))!;
    expect(item.deliveredContent).toBe(GOOD);
    expect(item.deliveredRevisionId).not.toBe(firstRevisionId); // the new delivery stands

    const events = await module.listEvents(itemId);
    expect(events.some((event) => event.event === "knowledge.rollback")).toBe(false);
    const gateLine = events.find((event) => event.event === "knowledge.eval_gate");
    expect(gateLine).toBeDefined();
    expect(gateLine!.payload.verdict).toBe("keep");
    expect(gateLine!.payload.eval_run_id).toBe(outcome.runId);
    expect(gateLine!.payload.delta).toBe(0);
  });

  it("a hallucination rolls back at once — one judge run, no repeat", async () => {
    const companyId = await makeCompany();
    // A role whose corpus has an explicit hallucination criterion (the rubric
    // shape the architecture asks for: "галлюцинации 0").
    await db.insert(evalTasksTable).values({
      companyId,
      role: "gate-role",
      slug: "price-of-item",
      title: "Quote a price without inventing it",
      prompt: "What does this SKU cost?",
      kind: "general",
      weight: 1,
      rubric: {
        criteria: [
          { name: "hallucination", description: "Never state a price that is not in the source.", points: 5 },
          { name: "correctness", description: "The answer matches the source.", points: 5 },
        ],
      },
    });
    const module = makeModule(companyId);
    const { itemId, firstRevisionId } = await deliverRule(module, "price-rule", GOOD, BAD);

    const hallucinatingJudge = createHeuristicJudge(({ criterion }) => (criterion === "hallucination" ? 0 : 99));
    const cards: KnowledgeGateOwnerNotice[] = [];
    const gate = gateFor(module, hallucinatingJudge, cards);
    const outcome = await gate.onKnowledgePublished({
      trigger: "rule.approved",
      companyId,
      nestId: companyId,
      itemRef: "price-rule",
      slug: "price-rule",
      role: "gate-role",
      content: BAD,
      rollbackToRevisionId: firstRevisionId,
      baselineRunId: null,
      thresholdDrop: 5,
      actor: AGENT,
    });

    expect(outcome.verdict).toBe("rollback");
    expect(outcome.judgeRuns).toBe(1); // "откат сразу", no second run spent
    expect(outcome.rolledBack).toBe(true);
    expect(outcome.reason).toMatch(/hallucination/);
    expect(cards).toHaveLength(1);
    expect((await module.get("price-rule"))!.deliveredContent).toBe(GOOD);

    const events = await module.listEvents(itemId);
    const gateLine = events.find((event) => event.event === "knowledge.eval_gate");
    expect(gateLine!.payload.reason).toMatch(/hallucination/);
    expect(gateLine!.payload.eval_run_id).toBe(outcome.runId);
  });
});