// server/src/myrmidon/lesson-distill/lesson-distill.myrmidon.test.ts
//
// myrmidon(1.7 KNOWLEDGE-2.0 L-4): the pure domain — window math, lesson
// typing, grouping, the ≥2-repeats rule, candidate shape. No DB.

import { afterEach, describe, expect, it, vi } from "vitest";
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
import {
  DEFAULT_LESSON_DISTILL_SETTINGS,
  resolveLessonDistillSettings,
} from "./settings.js";
import {
  startLessonDistillSweep,
  stopLessonDistillSweep,
} from "./startup.js";
import {
  applyLiveBehaviorSettings,
  liveBehaviorSettingsView,
} from "../behavior-settings/live.js";
import * as serviceModule from "./service.js";

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

describe("resolveLessonDistillSettings: matrix env x saved x default (OPE-12628)", () => {
  afterEach(() => {
    applyLiveBehaviorSettings({ settings: {}, sources: {} });
  });

  it("without env and without saved settings, built-in defaults are used", () => {
    applyLiveBehaviorSettings({ settings: {}, sources: {} });
    const resolved = resolveLessonDistillSettings({});
    expect(resolved.enabled).toBe(DEFAULT_LESSON_DISTILL_SETTINGS.enabled); // false
    expect(resolved.windowHours).toBe(DEFAULT_LESSON_DISTILL_SETTINGS.windowHours); // 24
    expect(resolved.repeatThreshold).toBe(DEFAULT_LESSON_DISTILL_SETTINGS.repeatThreshold); // 2
    expect(resolved.periodMinutes).toBe(DEFAULT_LESSON_DISTILL_SETTINGS.periodMinutes); // 60
  });

  it("saved UI settings take effect when env is not declared", () => {
    applyLiveBehaviorSettings({
      settings: {
        lessonDistillEnabled: true,
        lessonDistillWindowHours: 48,
        lessonDistillRepeatThreshold: 5,
        lessonDistillPeriodMinutes: 120,
      },
      sources: {
        lessonDistillEnabled: "ui",
        lessonDistillWindowHours: "ui",
        lessonDistillRepeatThreshold: "ui",
        lessonDistillPeriodMinutes: "ui",
      },
    });

    const resolved = resolveLessonDistillSettings({});
    expect(resolved.enabled).toBe(true);
    expect(resolved.windowHours).toBe(48);
    expect(resolved.repeatThreshold).toBe(5);
    expect(resolved.periodMinutes).toBe(120);
  });

  it("explicit env overrides saved UI settings", () => {
    applyLiveBehaviorSettings({
      settings: {
        lessonDistillEnabled: true,
        lessonDistillWindowHours: 48,
        lessonDistillRepeatThreshold: 5,
        lessonDistillPeriodMinutes: 120,
      },
      sources: {
        lessonDistillEnabled: "ui",
        lessonDistillWindowHours: "ui",
        lessonDistillRepeatThreshold: "ui",
        lessonDistillPeriodMinutes: "ui",
      },
    });

    const resolved = resolveLessonDistillSettings({
      MYRMIDON_LESSON_DISTILL_ENABLED: "0",
      MYRMIDON_LESSON_DISTILL_WINDOW_HOURS: "12",
      MYRMIDON_LESSON_DISTILL_REPEAT_THRESHOLD: "3",
      MYRMIDON_LESSON_DISTILL_PERIOD_MINUTES: "30",
    });

    expect(resolved.enabled).toBe(false);
    expect(resolved.windowHours).toBe(12);
    expect(resolved.repeatThreshold).toBe(3);
    expect(resolved.periodMinutes).toBe(30);
  });

  it("explicit env=1 enables sweep even when saved is false", () => {
    applyLiveBehaviorSettings({
      settings: {
        lessonDistillEnabled: false,
      },
      sources: {
        lessonDistillEnabled: "ui",
      },
    });

    const resolved = resolveLessonDistillSettings({
      MYRMIDON_LESSON_DISTILL_ENABLED: "1",
    });

    expect(resolved.enabled).toBe(true);
  });
});

describe("lesson distill sweep: live enabled toggle (OPE-12628)", () => {
  afterEach(() => {
    stopLessonDistillSweep();
    applyLiveBehaviorSettings({ settings: {}, sources: {} });
    vi.restoreAllMocks();
  });

  it("tick when disabled does not call runLessonDistillPass, calling applyLiveBehaviorSettings with enabled=true causes pass to run", async () => {
    vi.useFakeTimers();
    try {
      applyLiveBehaviorSettings({
        settings: { lessonDistillEnabled: false },
        sources: { lessonDistillEnabled: "ui" },
      });

      const runPassSpy = vi.spyOn(serviceModule, "runLessonDistillPass").mockResolvedValue({
        window: { since: NOW, until: NOW },
        lessonsSeen: 0,
        groupsFormed: 0,
        candidatesFound: 0,
        suggestionsCreated: 0,
        suggestionsRefreshed: 0,
        candidates: [],
      });

      const fakeDb = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ id: "company-1" }]),
          }),
        }),
      } as any;

      startLessonDistillSweep({
        db: fakeDb,
        env: {
          MYRMIDON_MEMORY_BASE_URL: "http://127.0.0.1:9385",
        },
      });

      // Initial tick ran with enabled=false -> runPassSpy should NOT have been called
      await vi.advanceTimersByTimeAsync(0);
      expect(runPassSpy).not.toHaveBeenCalled();

      // Now enable it live via applyLiveBehaviorSettings without restarting
      applyLiveBehaviorSettings({
        settings: { lessonDistillEnabled: true },
        sources: { lessonDistillEnabled: "ui" },
      });

      // Advance by 60 minutes (the sweep period)
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

      expect(runPassSpy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
