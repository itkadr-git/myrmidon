// server/src/myrmidon/knowledge/knowledge-store.db.myrmidon.test.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-1): the store + service against a real
// embedded database — the acceptance criteria (new draft never moves
// delivered_revision_id; approve of an approval-required item without
// approver_kind is 403; rollback creates a revision copy and moves the
// pointer; export → import → export is byte-for-byte), the link/backlink
// resolution, the pg SearchIndex (tsvector + pg_trgm + unaccent), the
// knowledge_events + activity mirror, and the module hygiene gate (0 SQL
// triggers and 0 dialect `sql\`` inside the module code).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  activityLog,
  agentCastes,
  agents,
  companies,
  createDb,
  createPgKnowledgeSearchIndex,
  knowledgeItems,
  knowledgeLinks,
  knowledgeRevisions,
  knowledgeSources,
  myrmidonWikiRegulations,
} from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { KnowledgeDomainError, createMemorySearchIndex, serializeKnowledgeTree, type KnowledgeTreePage } from "./domain.js";
import { createKnowledgeService, type KnowledgeActor } from "./store.js";
import { createKnowledgeModule } from "./service.js";
import { knowledgeRoutes } from "./routes.js";
import { errorHandler } from "../../middleware/index.js";
import { createDbRegulationStore } from "../wiki-cortex/store.js";
import { createKnowledgeAutonomyRegulationsBackend } from "../autonomy/knowledge-regulations.js";
import { resolvedRules } from "./rules.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

let AGENT!: KnowledgeActor; // rebuilt per company: activity_log.agent_id is an FK
let BOT!: KnowledgeActor;
const OWNER: KnowledgeActor = { actorType: "user", actorId: "owner-1", kind: "owner" };
const OPERATOR: KnowledgeActor = { actorType: "user", actorId: "operator-1", kind: "operator" };

describeEmbeddedPostgres("myrmidon(1.6.6 KNOWLEDGE-2.0 K-1) knowledge store over the database", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-knowledge-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(knowledgeSources);
    await db.delete(knowledgeRevisions);
    await db.delete(knowledgeItems);
    await db.delete(myrmidonWikiRegulations);
    await db.delete(agentCastes);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function makeCompany(): Promise<string> {
    const row = await db
      .insert(companies)
      .values({ name: `company ${randomUUID()}`, issuePrefix: `KN${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
    const [a1, a2] = await db
      .insert(agents)
      .values([
        { companyId: row.id, name: `writer-${randomUUID().slice(0, 6)}`, role: "writer" },
        { companyId: row.id, name: `bot-${randomUUID().slice(0, 6)}`, role: "bot" },
      ])
      .returning();
    AGENT = { actorType: "agent", actorId: a1!.id, kind: null };
    BOT = { actorType: "agent", actorId: a2!.id, kind: "bot" };
    return row.id;
  }

  function makeStore() {
    return createKnowledgeService(db, { now: () => new Date("2026-10-08T00:00:00Z") });
  }

  it("create writes the item, revision 1 and a knowledge.created event; slugs are unique per nest", async () => {
    companyId = await makeCompany();
    const store = makeStore();
    const item = await store.create(
      { companyId, nestId: companyId, slug: "playbook", title: "Playbook", content: "start here", summary: "intro", tags: ["onboarding"], sources: [{ kind: "issue", ref: "the K-1 spec", note: "spec" }] },
      AGENT,
    );
    expect(item.status).toBe("draft");
    expect(item.currentRevisionNumber).toBe(1);
    expect(item.deliveredRevisionId).toBeNull();

    await expect(
      store.create({ companyId, nestId: companyId, slug: "playbook", title: "dup", content: "x" }, AGENT),
    ).rejects.toMatchObject({ code: "slug_conflict", status: 409 });

    const revs = await store.listRevisions(companyId, "playbook");
    expect(revs).toHaveLength(1);
    expect(revs[0]!.sources).toEqual([{ kind: "issue", ref: "the K-1 spec", note: "spec" }]);

    const events = await store.listEvents(companyId, item.id);
    expect(events.map((event) => event.event)).toEqual(["knowledge.created"]);

    const mirrored = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "knowledge.created")));
    expect(mirrored.length).toBe(1);
  });

  it("a new draft never moves delivered_revision_id (S3)", async () => {
    companyId = await makeCompany();
    const store = makeStore();
    await store.create(
      { companyId, nestId: companyId, slug: "page", title: "Page", content: "Initial page content v1 with more than twenty characters." },
      AGENT,
    );
    await store.publish(companyId, "page", AGENT); // notes publish without approval
    const delivered = (await store.get(companyId, "page"))!;
    expect(delivered.deliveredContent).toBe("Initial page content v1 with more than twenty characters.");

    await store.draft(
      companyId,
      "page",
      { content: "Updated page content v2 draft with more than twenty characters." },
      AGENT,
    );
    const after = (await store.get(companyId, "page"))!;
    expect(after.deliveredRevisionId).toBe(delivered.deliveredRevisionId);
    expect(after.deliveredContent).toBe("Initial page content v1 with more than twenty characters.");
    expect(after.currentRevisionNumber).toBe(2);
  });

  it("approve of an approval-required item without approver_kind is 403 (S4)", async () => {
    companyId = await makeCompany();
    const store = makeStore();
    await store.create(
      { companyId, nestId: companyId, slug: "gate", title: "Gate", content: "c", kind: "note", approvalRequired: true, approverKind: null },
      AGENT,
    );
    await store.submit(companyId, "gate", AGENT);
    const error = await store.approve(companyId, "gate", OWNER).catch((e) => e);
    expect(error).toBeInstanceOf(KnowledgeDomainError);
    expect((error as KnowledgeDomainError).status).toBe(403);
    expect((error as KnowledgeDomainError).code).toBe("rule_requires_approver_kind");

    // publish without an approved revision is refused for approval-required items
    const pub = await store.publish(companyId, "gate", AGENT).catch((e) => e);
    expect((pub as KnowledgeDomainError).code).toBe("publish_requires_approval");
  });

  it("approve needs the presented approver kind; approve+publish delivers the revision", async () => {
    companyId = await makeCompany();
    const store = makeStore();
    await store.create(
      { companyId, nestId: companyId, slug: "budget-rule", title: "Budget rule", content: "cap 100", kind: "rule", roles: ["cmo"] },
      AGENT,
    );
    await store.submit(companyId, "budget-rule", AGENT);

    const wrong = await store.approve(companyId, "budget-rule", BOT).catch((e) => e);
    expect((wrong as KnowledgeDomainError).status).toBe(403);
    expect((wrong as KnowledgeDomainError).code).toBe("approver_kind_mismatch");

    const approved = await store.approve(companyId, "budget-rule", OWNER, { publish: true });
    expect(approved.status).toBe("published");
    expect(approved.deliveredRevisionId).not.toBeNull();
    const rev = (await store.getRevision(companyId, "budget-rule", approved.deliveredRevisionId!))!;
    expect(rev.status).toBe("approved");
    expect(rev.approvedByKind).toBe("owner");

    const events = await store.listEvents(companyId, approved.id);
    expect(events.map((event) => event.event)).toEqual(["knowledge.created", "knowledge.submitted", "knowledge.approved"]);
  });

  it("derives approver_kind from roles and the caste directory: SMM rule refuses operator 403 and succeeds for owner", async () => {
    companyId = await makeCompany();
    await db.insert(agentCastes).values({
      companyId,
      key: "smm",
      nameEn: "SMM",
      color: "blue",
      sensitive: true,
    });
    const store = makeStore();
    const created = await store.create(
      { companyId, nestId: companyId, slug: "rules/smm/publications", title: "SMM Rules", content: "review first", kind: "rule", roles: ["smm"], approverKind: "operator" },
      AGENT,
    );
    expect(created.approverKind).toBe("owner");
    await store.submit(companyId, "rules/smm/publications", AGENT);

    const operatorAttempt = await store.approve(companyId, "rules/smm/publications", OPERATOR).catch((e) => e);
    expect((operatorAttempt as KnowledgeDomainError).status).toBe(403);
    expect((operatorAttempt as KnowledgeDomainError).code).toBe("approver_kind_mismatch");

    const approved = await store.approve(companyId, "rules/smm/publications", OWNER, { publish: true });
    expect(approved.status).toBe("published");
    expect(approved.deliveredRevisionId).not.toBeNull();
  });

  it("migrates legacy wiki regulations to knowledge rules (N-4) idempotently", async () => {
    companyId = await makeCompany();
    const regId = randomUUID();
    await db.insert(myrmidonWikiRegulations).values({
      id: regId,
      companyId,
      slug: "rules/ops/runbooks",
      title: "Ops Runbooks",
      content: "Revision 2 content",
      status: "approved",
      roles: ["devops"],
      revisions: [
        {
          revisionNumber: 1,
          title: "Ops Runbooks",
          roles: ["devops"],
          content: "Revision 1 draft",
          status: "draft",
          changeSummary: "Initial draft",
          createdByAgentId: null,
          createdByUserId: null,
          createdAt: "2026-09-01T00:00:00.000Z",
        },
        {
          revisionNumber: 2,
          title: "Ops Runbooks",
          roles: ["devops"],
          content: "Revision 2 content",
          status: "approved",
          changeSummary: "Approved",
          createdByAgentId: null,
          createdByUserId: null,
          createdAt: "2026-09-02T00:00:00.000Z",
        },
      ],
      revisionNumber: 2,
    });

    // N-4 runs the shipped migration file, not a copy of it. The DDL statements
    // (ALTER/CREATE, the cmo flag) are already applied to the test database, so
    // only the data-moving statements are replayed.
    const migrationSql = readFileSync(
      join(import.meta.dirname, "../../../../packages/db/src/migrations/0413_knowledge_rules.sql"),
      "utf8",
    );
    const dataStatements = migrationSql
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter((statement) => /^(INSERT INTO|UPDATE "knowledge_items")/.test(statement));
    expect(dataStatements).toHaveLength(4);
    const runMigration = async () => {
      for (const statement of dataStatements) await db.execute(sql.raw(statement));
    };

    // First run
    await runMigration();
    const items = await db.select().from(knowledgeItems).where(eq(knowledgeItems.companyId, companyId));
    expect(items).toHaveLength(1);
    const [migrated] = items;
    expect(migrated!.slug).toBe("rules/ops/runbooks");
    expect(migrated!.status).toBe("published");
    expect(migrated!.currentRevisionNumber).toBe(2);
    expect(migrated!.deliveredRevisionId).not.toBeNull();

    const revs = await db.select().from(knowledgeRevisions).where(eq(knowledgeRevisions.itemId, migrated!.id));
    expect(revs).toHaveLength(2);

    const sources = await db.select().from(knowledgeSources).where(eq(knowledgeSources.companyId, companyId));
    expect(sources).toHaveLength(2);
    expect(sources[0]!.ref).toBe(`myrmidon_wiki_regulations:${regId}`);

    // Second run is idempotent
    await runMigration();
    const itemsSecond = await db.select().from(knowledgeItems).where(eq(knowledgeItems.companyId, companyId));
    expect(itemsSecond).toHaveLength(1);
    const revsSecond = await db.select().from(knowledgeRevisions).where(eq(knowledgeRevisions.itemId, migrated!.id));
    expect(revsSecond).toHaveLength(2);
    const sourcesSecond = await db.select().from(knowledgeSources).where(eq(knowledgeSources.companyId, companyId));
    expect(sourcesSecond).toHaveLength(2);
  });

  it("wiki-cortex store reads and writes knowledge rules without touching myrmidon_wiki_regulations", async () => {
    companyId = await makeCompany();
    const wikiStore = createDbRegulationStore(db);

    // Save draft
    const saved = await wikiStore.put({
      id: randomUUID(),
      companyId,
      slug: "deploy/pipeline",
      title: "Deployment Pipeline",
      roles: ["devops"],
      status: "draft",
      revisionNumber: 1,
      content: "Pipeline draft content",
      revisions: [
        {
          revisionNumber: 1,
          title: "Deployment Pipeline",
          roles: ["devops"],
          content: "Pipeline draft content",
          status: "draft",
          changeSummary: "initial draft",
          createdByAgentId: null,
          createdByUserId: "user-1",
          createdAt: new Date().toISOString(),
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(saved.slug).toBe("deploy/pipeline");
    expect(saved.status).toBe("draft");

    // Verify knowledge_items has it as kind="rule"
    const items = await db.select().from(knowledgeItems).where(and(eq(knowledgeItems.companyId, companyId), eq(knowledgeItems.slug, "deploy/pipeline")));
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("rule");
    expect(items[0]!.status).toBe("draft");
    expect(items[0]!.deliveredRevisionId).toBeNull();

    // Verify myrmidon_wiki_regulations table is untouched (0 rows)
    const legacyRows = await db.select().from(myrmidonWikiRegulations).where(eq(myrmidonWikiRegulations.companyId, companyId));
    expect(legacyRows).toHaveLength(0);

    // Approve the regulation
    const approved = await wikiStore.put({
      ...saved,
      status: "approved",
      revisions: [
        {
          ...saved.revisions[0]!,
          status: "approved",
        },
      ],
      updatedAt: new Date(),
    });
    expect(approved.status).toBe("approved");

    // Verify knowledge_items deliveredRevisionId is now set
    const [approvedItem] = await db.select().from(knowledgeItems).where(and(eq(knowledgeItems.companyId, companyId), eq(knowledgeItems.slug, "deploy/pipeline")));
    expect(approvedItem!.status).toBe("published");
    expect(approvedItem!.deliveredRevisionId).not.toBeNull();

    // Verify get and list
    const fetched = await wikiStore.get(companyId, "deploy/pipeline");
    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe("Deployment Pipeline");
    expect(fetched!.status).toBe("approved");

    const list = await wikiStore.list(companyId);
    expect(list.some((r) => r.slug === "deploy/pipeline")).toBe(true);

    // Verify myrmidon_wiki_regulations table remains untouched (0 rows)
    const legacyRowsAfter = await db.select().from(myrmidonWikiRegulations).where(eq(myrmidonWikiRegulations.companyId, companyId));
    expect(legacyRowsAfter).toHaveLength(0);
  });

  it("autonomy regulations CRUD reads and writes knowledge rules with change log and without touching myrmidon_wiki_regulations", async () => {
    companyId = await makeCompany();
    await db.insert(agentCastes).values({
      companyId,
      key: "cmo",
      nameEn: "CMO",
      color: "purple",
      sensitive: true,
    });

    const activityLogs: any[] = [];
    const logActivity = async (entry: any) => {
      activityLogs.push(entry);
    };
    const backend = createKnowledgeAutonomyRegulationsBackend(db, logActivity);

    // Create
    const createdRes = await backend.create(
      companyId,
      { type: "board", id: "user-1" },
      { role: "cmo", title: "Marketing Strategy", bodyMarkdown: "Draft v1" },
    );
    expect(createdRes.ok).toBe(true);
    if (!createdRes.ok) return;
    const reg = createdRes.value;
    expect(reg.role).toBe("cmo");
    expect(reg.title).toBe("Marketing Strategy");
    expect(reg.status).toBe("draft");
    expect(reg.revision).toBe(1);
    expect(reg.wikiPageId).toBe("rules/cmo/marketing-strategy");

    // Check knowledgeItems
    const [item] = await db.select().from(knowledgeItems).where(eq(knowledgeItems.id, reg.id));
    expect(item).toBeDefined();
    expect(item!.kind).toBe("rule");
    expect(item!.approverKind).toBe("owner"); // cmo is sensitive -> owner
    expect(item!.status).toBe("draft");

    // myrmidon_wiki_regulations untouched
    expect(await db.select().from(myrmidonWikiRegulations).where(eq(myrmidonWikiRegulations.companyId, companyId))).toHaveLength(0);

    // Update
    const updatedRes = await backend.update(
      companyId,
      { type: "board", id: "user-1" },
      { id: reg.id, bodyMarkdown: "Draft v2" },
    );
    expect(updatedRes.ok).toBe(true);
    if (!updatedRes.ok) return;
    expect(updatedRes.value.revision).toBe(2);
    expect(updatedRes.value.bodyMarkdown).toBe("Draft v2");
    expect(updatedRes.value.status).toBe("draft");

    // Approve: a sensitive caste's rule is the owner's; the operator is refused (403 gate)
    const operatorApprove = await backend.approve(companyId, { type: "board", id: "user-2" }, reg.id, "operator");
    expect(operatorApprove).toEqual({
      ok: false,
      failure: { kind: "approver_kind_mismatch", regulationId: reg.id, required: "owner", presented: "operator" },
    });
    expect((await db.select().from(knowledgeItems).where(eq(knowledgeItems.id, reg.id)))[0]!.deliveredRevisionId).toBeNull();
    const noKindApprove = await backend.approve(companyId, { type: "board", id: "user-2" }, reg.id, null);
    expect(noKindApprove.ok).toBe(false);
    const approvedRes = await backend.approve(companyId, { type: "board", id: "user-1" }, reg.id, "owner");
    expect(approvedRes.ok).toBe(true);
    if (!approvedRes.ok) return;
    expect(approvedRes.value.status).toBe("approved");

    const [approvedItem] = await db.select().from(knowledgeItems).where(eq(knowledgeItems.id, reg.id));
    expect(approvedItem!.status).toBe("published");
    expect(approvedItem!.deliveredRevisionId).not.toBeNull();

    // Restore to revision 1: the rollback publishes at once, so it passes the same gate
    const operatorRestore = await backend.restore(companyId, { type: "board", id: "user-2" }, { id: reg.id, toRevision: 1 }, "operator");
    expect(operatorRestore.ok).toBe(false);
    if (!operatorRestore.ok) expect(operatorRestore.failure.kind).toBe("approver_kind_mismatch");
    const [afterRefusedRestore] = await db.select().from(knowledgeItems).where(eq(knowledgeItems.id, reg.id));
    expect(afterRefusedRestore!.currentRevisionNumber).toBe(2);
    const restoredRes = await backend.restore(companyId, { type: "board", id: "user-1" }, { id: reg.id, toRevision: 1 }, "owner");
    expect(restoredRes.ok).toBe(true);
    if (!restoredRes.ok) return;
    expect(restoredRes.value.revision).toBe(3);
    expect(restoredRes.value.bodyMarkdown).toBe("Draft v1");
    expect(restoredRes.value.status).toBe("approved");

    // List
    const all = await backend.list(companyId);
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe(reg.id);

    // Delete
    const deletedRes = await backend.delete(companyId, { type: "board", id: "user-1" }, reg.id, "owner");
    expect(deletedRes.ok).toBe(true);
    expect(await backend.list(companyId)).toHaveLength(0);

    // myrmidon_wiki_regulations still untouched
    expect(await db.select().from(myrmidonWikiRegulations).where(eq(myrmidonWikiRegulations.companyId, companyId))).toHaveLength(0);

    // Activity log captured mutations
    expect(activityLogs.map((l) => l.action)).toEqual([
      "myrmidon.autonomy.regulation_created",
      "myrmidon.autonomy.regulation_edited",
      "myrmidon.autonomy.regulation_approved",
      "myrmidon.autonomy.regulation_rolled_back",
      "myrmidon.autonomy.regulation_deleted",
    ]);
  });

  it("unified carrier: rules created by autonomy are visible in wiki-cortex and delivery resolver", async () => {
    companyId = await makeCompany();
    const backend = createKnowledgeAutonomyRegulationsBackend(db);
    const created = await backend.create(
      companyId,
      { type: "board", id: "user-1" },
      { role: "engineer", title: "Git Workflow", bodyMarkdown: "Squash before merge." },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await backend.approve(companyId, { type: "board", id: "user-1" }, created.value.id, "operator");

    // Read via wiki-cortex store
    const wikiStore = createDbRegulationStore(db);
    const wikiPages = await wikiStore.list(companyId);
    expect(wikiPages.some((p) => p.title === "Git Workflow")).toBe(true);
    const page = await wikiStore.get(companyId, created.value.wikiPageId!);
    expect(page).not.toBeNull();
    expect(page!.content).toBe("Squash before merge.");

    // Read via knowledge delivery resolver
    const mod = createKnowledgeModule(db, companyId);
    const delivered = await resolvedRules(mod, "engineer");
    expect(delivered.some((r) => r.title === "Git Workflow" && r.content === "Squash before merge.")).toBe(true);
  });

  it("rollback copies the target revision and moves the pointer (S5)", async () => {
    companyId = await makeCompany();
    const store = makeStore();
    await store.create(
      { companyId, nestId: companyId, slug: "log", title: "Log", content: "Initial revision 1 good content with plenty of text.", sources: [{ kind: "pr", ref: "myrmidon#816", note: null }] },
      AGENT,
    );
    await store.publish(companyId, "log", AGENT);
    const r1 = (await store.get(companyId, "log"))!.deliveredRevisionId!;
    await store.draft(
      companyId,
      "log",
      { content: "Updated revision 2 bad content with plenty of text.", submit: true },
      AGENT,
    );
    await store.publish(companyId, "log", AGENT);
    const r2 = (await store.get(companyId, "log"))!.deliveredRevisionId!;

    const rolled = await store.rollback(companyId, "log", AGENT, { targetRevisionId: r1 });
    expect(rolled.currentRevisionNumber).toBe(3);
    expect(rolled.deliveredRevisionId).not.toBe(r1); // a copy, not the old row
    const copy = (await store.getRevision(companyId, "log", rolled.deliveredRevisionId!))!;
    expect(copy.content).toBe("Initial revision 1 good content with plenty of text.");
    expect(copy.status).toBe("approved");
    expect(copy.rolledBackFromRevisionId).toBe(r1);
    expect(copy.sources).toEqual([{ kind: "pr", ref: "myrmidon#816", note: null }]); // provenance mirrored
    expect((await store.get(companyId, "log"))!.deliveredContent).toBe("Initial revision 1 good content with plenty of text.");

    const noop = await store.rollback(companyId, "log", AGENT, { targetRevisionId: rolled.deliveredRevisionId! }).catch((e) => e);
    expect((noop as KnowledgeDomainError).code).toBe("rollback_noop");
  });

  it("[[…]] links resolve forwards and backwards; missing targets stay pending and backfill", async () => {
    companyId = await makeCompany();
    const store = makeStore();
    await store.create({ companyId, nestId: companyId, slug: "guide", title: "Guide", content: "see [[playbook]] and [[ghost]]" }, AGENT);

    // playbook does not exist yet: the references are recorded unresolved
    const pendingLinks = await db
      .select()
      .from(knowledgeLinks)
      .where(and(eq(knowledgeLinks.nestId, companyId), isNull(knowledgeLinks.resolvedItemId)));
    expect(pendingLinks.map((l) => l.targetSlug).sort()).toEqual(["ghost", "playbook"]);
    await store.create({ companyId, nestId: companyId, slug: "playbook", title: "Playbook", content: "body" }, AGENT);
    const filled = await store.backlinks(companyId, "playbook");
    expect(filled).toHaveLength(1);
    expect(filled[0]!.sourceSlug).toBe("guide");
    expect(filled[0]!.resolved).toBe(true);

    const ghost = await store.get(companyId, "ghost");
    expect(ghost).toBeNull();
    const links = await store.backlinks(companyId, "guide");
    expect(links).toEqual([]); // guide links OUT; nobody links into guide
    await store.create({ companyId, nestId: companyId, slug: "deep", title: "Deep", content: "x [[guide]]" }, AGENT);
    expect((await store.backlinks(companyId, "guide")).map((l) => l.sourceSlug)).toEqual(["deep"]);
  });

  it("archive clears the pointer and drops the page from the index; supersede is terminal (S6/S7)", async () => {
    companyId = await makeCompany();
    const store = createKnowledgeService(db, { searchIndex: createMemorySearchIndex() });
    await store.create({ companyId, nestId: companyId, slug: "old", title: "Old", content: "ancient quokka facts" }, AGENT);
    await store.publish(companyId, "old", AGENT);
    expect((await store.search(companyId, "quokka")).length).toBe(1);

    await store.archive(companyId, "old", AGENT);
    const archived = (await store.get(companyId, "old"))!;
    expect(archived.status).toBe("archived");
    expect(archived.deliveredRevisionId).toBeNull();
    expect(await store.search(companyId, "quokka")).toEqual([]);

    await store.create({ companyId, nestId: companyId, slug: "new", title: "New", content: "n" }, AGENT);
    const superseded = await store.supersede(companyId, "old", AGENT, { bySlug: "new" });
    expect(superseded.status).toBe("superseded");
    expect(superseded.supersededByItemId).not.toBeNull();
    const ro = await store.draft(companyId, "old", { content: "z" }, AGENT).catch((e) => e);
    expect((ro as KnowledgeDomainError).code).toBe("superseded_read_only");
  });

  it("export → import → export is byte-for-byte and re-import is idempotent", async () => {
    companyId = await makeCompany();
    const store = makeStore();
    await store.create({ companyId, nestId: companyId, slug: "a/page", title: "Page A", content: "alpha content", kind: "note", tags: ["t1"] }, AGENT);
    await store.publish(companyId, "a/page", AGENT);
    await store.create({ companyId, nestId: companyId, slug: "b/rule", title: "Rule B", content: "cap", kind: "rule", roles: ["cmo"], approverKind: "owner" }, AGENT);
    await store.submit(companyId, "b/rule", AGENT);
    await store.approve(companyId, "b/rule", OWNER, { publish: true });
    await store.create({ companyId, nestId: companyId, slug: "c/draft", title: "Draft C", content: "never delivered" }, AGENT);

    const first = await store.exportTree(companyId);
    // importing the same export back must not change a single byte
    const result = await store.importTree(companyId, companyId, first, AGENT);
    expect(result.created).toBe(0);
    expect(result.updated).toBe(3);
    const second = await store.exportTree(companyId);
    expect(second.equals(first)).toBe(true);

    // a foreign nest's tree is refused
    const other = await makeCompany();
    const mismatch = await store.importTree(other, other, first, AGENT).catch((e) => e);
    expect((mismatch as KnowledgeDomainError).code).toBe("nest_mismatch");

    // an empty nest round-trips too
    const emptyCompany = await makeCompany();
    const empty = await store.exportTree(emptyCompany);
    await store.importTree(emptyCompany, emptyCompany, empty, AGENT);
    expect((await store.exportTree(emptyCompany)).equals(empty)).toBe(true);
  });

  it("suggestions flow pending → accepted/declined and re-decide is 409 (S8)", async () => {
    companyId = await makeCompany();
    const store = makeStore();
    await store.create({ companyId, nestId: companyId, slug: "t", title: "T", content: "c" }, AGENT);
    const suggestion = await store.suggest(companyId, BOT, { companyId, body: "add deploy note", rationale: "seen in run", targetSlug: "t", sourceKind: "run", sourceRef: "run-9" });
    expect(suggestion.status).toBe("pending");
    expect(suggestion.targetItemId).not.toBeNull();
    expect((await store.listSuggestions(companyId, "pending")).length).toBe(1);

    await store.decideSuggestion(companyId, OWNER, { suggestionId: suggestion.id, companyId, decision: "accepted" });
    await store.decideSuggestion(companyId, OWNER, { suggestionId: suggestion.id, companyId, decision: "declined" }).catch((e) => {
      expect((e as KnowledgeDomainError).code).toBe("suggestion_decided");
    });
    expect((await store.listSuggestions(companyId, "accepted")).length).toBe(1);
    const events = await store.listEvents(companyId, suggestion.targetItemId!);
    expect(events.some((event) => event.event === "knowledge.suggested")).toBe(true);
  });

  it("the pg SearchIndex (tsvector + pg_trgm) finds delivered content through the module (S9 wiring)", async () => {
    companyId = await makeCompany();
    const mod = createKnowledgeModule(db, companyId, {
      now: () => new Date("2026-10-08T00:00:00Z"),
      searchIndex: createPgKnowledgeSearchIndex(db),
    });
    expect(mod.nestId).toBe(companyId); // today: one nest per company

    await mod.create({ slug: "mars", title: "Mars landing notes", content: "the quokka surveyed the red dunes", summary: "field notes" }, AGENT);
    await mod.publish("mars", AGENT);
    await mod.create({ slug: "moon", title: "Moon base plan", content: "solar arrays and regolith bricks" }, AGENT);
    await mod.publish("moon", AGENT);

    const hits = await mod.search("quokka");
    expect(hits.map((hit) => hit.slug)).toEqual(["mars"]);
    const fuzzy = await mod.search("regolithe"); // trigram tolerance
    expect(fuzzy.map((hit) => hit.slug)).toContain("moon");

    const draftOnly = await mod.draft("mars", { content: "unpublished words: zebra" }, AGENT);
    expect(draftOnly.deliveredRevisionId).not.toBeNull();
    expect(await mod.search("zebra")).toEqual([]); // drafts are not indexed until delivered
    await mod.publish("mars", AGENT, (await mod.listRevisions("mars"))[1]!.id);
    expect((await mod.search("zebra")).map((h) => h.slug)).toEqual(["mars"]);
  });

  // K-3: import and delete are not a way around the approver grade.
  describe("approver grade on import and delete", () => {
    const grade = (membershipRole: string, isInstanceAdmin = false) => ({
      type: "board",
      source: "session",
      userId: `user-${membershipRole}`,
      isInstanceAdmin,
      companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole }],
    });

    function httpApp(actor: unknown) {
      const server = express();
      server.use(express.json());
      server.use((req, _res, next) => {
        (req as unknown as { actor: unknown }).actor = actor;
        next();
      });
      server.use("/api", knowledgeRoutes({ moduleFor: (id) => createKnowledgeModule(db, id) }));
      server.use(errorHandler);
      return server;
    }

    const importUrl = () => `/api/myrmidon/companies/${companyId}/knowledge/import`;
    const page = (over: Partial<KnowledgeTreePage> & { slug: string }): KnowledgeTreePage => ({
      kind: "rule",
      title: over.slug,
      summary: null,
      folder: "rules/smm",
      tags: [],
      roles: ["smm"],
      status: "published",
      approvalRequired: true,
      approverKind: "operator", // the file lies: the code derives the grade
      content: "imported text",
      ...over,
    });
    const tree = (pages: KnowledgeTreePage[]) => serializeKnowledgeTree({ nestId: companyId, pages });
    const post = (actor: unknown, pages: KnowledgeTreePage[]) =>
      request(httpApp(actor)).post(importUrl()).set("Content-Type", "application/gzip").send(tree(pages));

    async function smmCompany() {
      companyId = await makeCompany();
      await db.insert(agentCastes).values({ companyId, key: "smm", nameEn: "SMM", color: "blue", sensitive: true });
    }

    async function publishedSmmRule(slug: string) {
      const store = makeStore();
      await store.create({ companyId, nestId: companyId, slug, title: slug, content: "owner text", kind: "rule", roles: ["smm"] }, AGENT);
      await store.submit(companyId, slug, AGENT);
      return store.approve(companyId, slug, OWNER, { publish: true });
    }

    it("an operator importing a smm rule with roles smm -> engineer is 403 and nothing changes; the owner may", async () => {
      await smmCompany();
      const rule = await publishedSmmRule("rules/smm/publications");
      const file = page({ slug: "rules/smm/publications", roles: ["engineer"], content: "owner text" });

      const refused = await post(grade("operator"), [file]);
      expect(refused.status).toBe(403);
      const [after] = await db.select().from(knowledgeItems).where(eq(knowledgeItems.id, rule.id));
      expect(after!.roles).toEqual(["smm"]);
      expect(after!.approverKind).toBe("owner");

      await post(grade("operator"), [{ ...file, roles: ["smm"], content: "operator rewrite" }]).then((res) => expect(res.status).toBe(403));
      expect((await post(grade("owner", true), [file])).status).toBe(200);
      const [moved] = await db.select().from(knowledgeItems).where(eq(knowledgeItems.id, rule.id));
      expect(moved!.roles).toEqual(["engineer"]);
      expect(moved!.approverKind).toBe("operator");
    });

    it("an operator importing a new smm rule gets a draft, not a published rule; the owner publishes", async () => {
      await smmCompany();
      const res = await post(grade("operator"), [page({ slug: "rules/smm/new" })]);
      expect(res.status).toBe(200);
      const [draft] = await db.select().from(knowledgeItems).where(and(eq(knowledgeItems.nestId, companyId), eq(knowledgeItems.slug, "rules/smm/new")));
      expect(draft!.status).toBe("draft");
      expect(draft!.deliveredRevisionId).toBeNull();
      expect(draft!.approverKind).toBe("owner");
      const revs = await db.select().from(knowledgeRevisions).where(eq(knowledgeRevisions.itemId, draft!.id));
      expect(revs.map((r) => r.status)).toEqual(["draft"]);

      expect((await post(grade("owner", true), [page({ slug: "rules/smm/owned" })])).status).toBe(200);
      const [published] = await db.select().from(knowledgeItems).where(and(eq(knowledgeItems.nestId, companyId), eq(knowledgeItems.slug, "rules/smm/owned")));
      expect(published!.status).toBe("published");
      expect(published!.deliveredRevisionId).not.toBeNull();
    });

    it("a viewer imports nothing that is a rule change; re-importing an unchanged export is idempotent for an operator", async () => {
      await smmCompany();
      await publishedSmmRule("rules/smm/publications");
      const exported = await makeStore().exportTree(companyId);
      expect((await request(httpApp(grade("operator"))).post(importUrl()).set("Content-Type", "application/gzip").send(exported)).status).toBe(200);
      expect(await makeStore().exportTree(companyId)).toEqual(exported);
      const changed = page({ slug: "rules/smm/publications", content: "viewer rewrite" });
      expect((await post(grade("viewer"), [changed])).status).toBe(403);
    });

    it("deleting a published rule of a sensitive caste needs the owner's grade; a draft is free", async () => {
      await smmCompany();
      const backend = createKnowledgeAutonomyRegulationsBackend(db);
      const actor = { type: "board" as const, id: "user-1" };
      const rule = await publishedSmmRule("rules/smm/publications");
      for (const kind of ["operator", "admin", null]) {
        const refused = await backend.delete(companyId, actor, rule.id, kind);
        expect(refused).toMatchObject({ ok: false, failure: { kind: "approver_kind_mismatch", required: "owner" } });
      }
      expect(await db.select().from(knowledgeItems).where(eq(knowledgeItems.id, rule.id))).toHaveLength(1);
      expect(await backend.delete(companyId, actor, rule.id, "owner")).toMatchObject({ ok: true });
      expect(await db.select().from(knowledgeItems).where(eq(knowledgeItems.id, rule.id))).toHaveLength(0);

      const store = makeStore();
      const draft = await store.create({ companyId, nestId: companyId, slug: "rules/smm/draft", title: "d", content: "c", kind: "rule", roles: ["smm"] }, AGENT);
      expect(await backend.delete(companyId, actor, draft.id, "operator")).toMatchObject({ ok: true });
    });
  });

  it("the second company sees none of the first company's knowledge", async () => {
    companyId = await makeCompany();
    const other = await makeCompany();
    const store = makeStore();
    await store.create({ companyId, nestId: companyId, slug: "secret", title: "S", content: "c" }, AGENT);
    expect(await store.get(other, "secret")).toBeNull();
    expect(await store.listItems(other)).toEqual([]);
    expect(await store.exportTree(other)).not.toBe(await store.exportTree(companyId));
  });

  // ----------------------------------------------------------------- OPE-9762 write protection
  describe("OPE-9762 write protection and alert logging over the database and HTTP router", () => {
    const grade = (membershipRole: string, isInstanceAdmin = false) => ({
      type: "board",
      source: "session",
      userId: `user-${membershipRole}`,
      isInstanceAdmin,
      companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole }],
    });

    function httpApp(actor: unknown) {
      const server = express();
      server.use(express.json());
      server.use((req, _res, next) => {
        (req as unknown as { actor: unknown }).actor = actor;
        next();
      });
      server.use("/api", knowledgeRoutes({ moduleFor: (id) => createKnowledgeModule(db, id) }));
      server.use(errorHandler);
      return server;
    }

    it("rejects create containing probe marker without force and logs alert; allows with force+reason", async () => {
      companyId = await makeCompany();
      const store = makeStore();

      await expect(
        store.create({
          companyId,
          nestId: companyId,
          slug: "probe-item",
          title: "Probe Item",
          content: "initial creation with __probe marker",
        }, AGENT),
      ).rejects.toThrow(/__probe/);

      const alertLogs = await db
        .select()
        .from(activityLog)
        .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "knowledge.write_protection_alert")));
      expect(alertLogs.length).toBeGreaterThanOrEqual(1);
      expect((alertLogs[0]!.details as Record<string, unknown>).slug).toBe("probe-item");
      expect((alertLogs[0]!.details as Record<string, unknown>).action).toBe("create");

      // With force and reason, creation succeeds
      const created = await store.create({
        companyId,
        nestId: companyId,
        slug: "probe-item",
        title: "Probe Item",
        content: "initial creation with __probe marker",
        force: true,
        reason: "Legitimate initial probe for testing",
      }, AGENT);
      expect(created.slug).toBe("probe-item");

      const overrideLogs = await db
        .select()
        .from(activityLog)
        .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "knowledge.write_protection_overridden")));
      expect(overrideLogs.length).toBeGreaterThanOrEqual(1);
    });

    it("allows initial creation of short stubs without force (documenting creation exception)", async () => {
      companyId = await makeCompany();
      const store = makeStore();
      const item = await store.create({
        companyId,
        nestId: companyId,
        slug: "short-stub",
        title: "Short Stub",
        content: "stub",
      }, AGENT);
      expect(item.slug).toBe("short-stub");
    });

    it("rejects draft overwrite with short probe or truncation without force and logs alert; allows with force+reason", async () => {
      companyId = await makeCompany();
      const store = makeStore();
      await store.create({
        companyId,
        nestId: companyId,
        slug: "doc-page",
        title: "Doc Page",
        content: "This is a detailed documentation page with more than twenty characters for testing.",
      }, AGENT);

      // 1. Single line < 20 chars rejected
      await expect(
        store.draft(companyId, "doc-page", { content: "ping" }, AGENT),
      ).rejects.toThrow(/shorter than 20 characters/);

      // 2. Severe truncation < 20% rejected
      await expect(
        store.draft(companyId, "doc-page", { content: "short" }, AGENT),
      ).rejects.toThrow();

      // Check alert logs in activityLog
      const alertLogs = await db
        .select()
        .from(activityLog)
        .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "knowledge.write_protection_alert")));
      expect(alertLogs.length).toBeGreaterThanOrEqual(2);
      expect((alertLogs[alertLogs.length - 1]!.details as Record<string, unknown>).action).toBe("draft");

      // 3. Allowed with force + reason
      const draft = await store.draft(
        companyId,
        "doc-page",
        { content: "ping", force: true, reason: "Manual probe update" },
        AGENT,
      );
      expect(draft.currentRevisionNumber).toBe(2);

      const overrideLogs = await db
        .select()
        .from(activityLog)
        .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "knowledge.write_protection_overridden")));
      expect(overrideLogs.length).toBeGreaterThanOrEqual(1);
    });

    it("HTTP router enforces live write protection and returns 422 with write_protection_rejected", async () => {
      companyId = await makeCompany();
      const store = makeStore();
      await store.create({
        companyId,
        nestId: companyId,
        slug: "router-page",
        title: "Router Page",
        content: "This is a detailed article written to test the HTTP router write-protection behavior.",
      }, AGENT);

      const app = httpApp(grade("owner", true));
      const draftUrl = `/api/myrmidon/companies/${companyId}/knowledge/items/router-page/draft`;

      // Without force: rejected with 422
      const res422 = await request(app)
        .post(draftUrl)
        .send({ content: "__probe" });
      expect(res422.status).toBe(422);
      expect(res422.body.code).toBe("write_protection_rejected");
      expect(res422.body.error).toMatch(/probe marker/);

      // With force and reason: accepted with 201
      const res201 = await request(app)
        .post(draftUrl)
        .send({ content: "__probe", force: true, reason: "Authorized live probe test" });
      expect(res201.status).toBe(201);
      expect(res201.body.revision).toBeDefined();
    });
  });
});

// ----------------------------------------------------------------- hygiene
// Acceptance criterion: "в коде модуля 0 триггеров и 0 `sql\`` с диалектными
// операторами" — the module must reach the database only through Drizzle
// builders / the SearchIndex port. This gate scans the module's sources.

describe("myrmidon(1.6.6 KNOWLEDGE-2.0 K-1) module hygiene", () => {
  const moduleDir = join(import.meta.dirname);
  const sources = readdirSync(moduleDir)
    .filter((name) => name.endsWith(".ts") && !name.includes(".test."))
    .sort();

  it("the module dir holds exactly the known module files (K-1 core + K-2 surfaces + K-8 seed)", () => {
    // K-1: domain/index/service/store. K-8 (OPE-5961, #1207) added the seed of
    // decisions and product knowledge: seed.ts (runner), seed-data.ts and
    // seed-product.ts (data). L-7 (#1349) added lint.ts. K-2 part B added the
    // REST (routes.ts) and MCP (mcp.ts) surfaces. New files must be listed
    // here deliberately.
    expect(sources).toEqual([
      "domain.ts",
      "git-export-git.ts",
      "git-export-job.ts",
      "git-export.ts",
      "index.ts",
      "lint.ts",
      "mcp.ts",
      "routes.ts",
      "rules.ts",
      "seed-data.ts",
      "seed-product.ts",
      "seed.ts",
      "service.ts",
      "store.ts",
    ]);
  });

  for (const name of sources) {
    it(`${name} contains no raw dialect SQL and no triggers`, () => {
      const text = readFileSync(join(moduleDir, name), "utf8");
      expect(text).not.toMatch(/sql`/);
      expect(text).not.toMatch(/\bCREATE\b.*\bTRIGGER\b/i);
      expect(text).not.toMatch(/\btrigger\b/i);
      expect(text).not.toMatch(/RETURNING\s+|ON CONFLICT|ILIKE|::\s*regconfig/i);
    });
  }

  it("domain.ts imports nothing from the database layer", () => {
    const text = readFileSync(join(moduleDir, "domain.ts"), "utf8");
    expect(text).not.toMatch(/@myrmidon\/db|drizzle/);
  });
});
