// server/src/myrmidon/agent-liveness/probe-sweep.ts
//
// myrmidon(1.8 AGENT-LIVENESS A1, OPE-13021): the process probe of every
// probeable agent, on a cadence.
//
// "The agent is alive" on the board has meant "the adapter spawned once" —
// a gateway process that died hours ago still reads `idle`/`active`. This
// sweep closes that gap for the adapters where the board owns an HTTP
// endpoint to probe: `hermes_gateway` (GET /api/health of the configured
// apiBaseUrl, the same endpoint `testEnvironment` probes) and `http` agents
// (GET the configured url with an empty probe — a 2xx/3xx/401-class answer
// means something is listening). Adapters the board cannot probe (the
// spawn-per-run locals) are skipped: their liveness stays what the last run
// says, and `lastProbeAt` stays null (deriveAgentProbeStatus reads "never
// probed").
//
// Every pass stamps, per probed agent:
//   - `lastProbeAt` = now, `lastProbeOutcome` = "ok"   (2xx/3xx answer)
//   - `lastProbeAt` = now, `lastProbeOutcome` = "unreachable" (timeout,
//     connection refused, 5xx, DNS failure)
// into `agent_runtime_state` (upsert; the row is created on first probe).
// The derived honest status is computed at read time by
// `deriveAgentProbeStatus` (@myrmidon/shared) — never stored.
//
// Wire-up: one pass per heartbeat-scheduler tick, gated by
// AGENT_LIVENESS_PROBE_SWEEP_INTERVAL_MS like the gateway sweeps. Transport
// rules match the hermes_gateway adapter's own testEnvironment: loopback and
// `myrmidon-bot-*` host names may use plain http, anything else remote needs
// https or the agent's own `dangerouslyAllowInsecureRemoteHttp` escape hatch
// — a probe must never loosen a security rule an invoke would enforce.
// 401/403 count as "ok": the process answered, auth is not liveness.
// Timestamps always advance (even on failure), so a flapping runtime shows
// in `lastProbeOutcome`, not in a frozen `lastProbeAt`.

import { and, inArray, isNotNull, ne } from "drizzle-orm";
import { agentRuntimeState, agents, type Db } from "@myrmidon/db";
import { logger } from "../../middleware/logger.js";

/** Cadence of the periodic probe pass (one per scheduler tick at most). */
export const AGENT_LIVENESS_PROBE_SWEEP_INTERVAL_MS = 30_000;

/** Per-request probe timeout: a hung runtime must not hold the tick. */
export const AGENT_LIVENESS_PROBE_TIMEOUT_MS = 5_000;

/** Agents probed per pass; the rest wait for the next tick. */
export const AGENT_LIVENESS_PROBE_SWEEP_BATCH = 50;

/** Adapters whose runtime the board can probe over HTTP. */
export const AGENT_LIVENESS_PROBEABLE_ADAPTERS = ["hermes_gateway", "http"] as const;

export interface AgentLivenessProbePort {
  /** One GET against the agent's runtime endpoint. Resolves with the HTTP
   * status, or rejects on timeout / connection / DNS failure. */
  probe: (input: { url: string; timeoutMs: number }) => Promise<{ status: number }>;
  now?: () => Date;
}

export interface AgentLivenessProbeSweepResult {
  /** Probeable agent rows inspected. */
  scanned: number;
  /** Agents probed (had a probeable URL). */
  probed: number;
  /** Probes that answered ok. */
  ok: number;
  /** Probes that failed (timeout, refused, 5xx). */
  unreachable: number;
}

/** Pure classification of one probe attempt. */
export function classifyAgentProbeOutcome(status: number | null): "ok" | "unreachable" {
  // Anything that answered below 500 counts as the process being alive,
  // including auth failures (401/403) and a probe hitting a POST-only route
  // (405): the runtime is up; the probe contract is not liveness's business.
  return status !== null && status < 500 ? "ok" : "unreachable";
}

interface ProbeCandidate {
  agentId: string;
  companyId: string;
  adapterType: string;
  adapterConfig: unknown;
}

/**
 * Resolve the HTTP endpoint an agent's adapter exposes, with the same URL
 * normalization and transport rules the adapter itself applies. `null` when
 * the agent has no probeable endpoint (or its transport config is not
 * allowed) — the sweep then skips the agent without stamping anything.
 */
export function resolveAgentProbeUrl(agent: ProbeCandidate): string | null {
  const config =
    agent.adapterConfig && typeof agent.adapterConfig === "object" && !Array.isArray(agent.adapterConfig)
      ? (agent.adapterConfig as Record<string, unknown>)
      : {};
  const raw =
    agent.adapterType === "hermes_gateway"
      ? firstNonEmptyString(config.apiBaseUrl, config.baseUrl, config.url)
      : firstNonEmptyString(config.url);
  if (!raw) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  // Hermes maps its dashboard root (http://host:9119, /chat) onto /api;
  // the health endpoint lives at /api/health in both shapes.
  const path = url.pathname.replace(/\/+$/, "");
  if (agent.adapterType === "hermes_gateway") {
    if (url.port === "9119" && (path === "" || path === "/chat")) {
      url.pathname = "/api";
    } else {
      url.pathname = path;
    }
  } else {
    url.pathname = path;
  }
  url.search = "";
  url.hash = "";

  if (url.protocol === "http:") {
    const hostname = url.hostname.toLowerCase();
    const loopback =
      hostname === "localhost" || hostname === "::1" || hostname === "0:0:0:0:0:0:0:1" ||
      hostname === "127.0.0.1" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
    const botContainer = /^myrmidon-bot-[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname);
    const escapeHatch = config.dangerouslyAllowInsecureRemoteHttp === true ||
      config.dangerouslyAllowInsecureRemoteHttp === "true";
    if (!loopback && !botContainer && !escapeHatch) return null;
  }

  const base = url.toString().replace(/\/+$/, "");
  return `${base}/health`;
}

function firstNonEmptyString(...values: readonly unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

/**
 * One probe pass. Reads probeable agents, probes each, stamps the outcome.
 * A probe failure never throws: a runtime being down is the datum, not an
 * error.
 */
export async function sweepAgentLivenessProbes(
  db: Db,
  port: AgentLivenessProbePort,
  opts: { limit?: number; now?: Date; force?: boolean } = {},
): Promise<AgentLivenessProbeSweepResult> {
  const now = opts.now ?? port.now?.() ?? new Date();
  const candidates = await db
    .select({
      agentId: agents.id,
      companyId: agents.companyId,
      adapterType: agents.adapterType,
      adapterConfig: agents.adapterConfig,
    })
    .from(agents)
    .where(
      and(
        isNotNull(agents.adapterConfig),
        inArray(agents.adapterType, [...AGENT_LIVENESS_PROBEABLE_ADAPTERS]),
        ne(agents.status, "terminated"),
      ),
    )
    .limit(opts.limit ?? AGENT_LIVENESS_PROBE_SWEEP_BATCH);

  const result: AgentLivenessProbeSweepResult = { scanned: candidates.length, probed: 0, ok: 0, unreachable: 0 };
  for (const candidate of candidates) {
    const url = resolveAgentProbeUrl(candidate);
    if (!url) continue;
    result.probed += 1;
    let status: number | null = null;
    try {
      const answer = await port.probe({ url, timeoutMs: AGENT_LIVENESS_PROBE_TIMEOUT_MS });
      status = answer.status;
    } catch {
      status = null;
    }
    const outcome = classifyAgentProbeOutcome(status);
    if (outcome === "ok") result.ok += 1;
    else result.unreachable += 1;
    await stampProbeOutcome(db, candidate.agentId, candidate.companyId, candidate.adapterType, outcome, now);
  }
  if (result.unreachable > 0) {
    logger.warn(
      { ...result },
      "agent liveness probe pass stamped unreachable runtimes",
    );
  } else if (result.probed > 0) {
    logger.info({ ...result }, "agent liveness probe pass complete");
  }
  return result;
}

/** Upsert the probe stamps; keeps `updatedAt` fresh (the agents-list ETag
 * aggregates it, so 304s cannot hide a fresh probe). */
export async function stampProbeOutcome(
  db: Db,
  agentId: string,
  companyId: string,
  adapterType: string,
  outcome: "ok" | "unreachable",
  now: Date,
): Promise<void> {
  await db
    .insert(agentRuntimeState)
    .values({
      agentId,
      companyId,
      adapterType,
      lastProbeAt: now,
      lastProbeOutcome: outcome,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: agentRuntimeState.agentId,
      set: {
        adapterType,
        lastProbeAt: now,
        lastProbeOutcome: outcome,
        updatedAt: now,
      },
    });
}
