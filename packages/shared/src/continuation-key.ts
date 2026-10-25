import { z } from "zod";

/**
 * myrmidon(1.6.6 P1.9 CLAIM-TRANSACTION): the shared continuation dedupe
 * contract. One deterministic key identifies one continuation event for one
 * issue at one thread head, so every producer (heartbeat retry path,
 * wake-queue issue_continuation_needed, run dispatch, recovery service) can
 * dedupe the same continuation through one registry (design OPE-8312 §D).
 *
 * No Node-only imports here: the shared barrel is consumed by browser and
 * extension surfaces whose tsconfigs do not include node types.
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

/** 2^53 — the exact-integer ceiling of JavaScript numbers. */
const EXACT_LIMIT = 4503599627370496;

/**
 * Deterministic FNV-1a over UTF-16 code units, folded into the exact-integer
 * range so the digest needs no BigInt. Pure arithmetic on code points: the
 * same input gives the same digest in every runtime.
 */
function fnv1a53(value: string): number {
  const offsetBasis = 0xcbf29ce484222325 % EXACT_LIMIT;
  const prime = 0x100000001b3 % EXACT_LIMIT;
  let hash = offsetBasis;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = (hash * prime) % EXACT_LIMIT;
  }
  return hash;
}

/**
 * Deterministic key for one continuation (issue, event, head).
 *
 * The key is `continuation:v1:<hex>` over the canonical length-prefixed
 * `issueId\0event\0head` tuple. Length prefixes make ambiguity impossible:
 * no field value can imitate a different split of the tuple. The key depends
 * only on the input, never on call order or time, so the same continuation
 * always produces the same key.
 */
export function buildContinuationKey(input: ContinuationKeyInput): string {
  const { issueId, event, head } = continuationKeyInputSchema.parse(input);
  const canonical = `${issueId.length}:${event.length}:${head.length}:${issueId}\0${event}\0${head}`;
  const left = fnv1a53(canonical);
  const right = fnv1a53(`${canonical}#2`);
  const hex = `${left.toString(16).padStart(13, "0")}${right
    .toString(16)
    .padStart(13, "0")}`;
  return `continuation:v1:${hex}`;
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
