// server/src/myrmidon/lesson-distill/lesson-distill.myrmidon.test.ts
//
// myrmidon(1.7 KNOWLEDGE-2.0 L-4): the pure domain — window math, lesson
// typing, grouping, the ≥2-repeats rule, candidate shape. No DB.

import { describe, expect, it } from "vitest";
import {
  LESSON_SUGGESTION_MARKER,
  REGULATION_REPEAT_THRESHOLD,
  candidateSuggestionBody,
  candidateSuggestionRationale,
  groupLessonOccurrences,
  isLessonUnit,
  lessonWindow,
  normalizeLessonText,
  occurrenceInWindow,
  selectRegulationCandidates,
  type LessonOccurrence,
} from "./domain.js";

const NOW = new Date("2026-10-10T12:00:00.000Z");

function occurrence(overrides: Partial<LessonOccurrence> = {}): LessonOccurrence {
  return {
    bankId: "bank-1",
    memoryId: "mem-1",
    text: "Always rebase before pushing",
    factType: "lesson",
    at: "2026-10-10T10:00:00.000Z",
    ...overrides,
  };
}

describe("lessonWindow / occurrenceInWindow", () => {
  it("builds a 24h window ending at now", () => {
    const window = lessonWindow(NOW, 24 * 60 * 60 * 1000);
    expect(window.until.toISOString()).toBe("2026-10-10T12:00:00.000Z");
    expect(window.since.toISOString()).toBe("2026-10-09T12:00:00.000Z");
  });

  it("keeps occurrences inside the window and drops the rest", () => {
    const window = lessonWindow(NOW, 24 * 60 * 60 * 1000);
    expect(occurrenceInWindow(occurrence({ at: "2026-10-09T12:00:01.000Z" }), window)).toBe(true);
    expect(occurrenceInWindow(occurrence({ at: "2026-10-09T12:00:00.000Z" }), window)).toBe(true); // inclusive start
    expect(occurrenceInWindow(occurrence({ at: "2026-10-09T11:59:59.000Z" }), window)).toBe(false);
    expect(occurrenceInWindow(occurrence({ at: "2026-10-10T12:00:00.000Z" }), window)).toBe(false); // exclusive end
    expect(occurrenceInWindow(occurrence({ at: "not-a-date" }), window)).toBe(false);
  });
});

describe("isLessonUnit", () => {
  it("accepts factType lesson and the tag fallback", () => {
    expect(isLessonUnit({ factType: "lesson", text: "x" })).toBe(true);
    expect(isLessonUnit({ factType: "Lesson", text: "x" })).toBe(true);
    expect(isLessonUnit({ factType: null, text: "x" }, ["lesson"])).toBe(true);
    expect(isLessonUnit({ factType: null, text: "x" }, [])).toBe(false);
    expect(isLessonUnit({ factType: "decision", text: "x" }, ["lesson"])).toBe(false);
  });
});

describe("normalizeLessonText", () => {
  it("collapses case, whitespace and trailing punctuation", () => {
    expect(normalizeLessonText("  ALWAYS   rebase before pushing! ")).toBe(normalizeLessonText("always rebase before pushing"));
    expect(normalizeLessonText("rebase, first;")).toBe("rebase, first");
  });
});

describe("groupLessonOccurrences + selectRegulationCandidates", () => {
  it("one mention is not a candidate", () => {
    const groups = groupLessonOccurrences([occurrence()]);
    expect(groups).toHaveLength(1);
    expect(selectRegulationCandidates(groups)).toEqual([]);
  });

  it("two mentions of the same lesson in different banks become one candidate", () => {
    const occurrences = [
      occurrence({ memoryId: "mem-a", bankId: "bank-a", text: "Always rebase before pushing" }),
      occurrence({ memoryId: "mem-b", bankId: "bank-b", text: "always  rebase before pushing!", at: "2026-10-10T11:00:00.000Z" }),
    ];
    const groups = groupLessonOccurrences(occurrences);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.repeats).toBe(2);
    const candidates = selectRegulationCandidates(groups);
    expect(candidates).toHaveLength(1);
    // The newest phrasing becomes the representative.
    expect(candidates[0]!.representative).toBe("always  rebase before pushing!");
    expect(candidates[0]!.primaryMemoryId).toBe("mem-b");
    expect(candidates[0]!.evidenceMemoryIds).toEqual(["mem-b", "mem-a"]);
  });

  it("distinct lessons group apart; threshold honors the default of 2", () => {
    const occurrences = [
      occurrence({ memoryId: "mem-1", text: "Rebase before push" }),
      occurrence({ memoryId: "mem-2", text: "Never force-push main" }),
      occurrence({ memoryId: "mem-3", text: "Never force-push main" }),
    ];
    const groups = groupLessonOccurrences(occurrences);
    const candidates = selectRegulationCandidates(groups);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.representative).toBe("Never force-push main");
    expect(REGULATION_REPEAT_THRESHOLD).toBe(2);
  });
});

describe("candidate suggestion text", () => {
  it("is single-line and marked", () => {
    const window = lessonWindow(NOW, 24 * 60 * 60 * 1000);
    const candidate = selectRegulationCandidates(
      groupLessonOccurrences([
        occurrence({ memoryId: "mem-1", text: "First line\nsecond line" }),
        occurrence({ memoryId: "mem-2", text: "First line second line" }),
      ]),
    )[0]!;
    const body = candidateSuggestionBody(candidate);
    expect(body.startsWith(`[${LESSON_SUGGESTION_MARKER}]`)).toBe(true);
    expect(body).not.toMatch(/\n/);
    const rationale = candidateSuggestionRationale(candidate, window);
    expect(rationale).toContain("repeats: 2");
    expect(rationale).toContain("mem-1, mem-2");
  });
});
