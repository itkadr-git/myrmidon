// server/src/myrmidon/model-providers/sweep.ts
//
// myrmidon(1.6.6 OPE-7198): periodic background sweep for Codex / ChatGPT pool accounts.
//
// Automatically refreshes account channels and attention signals for companies
// with configured pool providers, ensuring operator signals for banned or exhausted
// accounts appear and clear without anyone viewing the settings page.

import { and, eq, isNotNull } from "drizzle-orm";
import type { Db } from "@myrmidonai/db";
import { modelProviders } from "@myrmidonai/db";
import type { PoolAccountRoleSignal } from "@myrmidonai/shared";
import { logger } from "../../middleware/logger.js";
import { createDefaultModelProviderService } from "./wiring.js";
import type { ModelProviderService } from "./service.js";

export const POOL_SWEEP_INTERVAL_SEC_ENV = "MYRMIDON_POOL_SWEEP_INTERVAL_SEC";
const DEFAULT_SWEEP_INTERVAL_SEC = 300;
const MIN_SWEEP_INTERVAL_SEC = 30;
const MAX_SWEEP_INTERVAL_SEC = 86400;

export function readPoolSweepIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[POOL_SWEEP_INTERVAL_SEC_ENV]?.trim();
  if (!raw) return DEFAULT_SWEEP_INTERVAL_SEC * 1000;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_SWEEP_INTERVAL_SEC || value > MAX_SWEEP_INTERVAL_SEC) {
    return DEFAULT_SWEEP_INTERVAL_SEC * 1000;
  }
  return value * 1000;
}

export interface ModelProviderPoolSweepDeps {
  listCompaniesWithPools(): Promise<string[]>;
  syncPoolSignals(companyId: string): Promise<PoolAccountRoleSignal[]>;
  log?: typeof logger;
}

export interface ModelProviderPoolSweeper {
  sweep(): Promise<{ companies: number; signals: number }>;
  stop(): void;
}

export function createModelProviderPoolSweeper(
  deps: ModelProviderPoolSweepDeps,
  intervalMs: number,
): ModelProviderPoolSweeper {
  let sweeping = false;
  let stopped = false;
  const log = deps.log ?? logger.child({ service: "codex-pool-sweep" });

  async function sweep(): Promise<{ companies: number; signals: number }> {
    if (sweeping || stopped) return { companies: 0, signals: 0 };
    sweeping = true;
    let companiesCount = 0;
    let totalSignals = 0;
    try {
      const companyIds = await deps.listCompaniesWithPools().catch(() => [] as string[]);
      companiesCount = companyIds.length;
      for (const companyId of companyIds) {
        try {
          const signals = await deps.syncPoolSignals(companyId);
          totalSignals += signals.length;
        } catch (err) {
          log.warn({ err, companyId }, "codex pool signals sweep failed for one company");
        }
      }
    } finally {
      sweeping = false;
    }
    return { companies: companiesCount, signals: totalSignals };
  }

  const timer = setInterval(() => {
    void sweep().catch((err) => log.error({ err }, "codex pool signals sweep tick failed"));
  }, intervalMs);
  timer.unref?.();

  return {
    sweep,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export async function listCompaniesWithPoolProviders(db: Db): Promise<string[]> {
  const rows = await db
    .selectDistinct({ companyId: modelProviders.companyId })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.type, "chatgpt-pool"),
        isNotNull(modelProviders.credentialSecretName),
      ),
    );
  return rows.map((r) => r.companyId);
}

let activeSweeper: ModelProviderPoolSweeper | null = null;

export interface StartModelProviderPoolSweepOptions {
  env?: NodeJS.ProcessEnv;
  service?: ModelProviderService;
  deps?: Partial<ModelProviderPoolSweepDeps>;
}

export function startModelProviderPoolSweep(
  db: Db,
  opts: StartModelProviderPoolSweepOptions = {},
): () => void {
  const env = opts.env ?? process.env;
  const intervalMs = readPoolSweepIntervalMs(env);
  const service = opts.service ?? createDefaultModelProviderService(db);

  const deps: ModelProviderPoolSweepDeps = {
    listCompaniesWithPools: opts.deps?.listCompaniesWithPools ?? (() => listCompaniesWithPoolProviders(db)),
    syncPoolSignals: opts.deps?.syncPoolSignals ?? ((companyId) => service.syncPoolSignals(companyId)),
    log: opts.deps?.log ?? logger,
  };

  const sweeper = createModelProviderPoolSweeper(deps, intervalMs);
  activeSweeper = sweeper;

  // Run initial pass non-blocking
  void sweeper.sweep().catch((err) => {
    logger.warn({ err }, "initial codex pool sweep pass failed");
  });

  return () => {
    sweeper.stop();
    if (activeSweeper === sweeper) {
      activeSweeper = null;
    }
  };
}

export function stopModelProviderPoolSweep(): void {
  if (activeSweeper) {
    activeSweeper.stop();
    activeSweeper = null;
  }
}
