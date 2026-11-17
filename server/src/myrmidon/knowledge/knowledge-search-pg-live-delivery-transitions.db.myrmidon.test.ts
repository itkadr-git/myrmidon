import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agents, companies, createDb, createPgKnowledgeSearchIndex } from "@myrmidon/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createKnowledgeModule } from "./service.js";
import type { KnowledgeActor } from "./store.js";

const v1 = "quokka";
const v2 = "zephyr";
const controlToken = "xylophone";

describe("PostgreSQL delivered knowledge search transitions", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let mod: ReturnType<typeof createKnowledgeModule>;
  let actor: KnowledgeActor;
  let page: { id: string; slug: string };
  let control: { id: string; slug: string };

  beforeAll(async () => {
    const support = await getEmbeddedPostgresTestSupport();
    if (!support.supported) throw new Error(`Embedded PostgreSQL unsupported: ${support.reason}`);
    tempDb = await startEmbeddedPostgresTestDatabase("knowledge-delivery-");
    db = createDb(tempDb.connectionString);
  }, 90_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    const [company] = await db.insert(companies).values({
      name: `company ${randomUUID()}`,
      issuePrefix: `KN${randomUUID().slice(0, 6).toUpperCase()}`,
    }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company!.id, name: "writer", role: "writer",
    }).returning();
    actor = { actorType: "agent", actorId: agent!.id, kind: null };
    mod = createKnowledgeModule(db, company!.id, { searchIndex: createPgKnowledgeSearchIndex(db) });
    page = await mod.create({ slug: "page", title: "Page", content: v1 }, actor);
    control = await mod.create({ slug: "control", title: "Control", content: controlToken }, actor);
    await mod.publish("control", actor);
  });

  async function expectHits(query: string, expected: Array<{ id: string; slug: string }>) {
    const hits = await mod.search(query);
    expect(hits.map(({ itemId, slug }) => ({ itemId, slug })).sort((a, b) => a.slug.localeCompare(b.slug)))
      .toEqual(expected.map(({ id, slug }) => ({ itemId: id, slug })).sort((a, b) => a.slug.localeCompare(b.slug)));
  }

  it("does not find a draft-only page", async () => {
    await expectHits(v1, []);
    await expectHits(controlToken, [control]);
  });

  it("finds the first revision after publication", async () => {
    await mod.publish("page", actor);
    await expectHits(v1, [page]);
    await expectHits(controlToken, [control]);
  });

  it("keeps the delivered revision searchable while a new draft exists", async () => {
    await mod.publish("page", actor);
    await mod.draft("page", { content: `${v2} describes a complete updated document.` }, actor);
    await expectHits(v1, [page]);
    await expectHits(v2, []);
  });

  it("replaces the indexed revision after publication", async () => {
    await mod.publish("page", actor);
    await mod.draft("page", { content: `${v2} describes a complete updated document.` }, actor);
    await mod.publish("page", actor);
    await expectHits(v1, []);
    await expectHits(v2, [page]);
  });

  it("restores the first revision after rollback", async () => {
    const published = await mod.publish("page", actor);
    if (!published.deliveredRevisionId) throw new Error("First publication has no delivered revision");
    await mod.draft("page", { content: `${v2} describes a complete updated document.` }, actor);
    await mod.publish("page", actor);
    await mod.rollback("page", actor, { targetRevisionId: published.deliveredRevisionId });
    await expectHits(v1, [page]);
    await expectHits(v2, []);
  });

  it("removes archived content without removing an independent page", async () => {
    await mod.publish("page", actor);
    await mod.archive("page", actor);
    await expectHits(v1, []);
    await expectHits(controlToken, [control]);
  });
});
