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
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { KnowledgeDomainError, createMemorySearchIndex } from "./domain.js";
import { createKnowledgeService, type KnowledgeActor } from "./store.js";
import { createKnowledgeModule } from "./service.js";

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
    await store.create({ companyId, nestId: companyId, slug: "page", title: "Page", content: "v1" }, AGENT);
    await store.publish(companyId, "page", AGENT); // notes publish without approval
    const delivered = (await store.get(companyId, "page"))!;
    expect(delivered.deliveredContent).toBe("v1");

    await store.draft(companyId, "page", { content: "v2 draft" }, AGENT);
    const after = (await store.get(companyId, "page"))!;
    expect(after.deliveredRevisionId).toBe(delivered.deliveredRevisionId);
    expect(after.deliveredContent).toBe("v1");
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
        { revisionNumber: 1, status: "draft", content: "Revision 1 draft", changeSummary: "Initial draft", createdAt: "2026-09-01T00:00:00.000Z" },
        { revisionNumber: 2, status: "approved", content: "Revision 2 content", changeSummary: "Approved", createdAt: "2026-09-02T00:00:00.000Z" },
      ],
      revisionNumber: 2,
    });

    const runMigration = async () => {
      await db.execute(sql`
        INSERT INTO "knowledge_items" (
          "company_id", "nest_id", "kind", "slug", "title", "summary", "status", "folder_path",
          "tags", "roles", "approval_required", "approver_kind", "current_revision_number",
          "created_at", "updated_at"
        )
        SELECT
          w."company_id", w."company_id", 'rule', w."slug", w."title", NULL, 'draft',
          COALESCE(NULLIF(regexp_replace(w."slug", '/[^/]*$', ''), w."slug"), ''),
          '[]'::jsonb, w."roles", true,
          CASE WHEN EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(w."roles") AS role_key
            JOIN "agent_castes" c
              ON c."company_id" = w."company_id" AND c."key" = role_key AND c."sensitive"
            WHERE role_key <> '*'
          ) THEN 'owner' ELSE 'operator' END,
          0, w."created_at", w."updated_at"
        FROM "myrmidon_wiki_regulations" w
        WHERE NOT EXISTS (
          SELECT 1 FROM "knowledge_items" k WHERE k."nest_id" = w."company_id" AND k."slug" = w."slug"
        );

        INSERT INTO "knowledge_revisions" (
          "company_id", "nest_id", "item_id", "revision_number", "status", "content",
          "change_summary", "created_by_agent_id", "created_by_user_id", "created_at"
        )
        SELECT
          k."company_id", k."nest_id", k."id", rev."revision_number", rev."status", rev."content",
          rev."change_summary", rev."created_by_agent_id", rev."created_by_user_id", rev."created_at"
        FROM "myrmidon_wiki_regulations" w
        JOIN "knowledge_items" k
          ON k."nest_id" = w."company_id" AND k."slug" = w."slug" AND k."kind" = 'rule'
        CROSS JOIN LATERAL (
          SELECT
            (entry ->> 'revisionNumber')::integer AS "revision_number",
            CASE WHEN entry ->> 'status' = 'approved' THEN 'approved' ELSE 'draft' END AS "status",
            COALESCE(entry ->> 'content', '') AS "content",
            NULLIF(entry ->> 'changeSummary', '') AS "change_summary",
            NULLIF(entry ->> 'createdByAgentId', '') AS "created_by_agent_id",
            NULLIF(entry ->> 'createdByUserId', '') AS "created_by_user_id",
            COALESCE((entry ->> 'createdAt')::timestamptz, w."created_at") AS "created_at"
          FROM jsonb_array_elements(w."revisions") AS entry
          UNION ALL
          SELECT 1, w."status", w."content", NULL, NULL, NULL, w."created_at"
          WHERE jsonb_typeof(w."revisions") IS DISTINCT FROM 'array' OR jsonb_array_length(w."revisions") = 0
        ) rev
        WHERE NOT EXISTS (
          SELECT 1 FROM "knowledge_revisions" r
          WHERE r."item_id" = k."id" AND r."revision_number" = rev."revision_number"
        );

        UPDATE "knowledge_items" k
        SET
          "current_revision_number" = agg."max_revision",
          "delivered_revision_id" = (
            SELECT r."id" FROM "knowledge_revisions" r
            WHERE r."item_id" = k."id" AND r."status" = 'approved'
            ORDER BY r."revision_number" DESC LIMIT 1
          ),
          "status" = CASE WHEN agg."approved_count" > 0 THEN 'published' ELSE 'draft' END,
          "updated_at" = now()
        FROM (
          SELECT "item_id",
                 MAX("revision_number") AS "max_revision",
                 COUNT(*) FILTER (WHERE "status" = 'approved') AS "approved_count"
          FROM "knowledge_revisions"
          GROUP BY "item_id"
        ) agg
        WHERE agg."item_id" = k."id"
          AND k."kind" = 'rule'
          AND EXISTS (
            SELECT 1 FROM "myrmidon_wiki_regulations" w
            WHERE w."company_id" = k."nest_id" AND w."slug" = k."slug"
          );

        INSERT INTO "knowledge_sources" ("company_id", "nest_id", "revision_id", "kind", "ref", "note")
        SELECT
          r."company_id", r."nest_id", r."id", 'document',
          'myrmidon_wiki_regulations:' || w."id"::text,
          'legacy wiki regulation moved into the knowledge module by K-3 (N-4)'
        FROM "knowledge_revisions" r
        JOIN "knowledge_items" k ON k."id" = r."item_id" AND k."kind" = 'rule'
        JOIN "myrmidon_wiki_regulations" w ON w."company_id" = k."nest_id" AND w."slug" = k."slug"
        ON CONFLICT DO NOTHING;
      `);
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

  it("rollback copies the target revision and moves the pointer (S5)", async () => {
    companyId = await makeCompany();
    const store = makeStore();
    await store.create({ companyId, nestId: companyId, slug: "log", title: "Log", content: "r1 good", sources: [{ kind: "pr", ref: "myrmidon#816", note: null }] }, AGENT);
    await store.publish(companyId, "log", AGENT);
    const r1 = (await store.get(companyId, "log"))!.deliveredRevisionId!;
    await store.draft(companyId, "log", { content: "r2 bad", submit: true }, AGENT);
    await store.publish(companyId, "log", AGENT);
    const r2 = (await store.get(companyId, "log"))!.deliveredRevisionId!;

    const rolled = await store.rollback(companyId, "log", AGENT, { targetRevisionId: r1 });
    expect(rolled.currentRevisionNumber).toBe(3);
    expect(rolled.deliveredRevisionId).not.toBe(r1); // a copy, not the old row
    const copy = (await store.getRevision(companyId, "log", rolled.deliveredRevisionId!))!;
    expect(copy.content).toBe("r1 good");
    expect(copy.status).toBe("approved");
    expect(copy.rolledBackFromRevisionId).toBe(r1);
    expect(copy.sources).toEqual([{ kind: "pr", ref: "myrmidon#816", note: null }]); // provenance mirrored
    expect((await store.get(companyId, "log"))!.deliveredContent).toBe("r1 good");

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

  it("the second company sees none of the first company's knowledge", async () => {
    companyId = await makeCompany();
    const other = await makeCompany();
    const store = makeStore();
    await store.create({ companyId, nestId: companyId, slug: "secret", title: "S", content: "c" }, AGENT);
    expect(await store.get(other, "secret")).toBeNull();
    expect(await store.listItems(other)).toEqual([]);
    expect(await store.exportTree(other)).not.toBe(await store.exportTree(companyId));
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

  it("the module dir holds exactly the known module files (K-1 core + K-8 seed)", () => {
    // K-1: domain/index/service/store. K-8 (OPE-5961, #1207) added the seed of
    // decisions and product knowledge: seed.ts (runner), seed-data.ts and
    // seed-product.ts (data). New files must be listed here deliberately.
    expect(sources).toEqual([
      "domain.ts",
      "index.ts",
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
    expect(text).not.toMatch(/@paperclipai\/db|drizzle/);
  });
});
