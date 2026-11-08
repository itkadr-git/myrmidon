// server/src/myrmidon/litellm-sync/client.ts
//
// myrmidon(1.6.1 MODEL-PROVIDERS B): LiteLLM admin API client.
//
// Calls LiteLLM's /model/new, /model/update, /model/delete, /model/info endpoints using the
// admin key. Credential values are sent as values: LiteLLM encrypts them in its own DB
// (its secret manager is not configured on our deployments, so `secrets/<name>`
// references would never resolve).
//
// Payload rules (verified against LiteLLM v1.104.1):
//  - routing order is `litellm_params.order` (`/model/update` writes only
//    `litellm_params`; `model_info` is ignored); `priority`, `disabled` and
//    `provider` are not LiteLLM parameters and are never sent;
//  - `/model/delete` accepts only `{ id }` (`ModelInfoDelete`), so a model name
//    is deleted by looking its deployments up in `/model/info` first;
//  - `/model/update` merges `litellm_params`: an absent `api_key` keeps the
//    stored key, an empty string would erase it, so it is only sent when the
//    board holds a value.

import { isPoolModelProviderType } from "@myrmidon/shared";
import { unprocessable } from "../../errors.js";
import { LitellmSyncPort, type LitellmChannelView } from "./port.js";
/**
 * Strips or redacts any sensitive keys or tokens from an error string.
 */
export function sanitizeErrorMessage(message: string): string {
  if (!message) return "";
  return message
    .replace(/(Bearer\s+)[A-Za-z0-9_.-]+/gi, "$1<redacted>")
    .replace(/(authorization["':\s=]+)[A-Za-z0-9_.-]+/gi, "$1<redacted>")
    .replace(/\b(sk-[A-Za-z0-9_-]{6,})\b/gi, "<redacted>")
    .replace(/\b(pcp_[A-Za-z0-9_]+)\b/gi, "<redacted>")
    .replace(/(:\/\/[^:]+:)[^@]+(@)/g, "$1<redacted>$2")
    .replace(/(api[_-]?key["':\s=]+)[A-Za-z0-9_.-]+/gi, "$1<redacted>")
    .replace(/(secrets\/)[A-Za-z0-9_.-]+/gi, "$1<redacted>");
}

/**
 * Parses a LiteLLM deployment/channel entry from /model/info into a safe,
 * key-free channel view.
 */
export function parseLitellmChannel(item: any): LitellmChannelView {
  const litellmParams =
    item && typeof item.litellm_params === "object" && item.litellm_params !== null
      ? item.litellm_params
      : {};
  const modelInfo =
    item && typeof item.model_info === "object" && item.model_info !== null
      ? item.model_info
      : {};

  const group = String(item?.model_name || item?.id || "unknown");

  let provider = String(
    litellmParams.provider ||
      modelInfo.custom_llm_provider ||
      litellmParams.custom_llm_provider ||
      modelInfo.provider ||
      "",
  );

  let providerModel = String(
    litellmParams.model || modelInfo.model || item?.model || "",
  );

  if (!provider && providerModel.includes("/")) {
    provider = providerModel.split("/")[0];
  }
  if (!providerModel) {
    providerModel = group;
  }
  if (!provider) {
    provider = "unknown";
  }

  const rawId = modelInfo.id ?? item?.id ?? null;
  const id = typeof rawId === "string" ? rawId : null;

  const rawOrder = litellmParams.order ?? modelInfo.order ?? item?.order;
  const order =
    typeof rawOrder === "number" && !Number.isNaN(rawOrder)
      ? rawOrder
      : typeof rawOrder === "string" && !Number.isNaN(Number(rawOrder))
        ? Number(rawOrder)
        : null;

  const rawWeight = litellmParams.weight ?? modelInfo.weight ?? item?.weight ?? 0;
  const weight =
    typeof rawWeight === "number" && !Number.isNaN(rawWeight)
      ? rawWeight
      : typeof rawWeight === "string" && !Number.isNaN(Number(rawWeight))
        ? Number(rawWeight)
        : 0;

  return {
    id,
    group,
    provider,
    providerModel,
    order,
    weight,
  };
}

export interface LitellmSyncClientDeps {
  /** The base URL of the LiteLLM instance. */
  litellmBaseUrl: string;
  /** The admin key for LiteLLM model management. */
  litellmAdminKey: string;
}

/** LiteLLM provider prefix for a board connector type. */
export function litellmProviderPrefix(providerType: string): string {
  // These board connectors expose OpenAI-compatible APIs. LiteLLM routes them
  // through its `openai` provider; `openai-compatible` is not a LiteLLM prefix.
  // The subscription pools (`chatgpt-pool`, `antigravity-pool`, `google-ai-pool`)
  // are OpenAI-compatible routers too, and LiteLLM has no provider of those
  // names. The board does not register pool deployments at all (the service
  // skips them); the prefix stays right for any caller that still asks.
  if (
    providerType === "openai-compatible" ||
    providerType === "dashscope" ||
    providerType === "google" ||
    isPoolModelProviderType(providerType)
  ) {
    return "openai";
  }
  return providerType;
}

export function createLitellmSyncClient(deps: LitellmSyncClientDeps): LitellmSyncPort {
  const url = (path: string) => `${deps.litellmBaseUrl.replace(/\/$/, "")}${path}`;

  async function callLiteLLM<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(url(path), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deps.litellmAdminKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      let detail: string | undefined;
      try {
        const text = await response.text();
        try {
          const parsed = JSON.parse(text);
          detail = parsed?.error?.message ?? parsed?.detail ?? parsed?.message ?? text;
        } catch {
          detail = text;
        }
      } catch {
        // ignore read error
      }

      const message = detail
        ? `LiteLLM ${path} answered ${response.status}: ${detail}`
        : `LiteLLM ${path} answered ${response.status}`;

      throw unprocessable(message, {
        code: "litellm_request_failed",
        status: response.status,
        detail,
      });
    }

    return response.json();
  }

  /** The `litellm_params` of one deployment; only keys LiteLLM understands. */
  function deploymentParams(input: {
    litellmModelName: string;
    providerModel?: string;
    providerType: string;
    baseUrl: string | null;
    credentialValue?: string;
    order?: number;
    weight?: number;
    additionalConfig?: Record<string, unknown>;
  }): Record<string, unknown> {
    if (input.credentialValue !== undefined && input.credentialValue.startsWith(SECRET_REFERENCE_PREFIX)) {
      throw unprocessable("LiteLLM has no secret manager: send the credential value, not a secrets/<name> reference", {
        code: "litellm_credential_reference",
      });
    }
    return {
      model: `${litellmProviderPrefix(input.providerType)}/${input.providerModel ?? input.litellmModelName}`,
      api_base: input.baseUrl || undefined,
      ...(input.credentialValue ? { api_key: input.credentialValue } : {}),
      ...(input.order !== undefined ? { order: input.order } : {}),
      ...(input.weight !== undefined ? { weight: input.weight } : {}),
      ...input.additionalConfig,
    };
  }

  /** `/model/info` rows reduced to what registration, rotation and unregistration need. */
  async function fetchDeployments(): Promise<
    Array<{
      modelId?: string;
      litellmModelName: string;
      providerType: string;
      baseUrl: string | null;
      credentialSecretName: string;
      inGatewayConfig: boolean;
    }>
  > {
    const response = await fetch(url("/model/info"), {
      headers: {
        Authorization: `Bearer ${deps.litellmAdminKey}`,
      },
    });

    if (!response.ok) {
      throw unprocessable(`LiteLLM /model/info answered ${response.status}`, {
        code: "litellm_request_failed",
        status: response.status,
      });
    }

    const data = await response.json();
    // Parse the response based on LiteLLM's actual format
    const models = Array.isArray(data?.data) ? data.data : [];

    return models.map((model: any) => {
      const params = model.litellm_params ?? {};
      const upstream = typeof params.model === "string" ? params.model : "";
      return {
        ...(typeof model.model_info?.id === "string" ? { modelId: model.model_info.id } : {}),
        litellmModelName: model.model_name || model.id,
        providerType:
          params.provider || params.custom_llm_provider || (upstream.includes("/") ? upstream.split("/")[0] : ""),
        baseUrl: params.api_base || null,
        credentialSecretName: extractSecretName(params.api_key) || "",
        // `/model/delete` only knows models stored in the gateway database.
        inGatewayConfig: model.model_info?.db_model === false,
      };
    });
  }

  return {
    async registerModel(input) {
      await callLiteLLM("/model/new", {
        model_name: input.litellmModelName,
        litellm_params: deploymentParams(input),
        model_info: {},
      });
    },

    async updateDeployment(input) {
      await callLiteLLM("/model/update", {
        model_name: input.litellmModelName,
        litellm_params: deploymentParams(input),
        model_info: {
          id: input.modelId,
        },
      });
    },

    async deleteDeployment(modelId) {
      await callLiteLLM("/model/delete", { id: modelId });
    },

    async invalidateCache() {
      await callLiteLLM("/cache/delete", {});
    },

    async unregisterModel(litellmModelName, match) {
      const wanted = match && "baseUrl" in match ? normalizeBaseUrl(match.baseUrl) : undefined;
      const targets = (await fetchDeployments()).filter(
        (deployment) =>
          deployment.litellmModelName === litellmModelName &&
          deployment.modelId &&
          !deployment.inGatewayConfig &&
          (wanted === undefined || normalizeBaseUrl(deployment.baseUrl) === wanted),
      );
      for (const deployment of targets) {
        await callLiteLLM("/model/delete", { id: deployment.modelId });
      }
    },

    async listRegisteredModels() {
      return (await fetchDeployments()).map((deployment) => ({
        ...(deployment.modelId ? { modelId: deployment.modelId } : {}),
        litellmModelName: deployment.litellmModelName,
        providerType: deployment.providerType,
        baseUrl: deployment.baseUrl,
        credentialSecretName: deployment.credentialSecretName,
      }));
    },

    async listChannels() {
      let response: Response;
      try {
        response = await fetch(url("/model/info"), {
          headers: {
            Authorization: `Bearer ${deps.litellmAdminKey}`,
          },
        });
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        throw unprocessable(`LiteLLM connection error: ${sanitizeErrorMessage(raw)}`, {
          code: "litellm_connection_failed",
        });
      }

      if (!response.ok) {
        let errorText = "";
        try {
          errorText = await response.text();
        } catch {}
        const safeError = sanitizeErrorMessage(errorText || `HTTP ${response.status}`);
        throw unprocessable(`LiteLLM /model/info answered ${response.status}: ${safeError}`, {
          code: "litellm_request_failed",
          status: response.status,
        });
      }

      let data: any;
      try {
        data = await response.json();
      } catch {
        throw unprocessable("LiteLLM /model/info answered with invalid JSON", {
          code: "litellm_invalid_response",
        });
      }

      const models = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
      return models.map(parseLitellmChannel);
    },
  };
}

const SECRET_REFERENCE_PREFIX = "secrets/";

/** Trailing-slash and whitespace insensitive api_base; absent and empty are the same. */
function normalizeBaseUrl(baseUrl: string | null | undefined): string {
  return (baseUrl ?? "").trim().replace(/\/+$/, "");
}

/**
 * Extracts the secret name from an api_key formatted as "secrets/secret-name".
 * LiteLLM never reveals a stored key, so this only recognizes deployments that
 * were written with a reference by an older board version.
 */
function extractSecretName(apiKey: string | undefined): string | null {
  if (!apiKey || !apiKey.startsWith("secrets/")) {
    return null;
  }
  return apiKey.substring("secrets/".length);
}