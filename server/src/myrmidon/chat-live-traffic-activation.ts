import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  chatEndpoints,
  chatMessageLinks,
  chatPublications,
  toolConnections,
} from "@paperclipai/db";
import { logActivity } from "../services/activity-log.js";

/**
 * Live traffic finishes a setup the wizard left behind (1.6.5 F-10, part A).
 *
 * A chat endpoint's status is derived from the setup wizard: `verifying` while
 * the wizard is in its `test` step, `active` once the step is `complete`. Only
 * the owner pressing "Finish setup" ever completed it, so an endpoint whose
 * owner sent the test message, got the agent's reply and never came back stayed
 * `verifying` forever — while real traffic was already flowing through it
 * (F-10: "TG endpoints forever in `verifying`").
 *
 * This module completes such an endpoint from the traffic itself. The two
 * halves of the wizard's own check have to be there:
 *
 * - an outbound turn was actually delivered (`chat_publications.state =
 *   'published'`), and
 * - an inbound turn was recorded for the endpoint (the caller is the inbound
 *   path, or a persisted inbound link / `Test conversation received` health
 *   message proves it).
 *
 * Requiring both is the premature-activation guard: an endpoint with only an
 * outbound delivery (or only an inbound turn) is left alone. The grace window
 * keeps the vendor wizard authoritative while it is fresh — the owner is still
 * looking at the test step and will press "Finish setup" themselves — and takes
 * over only once that step went stale, which is exactly the stuck case.
 *
 * The state change is one guarded UPDATE (status, stage and runtime generation
 * re-checked in the WHERE, like the manual completion), so a repeated call and
 * two concurrent publishers activate exactly once: the late writer sees no row
 * and writes no activity record.
 */

/** Activity action of an automatic completion. */
export const LIVE_TRAFFIC_ACTIVATED_ACTION = "chat_endpoint.auto_activated";
/** Endpoint health message of an automatic completion. */
export const LIVE_TRAFFIC_HEALTH_MESSAGE = "Verified by live traffic";
/** Health message the vendor inbound path writes while an endpoint waits for its test turn. */
export const TEST_CONVERSATION_RECEIVED_MESSAGE = "Test conversation received";
/** Health message the vendor writes once an endpoint is connected. */
export const CONNECTED_HEALTH_MESSAGE = "Connected";

/**
 * How long a fresh `test` step belongs to the wizard alone.
 *
 * The owner is expected to press "Finish setup" right after the test round
 * trip; a step this old means they walked away, and the endpoint must not stay
 * `verifying` only because nobody came back to the wizard. Kept short on
 * purpose: it only has to outlive a test conversation, not a work session.
 */
export const LIVE_TRAFFIC_GRACE_MS = 15 * 60 * 1000;

/** An endpoint idling in the test stage this long is stale (part A, second half). */
export const VERIFYING_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
/** A publication delivered within this window counts as live traffic. */
export const VERIFYING_STALE_TRAFFIC_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface LiveTrafficActivationInput {
  endpointId: string;
  /**
   * Set by the inbound ingest path itself: that path *is* the inbound half of
   * the round trip, so no further evidence is looked up.
   */
  inboundObserved?: boolean;
  /** Injectable clock for tests. */
  now?: Date;
}

export interface VerifyingStaleEndpoint {
  id: string;
  companyId: string;
  connectionId: string;
}

function readSetupState(setup: unknown): Record<string, unknown> {
  return setup !== null && typeof setup === "object" && !Array.isArray(setup)
    ? (setup as Record<string, unknown>)
    : {};
}

/** The wizard stage recorded in `setup`, or null when the document is unusable. */
export function setupStage(setup: unknown): string | null {
  const step = readSetupState(setup).step;
  return typeof step === "string" && step.length > 0 ? step : null;
}

/** The runtime generation the endpoint currently owns (vendor `runtimeGeneration`). */
export function setupGeneration(setup: unknown): number {
  const value = readSetupState(setup).runtimeGeneration;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Milliseconds since the wizard entered the `test` step, or null when the
 * endpoint records no usable start. A stage without a start is never old
 * enough: it cannot be shown to be stuck.
 */
export function testStageAgeMs(setup: unknown, now: Date): number | null {
  const started = readSetupState(setup).testStartedAt;
  if (typeof started !== "string" || started.length === 0) return null;
  const startedAt = Date.parse(started);
  if (Number.isNaN(startedAt)) return null;
  return now.getTime() - startedAt;
}

async function hasDeliveredPublication(db: Db, endpointId: string): Promise<boolean> {
  const [delivered] = await db
    .select({ id: chatPublications.id })
    .from(chatPublications)
    .where(
      and(
        eq(chatPublications.endpointId, endpointId),
        eq(chatPublications.state, "published"),
      ),
    )
    .limit(1);
  return Boolean(delivered);
}

async function hasInboundEvidence(
  db: Db,
  endpointId: string,
  healthMessage: string | null,
): Promise<boolean> {
  if (healthMessage === TEST_CONVERSATION_RECEIVED_MESSAGE) return true;
  const [inbound] = await db
    .select({ id: chatMessageLinks.id })
    .from(chatMessageLinks)
    .where(
      and(
        eq(chatMessageLinks.endpointId, endpointId),
        eq(chatMessageLinks.direction, "inbound"),
      ),
    )
    .limit(1);
  return Boolean(inbound);
}

/**
 * Complete a `verifying` endpoint that real traffic already proves works.
 *
 * Returns true only for the call that changed the row. Nothing is written for
 * an endpoint that is not in the wizard's `test` stage, whose stage is still
 * fresh, that has no delivered outbound turn, that has no inbound turn, or that
 * was already completed (including by a concurrent caller).
 */
export async function activateChatEndpointFromLiveTraffic(
  db: Db,
  input: LiveTrafficActivationInput,
): Promise<boolean> {
  const now = input.now ?? new Date();
  const endpoint = await db
    .select({
      id: chatEndpoints.id,
      companyId: chatEndpoints.companyId,
      connectionId: chatEndpoints.connectionId,
      status: chatEndpoints.status,
      setup: chatEndpoints.setup,
      healthMessage: chatEndpoints.healthMessage,
      activatedAt: chatEndpoints.activatedAt,
    })
    .from(chatEndpoints)
    .where(eq(chatEndpoints.id, input.endpointId))
    .then((rows) => rows[0] ?? null);
  if (!endpoint) return false;
  if (endpoint.status !== "verifying") return false;
  const stage = setupStage(endpoint.setup);
  if (stage !== "test") return false;
  const age = testStageAgeMs(endpoint.setup, now);
  if (age === null || age < LIVE_TRAFFIC_GRACE_MS) return false;
  if (!(await hasDeliveredPublication(db, endpoint.id))) return false;
  if (
    !input.inboundObserved &&
    !(await hasInboundEvidence(db, endpoint.id, endpoint.healthMessage))
  ) {
    return false;
  }

  const state = readSetupState(endpoint.setup);
  const generation = setupGeneration(endpoint.setup);
  // The manual completion's single-flight guard: a test step restarted between
  // this read and the update must not be completed by this call.
  const expectedTestStartedAt =
    typeof state.testStartedAt === "string" ? state.testStartedAt : null;
  // Written as a jsonb merge: the stage becomes `complete` and the test window
  // is cleared while every other setup key the wizard wrote is kept.
  const completedStage = sql`coalesce(${chatEndpoints.setup}, '{}'::jsonb) || ${JSON.stringify({ step: "complete", testStartedAt: null })}::jsonb`;
  const activated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(chatEndpoints)
      .set({
        status: "active",
        setup: completedStage,
        healthMessage: LIVE_TRAFFIC_HEALTH_MESSAGE,
        activatedAt: endpoint.activatedAt ?? now,
        updatedAt: now,
      })
      .where(
        and(
          eq(chatEndpoints.id, endpoint.id),
          eq(chatEndpoints.status, "verifying"),
          sql`${chatEndpoints.setup}->>'step' = 'test'`,
          sql`coalesce((${chatEndpoints.setup}->>'runtimeGeneration')::integer, 0) = ${generation}`,
          expectedTestStartedAt
            ? sql`${chatEndpoints.setup}->>'testStartedAt' = ${expectedTestStartedAt}`
            : undefined,
        ),
      )
      .returning({ id: chatEndpoints.id });
    if (!row) return false;
    // The connection is healthy exactly when the traffic that activated it is
    // (same fields the manual completion writes).
    await tx
      .update(toolConnections)
      .set({
        status: "active",
        enabled: true,
        healthStatus: "healthy",
        healthMessage: CONNECTED_HEALTH_MESSAGE,
        lastError: null,
        healthCheckedAt: now,
        updatedAt: now,
      })
      .where(eq(toolConnections.id, endpoint.connectionId));
    return true;
  });
  if (!activated) return false;

  await logActivity(db, {
    companyId: endpoint.companyId,
    actorType: "system",
    actorId: "chat_live_traffic",
    action: LIVE_TRAFFIC_ACTIVATED_ACTION,
    entityType: "tool_connection",
    entityId: endpoint.connectionId,
    details: { endpointId: endpoint.id, trigger: "live_traffic" },
  });
  return true;
}

/**
 * Endpoints stuck in `verifying` while traffic flows (part A, second half).
 *
 * An attention signal for the board and the UI, not an error and not a status
 * change: the endpoint has been in the wizard's `test` stage for more than
 * {@link VERIFYING_STALE_AFTER_MS} *and* delivered a publication within the
 * last {@link VERIFYING_STALE_TRAFFIC_WINDOW_MS} — a live endpoint whose owner
 * never finished the wizard and that the automatic completion did not pick up.
 *
 * "In the stage for N hours" is measured from the stage start the wizard
 * records (`setup.testStartedAt`), falling back to the row's `updated_at` when
 * no start was recorded: both the inbound path and the publication commit also
 * refresh `updated_at`, so it alone cannot express "the stage did not move".
 */
export async function listVerifyingStaleEndpoints(
  db: Db,
  companyId: string,
  endpointIds?: string[],
  now: Date = new Date(),
): Promise<VerifyingStaleEndpoint[]> {
  if (endpointIds && endpointIds.length === 0) return [];
  // Sent as text with an explicit cast: drizzle's raw timestamptz parameters
  // need the string form, and both sides of each comparison are timestamptz.
  const staleBefore = new Date(
    now.getTime() - VERIFYING_STALE_AFTER_MS,
  ).toISOString();
  const trafficAfter = new Date(
    now.getTime() - VERIFYING_STALE_TRAFFIC_WINDOW_MS,
  ).toISOString();
  return db
    .select({
      id: chatEndpoints.id,
      companyId: chatEndpoints.companyId,
      connectionId: chatEndpoints.connectionId,
    })
    .from(chatEndpoints)
    .where(
      and(
        eq(chatEndpoints.companyId, companyId),
        eq(chatEndpoints.status, "verifying"),
        endpointIds ? inArray(chatEndpoints.id, endpointIds) : undefined,
        sql`coalesce(nullif(${chatEndpoints.setup}->>'testStartedAt', '')::timestamptz, ${chatEndpoints.updatedAt}) < ${staleBefore}::timestamptz`,
        sql`exists (select 1 from chat_publications where chat_publications.endpoint_id = ${chatEndpoints.id} and chat_publications.state = 'published' and chat_publications.published_at >= ${trafficAfter}::timestamptz)`,
      ),
    );
}