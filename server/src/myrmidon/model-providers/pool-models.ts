// server/src/myrmidon/model-providers/pool-models.ts
//
// 1.6.6 OPE-9932: Enrich adapter models with models available in the company's pools,
// marking which accounts provide each model.

import { and, eq } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { modelProviderModels, modelProviders } from "@myrmidon/db";
import {
  DEFAULT_CHATGPT_POOL_MODELS,
  type PoolAccountChannelView,
} from "@myrmidon/shared";
import { findModelProviderConnector } from "./plugin-lifecycle.js";
import { createDefaultModelProviderService } from "./wiring.js";
import type { AdapterModel } from "@myrmidon/adapter-utils";

export interface PoolAccountChannelProvider {
  listChannels(
    companyId: string,
    providerId: string,
  ): Promise<{ channels: PoolAccountChannelView[] }>;
}

/**
 * 1.6.6 OPE-9932: Enrich adapter models with models available in the company's pools,
 * marking which accounts provide each model.
 */
export async function enrichWithPoolModels(
  db: Db,
  companyId: string,
  baseModels: AdapterModel[],
  customService?: PoolAccountChannelProvider,
): Promise<AdapterModel[]> {
  try {
    const providers = await db
      .select()
      .from(modelProviders)
      .where(eq(modelProviders.companyId, companyId));

    if (!providers || providers.length === 0) {
      return baseModels;
    }

    const svc = customService ?? createDefaultModelProviderService(db);
    const poolModelAccounts = new Map<string, Set<string>>();

    for (const p of providers) {
      const connector = findModelProviderConnector(p.type);
      const isPool =
        p.type === "chatgpt-pool" || connector?.supportsChannels === true;
      if (!isPool) {
        continue;
      }

      try {
        const { channels } = await svc.listChannels(companyId, p.id);
        if (!channels || channels.length === 0) {
          continue;
        }

        let fallbackModels: string[] | null = null;

        for (const ch of channels) {
          // Banned accounts do not provide available models
          if (ch.isBanned || ch.state === "banned") {
            continue;
          }

          let accountModels = ch.models;
          if (!accountModels || accountModels.length === 0) {
            if (fallbackModels === null) {
              const dbModels = await db
                .select()
                .from(modelProviderModels)
                .where(
                  and(
                    eq(modelProviderModels.providerId, p.id),
                    eq(modelProviderModels.enabled, true),
                  ),
                );
              if (dbModels.length > 0) {
                fallbackModels = dbModels.map((m) => m.modelName);
              } else if (
                connector?.defaultModels &&
                connector.defaultModels.length > 0
              ) {
                fallbackModels = [...connector.defaultModels];
              } else if (p.type === "chatgpt-pool") {
                fallbackModels = [...DEFAULT_CHATGPT_POOL_MODELS];
              } else {
                fallbackModels = [];
              }
            }
            accountModels = fallbackModels;
          }

          const accountLabel = ch.label || `Account #${ch.n}`;
          for (const modelId of accountModels) {
            if (!modelId) continue;
            let set = poolModelAccounts.get(modelId);
            if (!set) {
              set = new Set<string>();
              poolModelAccounts.set(modelId, set);
            }
            set.add(accountLabel);
          }
        }
      } catch (err) {
        // Failing to list channels for one provider shouldn't crash model listing
        console.warn(
          `[enrichWithPoolModels] Failed to list channels for provider ${p.id}:`,
          err,
        );
      }
    }

    if (poolModelAccounts.size === 0) {
      return baseModels;
    }

    const result: AdapterModel[] = [];
    const seen = new Set<string>();

    for (const m of baseModels) {
      const accountsSet = poolModelAccounts.get(m.id);
      const mergedAccounts = Array.from(
        new Set([
          ...(m.accounts ?? []),
          ...(accountsSet ? Array.from(accountsSet) : []),
        ]),
      );
      result.push({
        ...m,
        accounts: mergedAccounts.length > 0 ? mergedAccounts : undefined,
      });
      seen.add(m.id);
    }

    for (const [modelId, accountsSet] of poolModelAccounts.entries()) {
      if (!seen.has(modelId)) {
        result.push({
          id: modelId,
          label: modelId,
          accounts: Array.from(accountsSet),
        });
        seen.add(modelId);
      }
    }

    return result;
  } catch (err) {
    console.error("[enrichWithPoolModels] Error:", err);
    return baseModels;
  }
}
