// server/src/myrmidon/litellm-budget-sync/sweep.ts
//
// myrmidon(1.7-BUDGET-CONFIG-C): the periodic projection pass.
//
// One pass per company per interval: the three-way sync (board vs projected
// vs gateway — see service.ts). The interval is resolved LIVE on every tick
// (the stored document is the source the UI writes; one env variable is a
// forced override), so a settings change needs no restart. The timer runs at
// a 10 s floor and each company self-throttles to its own resolved interval
// via the last-run timestamp. A pass whose previous run is still going is
// skipped, not queued — the M2-A posture.

import type { Db } from "@paperclipai/db";
import type { Logger } from "pino";
import { logger } from "../../middleware/logger.js";
import { agentKeySecretName } from "@paperclipai/shared";
import { and, eq, ne } from "drizzle-orm";
import { agents } from "@paperclipai/db";
import { createLitellmBudgetGatewayPort, type LitellmBudgetGatewayPort } from "./gateway.js";
import { syncBudgetProjection, type BudgetProjectionSyncDeps } from "./service.js";
import { readBudgetProjectionSettings, resolveBudgetProjectionRuntime } from "./settings.js";

/** The base deps every wiring (sweep, routes, immediate pass) builds on. */
export function budgetProjectionSyncDeps(
  db: Db,
  companyId: string,
  env: NodeJS.ProcessEnv = process.env,
): BudgetProjectionSyncDeps & { gatewayBaseUrl: string | null; adminKeySecret: string | null } {
  return {
    db,
    readSettings: () => readBudgetProjectionSettings(db, companyId),
    writeSettings: (next) =>
      mutateForSync(db, companyId, next),
    listAgentKeyAliases: (id) =>
      db
        .select({ id: agents.id, name: agents.name, role: agents.role })
        .from(agents)
        .where(and(eq(agents.companyId, id), ne(agents.status, "terminated")))
        .then((rows) =>
          rows.map((row) => ({
            agentId: row.id,
            alias: agentKeySecretName({ agentId: row.id, agentSlug: row.name }),
            role: row.role,
          })),
        ),
    addComment: (issueId, body, options) => issueCommentPort(db)(issueId, body, options),
    findSignalIssue: (id) => findSignalIssue(db, id),
    now: () => new Date(),
    log: logger,
    gatewayBaseUrl: env["MYRMIDON_LITELLM_BASE_URL"]?.trim() || null,
    adminKeySecret: env["MYRMIDON_LITELLM_ADMIN_KEY_SECRET"]?.trim() || null,
  };
}

/** The sync's own write: only the `projected` map moves, the rest stays. */
async function mutateForSync(
  db: Db,
  companyId: string,
  next: Parameters<BudgetProjectionSyncDeps["writeSettings"]>[0],
): Promise<void> {
  const { mutateBudgetProjectionDocument } = await import("./settings.js");
  await mutateBudgetProjectionDocument(db, companyId, (current) => ({
    // Keep every public field the operator may have saved in the meantime;
    // the sync owns exactly `projected`.
    next: { ...current, projected: next.projected },
    result: null,
  }));
}

/** The gateway port: env contour or the injected fake (tests). */
export function budgetProjectionGateway(
  deps: ReturnType<typeof budgetProjectionSyncDeps>,
  override?: LitellmBudgetGatewayPort,
): LitellmBudgetGatewayPort | null {
  if (override) return override;
  if (!deps.gatewayBaseUrl || !deps.adminKeySecret) return null;
  return createLitellmBudgetGatewayPort(deps.gatewayBaseUrl, deps.adminKeySecret);
}

export interface BudgetProjectionSweepPorts {
  listCompanyIds(db: Db): Promise<string[]>;
  gateway?: LitellmBudgetGatewayPort;
  log?: Pick<Logger, "info" | "warn" | "error">;
}

let stopRunning: (() => void) | null = null;
let immediatePass: (() => void) | null = null;

/** Register the immediate-pass hook the settings PUT calls. */
export function setBudgetProjectionImmediatePass(fn: (() => void) | null): void {
  immediatePass = fn;
}

/**
 * One pass for one company (shared by the timer, the settings save and the
 * re-sync route). Returns null when the gateway contour is unconfigured.
 */
export async function runBudgetProjectionPass(
  db: Db,
  companyId: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: { force?: boolean; gateway?: LitellmBudgetGatewayPort } = {},
): Promise<ReturnType<typeof syncBudgetProjection> | null> {
  const deps = budgetProjectionSyncDeps(db, companyId, env);
  const gateway = budgetProjectionGateway(deps, opts.gateway);
  if (!gateway) return null;
  return syncBudgetProjection({ ...deps, gateway }, companyId, { force: opts.force });
}

/**
 * Starts the projection sweep. A company is swept only while its stored
 * document's master switch is on (re-read every tick — the UI turns the
 * projection on/off live, no restart) and the instance names the gateway
 * contour.
 */
export function startBudgetProjectionSweep(
  db: Db,
  opts: { env?: NodeJS.ProcessEnv; ports?: BudgetProjectionSweepPorts } = {},
): () => void {
  const env = opts.env ?? process.env;
  const ports = opts.ports ?? {};
  const log = ports.log ?? logger;
  const pass = ports.gateway
    ? (companyId: string) =>
        runBudgetProjectionPass(db, companyId, env, { gateway: ports.gateway })
  : (companyId: string) => runBudgetProjectionPass(db, companyId, env);
  stopBudgetProjectionSweep();

  let sweeping = false;
  let stopped = false;
  const lastRunByCompany = new Map<string, number>();

  const tick = async () => {
    if (sweeping || stopped) return;
    sweeping = true;
    try {
      const companyIds = await ports.listCompanyIds(db);
      for (const companyId of companyIds) {
        try {
          const runtime = await resolveBudgetProjectionRuntime(db, companyId, env);
          if (!runtime.settings.enabled) continue;
          const intervalMs = runtime.sweepIntervalSec * 1000;
          const now = Date.now();
          const last = lastRunByCompany.get(companyId) ?? 0;
          if (now - last < intervalMs) continue;
          lastRunByCompany.set(companyId, now);
          const result = await pass(companyId);
          if (result) {
            log.info(
              {
                companyId,
                keysWritten: result.keysWritten,
                tagsWritten: result.tagsWritten,
                divergences: result.divergences.length,
              },
              "litellm budget projection sweep done",
            );
          }
        } catch (err) {
          log.warn({ err, companyId }, "litellm budget projection sweep failed for one company");
        }
      }
    } catch (err) {
      log.error({ err }, "litellm budget projection sweep tick failed");
    } finally {
      sweeping = false;
    }
  };

  const timer = setInterval(() => {
    void tick().catch(() => {});
  }, 10_000);
  if (typeof timer.unref === "function") timer.unref();

  // The immediate-pass hook: a settings save runs one pass now.
  setBudgetProjectionImmediatePass(() => {
    void tick().catch(() => {});
  });

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    setBudgetProjectionImmediatePass(null);
    if (stopRunning === stop) stopRunning = null;
  };
  stopRunning = stop;
  return stop;
}

/** Stops the sweep started by `startBudgetProjectionSweep`; a no-op when none runs. */
export function stopBudgetProjectionSweep(): void {
  stopRunning?.();
}

/** The company's newest in_progress issue with an agent assignee — where a divergence signal lands. */
async function findSignalIssue(db: Db, companyId: string): Promise<{ id: string } | null> {
  const { issues } = await import("@paperclipai/db");
  const { and, eq, desc, sql } = await import("drizzle-orm");
  const rows = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.status, "in_progress"),
        sql`${issues.assigneeAgentId} is not null`,
      ),
    )
    .orderBy(desc(issues.updatedAt))
    .limit(1);
  return rows[0] ?? null;
}

/** The system-notice comment port (issueService.addComment, authorType system). */
function issueCommentPort(db: Db) {
  return async (
    issueId: string,
    body: string,
    options: { presentation: Record<string, unknown>; metadata: Record<string, unknown> },
  ) => {
    const { issueService } = await import("../../services/issues.js");
    const svc = issueService(db);
    return svc.addComment(issueId, body, {}, {
      authorType: "system",
      presentation: options.presentation as never,
      metadata: options.metadata as never,
    });
  };
}
