// server/src/myrmidon/distill/distill-pass.db.myrmidon.test.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-5): one full distiller pass over a real
// embedded database with synthetic material. Acceptance criteria proven here:
// zero pages created directly (only knowledge_suggestions rows), every kept
// suggestion carries >= 1 source, `noise` is dropped silently, the human
// package is capped at 10, auto-accept only touches the allowed sections, and
// the life-contour boundary (I-7): a task whose project names the `life`
// direction never reaches the common raw material, and a proposal citing a
// life-shaped evidence ref is dropped before the nest.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  companies,
  documents,
  issueComments,
  issueDocuments,
  issues,
  knowledgeEvents,
  knowledgeItems,
  knowledgeSuggestions,
  projects,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { createKnowledgeModule } from "../knowledge/service.js";
import { runDistillPass } from "./service.js";
import { resolveDistillSettings } from "./settings.js";
import type { DistillModelCall } from "./model.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

const NOW = new Date("2026-10-09T00:00:00Z");

describeEmbeddedPostgres("myrmidon(1.6.6 KNOWLEDGE-2.0 K-5) distiller pass over the database (synthetic)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-distill-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog); // the knowledge store mirrors S9 into activity
    for (const table of [knowledgeEvents, knowledgeSuggestions, knowledgeItems]) {
      await db.delete(table);
    }
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(): Promise<string> {
    const row = await db
      .insert(companies)
      .values({ name: `distill ${randomUUID().slice(0, 8)}`, issuePrefix: `D${randomUUID().slice(0, 5).toUpperCase()}`, status: "active" })
      .returning();
    return row[0]!.id;
  }

  /** Closed task inside the window; `completedAt` drives selection (§4.5). */
  async function seedClosedTask(opts: {
    identifier: string;
    title: string;
    projectId?: string;
    completedMinutesAgo?: number;
    comments?: string[];
    doc?: { key: string; body: string };
  }): Promise<string> {
    const [issue] = await db
      .insert(issues)
      .values({
        companyId,
        identifier: opts.identifier,
        title: opts.title,
        description: `desc ${opts.title}`,
        status: "done",
        priority: "medium",
        projectId: opts.projectId ?? null,
        completedAt: new Date(NOW.getTime() - (opts.completedMinutesAgo ?? 60) * 60_000),
      })
      .returning();
    const id = issue!.id;
    for (const body of opts.comments ?? []) {
      await db.insert(issueComments).values({ companyId, issueId: id, authorType: "agent", body });
    }
    if (opts.doc) {
      const [doc] = await db
        .insert(documents)
        .values({ companyId, title: opts.doc.key, format: "markdown", latestBody: opts.doc.body, latestRevisionNumber: 1 })
        .returning();
      await db.insert(issueDocuments).values({ companyId, issueId: id, documentId: doc!.id, key: opts.doc.key });
    }
    return id;
  }

  function modelReturning(json: unknown): DistillModelCall {
    return async () => ({
      text: JSON.stringify(json),
      usage: { inputTokens: 12_345, outputTokens: 678 },
    });
  }

  function settings(autoAcceptSections: string[]) {
    return resolveDistillSettings(
      { knowledgeDistill: { enabled: true, autoAcceptSections, windowSec: 6 * 3600 } },
      {},
    );
  }

  async function suggestions(): Promise<Array<{ body: string; sourceRef: string | null; status: string }>> {
    const rows = await db.select().from(knowledgeSuggestions);
    return rows.map((r) => ({ body: r.body, sourceRef: r.sourceRef, status: r.status }));
  }

  it("closed tasks in the window become suggestions; noise silent; 0 pages written directly", async () => {
    companyId = await seedCompany();
    await seedClosedTask({ identifier: "T-1", title: "Deploy script hardened", comments: ["done, rollback works"] });
    await seedClosedTask({ identifier: "T-2", title: "Deploy script hardened again", comments: ["same patch"] });
    await seedClosedTask({ identifier: "T-3", title: "Weekly sync notes", comments: ["chatter"] });
    // outside the window: older than 6 h — must not be selected
    await seedClosedTask({ identifier: "T-4", title: "Ancient task", completedMinutesAgo: 600 });

    const model = modelReturning([
      { class: "decision", body: "Deploys roll back via the hardened script", rationale: "two patches", section: "how-made", slug: null, evidence: ["T-1", "T-2"] },
      { class: "noise", body: "sync notes", rationale: null, section: "general", slug: null, evidence: ["T-3"] },
      { class: "glossary_term", body: "no-source term", rationale: null, section: "glossary", slug: null, evidence: ["T-999"] },
    ]);

    const knowledge = createKnowledgeModule(db, companyId, { now: () => NOW });
    const report = await runDistillPass({ db, knowledge, model, settings: settings(["glossary"]), now: () => NOW });

    expect(report.tasksConsidered).toBe(3); // T-4 outside the window
    expect(report.droppedNoise).toBe(1); // silent — no per-item journal row
    expect(report.droppedUnsourced).toBeGreaterThanOrEqual(1); // T-999 resolves to nothing
    expect(report.suggestionsCreated).toBe(1);
    expect(report.noiseShare).toBeCloseTo(1 / 3, 5);
    expect(report.usage.inputTokens).toBe(12_345);

    const sugg = await suggestions();
    expect(sugg).toHaveLength(1);
    expect(sugg[0]!.body).toContain("hardened script");
    expect(sugg[0]!.sourceRef).toBeTruthy(); // every kept suggestion carries a source

    // K-5 criterion: the pass wrote ZERO pages — only suggestions.
    const items = await db.select().from(knowledgeItems);
    expect(items).toHaveLength(0);

    // the journal sees the spend: one knowledge.distill.pass event with numbers.
    const events = await db
      .select()
      .from(knowledgeEvents)
      .where(and(eq(knowledgeEvents.companyId, companyId), eq(knowledgeEvents.event, "knowledge.distill.pass")));
    expect(events).toHaveLength(1);
    const payload = events[0]!.payload as Record<string, unknown>;
    expect(payload.suggestionsCreated).toBe(1);
    expect((payload.usage as Record<string, unknown>).inputTokens).toBe(12_345);
  });

  it("I-7: life-contour material never reaches common suggestions (selection + ref edges)", async () => {
    companyId = await seedCompany();
    const [lifeProject] = await db
      .insert(projects)
      .values({ companyId, name: "fleet-life", status: "active" })
      .returning();
    await seedClosedTask({ identifier: "L-1", title: "private contour note", projectId: lifeProject!.id, comments: ["personal"] });
    await seedClosedTask({ identifier: "P-1", title: "public work", comments: ["ok"] });

    // the model misbehaves: one proposal cites a life-shaped evidence ref (T
    // from the private contour), one is clean.
    const model = modelReturning([
      { class: "decision", body: "leaked private claim", rationale: null, section: "general", slug: null, evidence: ["LIFE-9"] },
      { class: "runbook_step", body: "public runbook", rationale: null, section: "general", slug: null, evidence: ["P-1"] },
    ]);

    const knowledge = createKnowledgeModule(db, companyId, { now: () => NOW });
    const report = await runDistillPass({ db, knowledge, model, settings: settings([]), now: () => NOW });

    expect(report.tasksConsidered).toBe(1); // L-1 excluded at the selection edge
    expect(report.tasksExcludedLife).toBe(1);
    expect(report.droppedLife).toBe(1); // LIFE-9 ref blocked at the filter edge

    const sugg = await suggestions();
    expect(sugg).toHaveLength(1);
    expect(sugg[0]!.body).toContain("public runbook");
    expect(sugg.some((s) => s.body.includes("private"))).toBe(false);
  });

  it("human package capped at 10; auto-accept only for glossary sections present in settings", async () => {
    companyId = await seedCompany();
    const ids = ["A-1", "A-2", "A-3", "A-4", "A-5", "A-6", "A-7", "A-8", "A-9", "A-10", "A-11", "A-12"];
    for (const id of ids) await seedClosedTask({ identifier: id, title: `task ${id}`, comments: ["done"] });

    const model = modelReturning(
      ids.map((id) => ({
        class: id.endsWith("1") ? "glossary_term" : "decision",
        body: `claim from ${id}`,
        rationale: null,
        section: id.endsWith("1") ? "glossary" : "general",
        slug: null,
        evidence: [id],
      })),
    );

    const knowledge = createKnowledgeModule(db, companyId, { now: () => NOW });
    const report = await runDistillPass({ db, knowledge, model, settings: settings(["glossary"]), now: () => NOW });

    expect(report.suggestionsCreated).toBeLessThanOrEqual(10);
    const sugg = await suggestions();
    expect(sugg.length).toBeLessThanOrEqual(10);
    const accepted = sugg.filter((s) => s.status === "accepted");
    const glossaryBodies = sugg.filter((s) => s.body.includes("glossary_term"));
    expect(accepted.length).toBe(glossaryBodies.length);
    expect(accepted.length).toBeGreaterThan(0); // auto-accept fired for glossary only
    for (const s of sugg) {
      if (s.status === "accepted") expect(s.body).toContain("glossary_term");
    }
  });

  it("over-budget is a signal, not a crash", async () => {
    companyId = await seedCompany();
    await seedClosedTask({ identifier: "B-1", title: "big task", comments: ["x"] });
    const model = modelReturning([{ class: "decision", body: "claim", rationale: null, section: "general", slug: null, evidence: ["B-1"] }]);
    const knowledge = createKnowledgeModule(db, companyId, { now: () => NOW });
    const report = await runDistillPass({
      db,
      knowledge,
      model,
      settings: settings([]),
      now: () => NOW,
      budget: { maxInputTokens: 1000, maxDurationMs: 30 * 60_000 },
    });
    expect(report.budgetSignals).toContain("token_budget_exceeded");
    expect(report.suggestionsCreated).toBe(1); // the pass still completed
  });

  it("empty window: no model call, silent zero-report still journaled", async () => {
    companyId = await seedCompany();
    let called = 0;
    const model: DistillModelCall = async () => {
      called += 1;
      return { text: "[]", usage: { inputTokens: 0, outputTokens: 0 } };
    };
    const knowledge = createKnowledgeModule(db, companyId, { now: () => NOW });
    const report = await runDistillPass({ db, knowledge, model, settings: settings([]), now: () => NOW });
    expect(called).toBe(0);
    expect(report.tasksConsidered).toBe(0);
    const events = await db.select().from(knowledgeEvents).where(eq(knowledgeEvents.event, "knowledge.distill.pass"));
    expect(events).toHaveLength(1);
  });
});
