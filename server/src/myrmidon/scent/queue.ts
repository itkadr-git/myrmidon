// server/src/myrmidon/scent/queue.ts
//
// myrmidon(1.6.5 F-26 T10 SCENT): the markup queue runner (design §7.1
// п.4a). A self-contained timer — NOT a heartbeat.ts pass: the heartbeat's
// startup and dispatch paths must never wait on up to 50×40 sequential LLM
// calls of 20 s each. `startScentQueue(db)` is wired from server startup
// like the other myrmidon timers (maintenance, bot-disk), with
// `timer.unref()` so tests and short-lived scripts are not held open.
//
// One tick = one batch of ≤ `classifierBatchSize` records (open todo tasks
// without a scent first, then agents with empty tags), each gated by the
// hour budget (attempts count, successes or not — see service.canSpendCall),
// so a dead gateway burns at most batchSize ledger entries per tick and the
// same records are not hammered again within the hour.

import type { Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";
// Raw sql on `companies` (the drizzle schema export for it differs across
// stacked release branches; the table itself is stable since 1.5).
import { logger } from "../../middleware/logger.js";
import { logActivity } from "../../services/activity-log.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { secretService } from "../../services/index.js";
import { createCasteStore } from "../castes/store.js";
import { DEFAULT_SCENT_SETTINGS, readScentSettings } from "@paperclipai/shared";
import { classifyAgentScent, classifyIssueScent, type ScentGatewayDeps } from "./gateway.js";
import { baseStrengthFromGeneral, createScentService, scentSettingsFromGeneral } from "./service.js";

type TimerHandle = ReturnType<typeof setTimeout>;

/** How often the queue runs. Deliberately coarse — the hour budget, not the
 * tick, is the rate limiter. */
export const SCENT_QUEUE_TICK_MS = 60_000;

export const SCENT_BASE_URL_ENV = "MYRMIDON_SCENT_BASE_URL";
export const SCENT_KEY_SECRET_ENV = "MYRMIDON_SCENT_KEY_SECRET";

export interface ScentQueuePorts {
  fetch?: typeof fetch;
  /** Test hook: replace the secret store lookup. */
  resolveSecret?: (db: Db, companyId: string, secretName: string) => Promise<string | null>;
  /** Test hook: replace the company listing (the queue is per-company). */
  listCompanyIds?: () => Promise<string[]>;
  now?: () => number;
}

async function defaultResolveSecret(
  db: Db,
  companyId: string,
  secretName: string,
): Promise<string | null> {
  // The same pattern the evals judge follows: the company secret named
  // `secretName` (operator-managed, per company) wins; when the secret does
  // not exist the env variable of the same name is the fallback so the dev
  // contour works without a company setup. A missing key disables the call —
  // the attempt is journaled as failed and the record is retried within its
  // hour budget.
  const secrets = secretService(db);
  const row = await secrets.getByName(companyId, secretName);
  if (row) return secrets.resolveSecretValue(companyId, row.id, "latest");
  return process.env[secretName] ?? null;
}

async function tickCompany(db: Db, companyId: string, ports: ScentQueuePorts): Promise<void> {
  const settingsSvc = instanceSettingsService(db);
  const general = await settingsSvc.getGeneral();
  const settings = readScentSettings(
    (general as unknown as Record<string, unknown> | null)?.swarm,
    process.env,
  );
  if (!settings.enabled) return;

  const env = process.env;
  const baseUrl = env[SCENT_BASE_URL_ENV]?.trim() || env.MYRMIDON_EVALS_BASE_URL?.trim() || "";
  const secretName = env[SCENT_KEY_SECRET_ENV]?.trim() || "MYRMIDON_EVALS_API_KEY";
  const resolve = ports.resolveSecret ?? defaultResolveSecret;
  const apiKey = await resolve(db, companyId, secretName);
  if (!baseUrl || !apiKey) return; // contour not configured — nothing to do

  const castes = await createCasteStore({ db }).listCastes(companyId);
  const casteKeys = castes.map((c: { key: string }) => c.key);

  const gatewayDeps: ScentGatewayDeps = {
    fetch: ports.fetch ?? globalThis.fetch.bind(globalThis),
    apiKey,
    baseUrl,
  };
  const gateway = {
    classifyIssueScent: (input: Parameters<typeof classifyIssueScent>[1]) =>
      classifyIssueScent(gatewayDeps, input),
    classifyAgentScent: (input: Parameters<typeof classifyAgentScent>[1]) =>
      classifyAgentScent(gatewayDeps, input),
  };

  const service = createScentService({
    baseStrengthFor: baseStrengthFromGeneral(general),
    db,
    companyId,
    settings,
    gateway,
    casteKeys,
    logActivity: (entry) =>
      logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "system",
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        details: entry.details ?? {},
      }).then(() => undefined),
  });

  const slice = await service.listMarkupQueue(settings.classifierBatchSize);
  // Tasks first (routing needs the caste), then agents.
  for (const issueId of slice.issueIds) {
    await service.classifyIssue(issueId).catch((err) => {
      logger.error({ err, issueId }, "scent queue: issue classification failed");
    });
  }
  for (const agentId of slice.agentIds) {
    await service.classifyAgent(agentId).catch((err) => {
      logger.error({ err, agentId }, "scent queue: agent classification failed");
    });
  }
}

/** One pass over every company. Exported for tests. */
export async function runScentQueueTick(
  db: Db,
  ports: ScentQueuePorts = {},
): Promise<void> {
  const listCompanyIds =
    ports.listCompanyIds ??
    (async () => {
      const rows = await db.execute(sql`select id from companies`);
      return (rows as unknown as Array<{ id: string }>).map((r) => r.id);
    });
  for (const companyId of await listCompanyIds()) {
    await tickCompany(db, companyId, ports).catch((err) => {
      logger.error({ err, companyId }, "scent queue tick failed");
    });
  }
}

/**
 * Wire the queue timer. Returns a stop function. The first tick runs
 * immediately in the background; failures are logged, never thrown.
 */
export function startScentQueue(db: Db, ports: ScentQueuePorts = {}): () => void {
  let stopped = false;
  let timer: TimerHandle | null = null;
  // Self-scheduling: the next tick is armed only after the current one has
  // finished, so ticks can never overlap (canSpendCall is checked before the
  // gateway call and the ledger entry is written after it).
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => void run(), SCENT_QUEUE_TICK_MS);
    (timer as { unref?: () => void }).unref?.();
  };
  const run = async () => {
    try {
      await runScentQueueTick(db, ports);
    } catch (err) {
      logger.error({ err }, "scent queue tick failed");
    } finally {
      schedule();
    }
  };
  void run();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

export { DEFAULT_SCENT_SETTINGS };
export { scentSettingsFromGeneral };
