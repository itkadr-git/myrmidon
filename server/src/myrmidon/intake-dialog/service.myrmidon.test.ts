import { beforeAll, afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import {
  createDb,
  companies,
  issueThreadInteractions,
  issues,
  type Db,
} from "@myrmidon/db";
import { issueThreadInteractionService } from "../../services/issue-thread-interactions.js";
import {
  processIntakeCard,
  intakeCardApprovalIdempotencyKey,
  INTAKE_CARD_DOCUMENT_KEY,
} from "./service.js";
import type { RequirementCard } from "@myrmidon/shared";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("myrmidon(1.8 INTAKE-DIALOG / OPE-13010): intake dialog clarification and customer confirmation", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let issueId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-intake-dialog-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  beforeEach(async () => {
    const [company] = await db.insert(companies).values({ name: `Intake Dialog Test Co ${randomUUID()}` }).returning();
    companyId = company.id;
    const [issue] = await db.insert(issues).values({ companyId, title: "Seed Intake Task", status: "in_progress" }).returning();
    issueId = issue.id;
  });

  afterEach(async () => {
    await db.delete(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId));
    await db.delete(issues).where(eq(issues.id, issueId));
    await db.delete(companies).where(eq(companies.id, companyId));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("case 1: incomplete card (две фразы) → needs_clarification, neither interaction nor subtasks created", async () => {
    const twoPhrasesCard: Partial<RequirementCard> = {
      title: "Сделать кнопку",
      summary: "Кнопка должна быть синей",
    };

    const initialIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.companyId, companyId));
    expect(initialIssues.length).toBe(1);

    const result = await processIntakeCard(
      { db },
      {
        companyId,
        issueId,
        card: twoPhrasesCard,
      },
    );

    expect(result.status).toBe("needs_clarification");
    if (result.status === "needs_clarification") {
      expect(result.missing).toContain("goal");
      expect(result.missing).toContain("acceptanceCriteria");
      expect(result.questions.length).toBeGreaterThanOrEqual(2);
      expect(result.questions.some((q) => q.section === "goal")).toBe(true);
      expect(result.questions.some((q) => q.section === "acceptanceCriteria")).toBe(true);
    }

    const interactions = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.issueId, issueId));
    expect(interactions.length).toBe(0);

    const allIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.companyId, companyId));
    expect(allIssues.length).toBe(1);
  });

  it("case 2: complete card → creates exactly one request_confirmation with target.type=issue_document and current revisionId", async () => {
    const completeCard: RequirementCard = {
      title: "Добавить кнопку экспорта в CSV",
      summary: "Экспорт списка пользователей в файл CSV по клику на кнопку в шапке таблицы.",
      goal: "Позволить операторам выгружать отчёты без обращения к разработчикам.",
      acceptanceCriteria: [
        "Кнопка 'Экспорт в CSV' отображается в шапке таблицы пользователей",
        "При клике скачивается корректный файл CSV со всеми строками текущего фильтра",
      ],
    };

    const result = await processIntakeCard(
      { db },
      {
        companyId,
        issueId,
        card: completeCard,
      },
    );

    expect(result.status).toBe("confirmation_requested");
    if (result.status === "confirmation_requested") {
      expect(result.documentId).toBeDefined();
      expect(result.revisionId).toBeDefined();
      expect(result.revisionNumber).toBe(1);
      expect(result.interactionId).toBeDefined();

      const [stored] = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, result.interactionId));

      expect(stored).toBeDefined();
      expect(stored.kind).toBe("request_confirmation");
      expect(stored.idempotencyKey).toBe(
        intakeCardApprovalIdempotencyKey(issueId, result.revisionId),
      );
      expect(stored.target).toEqual({
        type: "issue_document",
        key: INTAKE_CARD_DOCUMENT_KEY,
        revisionId: result.revisionId,
        revisionNumber: 1,
      });
    }

    const interactions = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.issueId, issueId));
    expect(interactions.length).toBe(1);

    const allIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.companyId, companyId));
    expect(allIssues.length).toBe(1);
  });

  it("case 3: repeat with the same card / same revision → does not create a second interaction (idempotent)", async () => {
    const completeCard: RequirementCard = {
      title: "Идемпотентный тест задачи",
      summary: "Проверка повторного вызова с теми же данными",
      goal: "Не создавать дубликатов подтверждений",
      acceptanceCriteria: ["Один interaction при многократных вызовах"],
    };

    const result1 = await processIntakeCard(
      { db },
      {
        companyId,
        issueId,
        card: completeCard,
      },
    );
    expect(result1.status).toBe("confirmation_requested");

    const result2 = await processIntakeCard(
      { db },
      {
        companyId,
        issueId,
        card: completeCard,
      },
    );
    expect(result2.status).toBe("confirmation_requested");

    if (
      result1.status === "confirmation_requested" &&
      result2.status === "confirmation_requested"
    ) {
      expect(result2.interactionId).toBe(result1.interactionId);
      expect(result2.revisionId).toBe(result1.revisionId);
    }

    const interactions = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.issueId, issueId));
    expect(interactions.length).toBe(1);
  });

  it("case 4: new revision → old confirmation gets stale_target / expired when a newer document revision is created", async () => {
    const cardV1: RequirementCard = {
      title: "Версия 1 постановки",
      summary: "Первоначальное описание",
      goal: "Цель номер 1",
      acceptanceCriteria: ["Критерий 1"],
    };

    const resultV1 = await processIntakeCard(
      { db },
      {
        companyId,
        issueId,
        card: cardV1,
      },
    );
    expect(resultV1.status).toBe("confirmation_requested");
    const v1InteractionId = resultV1.status === "confirmation_requested" ? resultV1.interactionId : "";

    const cardV2: RequirementCard = {
      title: "Версия 2 постановки (изменённая)",
      summary: "Обновлённое описание после замечаний заказчика",
      goal: "Обновлённая цель номер 2",
      acceptanceCriteria: ["Критерий 1", "Критерий 2"],
    };

    const resultV2 = await processIntakeCard(
      { db },
      {
        companyId,
        issueId,
        card: cardV2,
      },
    );
    expect(resultV2.status).toBe("confirmation_requested");
    const v2InteractionId = resultV2.status === "confirmation_requested" ? resultV2.interactionId : "";

    expect(v2InteractionId).not.toBe(v1InteractionId);

    const [v1Interaction] = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, v1InteractionId));

    expect(v1Interaction.status).toBe("expired");

    const [v2Interaction] = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, v2InteractionId));

    expect(v2Interaction.status).toBe("pending");

    const interactionService = issueThreadInteractionService(db);
    await expect(
      interactionService.acceptInteraction(
        { id: issueId, companyId, projectId: null, goalId: null },
        v1InteractionId,
        {},
        { userId: `user-${randomUUID()}` },
      ),
    ).rejects.toMatchObject({ code: "interaction_stale_target" });
  });
});
