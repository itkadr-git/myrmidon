// server/src/myrmidon/hindsight/reflection/schema.ts
//
// myrmidon(1.7 POST-TASK-REFLECT): zod schemas for lesson records and the
// hindsight retain payload. Every lesson and every retain payload is validated
// before it leaves this module (acceptance criterion: schema validation before
// sending to hindsight). Design: docs/myrmidon/design/post-task-reflect.md §3.

import { z } from "zod";

import { DEFAULT_LESSON_TTL_DAYS, FAILURE_KINDS } from "./types.js";

export const failureKindSchema = z.enum(FAILURE_KINDS);

export const createLessonRecordInputSchema = z.object({
  id: z.string().min(1).optional(),
  role: z.string().min(1),
  failure_kind: failureKindSchema,
  root_cause: z.string().min(1),
  lesson_text: z.string().min(1).optional(),
  expires_at_days: z.number().int().min(1).max(365).optional(),
  createdAt: z.string().min(1).optional(),
  companyId: z.string().min(1).nullish(),
  issueId: z.string().min(1).nullish(),
  issueKey: z.string().min(1).nullish(),
  runId: z.string().min(1).nullish(),
  dedupKey: z.string().min(1).nullish(),
});

export const lessonRecordSchema = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  failure_kind: failureKindSchema,
  root_cause: z.string().min(1),
  lesson_text: z.string().min(1),
  expires_at_days: z.number().int().min(1).max(365),
  createdAt: z.string().min(1),
  expiresAt: z.string().min(1),
  companyId: z.string().min(1).nullish(),
  issueId: z.string().min(1).nullish(),
  issueKey: z.string().min(1).nullish(),
  runId: z.string().min(1).nullish(),
  dedupKey: z.string().min(1).nullish(),
});

export const hindsightRetainMetadataSchema = z
  .object({
    kind: z.literal("lesson"),
    failure_kind: failureKindSchema,
    role: z.string().min(1),
    root_cause: z.string().min(1),
    expires_at: z.string().min(1),
    issue_key: z.string().nullish(),
    dedup_key: z.string().nullish(),
    run_id: z.string().nullish(),
  })
  .passthrough();

export const hindsightRetainItemSchema = z.object({
  content: z.string().min(1),
  context: z.string().min(1),
  document_id: z.string().min(1).optional(),
  metadata: hindsightRetainMetadataSchema,
  tags: z.array(z.string().min(1)).default([]),
});

export const hindsightRetainPayloadSchema = z.object({
  bankId: z.string().min(1),
  items: z.array(hindsightRetainItemSchema).min(1),
  async: z.boolean().optional(),
});

export type CreateLessonRecordInputParsed = z.infer<typeof createLessonRecordInputSchema>;
export type LessonRecordParsed = z.infer<typeof lessonRecordSchema>;
export type HindsightRetainItemParsed = z.infer<typeof hindsightRetainItemSchema>;
export type HindsightRetainPayloadParsed = z.infer<typeof hindsightRetainPayloadSchema>;

export class LessonSchemaValidationError extends Error {
  readonly issues: unknown;

  constructor(message: string, issues: unknown) {
    super(message);
    this.name = "LessonSchemaValidationError";
    this.issues = issues;
  }
}

function toValidationError(error: z.ZodError, what: string): LessonSchemaValidationError {
  const summary = error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  return new LessonSchemaValidationError(`invalid ${what}: ${summary}`, error.issues);
}

/** Parse input for `createLessonRecord`; throws `LessonSchemaValidationError`. */
export function validateLessonRecordInput(
  input: unknown,
): CreateLessonRecordInputParsed {
  const parsed = createLessonRecordInputSchema.safeParse(input);
  if (!parsed.success) throw toValidationError(parsed.error, "lesson record input");
  return parsed.data;
}

/** Parse a full `LessonRecord`; throws `LessonSchemaValidationError`. */
export function validateLessonRecord(record: unknown): LessonRecordParsed {
  const parsed = lessonRecordSchema.safeParse(record);
  if (!parsed.success) throw toValidationError(parsed.error, "lesson record");
  return parsed.data;
}

/**
 * Validate the hindsight retain payload BEFORE sending to the memory service
 * (the acceptance criterion). Throws `LessonSchemaValidationError` on any
 * shape that hindsight would have to reject downstream.
 */
export function validateHindsightRetainPayload(
  payload: unknown,
): HindsightRetainPayloadParsed {
  const parsed = hindsightRetainPayloadSchema.safeParse(payload);
  if (!parsed.success) throw toValidationError(parsed.error, "hindsight retain payload");
  return parsed.data;
}

/**
 * Non-throwing variant for callers that branch on validity (the reflection
 * hook must never crash the board's status transition).
 */
export function safeValidateHindsightRetainPayload(
  payload: unknown,
): { success: true; data: HindsightRetainPayloadParsed } | { success: false; error: LessonSchemaValidationError } {
  const parsed = hindsightRetainPayloadSchema.safeParse(payload);
  if (parsed.success) return { success: true, data: parsed.data };
  return { success: false, error: toValidationError(parsed.error, "hindsight retain payload") };
}
