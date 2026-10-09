// server/src/myrmidon/knowledge/knowledge-seed.db.myrmidon.test.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-8): the seed corpus against a real embedded
// database — the acceptance criteria (≥40 decision items with decided_by,
// date, quote and a registry source reference; 4 product pages; supersede
// chains link the superseded decision to its replacement; the seeder is
// idempotent on re-run; every decision is delivered/published, not a draft).

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, and } from "drizzle-orm";
import {
  activityLog,
  companies,
  createDb,
  knowledgeItems,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { seedKnowledgeBase, SEED_DECISIONS, SEED_PRODUCT_PAGES } from "./seed.js";
import { createKnowledgeService } from "./store.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

describeEmbeddedPostgres("myrmidon(1.6.6 KNOWLEDGE-2.0 K-8) knowledge seed", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-knowledge-seed-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(knowledgeItems);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function makeCompany(): Promise<string> {
    const row = await db
      .insert(companies)
      .values({ name: `company ${randomUUID()}`, issuePrefix: `KS${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
    return row.id;
  }

  it("seeds ≥40 decisions and 4 product pages, all published", async () => {
    const companyId = await makeCompany();
    const result = await seedKnowledgeBase(db, companyId, companyId);
    expect(result.created).toBe(SEED_DECISIONS.length + SEED_PRODUCT_PAGES.length);
    expect(result.skipped).toBe(0);
    expect(result.errors).toEqual([]);

    const store = createKnowledgeService(db);

    // Acceptance: ≥40 decisions, each with decided_by/date/quote/source.
    const decisions = await db
      .select()
      .from(knowledgeItems)
      .where(and(eq(knowledgeItems.nestId, companyId), eq(knowledgeItems.folderPath, "decisions")));
    expect(decisions.length).toBeGreaterThanOrEqual(40);
    for (const item of decisions) {
      // Superseded decisions keep their history but lose the delivery pointer.
      if (item.status === "superseded") continue;
      expect(item.status).toBe("published");
      expect(item.deliveredRevisionId).not.toBeNull();
      const full = await store.get(companyId, item.slug);
      expect(full!.deliveredContent).toContain("decided_by: Alex");
      expect(full!.deliveredContent).toMatch(/date: \d{4}-\d{2}-\d{2}/);
      expect(full!.deliveredContent).toMatch(/^> /m);
    }

    // Acceptance: 4 product pages.
    const product = await db
      .select()
      .from(knowledgeItems)
      .where(and(eq(knowledgeItems.nestId, companyId), eq(knowledgeItems.folderPath, "product")));
    expect(product).toHaveLength(4);
    const slugs = product.map((p) => p.slug).sort();
    expect(slugs).toEqual([
      "product/colony-model",
      "product/open-core",
      "product/principles",
      "product/vision",
    ]);

    // Vision is the owner's text, verbatim.
    const vision = await store.get(companyId, "product/vision");
    expect(vision!.deliveredContent).toContain("Автономный кибер-муравейник");
    expect(vision!.deliveredContent).toContain("стигмергии");
  });

  it("applies supersede chains (FORAGING variant-2 → включить сейчас)", async () => {
    const companyId = await makeCompany();
    await seedKnowledgeBase(db, companyId, companyId);
    const store = createKnowledgeService(db);

    const superseded = await store.get(companyId, "decisions/2026-10-03-foraging-variant-2");
    expect(superseded!.status).toBe("superseded");
    const replacement = await store.get(companyId, "decisions/2026-10-03-foraging-enable-now");
    expect(replacement!.status).toBe("published");
    expect(superseded!.supersededByItemId).toBe(replacement!.id);
  });

  it("is idempotent: a second run skips existing slugs", async () => {
    const companyId = await makeCompany();
    const first = await seedKnowledgeBase(db, companyId, companyId);
    const second = await seedKnowledgeBase(db, companyId, companyId);
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(first.created);
    const count = await db
      .select()
      .from(knowledgeItems)
      .where(eq(knowledgeItems.nestId, companyId));
    expect(count.length).toBe(first.created);
  });
});
