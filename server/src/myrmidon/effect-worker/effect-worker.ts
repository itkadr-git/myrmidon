import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { agentWakeupRequests } from "@myrmidon/db";
import type { Db } from "@myrmidon/db";
import { logger } from "../../middleware/logger.js";
import { appendHeartbeatRunEvent } from "../../services/heartbeat-run-events.js";

/**
 * Effect-worker layer (OPE-12798, plan doc 03c4feec-c41b-41d0-ba9e-e9675193aae3).
 *
 * A separate execution layer for post-commit side effects: an effect is
 * registered inside the commit transaction on the existing transactional
 * outbox (`agent_wakeup_requests`), and a worker executes it post-commit.
 * The execution result is recorded back as a command/event — either appended
 * to the related run's event log (when a run exists), or persisted on the
 * intent row itself as a `payload.effect` milestone — so the flow is
 * observable without polling timers.
 *
 * The worker is deliberately minimal: claim → execute → record → settle.
 * It owns no retry policy beyond "leave the intent queued and let the caller
 * re-drain". This keeps the layer a thin executor, not a second scheduler.
 *
 * Existing outbox producers keep their own actor id and idempotency key
 * (e.g. `interaction-continuation-outbox:{interactionId}:{status}`); the
 * effect kind is declared in the intent payload (`payload.effectKind`) or
 * inferred from the key prefix. Behaviour and idempotency of the migrated
 * outbox are unchanged.
 *
 * Test discipline (t3code AGENTS.md G): tests of this layer drain the worker
 * explicitly and wait for concrete persisted milestones — never `sleep`.
 * Helpers live in `test-helpers.ts` and are gated by INV-15.
 */

export const EFFECT_WORKER_ACTOR_TYPE = "system" as const;
/** Actor id of intents natively owned by the effect-worker layer. */
export const EFFECT_WORKER_ACTOR_ID = "effect-worker";
export const EFFECT_WORKER_KEY_PREFIX = "effect-worker:";

export interface EffectIntent {
  id: string;
  companyId: string;
  agentId: string;
  idempotencyKey: string;
  status: string;
  payload: Record<string, unknown> | null;
  requestedAt: Date;
  claimedAt: Date | null;
  runId: string | null;
}

export interface EffectContext {
  db: Db;
  intent: EffectIntent;
  /** Persist a milestone (partial payload merge) on the intent row. */
  recordMilestone: (milestone: Record<string, unknown>) => Promise<void>;
  /** Append the execution result as a run-event on the given run. */
  appendRunEvent: (
    runId: string,
    input: {
      eventType: string;
      message?: string;
      payload?: Record<string, unknown>;
      level?: string;
      stream?: string;
    },
  ) => Promise<void>;
}

export type EffectHandler = (ctx: EffectContext) => Promise<{
  /** Terminal status written back to the intent row. */
  outcome: "settled" | "released" | "skipped";
  /** Related run to receive the result-as-command run-event. */
  runId?: string | null;
  /** Extra fields merged into the result event / milestone. */
  result?: Record<string, unknown>;
  error?: string | null;
}>;

export interface EffectWorker {
  registerEffect(kind: string, handler: EffectHandler): void;
  /** Claims and executes due effects of the given kinds. Returns counts. */
  drain(input?: {
    kinds?: string[];
    limit?: number;
    staleClaimMs?: number;
    /** Test seam: actor ids whose intents are claimable. Defaults to any
     * actor id — candidate selection is by declared effect kind, so a
     * migrated outbox keeps its own actor id and stays routable. */
    actorIds?: string[];
  }): Promise<{ scanned: number; settled: number; released: number; skipped: number; failed: number }>;
  /** Read a single intent by idempotency key. */
  readIntent(idempotencyKey: string): Promise<EffectIntent | null>;
}

const DEFAULT_STALE_CLAIM_MS = 60_000;

function kindFromIntent(intent: {
  idempotencyKey: string;
  payload: Record<string, unknown> | null;
}): string | null {
  const payloadKind = intent.payload?.effectKind;
  if (typeof payloadKind === "string" && payloadKind.length > 0) return payloadKind;
  if (intent.idempotencyKey.startsWith(EFFECT_WORKER_KEY_PREFIX)) {
    return intent.idempotencyKey.slice(EFFECT_WORKER_KEY_PREFIX.length).split(":")[0] ?? null;
  }
  // Migrated outboxes keep their own key prefix; map known prefixes to kinds.
  if (intent.idempotencyKey.startsWith("interaction-continuation-outbox:")) {
    return "interaction-continuation-deliver";
  }
  return null;
}

export function createEffectWorker(db: Db): EffectWorker {
  const handlers = new Map<string, EffectHandler>();

  async function readIntent(idempotencyKey: string): Promise<EffectIntent | null> {
    const rows = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, idempotencyKey))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      companyId: row.companyId,
      agentId: row.agentId,
      idempotencyKey: row.idempotencyKey ?? "",
      status: row.status,
      payload: (row.payload as Record<string, unknown> | null) ?? null,
      requestedAt: row.requestedAt,
      claimedAt: row.claimedAt,
      runId: row.runId,
    };
  }

  async function recordMilestone(intentId: string, milestone: Record<string, unknown>) {
    const existing = await db
      .select({ payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, intentId))
      .limit(1);
    const row = existing[0];
    const merged = {
      ...((row?.payload as Record<string, unknown> | null) ?? {}),
      ...milestone,
    };
    await db
      .update(agentWakeupRequests)
      .set({ payload: merged, updatedAt: new Date() })
      .where(eq(agentWakeupRequests.id, intentId));
  }

  async function appendRunEventForEffect(
    intent: EffectIntent,
    runId: string,
    input: {
      eventType: string;
      message?: string;
      payload?: Record<string, unknown>;
      level?: string;
      stream?: string;
    },
  ) {
    await appendHeartbeatRunEvent(db, {
      companyId: intent.companyId,
      runId,
      agentId: intent.agentId,
      eventType: input.eventType,
      stream: input.stream ?? "system",
      level: input.level ?? "info",
      message: input.message ?? null,
      payload: {
        effectKind: intent.payload?.effectKind ?? null,
        effectIntentId: intent.id,
        effectIdempotencyKey: intent.idempotencyKey,
        ...(input.payload ?? {}),
      },
    });
  }

  async function drain(input: {
    kinds?: string[];
    limit?: number;
    staleClaimMs?: number;
    actorIds?: string[];
  } = {}) {
    const now = new Date();
    const staleClaimMs = Math.max(1_000, input.staleClaimMs ?? DEFAULT_STALE_CLAIM_MS);
    const kinds = input.kinds ?? [...handlers.keys()];
    // Candidate selection is by declared effect kind, not actor id: migrated
    // outbox producers keep their own actor id (continuation intents use
    // `interaction-continuation-outbox`), and the payload's `effectKind` is
    // the single source of truth for routability. Intents without a declared
    // kind fall back to the effect-worker key prefix / known prefixes.
    const actorFilter = input.actorIds
      ? inArray(agentWakeupRequests.requestedByActorId, input.actorIds)
      : undefined;
    const kindFilter = kinds.length
      ? or(
          // Primary: intents declaring their kind in the payload.
          ...kinds.map((k) => sql`${agentWakeupRequests.payload}->>'effectKind' = ${k}`),
          // Fallback: intents that encode the kind in the key prefix and have
          // no declared payload kind.
          ...kinds.map(
            (k) => sql`(${agentWakeupRequests.payload}->>'effectKind' is null
              and ${agentWakeupRequests.idempotencyKey} like ${"effect-worker:" + k + ":%"})`,
          ),
        )
      : undefined;
    const candidates = await db
      .select({
        id: agentWakeupRequests.id,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.requestedByActorType, EFFECT_WORKER_ACTOR_TYPE),
          actorFilter,
          kindFilter,
          inArray(agentWakeupRequests.status, ["queued", "claimed"]),
          isNull(agentWakeupRequests.runId),
          or(
            isNull(agentWakeupRequests.claimedAt),
            lt(agentWakeupRequests.claimedAt, new Date(now.getTime() - staleClaimMs)),
          ),
        ),
      )
      .orderBy(asc(agentWakeupRequests.requestedAt))
      .limit(Math.max(1, Math.min(input.limit ?? 100, 500)));

    let settled = 0;
    let released = 0;
    let skipped = 0;
    let failed = 0;

    for (const candidate of candidates) {
      // Read the intent to determine its effect kind. The kind either lives
      // in the payload (migrated outboxes keep their actor id and key) or is
      // derived from the effect-worker key prefix.
      const intentPeek = await readIntent(candidate.idempotencyKey ?? "");
      if (!intentPeek) continue;
      const kind = kindFromIntent(intentPeek);
      if (!kind) continue;
      if (kinds.length > 0 && !kinds.includes(kind)) continue;
      const handler = handlers.get(kind);
      if (!handler) {
        logger.warn({ kind, intentId: candidate.id }, "effect worker: no handler registered for kind");
        continue;
      }

      // Claim the intent (lease, not status transition).
      const claimedRows = await db
        .update(agentWakeupRequests)
        .set({ claimedAt: now, updatedAt: now, error: null })
        .where(
          and(
            eq(agentWakeupRequests.id, candidate.id),
            inArray(agentWakeupRequests.status, ["queued", "claimed"]),
            or(
              isNull(agentWakeupRequests.claimedAt),
              lt(agentWakeupRequests.claimedAt, new Date(now.getTime() - staleClaimMs)),
            ),
          ),
        )
        .returning();
      const claimedRow = claimedRows[0];
      if (!claimedRow) continue;

      const intent: EffectIntent = {
        id: claimedRow.id,
        companyId: claimedRow.companyId,
        agentId: claimedRow.agentId,
        idempotencyKey: claimedRow.idempotencyKey ?? "",
        status: claimedRow.status,
        payload: (claimedRow.payload as Record<string, unknown> | null) ?? null,
        requestedAt: claimedRow.requestedAt,
        claimedAt: claimedRow.claimedAt,
        runId: claimedRow.runId,
      };

      const ctx: EffectContext = {
        db,
        intent,
        recordMilestone: (milestone) => recordMilestone(intent.id, milestone),
        appendRunEvent: (runId, eventInput) => appendRunEventForEffect(intent, runId, eventInput),
      };

      try {
        const result = await handler(ctx);
        const terminalStatus =
          result.outcome === "settled"
            ? "coalesced"
            : result.outcome === "skipped"
              ? "skipped"
              : "queued";
        const milestone = {
          effect: {
            kind,
            outcome: result.outcome,
            result: result.result ?? null,
            finishedAt: new Date().toISOString(),
          },
        };
        await recordMilestone(intent.id, milestone);
        const runId = result.runId ?? intent.runId ?? null;
        if (runId) {
          try {
            await appendRunEventForEffect(intent, runId, {
              eventType: "effect_result",
              message: `effect ${kind}: ${result.outcome}`,
              payload: {
                outcome: result.outcome,
                ...(result.result ?? {}),
              },
              level: result.outcome === "settled" ? "info" : "warn",
            });
          } catch (eventError) {
            // The delivery itself already settled (the intent row and, where
            // present, the durable wake record it). A missing/incompatible
            // run row (e.g. a vendor-emulated run id without a heartbeat_runs
            // row, or a run rebound to another agent) must not revert a
            // settled effect — record the failure in the milestone instead.
            const runEventError = eventError instanceof Error ? eventError.message : String(eventError);
            logger.warn(
              { err: eventError, intentId: intent.id, kind, runId },
              "effect worker: failed to append result run-event; outcome stays settled",
            );
            await recordMilestone(intent.id, {
              effect: { ...milestone.effect, runEventError },
            });
          }
        }
        await db
          .update(agentWakeupRequests)
          .set({
            status: terminalStatus,
            runId,
            error: result.error ?? null,
            finishedAt: result.outcome === "released" ? null : new Date(),
            updatedAt: new Date(),
          })
          .where(eq(agentWakeupRequests.id, intent.id));
        if (result.outcome === "settled") settled += 1;
        else if (result.outcome === "skipped") skipped += 1;
        else released += 1;
      } catch (error) {
        failed += 1;
        logger.warn(
          { err: error, intentId: intent.id, kind },
          "effect worker: handler failed; intent stays queued",
        );
        // Release the claim so the next drain can retry immediately.
        await db
          .update(agentWakeupRequests)
          .set({ claimedAt: null, updatedAt: new Date() })
          .where(eq(agentWakeupRequests.id, intent.id));
      }
    }

    return { scanned: candidates.length, settled, released, skipped, failed };
  }

  return {
    registerEffect(kind, handler) {
      handlers.set(kind, handler);
    },
    drain,
    readIntent,
  };
}
