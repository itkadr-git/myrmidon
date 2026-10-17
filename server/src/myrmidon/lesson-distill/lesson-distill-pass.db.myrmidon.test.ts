// server/src/myrmidon/lesson-distill/lesson-distill-pass.db.myrmidon.test.ts
//
// myrmidon(1.7 KNOWLEDGE-2.0 L-4): the pass over a real embedded database —
// agents' banks are stubbed with a fake memory client. Pins:
//   * two agents retaining the same lesson in the 24 h window → one pending
//     `regulation_candidate` suggestion (marked, sourceKind "run"), not a
//     page, and one journal event `knowledge.lesson_distill.pass`;
//   * a single mention produces nothing;
//   * a repeat outside the window does not count;
//   * a second pass refreshes the pending suggestion instead of duplicating.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, knowledgeEvents, knowledgeSuggestions } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { createMemorySearchIndex } from "../knowledge/domain.js";
import type { MemoryHindsightClient, HindsightMemoryItem } from "../agent-memory/hindsight-client.js";
import { runLessonDistillPass } from "./service.js";
import { LESSON_SUGGESTION_MARKER } from "./domain.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

const NOW = new Date("2026-10-10T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

describeEmbeddedPostgres("myrmidon(1.7 L-4) the lesson distill pass over the database", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-lesson-distill-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(knowledgeSuggestions);
    await db.delete(knowledgeEvents);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function lessonItem(id: string, text: string, at: Date): HindsightMemoryItem {
    return {
      id,
      text,
      factType: "lesson",
      state: "accepted",
      occurredAt: at.toISOString(),
      createdAt: at.toISOString(),
      documentId: null,
      tags: [],
    };
  }

  /** A company with two agents whose banks answer from the given items. The
   * items are split per bank: bank-0 gets the even-indexed items, bank-1 the
   * odd ones — a real pair of agents retains each lesson once, not twice. */
  async function makeCompany(items: HindsightMemoryItem[]): Promise<{ companyId: string; passDeps: Parameters<typeof runLessonDistillPass>[0] }> {
    const company = await db
      .insert(companies)
      .values({ name: `company ${randomUUID()}`, issuePrefix: `LD${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
    for (let i = 0; i < 2; i += 1) {
      await db.insert(agents).values({
        companyId: company.id,
        name: `agent-${i}-${randomUUID().slice(0, 6)}`,
        role: "engineer",
        adapterConfig: { hindsight: { bankId: `bank-${i}` } },
      });
    }
    const perBank = (bankIndex: number): HindsightMemoryItem[] =>
      items.filter((_, index) => index % 2 === bankIndex);
    return {
      companyId: company.id,
      passDeps: {
        db,
        client: (bankId: string) => fakeClient(perBank),
      },
    };
  }

  function fakeClient(itemsFor: (bankIndex: number) => HindsightMemoryItem[]): MemoryHindsightClient {
    return {
      async list(bankId: string) {
        const bankIndex = Number(bankId.slice("bank-".length));
        if (!Number.isInteger(bankIndex)) return { items: [], total: 0, limit: 100, offset: 0 };
        const items = itemsFor(bankIndex);
        return { items, total: items.length, limit: 100, offset: 0 };
      },
      async invalidate() {},
      async clear() {
        return { deletedCount: null };
      },
    };
  }

  it("two agents' identical lessons in the window become one marked pending suggestion + journal line", async () => {
    const lesson = "Always rebase before pushing";
    const { companyId, passDeps } = await makeCompany([
      lessonItem("mem-a", lesson, new Date(NOW.getTime() - 2 * HOUR)),
      lessonItem("mem-b", `${lesson}!`, new Date(NOW.getTime() - 1 * HOUR)),
    ]);

    const result = await runLessonDistillPass({ ...passDeps, now: () => NOW }, companyId);

    expect(result.lessonsSeen).toBe(2);
    expect(result.candidatesFound).toBe(1);
    expect(result.suggestionsCreated).toBe(1);

    const rows = await db.select().from(knowledgeSuggestions).where(eq(knowledgeSuggestions.companyId, companyId));
    expect(rows).toHaveLength(1);
    const suggestion = rows[0]!;
    expect(suggestion.status).toBe("pending");
    expect(suggestion.body).toBe(`[${LESSON_SUGGESTION_MARKER}] ${lesson}!`);
    expect(suggestion.sourceKind).toBe("run");
    expect(suggestion.sourceRef).toBe("hindsight:mem-b");
    expect(suggestion.rationale).toContain("repeats: 2");
    expect(suggestion.createdByAgentId).toBeNull();

    const events = await db.select().from(knowledgeEvents).where(eq(knowledgeEvents.companyId, companyId));
    expect(events.some((event) => event.event === "knowledge.lesson_distill.pass")).toBe(true);
    expect(events.some((event) => event.event === "knowledge.suggested")).toBe(true);
  });

  it("a single mention yields nothing", async () => {
    const { companyId, passDeps } = await makeCompany([
      lessonItem("mem-a", "Only mentioned once", new Date(NOW.getTime() - 3 * HOUR)),
    ]);
    const result = await runLessonDistillPass({ ...passDeps, now: () => NOW }, companyId);
    expect(result.candidatesFound).toBe(0);
    const rows = await db.select().from(knowledgeSuggestions).where(eq(knowledgeSuggestions.companyId, companyId));
    expect(rows).toHaveLength(0);
  });

  it("a repeat outside the 24h window does not count", async () => {
    const lesson = "Never force-push main";
    const { companyId, passDeps } = await makeCompany([
      lessonItem("mem-a", lesson, new Date(NOW.getTime() - 30 * HOUR)),
      lessonItem("mem-b", lesson, new Date(NOW.getTime() - 1 * HOUR)),
    ]);
    const result = await runLessonDistillPass({ ...passDeps, now: () => NOW }, companyId);
    expect(result.lessonsSeen).toBe(1);
    expect(result.candidatesFound).toBe(0);
  });

  it("a second pass refreshes the pending suggestion instead of duplicating", async () => {
    const lesson = "Check the staging flag before the release";
    const { companyId, passDeps } = await makeCompany([
      lessonItem("mem-a", lesson, new Date(NOW.getTime() - 2 * HOUR)),
      lessonItem("mem-b", lesson, new Date(NOW.getTime() - 1 * HOUR)),
    ]);
    const deps = { ...passDeps, now: () => NOW };
    await runLessonDistillPass(deps, companyId);
    const second = await runLessonDistillPass(deps, companyId);
    expect(second.suggestionsCreated).toBe(0);
    expect(second.suggestionsRefreshed).toBe(1);
    const rows = await db.select().from(knowledgeSuggestions).where(eq(knowledgeSuggestions.companyId, companyId));
    expect(rows).toHaveLength(1);
  });
});
