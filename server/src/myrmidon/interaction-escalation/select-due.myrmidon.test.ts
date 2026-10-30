import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import {
  agents,
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
import { selectDueEscalations } from "./select-due.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres selectDueEscalations tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("selectDueEscalations PG test", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let issueId: string;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("interaction-select-due-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await db.delete(interactionEscalations);
    await db.delete(issueThreadInteractions);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  async function seedCompanyAndIssue() {
    companyId = randomUUID();
    issueId = randomUUID();
    agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Escalation Co",
      issuePrefix: `ESC${randomUUID().slice(0, 4).toUpperCase()}`,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Agent Zero",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Task with interactions",
      identifier: `ESC-1`,
    });
  }

  it("просроченная pending-карточка выбирается один раз; повторный вызов - 0", async () => {
    await seedCompanyAndIssue();
    const now = new Date("2026-10-30T12:00:00Z");
    const interactionId = randomUUID();

    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "pending",
      routeType: "agent",
      addresseeAgentId: agentId,
      timeoutAt: new Date(now.getTime() - 60_000), // 1 minute overdue
      escalationLevel: 0,
      escalationChain: [
        { recipient: { userId: "user-manager" }, afterMinutes: 10 },
      ],
      payload: { prompt: "Confirm changes" },
    });

    // 1. Первый вызов выбирает просроченную карточку и фиксирует журнал
    const selected = await selectDueEscalations(db, now, 10);
    expect(selected).toEqual([
      {
        interactionId,
        nextLevel: 1,
      },
    ]);

    // Проверяем запись в interaction_escalations
    const journalEntries = await db
      .select()
      .from(interactionEscalations)
      .where(eq(interactionEscalations.interactionId, interactionId));
    expect(journalEntries).toHaveLength(1);
    expect(journalEntries[0].interactionId).toBe(interactionId);
    expect(journalEntries[0].level).toBe(1);
    expect(journalEntries[0].fromRecipient).toEqual({ agentId });
    expect(journalEntries[0].toRecipient).toEqual({ userId: "user-manager" });
    expect(journalEntries[0].reason).toBe("timeout");

    // 2. Повторный вызов не выбирает уже зафиксированную карточку -> 0
    const repeated = await selectDueEscalations(db, now, 10);
    expect(repeated).toEqual([]);

    // Проверяем, что в журнале всё ещё ровно 1 запись
    const journalAfterRepeat = await db
      .select()
      .from(interactionEscalations)
      .where(eq(interactionEscalations.interactionId, interactionId));
    expect(journalAfterRepeat).toHaveLength(1);
  });

  it("resolved и ещё не просроченные не выбираются", async () => {
    await seedCompanyAndIssue();
    const now = new Date("2026-10-30T12:00:00Z");

    const resolvedId = randomUUID();
    const futureId = randomUUID();
    const noTimeoutId = randomUUID();

    await db.insert(issueThreadInteractions).values([
      // Просроченная, но resolved
      {
        id: resolvedId,
        companyId,
        issueId,
        kind: "request_confirmation",
        status: "resolved",
        routeType: "agent",
        addresseeAgentId: agentId,
        timeoutAt: new Date(now.getTime() - 60_000),
        escalationLevel: 0,
        payload: {},
      },
      // Pending, но срок ещё не вышел (в будущем)
      {
        id: futureId,
        companyId,
        issueId,
        kind: "request_confirmation",
        status: "pending",
        routeType: "agent",
        addresseeAgentId: agentId,
        timeoutAt: new Date(now.getTime() + 60_000),
        escalationLevel: 0,
        payload: {},
      },
      // Pending, но timeoutAt is null
      {
        id: noTimeoutId,
        companyId,
        issueId,
        kind: "request_confirmation",
        status: "pending",
        addresseeAgentId: agentId,
        timeoutAt: null,
        escalationLevel: 0,
        payload: {},
      },
    ]);

    const selected = await selectDueEscalations(db, now, 10);
    expect(selected).toEqual([]);

    const journalEntries = await db.select().from(interactionEscalations);
    expect(journalEntries).toHaveLength(0);
  });

  it("лимит выборки соблюдён", async () => {
    await seedCompanyAndIssue();
    const now = new Date("2026-10-30T12:00:00Z");

    // Создаём 5 просроченных карточек
    const interactionIds = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];

    for (let i = 0; i < interactionIds.length; i++) {
      await db.insert(issueThreadInteractions).values({
        id: interactionIds[i],
        companyId,
        issueId,
        kind: "ask_user_questions",
        status: "pending",
        routeType: "agent",
        addresseeAgentId: agentId,
        // Разный timeoutAt для проверки детерминированного порядка
        timeoutAt: new Date(now.getTime() - (10 - i) * 60_000),
        escalationLevel: 0,
        payload: {},
      });
    }

    // Лимит 2: выбираются первые 2
    const batch1 = await selectDueEscalations(db, now, 2);
    expect(batch1).toHaveLength(2);

    let journal = await db.select().from(interactionEscalations);
    expect(journal).toHaveLength(2);

    // Следующий вызов с лимитом 2: выбираются следующие 2
    const batch2 = await selectDueEscalations(db, now, 2);
    expect(batch2).toHaveLength(2);
    expect(batch2.map((b) => b.interactionId)).not.toEqual(
      expect.arrayContaining(batch1.map((b) => b.interactionId)),
    );

    journal = await db.select().from(interactionEscalations);
    expect(journal).toHaveLength(4);

    // Следующий вызов с лимитом 2: выбирается последняя 1
    const batch3 = await selectDueEscalations(db, now, 2);
    expect(batch3).toHaveLength(1);

    journal = await db.select().from(interactionEscalations);
    expect(journal).toHaveLength(5);

    // Следующий вызов: всё уже зафиксировано -> 0
    const batch4 = await selectDueEscalations(db, now, 2);
    expect(batch4).toEqual([]);

    // Проверяем все 5 зафиксированы
    journal = await db.select().from(interactionEscalations);
    expect(journal).toHaveLength(5);
  });

  it("выбирает карточку следующего уровня эскалации после перехода", async () => {
    await seedCompanyAndIssue();
    const now = new Date("2026-10-30T12:00:00Z");
    const interactionId = randomUUID();

    // Карточка уже на уровне 1, просрочена на этом шаге
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "pending",
      routeType: "agent",
      addresseeAgentId: agentId,
      timeoutAt: new Date(now.getTime() - 30_000),
      escalationLevel: 1,
      escalationChain: [
        { recipient: { userId: "user-step-1" }, afterMinutes: 5 },
        { recipient: { serviceQueue: "ops-lead" }, afterMinutes: 15 },
      ],
      payload: {},
    });

    // В журнале уже есть запись для level 1
    await db.insert(interactionEscalations).values({
      companyId,
      interactionId,
      level: 1,
      fromRecipient: { agentId },
      toRecipient: { userId: "user-step-1" },
      reason: "timeout",
      createdAt: new Date(now.getTime() - 60_000),
    });

    // selectDueEscalations должна выбрать карточку для level 2
    const selected = await selectDueEscalations(db, now, 10);
    expect(selected).toEqual([
      {
        interactionId,
        nextLevel: 2,
      },
    ]);

    const journalLevel2 = await db
      .select()
      .from(interactionEscalations)
      .where(eq(interactionEscalations.interactionId, interactionId));
    expect(journalLevel2).toHaveLength(2);
    const level2Entry = journalLevel2.find((j) => j.level === 2);
    expect(level2Entry).toBeDefined();
    expect(level2Entry?.toRecipient).toEqual({ serviceQueue: "ops-lead" });

    // Повторный вызов -> 0
    const repeated = await selectDueEscalations(db, now, 10);
    expect(repeated).toEqual([]);
  });
});
