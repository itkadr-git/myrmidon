// server/src/myrmidon/litellm-sync/config-client.ts
//
// myrmidon(OPE-9855): LiteLLM config client for fallback topology.
// Source of truth: LiteLLM database (LiteLLM_Config table) and /config/update API.

import { sql } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import {
  assertFallbackTopologyAcyclic,
  findUnknownModelGroups,
  parseFallbackTopology,
  validateFallbackDiversity,
  validateFallbackOrder,
  type FallbackChain,
  type KnownModelInfo,
} from "@myrmidon/shared";
import { unprocessable } from "../../errors.js";

export interface LitellmConfigClientDeps {
  /** The base URL of the LiteLLM instance. */
  litellmBaseUrl?: string | null;
  /** The admin key for LiteLLM router and config management. */
  litellmAdminKey?: string | null;
  /** DB connection to store and read LiteLLM_Config as source of truth. */
  db?: Db;
}

export interface LitellmConfigClient {
  readFallbackTopology(): Promise<FallbackChain[]>;
  updateFallbackTopology(
    chains: FallbackChain[],
    catalog?: Map<string, KnownModelInfo>,
  ): Promise<{ ok: boolean }>;
}

export function createLitellmConfigClient(deps: LitellmConfigClientDeps): LitellmConfigClient {
  const url = (path: string) => {
    if (!deps.litellmBaseUrl) return path;
    return `${deps.litellmBaseUrl.replace(/\/$/, "")}${path}`;
  };

  return {
    async readFallbackTopology(): Promise<FallbackChain[]> {
      // 1. Try reading from DB as primary source of truth
      if (deps.db) {
        const fromDb = await readFallbacksFromDb(deps.db);
        if (fromDb !== null) {
          return fromDb;
        }
      }

      // 2. Fallback to reading from LiteLLM /router/settings HTTP API
      if (!deps.litellmBaseUrl || !deps.litellmAdminKey) {
        return [];
      }

      const response = await fetch(url("/router/settings"), {
        headers: {
          Authorization: `Bearer ${deps.litellmAdminKey}`,
        },
      });

      if (!response.ok) {
        throw unprocessable(`LiteLLM /router/settings answered ${response.status}`, {
          code: "litellm_request_failed",
          status: response.status,
        });
      }

      const body = (await response.json()) as { fields?: Array<{ field_name?: string; field_value?: unknown }> };
      const field = (body.fields ?? []).find((entry) => entry.field_name === "fallbacks");
      const payload = field?.field_value;

      if (!payload) return [];

      const chains = parseFallbackTopology(payload);
      if (!chains) {
        throw unprocessable("the gateway's fallback topology is in an unexpected shape", {
          code: "litellm_fallbacks_malformed",
        });
      }

      return chains;
    },

    async updateFallbackTopology(
      chains: FallbackChain[],
      catalog?: Map<string, KnownModelInfo>,
    ): Promise<{ ok: boolean }> {
      // 1. Check cycles
      const rawPayload = chains.map((c) => ({ [c.model]: [...c.targets] }));
      try {
        assertFallbackTopologyAcyclic(rawPayload);
      } catch (err) {
        throw unprocessable(err instanceof Error ? err.message : "The fallback topology loops", {
          code: "fallback_cycle",
        });
      }

      // 2. Reject unknown model groups (requires catalog of known models; empty catalog rejects any configured chains)
      const knownKeys = catalog ? new Set(catalog.keys()) : new Set<string>();
      const unknown = findUnknownModelGroups(chains, knownKeys);
      if (unknown.length > 0) {
        throw unprocessable(
          `Unknown model groups in fallback topology: ${unknown.join(", ")}. Only configured model groups can be used in fallback chains.`,
          {
            code: "litellm_unknown_model_groups",
            unknownGroups: unknown,
          },
        );
      }

      // 3. Validate order before diversity so callers receive the specific
      // ordering/provider violation rather than a generic single-provider error.
      for (const chain of chains) {
        const order = validateFallbackOrder(chain, catalog);
        if (!order.valid) {
          throw unprocessable(order.error ?? "Free channels must precede paid channels in fallback chains", {
            code: "litellm_invalid_fallback_order",
          });
        }
      }

      // 4. Validate single provider rule: "не допускать единственного provider"
      for (const chain of chains) {
        const diversity = validateFallbackDiversity(chain, catalog);
        if (!diversity.valid) {
          throw unprocessable(diversity.error ?? "Fallback chain must not rely on a single provider", {
            code: "litellm_single_provider_forbidden",
          });
        }
      }

      // 5. Persist to LiteLLM database (LiteLLM_Config table) as source of truth
      if (deps.db) {
        await writeFallbacksToDb(deps.db, chains);
      }

      // 6. Push runtime changes to LiteLLM /config/update API if configured
      if (deps.litellmBaseUrl && deps.litellmAdminKey) {
        const response = await fetch(url("/config/update"), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${deps.litellmAdminKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            router_settings: {
              fallbacks: rawPayload,
            },
          }),
        });

        if (!response.ok) {
          throw unprocessable(`LiteLLM /config/update answered ${response.status}`, {
            code: "litellm_request_failed",
            status: response.status,
          });
        }
      }

      return { ok: true };
    },
  };
}

/**
 * Direct DB reader for LiteLLM_Config table (LiteLLM database source of truth).
 * Returns null if the table is unpopulated or missing.
 */
export async function readFallbacksFromDb(db: Db): Promise<FallbackChain[] | null> {
  try {
    const result = await db.execute<{ param_name: string; param_value: unknown }>(
      sql`SELECT param_value FROM "LiteLLM_Config" WHERE param_name = 'router_settings' LIMIT 1`,
    );
    const rows = (Array.isArray(result)
      ? result
      : ((result as unknown as { rows?: unknown[] })?.rows ?? [])) as Array<{ param_value: unknown }>;
    const row = rows[0];
    if (!row || row.param_value === undefined || row.param_value === null) {
      return null;
    }

    let paramValue = row.param_value;
    if (typeof paramValue === "string") {
      try {
        paramValue = JSON.parse(paramValue);
      } catch {
        return null;
      }
    }

    const fallbacks = (paramValue as Record<string, unknown>)?.fallbacks;
    if (!fallbacks) return null;

    return parseFallbackTopology(fallbacks);
  } catch {
    // If table does not exist or query fails, return null so caller can fallback to API
    return null;
  }
}

/**
 * Direct DB writer for LiteLLM_Config table (LiteLLM database source of truth).
 */
export async function writeFallbacksToDb(db: Db, chains: FallbackChain[]): Promise<void> {
  const rawPayload = chains.map((c) => ({ [c.model]: [...c.targets] }));
  assertFallbackTopologyAcyclic(rawPayload);

  const payload = JSON.stringify({
    fallbacks: rawPayload,
  });

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "LiteLLM_Config" (
      param_name VARCHAR(255) PRIMARY KEY,
      param_value JSONB
    )
  `);

  await db.execute(sql`
    INSERT INTO "LiteLLM_Config" (param_name, param_value)
    VALUES ('router_settings', ${payload}::jsonb)
    ON CONFLICT (param_name)
    DO UPDATE SET param_value = EXCLUDED.param_value
  `);
}
