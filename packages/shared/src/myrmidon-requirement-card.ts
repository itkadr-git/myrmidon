import { z } from "zod";
import {
  TASK_CARD_REQUIRED_SECTIONS,
  TASK_CARD_SECTION_CODES,
  evaluateTaskCardReadiness,
  type TaskCardReadinessViolation,
  type TaskCardRequiredSection,
} from "./task-card-readiness.js";

/**
 * Single requirement card schema (OPE-13007).
 * Captures analyst's structured task definition across 5 mandatory sections:
 * edit target, intent, scope, criteria, and test.
 */
export const requirementCardSchema = z.object({
  editTarget: z.string().trim().min(1),
  intent: z.string().trim().min(1),
  scope: z.string().trim().min(1),
  criteria: z.array(z.string().trim().min(1)).min(1),
  test: z.string().trim().min(1),
});

export type RequirementCard = z.infer<typeof requirementCardSchema>;

export interface RequirementCardEvaluation {
  ready: boolean;
  missing: TaskCardRequiredSection[];
  violations: TaskCardReadinessViolation[];
}

const SECTION_EXTRACTORS: Record<
  TaskCardRequiredSection,
  (card: Partial<RequirementCard>) => unknown
> = {
  "МЕСТО ПРАВКИ": (card) => card.editTarget ?? (card as any).target ?? (card as any).place,
  "НАМЕРЕНИЕ": (card) => card.intent,
  "ГРАНИЦА ОБЪЁМА": (card) => card.scope,
  "КРИТЕРИИ ПРИЁМКИ": (card) => card.criteria ?? (card as any).acceptanceCriteria,
  "ТЕСТ": (card) => card.test,
};

function isSectionPresent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) {
    if (value.length === 0) return false;
    return value.some((item) => typeof item === "string" && item.trim().length > 0);
  }
  return false;
}

/**
 * Format requirement card as markdown with section headers matching VALID_CARD.
 */
export function renderRequirementCardMarkdown(card: Partial<RequirementCard>): string {
  const lines: string[] = [];

  const editTargetRaw = card.editTarget ?? (card as any).target ?? (card as any).place;
  if (typeof editTargetRaw === "string" && editTargetRaw.trim().length > 0) {
    lines.push(`МЕСТО ПРАВКИ: ${editTargetRaw.trim()}`);
  }

  const intentRaw = card.intent;
  if (typeof intentRaw === "string" && intentRaw.trim().length > 0) {
    lines.push(`НАМЕРЕНИЕ: ${intentRaw.trim()}`);
  }

  const scopeRaw = card.scope;
  if (typeof scopeRaw === "string" && scopeRaw.trim().length > 0) {
    lines.push(`ГРАНИЦА ОБЪЁМА: ${scopeRaw.trim()}`);
  }

  const criteriaRaw = card.criteria ?? (card as any).acceptanceCriteria;
  if (criteriaRaw) {
    if (typeof criteriaRaw === "string" && criteriaRaw.trim().length > 0) {
      lines.push(`КРИТЕРИИ ПРИЁМКИ: ${criteriaRaw.trim()}`);
    } else if (Array.isArray(criteriaRaw)) {
      const items = criteriaRaw
        .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
        .map((c) => c.trim());
      if (items.length === 1) {
        lines.push(`КРИТЕРИИ ПРИЁМКИ: ${items[0]}`);
      } else if (items.length > 1) {
        lines.push(`КРИТЕРИИ ПРИЁМКИ:\n${items.map((i) => (i.startsWith("- ") ? i : `- ${i}`)).join("\n")}`);
      }
    }
  }

  const testRaw = card.test;
  if (typeof testRaw === "string" && testRaw.trim().length > 0) {
    lines.push(`ТЕСТ: ${testRaw.trim()}`);
  }

  return lines.join("\n");
}

/**
 * Pure and deterministic readiness evaluator for requirement cards.
 * Combines field-level checks for missing sections and evaluateTaskCardReadiness
 * on the rendered markdown for checkable claims, unresolved markers, and structure.
 */
export function evaluateRequirementCard(
  partial: Partial<RequirementCard>,
): RequirementCardEvaluation {
  const missing: TaskCardRequiredSection[] = [];
  for (const section of TASK_CARD_REQUIRED_SECTIONS) {
    const extractor = SECTION_EXTRACTORS[section];
    if (!isSectionPresent(extractor(partial))) {
      missing.push(section);
    }
  }

  const markdown = renderRequirementCardMarkdown(partial);
  const readiness = evaluateTaskCardReadiness({
    title: "RequirementCard",
    description: markdown,
  });

  const violations: TaskCardReadinessViolation[] = [...readiness.violations];
  for (const section of missing) {
    const code = TASK_CARD_SECTION_CODES[section];
    if (!violations.some((v) => v.code === code)) {
      violations.push({
        code,
        message: `Отсутствует обязательный раздел «${section}» карточки задачи.`,
      });
    }
  }

  const ready = missing.length === 0 && violations.length === 0;
  return {
    ready,
    missing,
    violations,
  };
}
