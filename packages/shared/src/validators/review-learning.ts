import { z } from "zod";

// myrmidon(1.8 LEARN, OPE-13160): strict persisted contract for an approved
// review-pattern digest. The learn-from-code-review pipeline distills repeated,
// sanitized reviewer findings into skill candidates (see
// server/src/myrmidon/review-history/patterns.ts, OPE-12939); once a human
// approves the promotion, only a compact digest of that approved pattern may
// be persisted. The digest must carry provenance and a bounded source window
// so later readers can verify where the lesson came from, and it must never
// smuggle raw review prose, private bodies, or unsanitized (still-redacted)
// text into storage. The redaction marker and the 30-day cap mirror the
// extraction boundary (server/src/myrmidon/review-history/query.ts,
// OPE-12928) so a persisted digest cannot outlive the privacy invariants the
// pipeline was built around.

/**
 * The redaction marker shared with the extraction and grouping stages
 * (`REDACTION_MARKER` in server/src/myrmidon/review-history). A digest whose
 * text still contains it was not fully sanitized upstream and must be
 * rejected before it can be persisted.
 */
export const REVIEW_PATTERN_REDACTION_MARKER = "[REDACTED]";

/**
 * Maximum source window the persisted digest may claim, in milliseconds:
 * 30 days, matching `REVIEW_HISTORY_WINDOW_MS` at the extraction boundary.
 * A pattern distilled from a window wider than this would let stale review
 * history leak into a "recent lessons" digest.
 */
export const REVIEW_PATTERN_DIGEST_MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** One provenance entry: a deterministic source reference to a contributing finding. */
export const reviewPatternDigestSourceSchema = z
  .object({
    /**
     * Deterministic reference of the form
     * `issue:<id>:pr:<repo>#<n>:comment:<id>`. Carries coordinates only —
     * no author, no run id, no prose.
     */
    sourceRef: z.string().trim().min(1).max(500),
    /** The issue the finding came from. */
    issue: z.object({
      id: z.string().guid(),
      identifier: z.string().trim().min(1).max(64),
    }).strict(),
    /** The PR the finding came from. */
    pullRequest: z.object({
      repository: z.string().trim().min(1).max(500),
      number: z.number().int().positive(),
    }).strict(),
    /** When the finding was made, ISO-8601. */
    timestamp: z.string().datetime(),
  })
  .strict();

export type ReviewPatternDigestSource = z.infer<
  typeof reviewPatternDigestSourceSchema
>;

/**
 * The persisted, approved review-pattern digest. Strict input contract:
 * any extra field (e.g. a raw `body`/`feedback` column copied from a review
 * comment row) is rejected, so storage cannot silently accumulate review
 * prose. Only `approved` patterns are admissible — a `pending` or
 * `rejected` pattern has no business being persisted as a learned lesson.
 */
export const reviewPatternDigestSchema = z
  .object({
    /** Stable schema discriminator for persisted rows. */
    schema: z.literal("paperclip.review_pattern_digest.v1"),
    /** Deterministic id of the digest row. */
    id: z.string().guid(),
    companyId: z.string().guid(),
    /** Slug of the approved skill this digest backs (promotion target). */
    skillSlug: z.string().trim().min(1).max(200),
    /** The distilled lesson text. Must be sanitized: no redaction marker. */
    lesson: z.string().trim().min(1).max(4_000),
    /** Approval state. Only `approved` patterns may be persisted. */
    approvalState: z.literal("approved"),
    /**
     * Provenance of the contributing findings. Must be non-empty — a
     * digest without provenance cannot be audited back to real reviews.
     */
    sources: z
      .array(reviewPatternDigestSourceSchema)
      .min(1)
      .max(200),
    /** How many findings contributed to the pattern. */
    occurrenceCount: z.number().int().positive(),
    /** Start of the source window (ISO-8601). */
    windowStart: z.string().datetime(),
    /** End of the source window (ISO-8601). */
    windowEnd: z.string().datetime(),
    /** When the digest row was persisted, ISO-8601. */
    createdAt: z.string().datetime(),
  })
  .strict()
  .superRefine((digest, ctx) => {
    const start = Date.parse(digest.windowStart);
    const end = Date.parse(digest.windowEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return;
    if (end < start) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "windowEnd must not be before windowStart",
        path: ["windowEnd"],
      });
      return;
    }
    // The source window may not exceed the 30-day extraction cap. A wider
    // window would silently widen the privacy boundary the pipeline was
    // built around.
    if (end - start > REVIEW_PATTERN_DIGEST_MAX_WINDOW_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "source window exceeds the 30-day extraction cap (REVIEW_PATTERN_DIGEST_MAX_WINDOW_MS)",
        path: ["windowEnd"],
      });
    }
    // Redaction invariant: a lesson that still carries the marker was not
    // fully sanitized upstream and must never reach storage.
    if (digest.lesson.includes(REVIEW_PATTERN_REDACTION_MARKER)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "lesson still contains the redaction marker; sanitize upstream before persisting",
        path: ["lesson"],
      });
    }
    if (digest.occurrenceCount < digest.sources.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "occurrenceCount must be at least the number of recorded sources",
        path: ["occurrenceCount"],
      });
    }
  });

export type ReviewPatternDigest = z.infer<typeof reviewPatternDigestSchema>;
