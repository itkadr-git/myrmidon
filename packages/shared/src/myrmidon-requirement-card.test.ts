import { describe, expect, it } from "vitest";
import {
  TASK_CARD_REQUIRED_SECTIONS,
  TASK_CARD_SECTION_CODES,
  TASK_CARD_UNRESOLVED_MARKERS,
  TASK_CARD_VIOLATION_CODES,
  evaluateTaskCardReadiness,
  type TaskCardReadinessViolation,
} from "./task-card-readiness.js";
import {
  evaluateRequirementCard,
  renderRequirementCardMarkdown,
  requirementCardSchema,
  type RequirementCard,
} from "./myrmidon-requirement-card.js";

const VALID_CARD: RequirementCard = {
  editTarget: "packages/shared/src/example.ts",
  intent: "сделать пример понятнее.",
  scope: "без сервера и UI.",
  criteria: ["Утверждение: пример работает. Ложно, если пример не работает."],
  test: "packages/shared/src/example.test.ts",
};

function codes(violations: TaskCardReadinessViolation[]): string[] {
  return violations.map((v) => v.code);
}

describe("myrmidon-requirement-card (OPE-13007)", () => {
  it("a complete valid requirement card evaluates to ready with no violations", () => {
    const result = evaluateRequirementCard(VALID_CARD);
    expect(result).toEqual({
      ready: true,
      missing: [],
      violations: [],
    });
    expect(requirementCardSchema.safeParse(VALID_CARD).success).toBe(true);
  });

  it("each of the 5 missing or whitespace-only fields lands in missing and produces section violation", () => {
    const cases: Array<{
      section: (typeof TASK_CARD_REQUIRED_SECTIONS)[number];
      partialEmpty: Partial<RequirementCard>;
      partialSpaces: Partial<RequirementCard>;
    }> = [
      {
        section: "МЕСТО ПРАВКИ",
        partialEmpty: { ...VALID_CARD, editTarget: "" },
        partialSpaces: { ...VALID_CARD, editTarget: "   " },
      },
      {
        section: "НАМЕРЕНИЕ",
        partialEmpty: { ...VALID_CARD, intent: "" },
        partialSpaces: { ...VALID_CARD, intent: "   " },
      },
      {
        section: "ГРАНИЦА ОБЪЁМА",
        partialEmpty: { ...VALID_CARD, scope: "" },
        partialSpaces: { ...VALID_CARD, scope: "   " },
      },
      {
        section: "КРИТЕРИИ ПРИЁМКИ",
        partialEmpty: { ...VALID_CARD, criteria: [] },
        partialSpaces: { ...VALID_CARD, criteria: ["   "] },
      },
      {
        section: "ТЕСТ",
        partialEmpty: { ...VALID_CARD, test: "" },
        partialSpaces: { ...VALID_CARD, test: "   " },
      },
    ];

    for (const { section, partialEmpty, partialSpaces } of cases) {
      const emptyResult = evaluateRequirementCard(partialEmpty);
      expect(emptyResult.ready, `${section} empty`).toBe(false);
      expect(emptyResult.missing, `${section} empty`).toContain(section);
      expect(codes(emptyResult.violations), `${section} empty`).toContain(
        TASK_CARD_SECTION_CODES[section],
      );

      const spacesResult = evaluateRequirementCard(partialSpaces);
      expect(spacesResult.ready, `${section} spaces`).toBe(false);
      expect(spacesResult.missing, `${section} spaces`).toContain(section);
      expect(codes(spacesResult.violations), `${section} spaces`).toContain(
        TASK_CARD_SECTION_CODES[section],
      );
    }
  });

  it("an entirely empty card flags all 5 sections as missing", () => {
    const result = evaluateRequirementCard({});
    expect(result.ready).toBe(false);
    expect(result.missing).toEqual([...TASK_CARD_REQUIRED_SECTIONS]);
    expect(codes(result.violations)).toContain(TASK_CARD_VIOLATION_CODES.EMPTY_CARD);
  });

  it("yields NO_CHECKABLE_CLAIM when criteria lacks checkable claim token", () => {
    const cardWithoutClaim: RequirementCard = {
      ...VALID_CARD,
      criteria: ["Нужно просто чтобы пример работал надежно."],
    };
    const result = evaluateRequirementCard(cardWithoutClaim);
    expect(result.ready).toBe(false);
    expect(result.missing).toEqual([]);
    expect(codes(result.violations)).toContain(TASK_CARD_VIOLATION_CODES.NO_CHECKABLE_CLAIM);
  });

  it("accepts a КОГДА … ТОГДА checkable claim", () => {
    const whenThenCard: RequirementCard = {
      ...VALID_CARD,
      criteria: ["КОГДА пример запускают ТОГДА он завершается без ошибок."],
    };
    const result = evaluateRequirementCard(whenThenCard);
    expect(result.ready).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.violations).toEqual([]);
  });

  it("flags unresolved markers such as TBD, не уточнено, ??? with UNRESOLVED_MARKER", () => {
    for (const marker of TASK_CARD_UNRESOLVED_MARKERS) {
      const cardWithMarker: RequirementCard = {
        ...VALID_CARD,
        intent: `сделать пример понятнее, ${marker}`,
      };
      const result = evaluateRequirementCard(cardWithMarker);
      expect(result.ready, marker).toBe(false);
      expect(codes(result.violations), marker).toContain(
        TASK_CARD_VIOLATION_CODES.UNRESOLVED_MARKER,
      );
    }
  });

  it("rendered markdown passes evaluateTaskCardReadiness cleanly", () => {
    const rendered = renderRequirementCardMarkdown(VALID_CARD);
    const readiness = evaluateTaskCardReadiness({
      title: "Задача",
      description: rendered,
    });
    expect(readiness).toEqual({ ready: true, violations: [] });

    // Renders sections in the expected canonical format
    expect(rendered).toContain("МЕСТО ПРАВКИ: packages/shared/src/example.ts");
    expect(rendered).toContain("НАМЕРЕНИЕ: сделать пример понятнее.");
    expect(rendered).toContain("ГРАНИЦА ОБЪЁМА: без сервера и UI.");
    expect(rendered).toContain(
      "КРИТЕРИИ ПРИЁМКИ: Утверждение: пример работает. Ложно, если пример не работает.",
    );
    expect(rendered).toContain("ТЕСТ: packages/shared/src/example.test.ts");
  });

  it("requirementCardSchema rejects empty and invalid cards", () => {
    expect(() => requirementCardSchema.parse({})).toThrow();
    expect(() =>
      requirementCardSchema.parse({
        ...VALID_CARD,
        criteria: [],
      }),
    ).toThrow();
    expect(() =>
      requirementCardSchema.parse({
        ...VALID_CARD,
        editTarget: "   ",
      }),
    ).toThrow();
  });
});
