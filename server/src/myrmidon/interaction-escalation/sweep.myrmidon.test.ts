import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  interactionEscalations,
  issues,
  issueThreadInteractions,
} from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import {
  createInteractionEscalationSweep,
  DEFAULT_INTERACTION_ESCALATION_INTERVAL_SEC,
  readInteractionEscalationSettings,
} from "./sweep.js";

describe("interaction escalation sweep settings", () => {
  it("defaults to 60s interval and enabled true", async () => {
    const settings = await readInteractionEscalationSettings({});
    expect(settings.enabled).toBe(true);
    expect(settings.intervalSec).toBe(DEFAULT_INTERACTION_ESCALATION_INTERVAL_SEC);
    expect(settings.intervalSec).toBe(60);
  });

  it("reads settings from instanceSettings general", async () => {
    const settings = await readInteractionEscalationSettings({
      instanceSettings: {
        getGeneral: async () => ({
          interactionEscalation: {
            enabled: false,
            intervalSec: 30,
          },
        }),
      },
    });
    expect(settings.enabled).toBe(false);
    expect(settings.intervalSec).toBe(30);
  });

  it("reads settings from instanceSettings experimental", async () => {
    const settings = await readInteractionEscalationSettings({
      instanceSettings: {
        getExperimental: async () => ({
          enableInteractionEscalation: false,
        }),
      },
    });
    expect(settings.enabled).toBe(false);
  });

  it("explicit override wins over instance settings", async () => {
    const settings = await readInteractionEscalationSettings({
      enabled: true,
      intervalSec: 45,
      instanceSettings: {
        getGeneral: async () => ({
          interactionEscalation: { enabled: false, intervalSec: 90 },
        }),
      },
    });
    expect(settings.enabled).toBe(true);
    expect(settings.intervalSec).toBe(45);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres interaction escalation sweep tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("interaction escalation sweep integration", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let issueId: string;
  let leadId: string;
  let architectId: string;
  let secondaryId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("interaction-escalation-sweep-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await db.delete(agentWakeupRequests);
    await db.delete(interactionEscalations);
    await db.delete(issueThreadInteractions);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  async function seedSetup() {
    companyId = randomUUID();
    issueId = randomUUID();
    leadId = randomUUID();
    architectId = randomUUID();
    secondaryId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Sweep Escalation Co",
      issuePrefix: `SWP${randomUUID().slice(0, 3).toUpperCase()}`,
    });

    await db.insert(agents).values(
      [
        { id: leadId, name: "Lead" },
        { id: architectId, name: "Architect" },
        { id: secondaryId, name: "Secondary" },
      ].map((a) => ({
        id: a.id,
        companyId,
        name: a.name,
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })),
    );

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Task with escalations",
      identifier: "SWP-1",
    });
  }

  function makeCard(overrides: Partial<typeof issueThreadInteractions.$inferInsert> = {}) {
    return {
      id: randomUUID(),
      companyId,
      issueId,
      kind: "ask_user_questions",
      status: "pending",
      title: "Overdue Card",
      summary: "Card summary",
      routeType: "decision",
      addresseeAgentId: leadId,
      escalationLevel: 0,
      timeoutAt: new Date(Date.now() - 60_000), // overdue 1 minute ago
      escalationChain: [
        { recipient: { agentId: leadId }, afterMinutes: 0 },
        { recipient: { agentId: architectId }, afterMinutes: 5 },
        { recipient: { agentId: secondaryId }, afterMinutes: 10 },
        { recipient: { serviceQueue: "operators" }, afterMinutes: 15 },
      ],
      payload: {
        version: 1,
        questions: [
          {
            id: "q1",
            header: "Test",
            prompt: "Test prompt",
            selectionMode: "single",
            options: [{ id: "opt", label: "Option" }],
          },
        ],
      },
      ...overrides,
    };
  }

  it("флаг off - тик ничего не делает", async () => {
    await seedSetup();
    const cardData = makeCard();
    await db.insert(issueThreadInteractions).values(cardData as any);

    const sweep = createInteractionEscalationSweep({
      db,
      enabled: false,
    });

    const result = await sweep({ force: true });
    expect(result.skipped).toBe(true);
    expect(result.due).toBe(0);
    expect(result.escalated).toBe(0);

    // Card remains untouched at level 0
    const [card] = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, cardData.id));
    expect(card.escalationLevel).toBe(0);
    expect(card.addresseeAgentId).toBe(leadId);

    const escalations = await db.select().from(interactionEscalations);
    expect(escalations).toHaveLength(0);
  });

  it("за тик обрабатываются все просроченные", async () => {
    await seedSetup();
    const card1 = makeCard({ id: randomUUID() });
    const card2 = makeCard({ id: randomUUID() });
    const card3 = makeCard({ id: randomUUID() });
    // Not due yet:
    const notDueCard = makeCard({
      id: randomUUID(),
      timeoutAt: new Date(Date.now() + 3600_000),
    });

    await db.insert(issueThreadInteractions).values([card1, card2, card3, notDueCard] as any);

    const sweep = createInteractionEscalationSweep({
      db,
      enabled: true,
      batchSize: 2, // smaller batch to test multiple batch loop in a single tick
    });

    const result = await sweep({ force: true });
    expect(result.due).toBe(3);
    expect(result.escalated).toBe(3);
    expect(result.failed).toBe(0);

    // All 3 overdue cards advanced to level 1 and architect
    for (const c of [card1, card2, card3]) {
      const [updated] = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, c.id));
      expect(updated.escalationLevel).toBe(1);
      expect(updated.addresseeAgentId).toBe(architectId);
    }

    // Not due card remained at level 0
    const [notDue] = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, notDueCard.id));
    expect(notDue.escalationLevel).toBe(0);
    expect(notDue.addresseeAgentId).toBe(leadId);

    // Wakes were queued for the new recipient
    const wakes = await db.select().from(agentWakeupRequests);
    expect(wakes).toHaveLength(3);
    expect(wakes.every((w) => w.agentId === architectId)).toBe(true);
  });

  it("два конкурентных тика не дают двух шагов на одну карточку", async () => {
    await seedSetup();
    const cardData = makeCard();
    await db.insert(issueThreadInteractions).values(cardData as any);

    const sweep1 = createInteractionEscalationSweep({
      db,
      enabled: true,
      intervalSec: 0,
    });
    const sweep2 = createInteractionEscalationSweep({
      db,
      enabled: true,
      intervalSec: 0,
    });

    // Run both sweeps concurrently against the same database
    const [res1, res2] = await Promise.all([
      sweep1({ force: true }),
      sweep2({ force: true }),
    ]);

    // Exactly 1 total escalation across both runs
    expect(res1.escalated + res2.escalated).toBe(1);

    // Card advanced exactly ONE level (level 1, architect), NEVER two levels (level 2)
    const [card] = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, cardData.id));
    expect(card.escalationLevel).toBe(1);
    expect(card.addresseeAgentId).toBe(architectId);

    // Only 1 wake request and 1 journal entry created
    const escalations = await db.select().from(interactionEscalations);
    expect(escalations).toHaveLength(1);
    expect(escalations[0].level).toBe(1);

    const wakes = await db.select().from(agentWakeupRequests);
    expect(wakes).toHaveLength(1);
    expect(wakes[0].agentId).toBe(architectId);
  });

  it("настройка интервала ограничивает частоту запусков", async () => {
    await seedSetup();
    const cardData = makeCard();
    await db.insert(issueThreadInteractions).values(cardData as any);

    let currentTime = Date.now();
    const sweep = createInteractionEscalationSweep({
      db,
      enabled: true,
      intervalSec: 60,
      now: () => new Date(currentTime),
    });

    // Pass 1: runs
    const res1 = await sweep();
    expect(res1.skipped).toBe(false);
    expect(res1.escalated).toBe(1);

    // Pass 2: 10 seconds later, throttled by interval (60s)
    currentTime += 10_000;
    const res2 = await sweep();
    expect(res2.skipped).toBe(true);
    expect(res2.reason).toBe("interval_throttled");

    // Pass 3: 70 seconds after pass 1, interval elapsed -> runs
    currentTime += 60_000;
    const res3 = await sweep();
    expect(res3.skipped).toBe(false);
  });
});
