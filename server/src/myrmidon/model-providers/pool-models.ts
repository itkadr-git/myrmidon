// server/src/myrmidon/model-providers/pool-models.ts
//
// 1.6.6 OPE-9932: Enrich adapter models with models available in the company's pools,
// marking which accounts provide each model.

import { and, eq } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { modelProviderModels, modelProviders } from "@myrmidon/db";
import {
  DEFAULT_CHATGPT_POOL_MODELS,
  getModelProviderConnector,
  type PoolAccountChannelView,
} from "@myrmidon/shared";
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
  adapterType?: string,
): Promise<AdapterModel[]> {
  try {
    const providers = await db
      .select()
      .from(modelProviders)
      .where(eq(modelProviders.companyId, companyId));

    const providerMap = new Map(providers.map((p) => [p.id, p]));
    const isOmp = adapterType === "omp_local";

    const dbModelsAll = await db
      .select({
        providerId: modelProviderModels.providerId,
        litellmModelName: modelProviderModels.litellmModelName,
        enabled: modelProviderModels.enabled,
      })
      .from(modelProviderModels)
      .innerJoin(modelProviders, eq(modelProviderModels.providerId, modelProviders.id))
      .where(and(eq(modelProviderModels.enabled, true), eq(modelProviders.companyId, companyId)));

    const registryModels = new Map<string, string[]>();
    for (const m of dbModelsAll) {
      const p = providerMap.get(m.providerId);
      const isPool = p && (p.type === "chatgpt-pool" || getModelProviderConnector(p.type)?.supportsChannels === true);
      let modelId = m.litellmModelName;
      if (isOmp) {
        if (!modelId.startsWith("litellm/")) {
          modelId = `litellm/${modelId}`;
        }
      }
      let set = registryModels.get(modelId);
      if (!set) {
        set = [];
        registryModels.set(modelId, set);
      }
      if (p && !isPool) {
        set.push(p.name);
      }
    }

    if (!providers || providers.length === 0) {
      if (isOmp && registryModels.size > 0) {
        const result: AdapterModel[] = [];
        const seen = new Set<string>();
        for (const m of baseModels) {
          result.push(m);
          seen.add(m.id);
        }
        for (const [modelId, accounts] of registryModels.entries()) {
          if (!seen.has(modelId)) {
            result.push({
              id: modelId,
              label: modelId,
              accounts: accounts.length > 0 ? accounts : undefined,
            });
            seen.add(modelId);
          }
        }
        return result;
      }
      return baseModels;
    }

    const svc = customService ?? createDefaultModelProviderService(db);
    const poolModelAccounts = new Map<string, Set<string>>();

    for (const p of providers) {
      const connector = getModelProviderConnector(p.type);
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
          // Banned or quota-exhausted accounts are out of rotation until their
          // reset window. Do not advertise their models as pool-backed; otherwise
          // model selection can route a fresh request back to a known-exhausted
          // account before the provider refreshes its channel state.
          const limitedWindows = [ch.windows.primary, ch.windows.secondary].some(
            (window) =>
              window?.limitReached === true &&
              (window.resetsAt === null || window.resetsAt > Date.now() / 1000),
          );
          if (
            ch.isBanned ||
            ch.state === "banned" ||
            ch.isExhausted ||
            (ch.limitedUntil !== null && ch.limitedUntil > Date.now() / 1000) ||
            limitedWindows
          ) {
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
                fallbackModels = dbModels.map((m) => m.litellmModelName);
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
          for (let modelId of accountModels) {
            if (!modelId) continue;
            if (isOmp && !modelId.startsWith("litellm/")) {
              modelId = `litellm/${modelId}`;
            }
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

    // Also add registry non-pool models if isOmp
    if (isOmp) {
      for (const [modelId, accounts] of registryModels.entries()) {
        let set = poolModelAccounts.get(modelId);
        if (!set) {
          set = new Set<string>();
          poolModelAccounts.set(modelId, set);
        }
        for (const acc of accounts) {
          set.add(acc);
        }
      }
    }

    if (poolModelAccounts.size === 0) {
      return baseModels;
    }

    const result: AdapterModel[] = [];
    const seen = new Set<string>();

    for (const m of baseModels) {
      let modelId = m.id;
      if (isOmp && !modelId.startsWith("litellm/")) {
        modelId = `litellm/${modelId}`;
      }
      const accountsSet = poolModelAccounts.get(modelId) ?? poolModelAccounts.get(m.id);
      const mergedAccounts = Array.from(
        new Set([
          ...(m.accounts ?? []),
          ...(accountsSet ? Array.from(accountsSet) : []),
        ]),
      );
      result.push({
        ...m,
        id: modelId,
        label: m.label && m.label !== m.id ? m.label : modelId,
        accounts: mergedAccounts.length > 0 ? mergedAccounts : undefined,
      });
      seen.add(modelId);
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
