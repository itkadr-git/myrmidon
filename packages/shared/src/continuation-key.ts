import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * myrmidon(1.6.6 P1.9 CLAIM-TRANSACTION): the shared continuation dedupe
 * contract. One deterministic key identifies one continuation event for one
 * issue at one thread head, so every producer (heartbeat retry path,
 * wake-queue issue_continuation_needed, run dispatch, recovery service) can
 * dedupe the same continuation through one registry (design OPE-8312 §D).
 */

/**
 * The wake/retry event identity that feeds the key. It names why the
 * continuation exists — for example "issue_continuation_needed" — and stays a
 * plain discriminant so keys stay stable across producer refactors.
 */
export const continuationKeyEventSchema = z
  .string()
  .trim()
  .min(1, "continuation event must not be empty");

/** Thread-head identity: a comment id, or another non-empty opaque marker. */
export const continuationKeyHeadSchema = z
  .string()
  .trim()
  .min(1, "continuation head must not be empty");

export const continuationKeyIssueIdSchema = z
  .string()
  .trim()
  .min(1, "issueId must not be empty");

export const continuationKeyInputSchema = z
  .object({
    issueId: continuationKeyIssueIdSchema,
    event: continuationKeyEventSchema,
    head: continuationKeyHeadSchema,
  })
  .strict();

export type ContinuationKeyInput = z.infer<typeof continuationKeyInputSchema>;

/**
 * Deterministic key for one continuation (issue, event, head).
 *
 * The key is `continuation:v1:<sha256-16hex>` over the canonical
 * `issueId\0event\0head` tuple. The NUL separator and the length-prefixed
 * fields make ambiguity impossible: no field value can imitate a different
 * split of the tuple. The key depends only on the input, never on call order
 * or time, so the same continuation always hashes to the same key.
 */
export function buildContinuationKey(input: ContinuationKeyInput): string {
  const { issueId, event, head } = continuationKeyInputSchema.parse(input);
  const digest = createHash("sha256")
    .update(`${issueId.length}:${event.length}:${head.length}:`)
    .update(`${issueId}\0${event}\0${head}`)
    .digest("hex")
    .slice(0, 32);
  return `continuation:v1:${digest}`;
}

/**
 * Result of claiming a continuation key through the registry: `created` when
 * this claim was the first one, `deduped` when the same continuation was
 * already claimed. The key travels with the outcome so callers and metrics
 * log one identity.
 */
export interface ContinuationDedupeOutcome {
  outcome: "created" | "deduped";
  key: string;
}

/**
 * Counters for continuation dedupe (OPE-9180 wires the concrete sink).
 * Implementations report created vs deduped claims so operators can see
 * duplicate continuations prevented per producer.
 */
export interface ContinuationDedupeMetrics {
  /** A new continuation was claimed. */
  onContinuationCreated(key: string): void;
  /** An already-claimed continuation was suppressed. */
  onContinuationDeduped(key: string): void;
}
