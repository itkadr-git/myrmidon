// server/src/myrmidon/hindsight/reflection/reflection.myrmidon.test.ts
//
// myrmidon(1.7 POST-TASK-REFLECT, OPE-12080): the pure domain unit tests —
// lesson creation with the 30-day expiry, failure categorization, and schema
// validation before the hindsight send. No DB, no network.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_LESSON_TTL_DAYS,
  FAILURE_KINDS,
  LessonSchemaValidationError,
  categorizeFailure,
  categorizeFailureOrNull,
  computeExpiresAt,
  createLessonRecord,
  createReflectionService,
  formatDocumentId,
  formatDedupKey,
  formatHindsightRetainPayload,
  formatLessonTags,
  formatLessonText,
  formatRoleBankId,
  safeValidateHindsightRetainPayload,
  validateHindsightRetainPayload,
  validateLessonRecord,
  validateLessonRecordInput,
  type LessonRecord,
} from "./index.js";

const NOW = new Date("2026-11-07T12:00:00.000Z");
const clock = () => NOW;
const DAY_MS = 24 * 60 * 60 * 1000;

function baseInput() {
  return {
    role: "eng",
    failure_kind: "review_changes" as const,
    root_cause: "expectations were adjusted to the actual output",
    issueId: "afef5cb1-9620-4bb3-a63f-e1e2ffc244df",
    issueKey: "OPE-12080",
    companyId: "2870b911-483a-4091-9f15-183841811143",
  };
}

describe("createLessonRecord", () => {
  it("creates a lesson record with the 30-day default expiry", () => {
    const lesson = createLessonRecord(baseInput(), { clock });

    expect(lesson.expires_at_days).toBe(30);
    expect(lesson.expires_at_days).toBe(DEFAULT_LESSON_TTL_DAYS);
    expect(lesson.createdAt).toBe("2026-11-07T12:00:00.000Z");
    expect(lesson.expiresAt).toBe(new Date(NOW.getTime() + 30 * DAY_MS).toISOString());
    expect(lesson.id).toBeTruthy();
    expect(lesson.role).toBe("eng");
    expect(lesson.failure_kind).toBe("review_changes");
    expect(lesson.lesson_text).toContain("expectations were adjusted");
  });

  it("honours an explicit createdAt and computes expiresAt from it", () => {
    const lesson = createLessonRecord(
      { ...baseInput(), createdAt: "2026-10-01T00:00:00.000Z" },
      { clock },
    );
    expect(lesson.createdAt).toBe("2026-10-01T00:00:00.000Z");
    expect(lesson.expiresAt).toBe("2026-10-31T00:00:00.000Z");
  });

  it("supports a custom TTL", () => {
    const lesson = createLessonRecord({ ...baseInput(), expires_at_days: 7 }, { clock });
    expect(lesson.expires_at_days).toBe(7);
    expect(lesson.expiresAt).toBe(new Date(NOW.getTime() + 7 * DAY_MS).toISOString());
  });

  it("rejects a non-positive TTL", () => {
    expect(() =>
      createLessonRecord({ ...baseInput(), expires_at_days: 0 }, { clock }),
    ).toThrow(LessonSchemaValidationError);
  });

  it("generates distinct ids for distinct records", () => {
    const a = createLessonRecord(baseInput(), { clock });
    const b = createLessonRecord(baseInput(), { clock });
    expect(a.id).not.toBe(b.id);
  });

  it("keeps an explicit lesson_text when provided", () => {
    const lesson = createLessonRecord(
      { ...baseInput(), lesson_text: "Check the acceptance criteria before resubmitting." },
      { clock },
    );
    expect(lesson.lesson_text).toBe("Check the acceptance criteria before resubmitting.");
  });

  it("produces a schema-valid record for every failure kind", () => {
    for (const kind of FAILURE_KINDS) {
      const lesson = createLessonRecord({ ...baseInput(), failure_kind: kind }, { clock });
      expect(() => validateLessonRecord(lesson)).not.toThrow();
    }
  });

  it("rejects an empty role or root_cause", () => {
    expect(() => createLessonRecord({ ...baseInput(), role: "" }, { clock })).toThrow(
      LessonSchemaValidationError,
    );
    expect(() => createLessonRecord({ ...baseInput(), root_cause: "  " }, { clock })).toThrow(
      LessonSchemaValidationError,
    );
  });
});

describe("categorizeFailure", () => {
  it("categorizes review returns as review_changes", () => {
    expect(categorizeFailure("review_changes")).toBe("review_changes");
    expect(categorizeFailure("review_return")).toBe("review_changes");
    expect(categorizeFailure("request_changes")).toBe("review_changes");
    expect(categorizeFailure("changes_requested")).toBe("review_changes");
    expect(categorizeFailure({ status: "in_progress", verdict: "changes_requested" })).toBe(
      "review_changes",
    );
    expect(categorizeFailure({ reason: "returned from acceptance: review remarks" })).toBe(
      "review_changes",
    );
  });

  it("categorizes run errors as error", () => {
    expect(categorizeFailure("error")).toBe("error");
    expect(categorizeFailure("run_error")).toBe("error");
    expect(categorizeFailure("failed")).toBe("error");
    expect(categorizeFailure(new Error("boom"))).toBe("error");
    expect(categorizeFailure({ error: new Error("CI red") })).toBe("error");
    expect(categorizeFailure({ event: "heartbeat_error" })).toBe("error");
  });

  it("categorizes blocked transitions as blocked", () => {
    expect(categorizeFailure("blocked")).toBe("blocked");
    expect(categorizeFailure("issue_blocked")).toBe("blocked");
    expect(categorizeFailure({ status: "blocked" })).toBe("blocked");
    expect(categorizeFailure({ event: "blocked_transition" })).toBe("blocked");
  });

  it("returns null for unknown input (strict variant throws)", () => {
    expect(categorizeFailureOrNull("all good, nothing happened")).toBeNull();
    expect(categorizeFailureOrNull({ status: "done" })).toBeNull();
    expect(() => categorizeFailure("all good, nothing happened")).toThrow(
      /cannot categorize failure/,
    );
  });
});

describe("computeExpiresAt", () => {
  it("adds the default 30 days", () => {
    expect(computeExpiresAt(NOW)).toBe("2026-12-07T12:00:00.000Z");
  });
  it("adds a custom number of days", () => {
    expect(computeExpiresAt(NOW, 90)).toBe("2027-02-05T12:00:00.000Z");
  });
});

describe("schema validation before sending to hindsight", () => {
  it("accepts a well-formed retain payload", () => {
    const lesson = createLessonRecord(baseInput(), { clock });
    const payload = formatHindsightRetainPayload(lesson);
    expect(() => validateHindsightRetainPayload(payload)).not.toThrow();
    expect(payload.bankId).toBe(
      "role-2870b911-483a-4091-9f15-183841811143-eng",
    );
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0].context).toBe("paperclip");
    expect(payload.items[0].metadata.kind).toBe("lesson");
    expect(payload.items[0].metadata.failure_kind).toBe("review_changes");
    expect(payload.items[0].metadata.event).toBe("review_changes");
    expect(payload.items[0].metadata.expires_at).toBe(lesson.expiresAt);
  });

  it("rejects a payload with empty content", () => {
    const lesson = createLessonRecord(baseInput(), { clock });
    const payload = formatHindsightRetainPayload(lesson);
    payload.items[0].content = "";
    const result = safeValidateHindsightRetainPayload(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(LessonSchemaValidationError);
      expect(result.error.message).toMatch(/hindsight retain payload/);
    }
  });

  it("rejects a payload with an unknown failure_kind", () => {
    const lesson = createLessonRecord(baseInput(), { clock });
    const payload = formatHindsightRetainPayload(lesson);
    (payload.items[0].metadata as Record<string, unknown>).failure_kind = "meh";
    expect(() => validateHindsightRetainPayload(payload)).toThrow(LessonSchemaValidationError);
  });

  it("rejects a payload with the wrong metadata kind", () => {
    const lesson = createLessonRecord(baseInput(), { clock });
    const payload = formatHindsightRetainPayload(lesson);
    (payload.items[0].metadata as Record<string, unknown>).kind = "note";
    expect(() => validateHindsightRetainPayload(payload)).toThrow(LessonSchemaValidationError);
  });

  it("rejects a payload without a bank id", () => {
    const lesson = createLessonRecord(baseInput(), { clock });
    const payload = formatHindsightRetainPayload(lesson);
    delete (payload as { bankId?: string }).bankId;
    expect(() => validateHindsightRetainPayload(payload)).toThrow(LessonSchemaValidationError);
  });

  it("rejects a payload with an empty items array", () => {
    const lesson = createLessonRecord(baseInput(), { clock });
    const payload = formatHindsightRetainPayload(lesson);
    payload.items = [];
    expect(() => validateHindsightRetainPayload(payload)).toThrow(LessonSchemaValidationError);
  });

  it("rejects a lesson record missing its expiry fields", () => {
    const lesson = createLessonRecord(baseInput(), { clock }) as Record<string, unknown>;
    delete lesson.expiresAt;
    expect(() => validateLessonRecord(lesson)).toThrow(LessonSchemaValidationError);
  });

  it("rejects invalid create input", () => {
    expect(() => validateLessonRecordInput({ role: "eng" })).toThrow(LessonSchemaValidationError);
    expect(() =>
      validateLessonRecordInput({ ...baseInput(), failure_kind: "reverted" }),
    ).toThrow(LessonSchemaValidationError);
  });
});

describe("lesson formatter", () => {
  it("formats the role bank id", () => {
    expect(formatRoleBankId("c1", "Eng")).toBe("role-c1-eng");
    expect(() => formatRoleBankId("", "eng")).toThrow(/companyId/);
    expect(() => formatRoleBankId("c1", "  ")).toThrow(/role/);
  });

  it("formats the issue document id", () => {
    expect(formatDocumentId("i-123")).toBe("issue:i-123");
    expect(formatDocumentId(null)).toBeUndefined();
    expect(formatDocumentId("  ")).toBeUndefined();
  });

  it("formats the lesson tags", () => {
    expect(formatLessonTags({ failure_kind: "blocked", role: "CMO" })).toEqual([
      "lesson",
      "post-task-reflect",
      "event:blocked",
      "role:cmo",
    ]);
  });

  it("formats the deterministic dedup key", () => {
    expect(formatDedupKey("i-1", "review_changes", 42)).toBe("i-1:review_changes:42");
  });

  it("formats the template lesson text per failure kind", () => {
    const review = formatLessonText({ role: "eng", failure_kind: "review_changes", root_cause: "X" });
    expect(review).toContain("review feedback");
    const error = formatLessonText({ role: "eng", failure_kind: "error", root_cause: "Y" });
    expect(error).toContain("failure logs");
    const blocked = formatLessonText({ role: "eng", failure_kind: "blocked", root_cause: "Z" });
    expect(blocked).toContain("blocked");
  });

  it("caps the lesson text at ~500 characters", () => {
    const text = formatLessonText({
      role: "eng",
      failure_kind: "error",
      root_cause: "x".repeat(800),
    });
    expect(text.length).toBeLessThanOrEqual(500);
  });

  it("refuses a payload without any companyId", () => {
    const lesson: LessonRecord = createLessonRecord(baseInput(), { clock });
    delete (lesson as { companyId?: string | null }).companyId;
    expect(() => formatHindsightRetainPayload(lesson)).toThrow(/companyId/);
  });
});

describe("reflection service", () => {
  it("creates and submits a lesson through the injected client", async () => {
    const retained: Array<{ bankId: string; content: string; documentId?: string }> = [];
    const service = createReflectionService({
      clock,
      hindsightClient: {
        async retain(bankId, content, documentId) {
          retained.push({ bankId, content, documentId });
        },
      },
    });
    const lesson = service.createLesson({
      ...baseInput(),
      failure_kind: "blocked",
      root_cause: "waiting on CI access",
      dedupKey: formatDedupKey("afef5cb1-9620-4bb3-a63f-e1e2ffc244df", "blocked", 3),
    });
    expect(lesson.failure_kind).toBe("blocked");
    const result = await service.submitLesson(lesson);
    expect(result.success).toBe(true);
    expect(result.bankId).toBe("role-2870b911-483a-4091-9f15-183841811143-eng");
    expect(retained).toHaveLength(1);
    expect(retained[0].documentId).toBe("issue:afef5cb1-9620-4bb3-a63f-e1e2ffc244df");
  });

  it("does not send and reports failure when the payload is invalid", async () => {
    const retained: unknown[] = [];
    const service = createReflectionService({
      clock,
      hindsightClient: {
        async retain(bankId, content) {
          retained.push({ bankId, content });
        },
      },
    });
    const lesson = service.createLesson(baseInput(), { clock });
    // Corrupt the record after creation: the validation gate must catch it.
    (lesson as { lesson_text: string }).lesson_text = "";
    const result = await service.submitLesson(lesson);
    expect(result.success).toBe(false);
    expect(result.reason).toMatch(/invalid|lesson_text|content/i);
    expect(retained).toHaveLength(0);
  });

  it("swallows transport errors without throwing", async () => {
    const service = createReflectionService({
      clock,
      hindsightClient: {
        async retain() {
          throw new Error("hindsight is down");
        },
      },
    });
    const lesson = service.createLesson(baseInput(), { clock });
    const result = await service.submitLesson(lesson);
    expect(result.success).toBe(false);
    expect(result.reason).toContain("hindsight is down");
  });

  it("reports failure when no client is configured", async () => {
    const service = createReflectionService({ clock });
    const lesson = service.createLesson(baseInput(), { clock });
    const result = await service.submitLesson(lesson);
    expect(result.success).toBe(false);
    expect(result.reason).toMatch(/no hindsight client/);
  });

  it("exposes categorization through the service", () => {
    const service = createReflectionService({ clock });
    expect(service.categorize("request_changes")).toBe("review_changes");
    expect(service.categorize("run_error")).toBe("error");
    expect(service.categorize("blocked")).toBe("blocked");
  });
});
