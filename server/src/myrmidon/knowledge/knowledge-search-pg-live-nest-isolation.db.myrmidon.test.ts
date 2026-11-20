import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, createPgKnowledgeSearchIndex } from "@myrmidon/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createKnowledgeModule, type KnowledgeModule } from "./service.js";
import type { KnowledgeActor } from "./store.js";

describe("knowledge search isolates nests on PostgreSQL", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let modA: KnowledgeModule;
  let modB: KnowledgeModule;
  let empty: KnowledgeModule;
  let exactA: string;
  let exactB: string;
  let fuzzyA: string;
  let fuzzyB: string;

  beforeAll(async () => {
    const support = await getEmbeddedPostgresTestSupport();
    if (!support.supported) throw new Error(`Embedded PostgreSQL unsupported: ${support.reason}`);
    tempDb = await startEmbeddedPostgresTestDatabase("knowledge-nest-isolation-");
    const db = createDb(tempDb.connectionString);
    const index = createPgKnowledgeSearchIndex(db);

    async function makeNest(): Promise<{ mod: KnowledgeModule; actor: KnowledgeActor }> {
      const [company] = await db.insert(companies).values({
        name: `company ${randomUUID()}`,
        issuePrefix: `KN${randomUUID().slice(0, 6).toUpperCase()}`,
      }).returning();
      if (!company) throw new Error("Company insert returned no row");
      const [agent] = await db.insert(agents).values({
        companyId: company.id, name: `writer-${randomUUID()}`, role: "writer",
      }).returning();
      if (!agent) throw new Error("Agent insert returned no row");
      return {
        mod: createKnowledgeModule(db, company.id, { searchIndex: index }),
        actor: { actorType: "agent", actorId: agent.id, kind: null },
      };
    }

    const a = await makeNest();
    const b = await makeNest();
    const c = await makeNest();
    modA = a.mod;
    modB = b.mod;
    empty = c.mod;
    async function deliver(mod: KnowledgeModule, actor: KnowledgeActor, slug: string, content: string) {
      const item = await mod.create({ slug, title: slug, content }, actor);
      await mod.publish(slug, actor);
      return item.id;
    }
    exactA = await deliver(modA, a.actor, "shared-exact", "quokka unique exact search marker");
    exactB = await deliver(modB, b.actor, "shared-exact", "quokka unique exact search marker");
    fuzzyA = await deliver(modA, a.actor, "shared-fuzzy", "solar arrays and regolith bricks");
    fuzzyB = await deliver(modB, b.actor, "shared-fuzzy", "solar arrays and regolith bricks");
  }, 90_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns exact matches only from each nest", async () => {
    expect((await modA.search("quokka")).map(({ itemId, slug }) => ({ itemId, slug }))).toEqual([{ itemId: exactA, slug: "shared-exact" }]);
    expect((await modB.search("quokka")).map(({ itemId, slug }) => ({ itemId, slug }))).toEqual([{ itemId: exactB, slug: "shared-exact" }]);
    expect(exactA).not.toBe(exactB);
  });

  it("returns nonempty fuzzy matches only from each nest", async () => {
    expect((await modA.search("regolithe")).map(({ itemId, slug }) => ({ itemId, slug }))).toEqual([{ itemId: fuzzyA, slug: "shared-fuzzy" }]);
    expect((await modB.search("regolithe")).map(({ itemId, slug }) => ({ itemId, slug }))).toEqual([{ itemId: fuzzyB, slug: "shared-fuzzy" }]);
    expect(fuzzyA).not.toBe(fuzzyB);
  });

  it("returns no matches for an empty nest", async () => {
    expect(await empty.search("quokka")).toEqual([]);
    expect(await empty.search("regolithe")).toEqual([]);
  });

  it("retains A scope after searching B", async () => {
    expect((await modB.search("quokka")).map(({ itemId, slug }) => ({ itemId, slug }))).toEqual([{ itemId: exactB, slug: "shared-exact" }]);
    expect((await modA.search("quokka")).map(({ itemId, slug }) => ({ itemId, slug }))).toEqual([{ itemId: exactA, slug: "shared-exact" }]);
    expect((await modB.search("regolithe")).map(({ itemId, slug }) => ({ itemId, slug }))).toEqual([{ itemId: fuzzyB, slug: "shared-fuzzy" }]);
    expect((await modA.search("regolithe")).map(({ itemId, slug }) => ({ itemId, slug }))).toEqual([{ itemId: fuzzyA, slug: "shared-fuzzy" }]);
  });
});
