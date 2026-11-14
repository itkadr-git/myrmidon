// server/src/myrmidon/intake-dialog/service.ts
//
// myrmidon(1.8 INTAKE-DIALOG / OPE-13010): dialogue clarification and customer confirmation.
//
// Intent:
// Customer describes their request in their own words; intake service evaluates
// whether the requirement card is complete.
// - Incomplete card: return questions for missing sections and create nothing.
// - Complete card: save requirement-card document and create request_confirmation
//   tied to that specific document revision.

import type { DbClient } from "../../db/index.js";
import { documentService } from "../../services/documents.js";
import { issueThreadInteractionService } from "../../services/issue-thread-interactions.js";
import {
  type RequirementCard,
  evaluateRequirementCard,
  renderRequirementCardMarkdown,
} from "@myrmidon/shared";

export const INTAKE_CARD_DOCUMENT_KEY = "requirement-card";

/**
 * Deterministic idempotency key for intake confirmation card.
 * Modeled after ctoChatApprovalIdempotencyKey (`intake-card:<issueId>:<revisionId>`).
 */
export function intakeCardApprovalIdempotencyKey(issueId: string, revisionId: string): string {
  return `intake-card:${issueId}:${revisionId}`;
}

export interface ClarificationQuestion {
  section: string;
  question: string;
}

export type IntakeDialogResult =
  | {
      status: "needs_clarification";
      questions: ClarificationQuestion[];
      missing: string[];
      violations: string[];
    }
  | {
      status: "confirmation_requested";
      documentId: string;
      revisionId: string;
      revisionNumber: number;
      interactionId: string;
    };

export interface ProcessIntakeCardInput {
  companyId: string;
  issueId: string;
  card: Partial<RequirementCard> | null | undefined;
  authorAgentId?: string | null;
  authorUserId?: string | null;
  createdByRunId?: string | null;
}

export interface IntakeDialogDeps {
  db: DbClient;
}

const SECTION_QUESTIONS: Record<string, string> = {
  title: "Укажите краткое название задачи или требования.",
  summary: "Опишите суть запроса: что именно требуется сделать?",
  goal: "Какова цель и ожидаемый бизнес-результат?",
  acceptanceCriteria: "Укажите критерии приёмки: как проверить, что задача выполнена?",
  scope: "Укажите границы задачи: что входит в реализацию?",
  outOfScope: "Укажите, что явно остаётся за рамками задачи.",
};

/**
 * Standard question text for missing section.
 */
export function getQuestionForMissingSection(section: string): string {
  return SECTION_QUESTIONS[section] ?? `Уточните сведения по разделу «${section}».`;
}

/**
 * Process an intake requirement card.
 *
 * 1. Evaluate requirement card completeness.
 * 2. If incomplete: return status "needs_clarification" with questions for missing sections.
 *    No documents or interactions are created.
 * 3. If complete:
 *    a. Upsert "requirement-card" document on the issue with the rendered markdown.
 *    b. Create a request_confirmation interaction tied to { type: "issue_document", key: "requirement-card", revisionId, revisionNumber }.
 *    c. Use deterministic idempotency key `intake-card:<issueId>:<revisionId>`.
 *    d. Return confirmation_requested with document and interaction details.
 */
export async function processIntakeCard(
  deps: IntakeDialogDeps,
  input: ProcessIntakeCardInput,
): Promise<IntakeDialogResult> {
  const evaluation = evaluateRequirementCard(input.card);

  if (!evaluation.ready) {
    const questions: ClarificationQuestion[] = evaluation.missing.map((section) => ({
      section,
      question: getQuestionForMissingSection(section),
    }));

    return {
      status: "needs_clarification",
      questions,
      missing: evaluation.missing,
      violations: evaluation.violations,
    };
  }

  const fullCard = input.card as RequirementCard;
  const markdownBody = renderRequirementCardMarkdown(fullCard);
  const docService = documentService(deps.db);

  // Upsert the requirement-card document on the issue
  const upsertResult = await docService.upsertIssueDocument({
    issueId: input.issueId,
    key: INTAKE_CARD_DOCUMENT_KEY,
    title: fullCard.title.trim(),
    format: "markdown",
    body: markdownBody,
    changeSummary: "Intake dialogue requirement card update",
    createdByAgentId: input.authorAgentId ?? null,
    createdByUserId: input.authorUserId ?? null,
    createdByRunId: input.createdByRunId ?? null,
  });

  const { document } = upsertResult;
  const revisionId = document.latestRevisionId;
  const revisionNumber = document.latestRevisionNumber;

  const interactionService = issueThreadInteractionService(deps.db);
  const idempotencyKey = intakeCardApprovalIdempotencyKey(input.issueId, revisionId);

  const interaction = await interactionService.create({
    companyId: input.companyId,
    issueId: input.issueId,
    agentId: input.authorAgentId ?? null,
    userId: input.authorUserId ?? null,
    kind: "request_confirmation",
    idempotencyKey,
    target: {
      type: "issue_document",
      key: INTAKE_CARD_DOCUMENT_KEY,
      revisionId,
      revisionNumber,
    },
    payload: {
      prompt: `Подтвердите постановку задачи: ${fullCard.title.trim()}`,
      actionLabel: "Утвердить",
    },
  });

  return {
    status: "confirmation_requested",
    documentId: document.id,
    revisionId,
    revisionNumber,
    interactionId: interaction.id,
  };
}

export function intakeDialogService(deps: IntakeDialogDeps) {
  return {
    processCard: (input: ProcessIntakeCardInput) => processIntakeCard(deps, input),
  };
}
