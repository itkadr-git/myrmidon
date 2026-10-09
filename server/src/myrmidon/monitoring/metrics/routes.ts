// server/src/myrmidon/monitoring/metrics/routes.ts
//
// myrmidon(1.7-METRICS): GET /metrics — the board's own Prometheus endpoint.
//
// Mounted at the origin root (outside /api, like the swarm-claim ingress) so
// a scraper hits `GET /metrics` directly. The route carries NO board actor:
// the guard is one bearer token, resolved through the company secret store
// by NAME (settings name the secret; the value is never returned and never
// logged). A missing, unresolvable or wrong token answers 401 — the
// endpoint never falls open.
//
// The response is the 0.0.4 text exposition format; the family set and the
// rendering live in metrics.ts. The token lookup and the collector are
// injectable seams, the same shape litellm-costs routes use for tests.

import { Router, type Request, type Response } from "express";
import { and, eq, ne } from "drizzle-orm";
import { companySecrets, type Db } from "@paperclipai/db";
import { secretService } from "../../../services/secrets.js";
import {
  clampErrorWindowSec,
  clampLatencyWindowSec,
  collectMetricsSnapshot,
  METRICS_CONTENT_TYPE,
  renderMetricsText,
  runMetricsSelfCheck,
  type MetricsCollectorDeps,
  type MetricsSelfCheck,
} from "./metrics.js";
import {
  startProcessMetricsObservation,
  type ProcessMetricsSource,
} from "./process-metrics.js";

/** Settings env: the NAME of the company secret holding the scraper token. */
export const METRICS_TOKEN_SECRET_ENV = "MYRMIDON_METRICS_TOKEN_SECRET";
/** Settings env: the env variable holding the scraper token directly. */
export const METRICS_TOKEN_ENV = "MYRMIDON_METRICS_TOKEN";
/** Settings env: default error window (seconds). */
export const METRICS_ERROR_WINDOW_ENV = "MYRMIDON_METRICS_ERROR_WINDOW_SEC";
/** Settings env: default latency window (seconds). */
export const METRICS_LATENCY_WINDOW_ENV = "MYRMIDON_METRICS_LATENCY_WINDOW_SEC";

/** Where the secret NAME is looked up (company secret rows by name). */
export type ListSecretRowsByName = (
  name: string,
) => Promise<Array<{ id: string; companyId: string }>>;

/** Where a secret VALUE is resolved (never logged, never echoed). */
export type ReadSecretValue = (companyId: string, secretId: string) => Promise<string | null>;

export interface MetricsRoutesDeps {
  db: Db;
  env?: NodeJS.ProcessEnv;
  now(): Date;
  /** Secret lookup seam; the real wiring queries `company_secrets`. */
  listSecretRowsByName?: ListSecretRowsByName;
  /** Secret value seam; the real wiring resolves through the secret service. */
  readSecretValue?: ReadSecretValue;
  /** Self-check seam; the real wiring runs the collector against `db`. */
  runSelfCheck?: (deps: MetricsCollectorDeps) => Promise<MetricsSelfCheck>;
  /**
   * myrmidon(1.6.5-PROCS-Q3): the process-metrics seam (event loop delay,
   * memory, live events). Absent → the production in-process source.
   */
  processMetrics?: ProcessMetricsSource | null;
  /**
   * myrmidon(PROCS-0.1): the identity of this process (role + boot), rendered
   * as labels on the process families. Absent → unlabeled lines (the
   * 1.6.5-PROCS-Q3 shape).
   */
  processIdentity?: { role: string; bootId: string } | null;
}

/**
 * Resolves the scraper token. Precedence: the company secret named by
 * MYRMIDON_METRICS_TOKEN_SECRET (first resolvable row wins — the same
 * lookup order the litellm sweep uses), else the env variable
 * MYRMIDON_METRICS_TOKEN. `null` means the endpoint is off (401 for
 * everyone): a metrics endpoint without a configured token must not fall
 * open to the whole network. The token value never appears in a log, an
 * error or a response.
 */
export async function resolveMetricsToken(deps: {
  env: NodeJS.ProcessEnv;
  listSecretRowsByName: ListSecretRowsByName;
  readSecretValue: ReadSecretValue;
}): Promise<string | null> {
  const secretName = deps.env[METRICS_TOKEN_SECRET_ENV]?.trim();
  if (secretName) {
    const rows = await deps
      .listSecretRowsByName(secretName)
      .catch(() => [] as Array<{ id: string; companyId: string }>);
    for (const row of rows) {
      const value = await deps
        .readSecretValue(row.companyId, row.id)
        .catch(() => null as string | null);
      if (value && value.trim()) return value.trim();
    }
  }
  const envToken = deps.env[METRICS_TOKEN_ENV]?.trim();
  return envToken || null;
}

/** Timing-safe comparison; both inputs are strings of unknown length. */
export function tokenMatches(expected: string, provided: string): boolean {
  if (expected.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

export function myrmidonMetricsRoutes(deps: MetricsRoutesDeps) {
  const router = Router();
  const env = deps.env ?? process.env;
  const listSecretRowsByName: ListSecretRowsByName =
    deps.listSecretRowsByName ??
    (async (name: string) =>
      deps.db
        .select({ id: companySecrets.id, companyId: companySecrets.companyId })
        .from(companySecrets)
        .where(
          and(
            eq(companySecrets.scope, "company"),
            eq(companySecrets.name, name),
            ne(companySecrets.status, "deleted"),
          ),
        ));
  const readSecretValue: ReadSecretValue =
    deps.readSecretValue ??
    (async (companyId: string, secretId: string) => {
      const secrets = secretService(deps.db);
      return secrets.resolveSecretValue(companyId, secretId, "latest");
    });
  const defaultErrorWindowSec = clampErrorWindowSec(env[METRICS_ERROR_WINDOW_ENV]);
  const defaultLatencyWindowSec = clampLatencyWindowSec(env[METRICS_LATENCY_WINDOW_ENV]);
  const runSelfCheck: (deps: MetricsCollectorDeps) => Promise<MetricsSelfCheck> =
    deps.runSelfCheck ?? runMetricsSelfCheck;

  // myrmidon(1.6.5-PROCS-Q3): the process observers (delay histogram +
  // live-event subscribers) start lazily on the FIRST authorized scrape and
  // never cost anything before that — an unconfigured endpoint stays exactly
  // as cheap as before. Injected fakes (tests) skip the start.
  let processObservationStarted = false;
  function ensureProcessObservation(): void {
    if (deps.processMetrics || processObservationStarted) return;
    processObservationStarted = true;
    startProcessMetricsObservation();
  }

  /** Resolves the bearer guard for this router; false answers 401. */
  async function authorized(req: Request, res: Response): Promise<boolean> {
    // The guard runs before any collection: a caller without the token
    // learns nothing about the board (not even which families exist).
    const token = await resolveMetricsToken({ env, listSecretRowsByName, readSecretValue });
    if (!token) {
      res.status(401).send("metrics token is not configured");
      return false;
    }
    const header = req.headers.authorization ?? "";
    if (!header.startsWith("Bearer ")) {
      res.status(401).send("bearer token required");
      return false;
    }
    const provided = header.slice("Bearer ".length).trim();
    if (!provided || !tokenMatches(token, provided)) {
      res.status(401).send("invalid bearer token");
      return false;
    }
    return true;
  }

  router.get("/metrics", async (req: Request, res: Response) => {
    if (!(await authorized(req, res))) return;

    ensureProcessObservation();
    const query = req.query as Record<string, unknown>;
    const snapshot = await collectMetricsSnapshot({
      db: deps.db,
      now: deps.now,
      errorWindowSec: clampErrorWindowSec(query.window ?? defaultErrorWindowSec),
      latencyWindowSec: clampLatencyWindowSec(query.latency_window ?? defaultLatencyWindowSec),
      ...(deps.processMetrics !== undefined ? { processMetrics: deps.processMetrics } : {}),
      ...(deps.processIdentity !== undefined ? { processIdentity: deps.processIdentity } : {}),
    });
    res.status(200).set("Content-Type", METRICS_CONTENT_TYPE).send(renderMetricsText(snapshot));
  });

  // Self-check link (myrmidon 1.6.6 annex): the probe answers under the
  // canonical /api path but rides this same router — no second app.ts
  // mount, no new credentials. It carries only aggregate numbers (which
  // families worked, how long the scrape took): no secret and no metric
  // value ever leaves it.
  router.get("/api/myrmidon/monitoring/selfcheck", async (req: Request, res: Response) => {
    if (!(await authorized(req, res))) return;

    const query = req.query as Record<string, unknown>;
    try {
      const result = await runSelfCheck({
        db: deps.db,
        now: deps.now,
        errorWindowSec: clampErrorWindowSec(query.window ?? defaultErrorWindowSec),
        latencyWindowSec: clampLatencyWindowSec(query.latency_window ?? defaultLatencyWindowSec),
        ...(deps.processMetrics !== undefined ? { processMetrics: deps.processMetrics } : {}),
      });
      res.status(result.ok ? 200 : 503).json(result);
    } catch {
      // A probe that itself throws still answers with a shape, never a stack.
      res.status(500).json({
        ok: false,
        families_ok: 0,
        families_failed: ["selfcheck_crash"],
        scrape_ms: 0,
        checked_at: deps.now().toISOString(),
      });
    }
  });

  return router;
}
