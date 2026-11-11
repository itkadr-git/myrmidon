// server/src/myrmidon/litellm-sync/config-client.ts
//
// myrmidon(OPE-9855): LiteLLM config client for fallback topology.
//
// The gateway is the only source of truth. The topology is read from the live
// router (`GET /router/settings`) and written whole with `POST /config/update`
// ({router_settings: {fallbacks: [...]}}); the board keeps no copy of it. A
// copy in the board database would drift from what the router really does
// and would answer "saved" for a write the gateway never saw.

import {
  GATEWAY_ADMIN_KEY_SECRET_ENV,
  GATEWAY_BASE_URL_ENV,
  assertFallbackTopologyAcyclic,
  evaluateFallbackChain,
  findUnknownModelGroups,
  parseFallbackTopology,
  type FallbackChain,
  type KnownModelInfo,
} from "@myrmidon/shared";
import { serviceUnavailable, unprocessable } from "../../errors.js";
import { sanitizeErrorMessage } from "./client.js";

/** The code every "the gateway is not set up" answer carries (503). */
export const GATEWAY_NOT_CONFIGURED_CODE = "litellm_gateway_not_configured";

export interface LitellmConfigClientDeps {
  /** The base URL of the LiteLLM instance. */
  litellmBaseUrl?: string | null;
  /** The admin key for LiteLLM router and config management. */
  litellmAdminKey?: string | null;
}

export interface FallbackUpdateResult {
  ok: boolean;
  /** Findings that did not refuse the save (for example a fallback inside one provider). */
  warnings: string[];
}

export interface LitellmConfigClient {
  readFallbackTopology(): Promise<FallbackChain[]>;
  updateFallbackTopology(
    chains: FallbackChain[],
    catalog?: Map<string, KnownModelInfo>,
  ): Promise<FallbackUpdateResult>;
}

/**
 * The 503 for a gateway the board cannot talk to: `code`, `enabled: false`
 * and the names of the settings that are missing, so a screen can say what to
 * set instead of showing a bare error.
 */
export function gatewayNotConfigured(missing: readonly string[], reason?: string) {
  const names = missing.join(" and ");
  return serviceUnavailable(reason ?? `LLM gateway fallback management is not enabled: set ${names}`, {
    code: GATEWAY_NOT_CONFIGURED_CODE,
    enabled: false,
    missing: [...missing],
  });
}

export function createLitellmConfigClient(deps: LitellmConfigClientDeps): LitellmConfigClient {
  /** The gateway address and admin key, or the 503 that names what is missing. */
  const requireGateway = (): { baseUrl: string; adminKey: string } => {
    const baseUrl = deps.litellmBaseUrl?.trim() || null;
    const adminKey = deps.litellmAdminKey || null;
    if (baseUrl && adminKey) return { baseUrl: baseUrl.replace(/\/+$/, ""), adminKey };
    const missing: string[] = [];
    if (!baseUrl) missing.push(GATEWAY_BASE_URL_ENV);
    if (!adminKey) missing.push(GATEWAY_ADMIN_KEY_SECRET_ENV);
    throw gatewayNotConfigured(
      missing,
      // The admin key comes from the secret the variable names; with the
      // variable set, an empty key means that secret is absent or has no value.
      baseUrl
        ? `LLM gateway fallback management is not enabled: the gateway admin key is empty — store it in the company secret that ${GATEWAY_ADMIN_KEY_SECRET_ENV} names`
        : undefined,
    );
  };

  const call = async (
    gateway: { baseUrl: string },
    path: string,
    init: { method?: "POST"; headers: Record<string, string>; body?: string },
  ): Promise<Response> => {
    try {
      return await fetch(`${gateway.baseUrl}${path}`, init);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      throw unprocessable(`LiteLLM connection error: ${sanitizeErrorMessage(raw)}`, {
        code: "litellm_connection_failed",
      });
    }
  };

  /** A gateway answer that is not 2xx, with the gateway's own reason when it gave one. */
  const requestFailed = async (path: string, response: Response) => {
    let detail = "";
    try {
      detail = sanitizeErrorMessage((await response.text()).slice(0, 500));
    } catch {
      // No body to read; the status alone is the answer.
    }
    return unprocessable(
      `LiteLLM ${path} answered ${response.status}${detail ? `: ${detail}` : ""}`,
      { code: "litellm_request_failed", status: response.status },
    );
  };

  return {
    async readFallbackTopology(): Promise<FallbackChain[]> {
      const gateway = requireGateway();
      const response = await call(gateway, "/router/settings", {
        headers: { Authorization: `Bearer ${gateway.adminKey}` },
      });
      if (!response.ok) throw await requestFailed("/router/settings", response);

      // `current_values` is what the router runs with; `fields[]` carries the same
      // value for gateways that answer only the field list.
      const body = (await response.json()) as {
        current_values?: { fallbacks?: unknown } | null;
        fields?: Array<{ field_name?: string; field_value?: unknown }>;
      };
      const field = (body.fields ?? []).find((entry) => entry.field_name === "fallbacks");
      const payload = body.current_values?.fallbacks ?? field?.field_value;
      if (payload === undefined || payload === null) return [];

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
    ): Promise<FallbackUpdateResult> {
      // 1. Check cycles and reject chain entries with no usable destination.
      const rawPayload = chains.map((c) => ({ [c.model]: [...c.targets] }));
      for (const chain of chains) {
        if (!chain.model.trim() || chain.targets.length === 0 || chain.targets.some((target) => !target.trim())) {
          throw unprocessable(`Fallback chain for '${chain.model}' has no fallback targets or contains an empty model name`, {
            code: "litellm_fallback_deadend",
          });
        }
      }
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

      // 3. The owner's ordering policy (free channels first, then cheaper ones)
      // refuses a save. Provider findings only warn: a fallback inside one
      // provider is the owner's call, and a provider the catalog does not know
      // is not evidence of anything.
      const warnings: string[] = [];
      for (const chain of chains) {
        const { errors, warnings: chainWarnings } = evaluateFallbackChain(chain, catalog);
        if (errors.length > 0) {
          throw unprocessable(errors[0]!.message, {
            code: "litellm_invalid_fallback_order",
            kind: errors[0]!.kind,
          });
        }
        warnings.push(...chainWarnings.map((issue) => issue.message));
      }

      // 4. Write the whole list to the gateway: LiteLLM merges per key, so the
      // list sent here replaces `router_settings.fallbacks` and nothing else.
      const gateway = requireGateway();
      const response = await call(gateway, "/config/update", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${gateway.adminKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          router_settings: {
            fallbacks: rawPayload,
          },
        }),
      });
      if (!response.ok) throw await requestFailed("/config/update", response);

      return { ok: true, warnings };
    },
  };
}
