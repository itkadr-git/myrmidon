// server/src/myrmidon/tracing-health/service.ts
//
// myrmidon(TRACING-HEALTH): the "LLM tracing" health decision.
//
// Incident 02.10: Langfuse v4 rejects the legacy LiteLLM `langfuse` callback
// (~12k "Bad request" per hour, gateway CPU burned), while the OTEL callback
// quietly delivered ~40k events/day into ClickHouse `events_core` — and nobody
// noticed, because nothing checks tracing: in v4 the old `traces`/
// `observations` tables are empty by design, so a naive "any traces?" check
// reads "no traces" forever.
//
// This module answers ONE question with two live probes, per the operator's
// delivery ratio definition:
//
//   OK   ⇔  the gateway served traffic in the window (non-zero spend-log rows
//            or non-zero requests) AND `events_core` received events in the
//            window AND the gateway's callback error count in the window is
//            within tolerance (~0).
//   RED  ⇔  any of the three fails, or a probe is unreachable.
//
// The gateway-traffic leg is what makes "no events" meaningful: on a quiet
// instance with no requests, tracing is NOT red — it is `ok` with a note
// ("no gateway traffic in the window"), because there was nothing to trace.
//
// The red signal goes to the OPERATOR attention desk (`agent_error_alert`
// family is agent-scoped; this check is instance-scoped, so it adds its own
// dedicated kind) — never to the owner: the ticket's rule, same as the
// AUTO-RESUME escalation. Dedup is per state: one card while the failure
// persists, none while healthy.

import { desc, eq, and, gte, sql } from "drizzle-orm";
import { heartbeatRuns, litellmCostEvents, type Db } from "@paperclipai/db";
import { recordTracingHealthSignal } from "./attention-bridge.js";
import {
  CallbackFailureSeries,
  TracingProbeError,
  type GatewayProbeResult,
  type TracingProbeClient,
} from "./clients.js";
import { readTracingHealthSettings } from "./settings.js";

/** Status card shape: stable JSON contract for the UI (part D of the parent plan). */
export type TracingHealthStatus = "ok" | "red";

export interface TracingHealthCard {
  status: TracingHealthStatus;
  /** The three legs of the decision, in probe order. */
  checks: {
    /** Did the LLM gateway serve any traffic in the window? */
    gatewayTraffic: { ok: boolean; note: string };
    /** Did ClickHouse `events_core` receive events in the window? */
    eventsCore: { ok: boolean; note: string; count: number | null };
    /** Is the gateway's callback failure count within tolerance? */
    callbackErrors: { ok: boolean; note: string; failures: number | null };
  };
  /** Human-readable summary of the deciding failure, or of health. */
  summary: string;
  /** True when the check itself could not run (settings off or probe failed). */
  enabled: boolean;
  /** Configured window in milliseconds (rides the card for the UI). */
  windowMs: number;
  /** ISO timestamp of the evaluation. */
  checkedAt: string;
}

/** The operator attention item the attention feed adds when the card is red. */
export interface TracingAttentionSignal {
  dedupKey: string;
  status: TracingHealthStatus;
  summary: string;
  whyNow: string;
  detail: { kind: "generic"; summaryExcerpt: string };
  severity: "high" | "medium";
}

export const TRACING_ATTENTION_DEDUP_KEY = "tracing_health:llm-tracing";
export const TRACING_ATTENTION_ACTIVITY_ACTION = "myrmidon.tracing.health_signal";

export interface TracingHealthDeps {
  db: Db;
  env?: NodeJS.ProcessEnv;
  /** Reads a company secret value by name, or null. Injected for tests. */
  readSecretValue(companyId: string, secretName: string): Promise<string | null>;
  /** The two live probes. Injected for tests. */
  client: TracingProbeClient;
  now(): Date;
}

export function tracingHealthService(deps: TracingHealthDeps) {
  const settings = () => readTracingHealthSettings(deps.env ?? process.env);

  /**
   * The last successful card, kept in process memory per company: the probe
   * results are window-scoped, and the attention signal only needs the CURRENT
   * state (dedup is by state — a healthy result re-arms the card).
   */
  const lastCardByCompany = new Map<string, TracingHealthCard>();

  async function countGatewayRequests(companyId: string, sinceMs: number): Promise<number> {
    // 1. Spend rows the M2-A sweep collected — one row per gateway request.
    const rows = await deps.db
      .select({ count: sql<number>`count(*)::int` })
      .from(litellmCostEvents)
      .where(and(
        eq(litellmCostEvents.companyId, companyId),
        gte(litellmCostEvents.occurredAt, new Date(sinceMs)),
      ));
    const collected = Number(rows[0]?.count ?? 0);
    if (collected > 0) return collected;
    // 2. Fallback: heartbeat runs with a gateway request in the window —
    //    covers instances without the cost sweep but with live agents.
    const runRows = await deps.db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, companyId),
        gte(heartbeatRuns.startedAt, new Date(sinceMs)),
      ));
    return Number(runRows[0]?.count ?? 0);
  }

  async function evaluate(companyId: string): Promise<TracingHealthCard> {
    const current = settings();
    const now = deps.now();
    const checkedAt = now.toISOString();
    if (!current.enabled) {
      const card: TracingHealthCard = {
        status: "ok",
        checks: {
          gatewayTraffic: { ok: true, note: "not evaluated" },
          eventsCore: { ok: true, note: "not evaluated", count: null },
          callbackErrors: { ok: true, note: "not evaluated", failures: null },
        },
        summary:
          "LLM tracing health is not enabled: set MYRMIDON_TRACING_CLICKHOUSE_URL, MYRMIDON_TRACING_CLICKHOUSE_KEY_SECRET, MYRMIDON_TRACING_LITELLM_METRICS_URL and MYRMIDON_TRACING_LITELLM_KEY_SECRET.",
        enabled: false,
        windowMs: current.windowMs,
        checkedAt,
      };
      lastCardByCompany.set(companyId, card);
      recordTracingHealthSignal(companyId, card, now);
      return card;
    }

    const sinceMs = now.getTime() - current.windowMs;
    const failures: string[] = [];
    let eventsCount: number | null = null;
    let callbackFailures: number | null = null;
    let sawTraffic = false;
    let trafficNote = "no gateway requests in the window";
    let eventsNote = "";
    let callbackNote = "";

    // Leg 1: gateway traffic (the question is only meaningful with traffic).
    let gatewayRequests = 0;
    try {
      gatewayRequests = await countGatewayRequests(companyId, sinceMs);
    } catch (err) {
      trafficNote = "gateway traffic count read failed";
      failures.push(trafficNote);
    }
    if (gatewayRequests > 0) {
      sawTraffic = true;
      trafficNote = `${gatewayRequests} gateway request(s) in the window`;
    }

    // Leg 2: Langfuse v4 ClickHouse events_core.
    try {
      const keyValue = current.clickhouseKeySecret
        ? await deps.readSecretValue(companyId, current.clickhouseKeySecret)
        : null;
      const result = await deps.client.countEventsCoreSince(current, keyValue, sinceMs);
      eventsCount = result.count;
      eventsNote = sawTraffic
        ? result.count > 0
          ? `${result.count} event(s) in events_core over ${Math.round(current.windowMs / 60_000)} min`
          : `no events in events_core over ${Math.round(current.windowMs / 60_000)} min while the gateway served traffic`
        : `events_core has ${result.count} event(s), but the gateway served no traffic in the window`;
    } catch (err) {
      const probe = err instanceof TracingProbeError ? err.probe : "clickhouse";
      eventsNote = probe === "clickhouse"
        ? `Langfuse ClickHouse probe failed: ${err instanceof Error ? err.message : "unknown error"}`
        : `probe failed: ${err instanceof Error ? err.message : "unknown error"}`;
      failures.push(eventsNote);
    }

    // Leg 3: LiteLLM callback failures.
    let gateway: GatewayProbeResult | null = null;
    try {
      const keyValue = current.litellmKeySecret
        ? await deps.readSecretValue(companyId, current.litellmKeySecret)
        : null;
      gateway = await deps.client.readGatewayMetrics(current, keyValue);
      callbackFailures = sumCallbackFailures(gateway.callbackFailures);
      if (callbackFailures === 0) {
        callbackNote = "no callback logging failures";
      } else {
        callbackNote = `${callbackFailures} callback logging failure(s) in the window (tolerance ${current.maxCallbackFailures})`;
      }
    } catch (err) {
      callbackNote = `LiteLLM metrics probe failed: ${err instanceof Error ? err.message : "unknown error"}`;
      failures.push(callbackNote);
    }

    const eventsOk = sawTraffic ? eventsCount !== null && eventsCount > 0 : true;
    const callbacksOk = callbackFailures !== null && callbackFailures <= current.maxCallbackFailures;

    if (sawTraffic && eventsCount !== null && eventsCount === 0) failures.push(eventsNote);
    if (!sawTraffic && gatewayRequests === 0 && eventsCount !== null) {
      // Quiet instance: not red, and the events leg is explicitly "n/a".
      trafficNote = "no gateway traffic in the window — tracing has nothing to deliver";
    }
    if (callbackFailures !== null && callbackFailures > current.maxCallbackFailures) {
      failures.push(callbackNote);
    }

    const status: TracingHealthStatus = failures.length > 0 || !eventsOk || !callbacksOk ? "red" : "ok";
    const summary = failures.length > 0
      ? `LLM tracing is unhealthy: ${failures.join("; ")}`
      : sawTraffic
        ? `LLM tracing is healthy: ${trafficNote}; ${eventsNote}; ${callbackNote}`
        : `LLM tracing is idle: ${trafficNote}`;

    const card: TracingHealthCard = {
      status,
      checks: {
        gatewayTraffic: { ok: true, note: trafficNote },
        eventsCore: { ok: eventsOk, note: eventsNote, count: eventsCount },
        callbackErrors: { ok: callbacksOk, note: callbackNote, failures: callbackFailures },
      },
      summary,
      enabled: true,
      windowMs: current.windowMs,
      checkedAt,
    };
    lastCardByCompany.set(companyId, card);
    recordTracingHealthSignal(companyId, card, now);
    return card;
  }

  return { settings, evaluate, countGatewayRequests };
}

/** Sum of all callback failure series (Prometheus counters are cumulative). */
export function sumCallbackFailures(series: CallbackFailureSeries[]): number {
  let total = 0;
  for (const s of series) total += s.value;
  return total;
}

/** The first failing leg's note, for the attention whyNow. */
export function legFailureSummary(card: TracingHealthCard): string {
  if (!card.checks.eventsCore.ok) return card.checks.eventsCore.note;
  if (!card.checks.callbackErrors.ok) return card.checks.callbackErrors.note;
  return card.checks.gatewayTraffic.note;
}
