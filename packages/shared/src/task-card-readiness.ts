/**
 * TASK-CARD-READINESS-1 (OPE-12166): deterministic, pure readiness checker
 * for a task card (issue title + description). It only computes — no
 * server, routes, DB, UI, or network.
 *
 * A card is ready when:
 * - it carries all required sections (МЕСТО ПРАВКИ, НАМЕРЕНИЕ,
 *   ГРАНИЦА ОБЪЁМА, КРИТЕРИИ ПРИЁМКИ, ТЕСТ);
 * - it contains no unresolved-uncertainty markers («не уточнено», «TBD»,
 *   «???»);
 * - it contains at least one checkable acceptance claim («Ложно, если»
 *   or a «КОГДА … ТОГДА» when/then sentence).
 */

/** Required card section headers. */
export const TASK_CARD_REQUIRED_SECTIONS = [
  "МЕСТО ПРАВКИ",
  "НАМЕРЕНИЕ",
  "ГРАНИЦА ОБЪЁМА",
  "КРИТЕРИИ ПРИЁМКИ",
  "ТЕСТ",
] as const;

/** Sections whose absence gets a dedicated violation code. */
export const TASK_CARD_SECTION_CODES = {
  "МЕСТО ПРАВКИ": "MISSING_SECTION_EDIT_TARGET",
  "НАМЕРЕНИЕ": "MISSING_SECTION_INTENT",
  "ГРАНИЦА ОБЪЁМА": "MISSING_SECTION_SCOPE",
  "КРИТЕРИИ ПРИЁМКИ": "MISSING_SECTION_ACCEPTANCE",
  "ТЕСТ": "MISSING_SECTION_TEST",
} as const;

/** Remaining violation codes that are not tied to a single section. */
export const TASK_CARD_VIOLATION_CODES = {
  EMPTY_CARD: "EMPTY_CARD",
  UNRESOLVED_MARKER: "UNRESOLVED_MARKER",
  NO_CHECKABLE_CLAIM: "NO_CHECKABLE_CLAIM",
} as const;

/** Markers of still-open uncertainty. */
export const TASK_CARD_UNRESOLVED_MARKERS = ["не уточнено", "TBD", "???"] as const;

/** Checkable-claim spellings accepted in acceptance criteria. */
export const TASK_CARD_CHECKABLE_CLAIM_TOKENS = ["Ложно, если", "КОГДА"] as const;

export type TaskCardRequiredSection = (typeof TASK_CARD_REQUIRED_SECTIONS)[number];

/** A single violation found in a task card. */
export interface TaskCardReadinessViolation {
  code: string;
  message: string;
}

/** Input to {@link evaluateTaskCardReadiness}. */
export interface TaskCardReadinessInput {
  title: string;
  description: string | null;
  descriptionTruncated?: boolean;
}

/** Result of {@link evaluateTaskCardReadiness}. */
export interface TaskCardReadinessResult {
  ready: boolean;
  violations: TaskCardReadinessViolation[];
}

const checkableClaimRe = /Ложно,\s*если|КОГДА\s+.+\s+ТОГДА/si;

function sectionPresent(description: string, section: string): boolean {
  return description.includes(section);
}

/**
 * Evaluate whether a task card is complete enough to hand to an engineer.
 * Pure and deterministic: same input always yields the same violations,
 * in a stable order (empty card, missing sections, unresolved markers,
 * checkable claim).
 */
export function evaluateTaskCardReadiness(input: TaskCardReadinessInput): TaskCardReadinessResult {
  const violations: TaskCardReadinessViolation[] = [];
  const description = (input.description ?? "").trim();

  if (description.length === 0) {
    violations.push({
      code: TASK_CARD_VIOLATION_CODES.EMPTY_CARD,
      message: "Описание карточки задачи пустое: у задачи нет тела для проверки.",
    });
    return { ready: false, violations };
  }

  for (const section of TASK_CARD_REQUIRED_SECTIONS) {
    if (!sectionPresent(description, section)) {
      violations.push({
        code: TASK_CARD_SECTION_CODES[section],
        message: `Отсутствует обязательный раздел «${section}» карточки задачи.`,
      });
    }
  }

  for (const marker of TASK_CARD_UNRESOLVED_MARKERS) {
    if (description.toLowerCase().includes(marker.toLowerCase())) {
      violations.push({
        code: TASK_CARD_VIOLATION_CODES.UNRESOLVED_MARKER,
        message: `В карточке есть маркер незакрытой неопределённости «${marker}».`,
      });
    }
  }

  if (!checkableClaimRe.test(description)) {
    violations.push({
      code: TASK_CARD_VIOLATION_CODES.NO_CHECKABLE_CLAIM,
      message:
        "Нет проверяемых критериев приёмки: нужен блок «Ложно, если …» или предложение вида «КОГДА … ТОГДА».",
    });
  }

  return { ready: violations.length === 0, violations };
}
