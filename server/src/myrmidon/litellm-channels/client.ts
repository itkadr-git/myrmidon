// server/src/myrmidon/litellm-channels/client.ts
//
// myrmidon(1.6.7 OPE-9854): LiteLLM channel management client.
// Calls LiteLLM /model/new, /model/update, /model/delete, /model/info.

import { badGateway, unprocessable } from "../../errors.js";
import type {
  AddChannelInput,
  LitellmChannelView,
  LitellmChannelsPort,
  ReorderChannelInput,
  UpdateChannelInput,
} from "./types.js";

export interface LitellmChannelsClientDeps {
  litellmBaseUrl: string;
  litellmAdminKey: string;
}

function extractSecretName(apiKey: string | undefined | null): string | null {
  if (!apiKey || typeof apiKey !== "string") {
    return null;
  }
  const match = apiKey.match(/^secrets\/(.+)$/);
  return match ? match[1] : null;
}

export function createLitellmChannelsClient(deps: LitellmChannelsClientDeps): LitellmChannelsPort {
  function url(path: string): string {
    const base = deps.litellmBaseUrl.replace(/\/+$/, "");
    return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
  }

  async function callLiteLLM<T>(
    path: string,
    options: {
      method?: "GET" | "POST";
      body?: Record<string, unknown>;
    } = {},
  ): Promise<T> {
    const method = options.method ?? "POST";
    let response: Response;

    try {
      response = await fetch(url(path), {
        method,
        headers: {
          Authorization: `Bearer ${deps.litellmAdminKey}`,
          ...(options.body ? { "Content-Type": "application/json" } : {}),
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw badGateway(`Failed to connect to LiteLLM: ${message}`, {
        code: "litellm_connection_failed",
      });
    }

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
        ? `LiteLLM ${path} failed (${response.status}): ${detail}`
        : `LiteLLM ${path} answered ${response.status}`;

      throw unprocessable(message, {
        code: "litellm_request_failed",
        status: response.status,
        detail,
      });
    }

    try {
      return (await response.json()) as T;
    } catch {
      return {} as T;
    }
  }

  function parseChannelFromDeployment(model: Record<string, any>): LitellmChannelView {
    const modelInfo = (model.model_info && typeof model.model_info === "object" ? model.model_info : {}) as Record<string, any>;
    const litellmParams = (model.litellm_params && typeof model.litellm_params === "object" ? model.litellm_params : {}) as Record<string, any>;

    const id = String(modelInfo.id || model.id || model.model_name || "");
    const modelName = String(model.model_name || model.id || "");
    const providerModel = String(litellmParams.model || model.model_name || "");
    const providerType = litellmParams.provider ? String(litellmParams.provider) : null;
    const baseUrl = litellmParams.api_base ? String(litellmParams.api_base) : null;
    const credentialSecretName = extractSecretName(litellmParams.api_key);

    const rawOrder = modelInfo.order ?? modelInfo.priority ?? litellmParams.order ?? litellmParams.priority ?? 0;
    const order = Number.isFinite(Number(rawOrder)) ? Number(rawOrder) : 0;

    const rawWeight = modelInfo.weight ?? litellmParams.weight ?? 1;
    const weight = Number.isFinite(Number(rawWeight)) ? Number(rawWeight) : 1;

    let disabled = false;
    if (modelInfo.disabled !== undefined) {
      disabled = Boolean(modelInfo.disabled);
    } else if (modelInfo.mode !== undefined) {
      disabled = modelInfo.mode === "disabled";
    } else if (litellmParams.disabled !== undefined) {
      disabled = Boolean(litellmParams.disabled);
    }

    return {
      id,
      modelName,
      providerModel,
      providerType,
      baseUrl,
      credentialSecretName,
      order,
      weight,
      disabled,
      litellmParams,
      modelInfo,
    };
  }

  return {
    async listChannels(): Promise<LitellmChannelView[]> {
      const data = await callLiteLLM<any>("/model/info", { method: "GET" });
      const list = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
      return list.map((item: Record<string, any>) => parseChannelFromDeployment(item));
    },

    async addChannel(input: AddChannelInput): Promise<LitellmChannelView> {
      const litellmParams: Record<string, unknown> = {
        model: input.providerModel || input.modelName,
        ...(input.providerType ? { provider: input.providerType } : {}),
        ...(input.baseUrl ? { api_base: input.baseUrl } : {}),
        ...(input.credentialSecretName ? { api_key: `secrets/${input.credentialSecretName}` } : {}),
        ...(input.apiKey ? { api_key: input.apiKey } : {}),
        ...(input.order !== undefined ? { order: input.order, priority: input.order } : {}),
        ...(input.weight !== undefined ? { weight: input.weight } : {}),
        ...(input.disabled !== undefined ? { disabled: input.disabled } : {}),
        ...input.additionalConfig,
      };

      const modelInfo: Record<string, unknown> = {
        ...(input.channelId ? { id: input.channelId } : {}),
        order: input.order ?? 0,
        priority: input.order ?? 0,
        weight: input.weight ?? 1,
        disabled: Boolean(input.disabled),
      };

      const payload = {
        model_name: input.modelName,
        litellm_params: litellmParams,
        model_info: modelInfo,
      };

      const res = await callLiteLLM<any>("/model/new", {
        method: "POST",
        body: payload,
      });

      const returnedId = input.channelId || res?.data?.model_info?.id || res?.data?.id || res?.model_info?.id || res?.id || input.modelName;

      return {
        id: String(returnedId),
        modelName: input.modelName,
        providerModel: input.providerModel || input.modelName,
        providerType: input.providerType ?? null,
        baseUrl: input.baseUrl ?? null,
        credentialSecretName: input.credentialSecretName ?? extractSecretName(input.apiKey),
        order: input.order ?? 0,
        weight: input.weight ?? 1,
        disabled: Boolean(input.disabled),
        litellmParams,
        modelInfo: {
          ...modelInfo,
          id: returnedId,
        },
      };
    },

    async updateChannel(input: UpdateChannelInput): Promise<LitellmChannelView> {
      const modelInfo: Record<string, unknown> = {
        id: input.channelId,
        ...(input.order !== undefined ? { order: input.order, priority: input.order } : {}),
        ...(input.weight !== undefined ? { weight: input.weight } : {}),
        ...(input.disabled !== undefined ? { disabled: input.disabled } : {}),
      };

      const litellmParams: Record<string, unknown> = {
        ...(input.providerModel ? { model: input.providerModel } : {}),
        ...(input.providerType ? { provider: input.providerType } : {}),
        ...(input.baseUrl !== undefined ? { api_base: input.baseUrl || undefined } : {}),
        ...(input.credentialSecretName ? { api_key: `secrets/${input.credentialSecretName}` } : {}),
        ...(input.apiKey ? { api_key: input.apiKey } : {}),
        ...(input.order !== undefined ? { order: input.order, priority: input.order } : {}),
        ...(input.weight !== undefined ? { weight: input.weight } : {}),
        ...(input.disabled !== undefined ? { disabled: input.disabled } : {}),
        ...input.additionalConfig,
      };

      const payload: Record<string, unknown> = {
        model_info: modelInfo,
        ...(input.modelName ? { model_name: input.modelName } : {}),
        ...(Object.keys(litellmParams).length > 0 ? { litellm_params: litellmParams } : {}),
      };

      const res = await callLiteLLM<any>("/model/update", {
        method: "POST",
        body: payload,
      });

      const returnedModel = res?.data || res?.model || {};
      const parsed = parseChannelFromDeployment({
        ...returnedModel,
        model_info: {
          ...(returnedModel.model_info || {}),
          id: input.channelId,
          ...(input.order !== undefined ? { order: input.order, priority: input.order } : {}),
          ...(input.weight !== undefined ? { weight: input.weight } : {}),
          ...(input.disabled !== undefined ? { disabled: input.disabled } : {}),
        },
        model_name: input.modelName || returnedModel.model_name || "",
      });

      return parsed;
    },

    async disableChannel(channelId: string): Promise<LitellmChannelView> {
      return this.updateChannel({ channelId, disabled: true });
    },

    async enableChannel(channelId: string): Promise<LitellmChannelView> {
      return this.updateChannel({ channelId, disabled: false });
    },

    async deleteChannel(channelId: string): Promise<void> {
      await callLiteLLM("/model/delete", {
        method: "POST",
        body: { id: channelId },
      });
    },

    async reorderChannels(orders: ReorderChannelInput[]): Promise<LitellmChannelView[]> {
      const results: LitellmChannelView[] = [];
      for (const item of orders) {
        const updated = await this.updateChannel({
          channelId: item.channelId,
          order: item.order,
        });
        results.push(updated);
      }
      return results;
    },
  };
}
