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
import { and, eq, isNull } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  createPgKnowledgeSearchIndex,
  knowledgeItems,
  knowledgeLinks,
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
    await db.delete(knowledgeItems);
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
      { companyId, nestId: companyId, slug: "budget-rule", title: "Budget rule", content: "cap 100", kind: "rule", approverKind: "owner" },
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
    await store.create({ companyId, nestId: companyId, slug: "b/rule", title: "Rule B", content: "cap", kind: "rule", approverKind: "owner" }, AGENT);
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

  it("the module dir holds exactly the K-1 + K-2 files", () => {
    expect(sources).toEqual(["domain.ts", "index.ts", "mcp.ts", "routes.ts", "service.ts", "store.ts"]);
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
