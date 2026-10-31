// server/src/myrmidon/litellm-sync/client.ts
//
// myrmidon(1.6.1 MODEL-PROVIDERS B): LiteLLM admin API client.
//
// Calls LiteLLM's /model/new, /model/update, /model/delete, /model/info endpoints using the
// admin key. Never sends credential values - only secret name references.

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

  const rawWeight = litellmParams.weight ?? modelInfo.weight ?? item?.weight;
  const weight =
    typeof rawWeight === "number" && !Number.isNaN(rawWeight)
      ? rawWeight
      : typeof rawWeight === "string" && !Number.isNaN(Number(rawWeight))
        ? Number(rawWeight)
        : null;

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

  return {
    async registerModel(input) {
      const payload = {
        model_name: input.litellmModelName,
        litellm_params: {
          model: input.litellmModelName,
          provider: input.providerType,
          api_base: input.baseUrl || undefined,
          // Pass the secret name reference, not the value
          api_key: `secrets/${input.credentialSecretName}`,
          ...(input.order !== undefined ? { order: input.order, priority: input.order } : {}),
          ...(input.weight !== undefined ? { weight: input.weight } : {}),
          ...(input.disabled !== undefined ? { disabled: input.disabled } : {}),
          ...input.additionalConfig,
        },
        model_info: {
          ...(input.order !== undefined ? { order: input.order, priority: input.order } : {}),
          ...(input.weight !== undefined ? { weight: input.weight } : {}),
          ...(input.disabled !== undefined ? { disabled: input.disabled } : {}),
        },
      };

      await callLiteLLM("/model/new", payload);
    },

    async updateDeployment(input) {
      await callLiteLLM("/model/update", {
        model_name: input.litellmModelName,
        litellm_params: {
          model: input.litellmModelName,
          provider: input.providerType,
          api_base: input.baseUrl || undefined,
          // Pass the secret name reference, not the value
          api_key: `secrets/${input.credentialSecretName}`,
          ...(input.order !== undefined ? { order: input.order, priority: input.order } : {}),
          ...(input.weight !== undefined ? { weight: input.weight } : {}),
          ...(input.disabled !== undefined ? { disabled: input.disabled } : {}),
          ...input.additionalConfig,
        },
        model_info: {
          id: input.modelId,
          ...(input.order !== undefined ? { order: input.order, priority: input.order } : {}),
          ...(input.weight !== undefined ? { weight: input.weight } : {}),
          ...(input.disabled !== undefined ? { disabled: input.disabled } : {}),
        },
      });
    },

    async deleteDeployment(modelId) {
      await callLiteLLM("/model/delete", { id: modelId });
    },

    async unregisterModel(litellmModelName) {
      const payload = {
        model_names: [litellmModelName],
      };

      await callLiteLLM("/model/delete", payload);
    },

    async listRegisteredModels() {
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
      
      return models.map((model: any) => ({
        ...(typeof model.model_info?.id === "string" ? { modelId: model.model_info.id } : {}),
        litellmModelName: model.model_name || model.id,
        providerType: model.litellm_params?.provider || "",
        baseUrl: model.litellm_params?.api_base || null,
        credentialSecretName: extractSecretName(model.litellm_params?.api_key) || "",
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

/**
 * Extracts the secret name from an api_key formatted as "secrets/secret-name".
 */
function extractSecretName(apiKey: string | undefined): string | null {
  if (!apiKey || !apiKey.startsWith("secrets/")) {
    return null;
  }
  return apiKey.substring("secrets/".length);
}