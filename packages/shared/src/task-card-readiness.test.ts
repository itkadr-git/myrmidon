import { describe, expect, it } from "vitest";
import {
  TASK_CARD_CHECKABLE_CLAIM_TOKENS,
  TASK_CARD_REQUIRED_SECTIONS,
  TASK_CARD_SECTION_CODES,
  TASK_CARD_UNRESOLVED_MARKERS,
  TASK_CARD_VIOLATION_CODES,
  evaluateTaskCardReadiness,
  type TaskCardReadinessViolation,
} from "./task-card-readiness.js";

const VALID_CARD = [
  "МЕСТО ПРАВКИ: packages/shared/src/example.ts",
  "НАМЕРЕНИЕ: сделать пример понятнее.",
  "ГРАНИЦА ОБЪЁМА: без сервера и UI.",
  "КРИТЕРИИ ПРИЁМКИ: Утверждение: пример работает. Ложно, если пример не работает.",
  "ТЕСТ: packages/shared/src/example.test.ts",
].join("\n");

function codes(violations: TaskCardReadinessViolation[]): string[] {
  return violations.map((v) => v.code);
}

describe("evaluateTaskCardReadiness", () => {
  it("a full card without markers is ready with no violations", () => {
    const result = evaluateTaskCardReadiness({ title: "Задача", description: VALID_CARD });
    expect(result).toEqual({ ready: true, violations: [] });
  });

  it("a null description is not ready (empty card)", () => {
    const result = evaluateTaskCardReadiness({ title: "Задача", description: null });
    expect(result.ready).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.code).toBe(TASK_CARD_VIOLATION_CODES.EMPTY_CARD);
  });

  it("each missing required section yields its violation code", () => {
    const table = TASK_CARD_REQUIRED_SECTIONS.map((section) => ({
      section,
      code: TASK_CARD_SECTION_CODES[section],
    }));

    for (const { section, code } of table) {
      const description = VALID_CARD.replace(new RegExp(`^.*${section}.*$`, "mu"), "")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .join("\n");
      const result = evaluateTaskCardReadiness({ title: "Задача", description });
      expect(result.ready, section).toBe(false);
      expect(codes(result.violations), section).toContain(code);
    }
  });

  it("unresolved markers flag the card (table)", () => {
    const table = [
      { fragment: "Сроки не уточнено, берём потом.", marker: "не уточнено" },
      { fragment: "Формат TBD позже.", marker: "TBD" },
      { fragment: "Как это хранить — ???", marker: "???" },
    ];

    for (const { fragment, marker } of table) {
      const result = evaluateTaskCardReadiness({
        title: "Задача",
        description: `${VALID_CARD}\n${fragment}`,
      });
      expect(result.ready, marker).toBe(false);
      expect(codes(result.violations), marker).toContain(TASK_CARD_VIOLATION_CODES.UNRESOLVED_MARKER);
      expect(
        TASK_CARD_UNRESOLVED_MARKERS.map((m) => m.toLowerCase()).includes(marker.toLowerCase()),
        marker,
      ).toBe(true);
    }
  });

  it("acceptance criteria without a checkable claim yield NO_CHECKABLE_CLAIM", () => {
    const noClaim = VALID_CARD.replace(
      "Ложно, если пример не работает.",
      "Нужно просто, чтобы пример работал.",
    );
    const result = evaluateTaskCardReadiness({ title: "Задача", description: noClaim });
    expect(result.ready).toBe(false);
    expect(codes(result.violations)).toContain(TASK_CARD_VIOLATION_CODES.NO_CHECKABLE_CLAIM);
  });

  it("a КОГДА … ТОГДА claim satisfies the checkable-claim requirement", () => {
    const whenThen = VALID_CARD.replace(
      "Ложно, если пример не работает.",
      "КОГДА пример запускают ТОГДА он завершается без ошибок.",
    );
    const result = evaluateTaskCardReadiness({ title: "Задача", description: whenThen });
    expect(result.ready).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("checkable-claim tokens stay lowercase-stable", () => {
    const result = evaluateTaskCardReadiness({
      title: "Задача",
      description: VALID_CARD.replace("Ложно, если", "ложно, если"),
    });
    expect(result.ready).toBe(true);
    expect(TASK_CARD_CHECKABLE_CLAIM_TOKENS.length).toBe(2);
  });
});
